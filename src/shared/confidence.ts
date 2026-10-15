/**
 * Confidence rules, enforced in code.
 *
 * The types in `types.ts` can only say that `Confidence` is one of four strings. The
 * actual product requirement — *a single tool hit can never be better than
 * `unverified`* — is a runtime invariant, so it lives here and everything that writes a
 * confidence value goes through this module.
 *
 * Why this matters more than it looks: Sherlock and Maigret share a known, unresolved
 * false-positive class where a site's anti-bot redirect answers 200 and the matcher
 * reads it as "account exists" (issues still open as of Aug 2026). If a single adapter
 * could mint `confirmed`, that bug would silently become "facts" in a case file. So the
 * only way up is through `promote()`, and the only ways up are:
 *
 *   unverified  -> corroborated   >= 2 findings with distinct `source` values
 *   *           -> confirmed      a human, with a note saying what they looked at
 *   *           -> refuted        a human with a note, or >= 2 contradicting sources
 *
 * Independence is keyed on `Finding.source`, never on `Finding.tool`. Sherlock and
 * Maigret both probing github.com is *one* source. That distinction is the entire value
 * of the rule; without it, running two tools that wrap the same site list would
 * "corroborate" every false positive in the list.
 */

import { siteOrigin } from './platforms'
import { claimsContradict } from './relevance'
import {
  ADAPTER_MAX_CONFIDENCE,
  type Confidence,
  type ConfidenceActor,
  type ConfidenceChange,
  type Finding,
  type IsoTimestamp
} from './types'

/** Minimum number of distinct sources needed to corroborate. */
export const CORROBORATION_THRESHOLD = 2

export class ConfidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfidenceError'
  }
}

/**
 * Ordering for display and for "is this an upgrade" checks.
 *
 * `refuted` deliberately sits outside the ladder at -1: it is not a weaker `unverified`,
 * it is a different claim about the world, and it must never be reachable by a rule that
 * says "take the highest".
 */
export function confidenceRank(c: Confidence): number {
  switch (c) {
    case 'refuted':
      return -1
    case 'unverified':
      return 0
    case 'corroborated':
      return 1
    case 'confirmed':
      return 2
  }
}

/**
 * Sources that describe where the app *looked*, not who answered.
 *
 * `local:` is analysis over the case's own files — a run summary, an hour histogram, an
 * inference. `file:` is a claim read out of bytes the operator already had. Neither is a
 * second opinion, so neither may ever be one of the two independent sources corroboration
 * requires: letting one count would let analysis corroborate the findings it was derived
 * from, and then let that promotion authorise more analysis.
 */
export function isDerivedSource(source: string): boolean {
  const s = (source ?? '').trim().toLowerCase()
  return s.startsWith('local:') || s.startsWith('file:')
}

/**
 * Normalise a source string down to its independence key — **the one fold in the app**.
 *
 * `https://github.com/foo`, `github.com`, `GitHub.com/`, `www.github.com` and
 * `api.github.com` are all one source: GitHub answering, however many tools asked. That
 * is `siteOrigin()` in `shared/platforms.ts`, which the adapters already apply at emit
 * time; applying it again here is what makes the guarantee hold for a source some adapter
 * forgot to fold, or one an operator typed by hand.
 *
 * This used to fold only `www.`, which meant the same two findings could corroborate in
 * the engine (which folds to the operator) and not in the database view, or the reverse.
 * The conservative fold wins, in both places, for the reason `platforms.ts` states: a
 * missed corroboration is recoverable by a human looking, a fabricated one is not.
 *
 * Derived sources keep their prefix intact and are never folded to a host — `local:dorks`
 * and `local:maigret` are different, and neither is the host `local`. Anything that is not
 * a URL or hostname falls back to a lowercased trim, so dataset names like `HaveIBeenPwned`
 * still work.
 */
export function independenceKey(source: string): string {
  const s = (source ?? '').trim().toLowerCase()
  if (!s) return ''
  const plain = s.replace(/\/+$/, '')
  if (isDerivedSource(s)) return plain
  return siteOrigin(s) || plain
}

/**
 * The distinct **independent** sources represented by a set of findings.
 *
 * Derived sources are dropped rather than counted, which is what stops a `local:` claim
 * from corroborating the findings it was computed from. Use `derivedSources()` when you
 * need to say out loud what was present and deliberately not counted.
 */
export function distinctSources(findings: readonly Finding[]): string[] {
  const keys = new Set<string>()
  for (const f of findings) {
    if (isDerivedSource(f.source)) continue
    const k = independenceKey(f.source)
    if (k) keys.add(k)
  }
  return [...keys].sort()
}

/** The derived sources present in a set of findings — named in the refusal, never counted. */
export function derivedSources(findings: readonly Finding[]): string[] {
  const keys = new Set<string>()
  for (const f of findings) {
    if (!isDerivedSource(f.source)) continue
    const k = independenceKey(f.source)
    if (k) keys.add(k)
  }
  return [...keys].sort()
}

/**
 * Guard applied to everything an adapter emits.
 *
 * Adapters may only produce `unverified`. A negative result is *not* `refuted` — it is
 * an `unverified` finding whose claim states the negative ("holehe reports no account
 * for this address on Spotify"), because one tool failing to find something is exactly
 * as fallible as one tool finding it.
 */
export function assertAdapterConfidence(adapterId: string, c: Confidence | undefined): void {
  if (c !== undefined && c !== ADAPTER_MAX_CONFIDENCE) {
    throw new ConfidenceError(
      `Adapter "${adapterId}" tried to emit confidence "${c}". Adapters may only emit ` +
        `"${ADAPTER_MAX_CONFIDENCE}"; promotion is a separate, audited step (see promote()).`
    )
  }
}

/** Force an adapter-supplied confidence to the only legal value. Throws on violation. */
export function adapterConfidence(adapterId: string, c: Confidence | undefined): Confidence {
  assertAdapterConfidence(adapterId, c)
  return ADAPTER_MAX_CONFIDENCE
}

export interface PromotionRequest {
  finding: Finding
  to: Confidence
  actor: ConfidenceActor
  /** Findings offered as corroboration. Ignored for a human vouch. */
  supporting?: readonly Finding[]
  /** Required for a human vouch, and for a human refutation. */
  note?: string
  at?: IsoTimestamp
  /** Injected for deterministic ids in tests. */
  idFactory?: () => string
}

export interface PromotionResult {
  finding: Finding
  change: ConfidenceChange
}

/**
 * The only way a `Finding` changes confidence. Returns the updated finding plus the
 * audit record to append to `confidence-log.jsonl`. Throws `ConfidenceError` if the
 * evidence offered does not meet the bar — it never silently downgrades the request.
 */
export function promote(req: PromotionRequest): PromotionResult {
  const { finding, to, actor } = req
  const from = finding.confidence
  const at = req.at ?? new Date().toISOString()
  const note = (req.note ?? '').trim()
  const supporting = (req.supporting ?? []).filter((f) => f.id !== finding.id)

  if (from === to) {
    throw new ConfidenceError(`Finding ${finding.id} is already "${to}".`)
  }

  for (const s of supporting) {
    if (s.caseId !== finding.caseId) {
      throw new ConfidenceError(
        `Supporting finding ${s.id} belongs to case ${s.caseId}, not ${finding.caseId}. ` +
          `Corroboration never crosses cases.`
      )
    }
    if (s.entityId !== finding.entityId) {
      throw new ConfidenceError(
        `Supporting finding ${s.id} is about entity ${s.entityId}, not ${finding.entityId}. ` +
          `Corroboration must be about the same entity.`
      )
    }
  }

  // The finding itself counts as one source — unless it is derived, in which case it
  // counts as none, exactly like every other `local:` claim.
  const sources = distinctSources([finding, ...supporting])
  const derived = derivedSources([finding, ...supporting])

  switch (to) {
    case 'unverified':
      // Demotion back to the default is always allowed, but must still be recorded.
      if (actor !== 'human') {
        throw new ConfidenceError('Only a human may demote a finding back to "unverified".')
      }
      if (!note) {
        throw new ConfidenceError('Demoting to "unverified" requires a note saying why.')
      }
      break

    case 'corroborated': {
      if (actor !== 'corroborator') {
        throw new ConfidenceError(
          `Promotion to "corroborated" is evidence-driven; pass actor "corroborator". ` +
            `A human who has personally checked should use "confirmed" instead.`
        )
      }
      if (sources.length < CORROBORATION_THRESHOLD) {
        throw new ConfidenceError(
          `Promotion to "corroborated" needs at least ${CORROBORATION_THRESHOLD} independent ` +
            `sources; got ${sources.length} (${sources.join(', ') || 'none'}). ` +
            `Independence is keyed on the source, not the tool — two tools reading the same ` +
            `site is one source.` +
            (derived.length
              ? ` ${derived.join(', ')} also named it and does not count: local analysis ` +
                `rearranges captures already in the case, so it cannot corroborate the ` +
                `findings it was derived from.`
              : '')
        )
      }
      // Two sources that mention the same entity while asserting opposite things are not
      // agreement, and counting them as agreement is the same failure as counting one site
      // twice: it manufactures a promotion out of nothing. The contradiction test is
      // `shared/relevance.ts`'s, unchanged and not re-implemented — a different personal
      // name, or a gender that disagrees. Silence is not disagreement, so a claim that
      // states nothing about who holds the account never blocks anything.
      const clash = firstContradiction(finding, supporting)
      if (clash) {
        throw new ConfidenceError(
          `Promotion to "corroborated" needs the sources to agree, and these do not: ` +
            `${clash.why} (${independenceKey(clash.a.source) || clash.a.source} vs ` +
            `${independenceKey(clash.b.source) || clash.b.source}). Two sources that name the ` +
            `same entity while asserting opposite things are not corroboration. Decide which ` +
            `is wrong, or confirm it by hand with a note.`
        )
      }
      break
    }

    case 'confirmed': {
      if (actor !== 'human') {
        throw new ConfidenceError(
          `Only a human may set "confirmed". No amount of tool agreement produces it: ` +
            `corroboration tops out at "corroborated".`
        )
      }
      if (!note) {
        throw new ConfidenceError(
          'Confirming requires a note recording what you actually looked at. ' +
            'A confirmation with no stated basis is indistinguishable from a guess.'
        )
      }
      break
    }

    case 'refuted': {
      if (actor === 'human') {
        if (!note) throw new ConfidenceError('Refuting by hand requires a note saying what disproved it.')
      } else if (sources.length < CORROBORATION_THRESHOLD) {
        throw new ConfidenceError(
          `Refuting on evidence needs at least ${CORROBORATION_THRESHOLD} independent ` +
            `contradicting sources; got ${sources.length}.`
        )
      }
      break
    }
  }

  const supportingIds = supporting.map((f) => f.id)
  const idFactory = req.idFactory
  const change: ConfidenceChange = {
    id: idFactory ? idFactory() : `cch_${at}_${finding.id}`,
    caseId: finding.caseId,
    findingId: finding.id,
    from,
    to,
    actor,
    supportingFindingIds: supportingIds,
    independentSources: sources,
    note,
    at
  }

  return {
    finding: {
      ...finding,
      confidence: to,
      // Any confidence decision is an act of verification; stamp it.
      lastVerified: at
    },
    change
  }
}

export interface ClaimClash {
  a: Finding
  b: Finding
  /** The scorer's own sentence, so the refusal says what actually disagreed. */
  why: string
}

/**
 * The first pair of claims among these findings that disagree, or `null`.
 *
 * Every claim is tested against every other rather than only against the finding being
 * promoted: `A` may say nothing while `B` and `C` name two different people, and that set
 * is no more in agreement than the pair.
 *
 * Only *stated* disagreement counts — a different personal name, or a gender the other
 * side's name does not read as. `relevance.ts` prices everything softer than that (a
 * location field, an account older than the stated age) below the `contradicted` band on
 * purpose, because those are wrong on real profiles often enough to be worth noticing and
 * not worth acting on. They still show on the row; they do not block a promotion.
 */
export function firstContradiction(
  finding: Finding,
  supporting: readonly Finding[]
): ClaimClash | null {
  const all = [finding, ...supporting]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i] as Finding
      const b = all[j] as Finding
      const why = claimsContradict(a.claim, b.claim)
      if (why) return { a, b, why }
    }
  }
  return null
}

/**
 * Non-throwing check: could these findings corroborate each other right now?
 * Used by the UI to enable/disable the promote button and to explain why not.
 *
 * It answers with the same rules `promote()` enforces — derived sources excluded, claims
 * required to agree — because a button that offers a promotion the call then refuses is
 * worse than a disabled one.
 */
export function canCorroborate(
  finding: Finding,
  candidates: readonly Finding[]
): { ok: boolean; sources: string[]; reason: string | null } {
  const same = candidates.filter(
    (c) => c.id !== finding.id && c.caseId === finding.caseId && c.entityId === finding.entityId
  )
  const sources = distinctSources([finding, ...same])
  if (sources.length < CORROBORATION_THRESHOLD) {
    const derived = derivedSources([finding, ...same])
    return {
      ok: false,
      sources,
      reason:
        `${sources.length} independent source${sources.length === 1 ? '' : 's'} ` +
        `(${sources.join(', ') || 'none'}); needs ${CORROBORATION_THRESHOLD}.` +
        (derived.length
          ? ` ${derived.join(', ')} does not count — local analysis is not a second opinion.`
          : '')
    }
  }
  const clash = firstContradiction(finding, same)
  if (clash) {
    return {
      ok: false,
      sources,
      reason: `${sources.length} independent sources, but they disagree: ${clash.why}`
    }
  }
  return { ok: true, sources, reason: null }
}

/** Short label + colour token for the UI badge. */
export function confidenceBadge(c: Confidence): { label: string; tone: 'neutral' | 'warn' | 'good' | 'bad' } {
  switch (c) {
    case 'unverified':
      return { label: 'Unverified', tone: 'warn' }
    case 'corroborated':
      return { label: 'Corroborated', tone: 'neutral' }
    case 'confirmed':
      return { label: 'Confirmed', tone: 'good' }
    case 'refuted':
      return { label: 'Refuted', tone: 'bad' }
  }
}

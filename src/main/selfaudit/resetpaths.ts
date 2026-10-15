/**
 * The reset-path map: which accounts can be recovered through which address or number.
 *
 * This is the most valuable page in the self-audit, and it is the one most easily faked.
 * A convincing graph of arrows can be drawn from nothing at all; what makes this one worth
 * reading is that **every edge is something a site actually said**, and where the data does
 * not support a link none is drawn.
 *
 * ## Where the edges come from
 *
 * - **holehe's own CSV**, re-derived from the permanent raw capture rather than from a
 *   claim string. Each row is one site's answer to "is this address registered here",
 *   obtained from a password-reset, registration or login form — the `method` column says
 *   which. `exists=True` with no rate limit is an **observed** edge: the site itself
 *   behaved as though the address were registered.
 * - **The masked recovery hints** those same rows sometimes carry — `te****@e*****.com`,
 *   `+33 6 ** ** ** 12`. A mask is a constraint on a value, not a value, so it can never
 *   produce an observed edge. Where a mask is *consistent* with something the operator
 *   seeded, the edge is drawn as `consistent` and labelled as an inference. Where the mask
 *   is too generic to distinguish anybody — `t****@g****.com` fits half of Gmail — no edge
 *   is drawn at all.
 * - **The username adapters** contribute the account set. An account they found on a site
 *   holehe never reached is not an edge; it is a hole, and it goes in `unchecked` with the
 *   reason. "You have an account here and we do not know what recovers it" is a true and
 *   useful sentence. "You have no recovery exposure here" would not be.
 *
 * ## The chain
 *
 * The thing worth finding is the multi-step route — an old forum account registered to an
 * alias address, whose masked recovery hint is consistent with the phone number that also
 * recovers everything else. That chain is built only when every step has its own evidence,
 * and the inferred step says so in its own text.
 */

import { parseCsv, pyBool } from '../adapters/support/csv'
import { siteOrigin } from '../adapters/support/sources'
import { readRawEnvelope } from './coverage'
import { isSilent, type ResetPathEdge, type ResetPathHub, type ResetPathMap } from '../../shared/selfaudit'
import type { SelfAuditCheck, SelfAuditSnapshot, SnapshotSeed } from '../../shared/selfaudit'

/** Characters holehe and the sites it reads use to redact the middle of a value. */
const MASK_CHARS = /[*•·×xX]{2,}|\*+/

/** A mask with fewer literal characters than this identifies nobody. No edge is drawn. */
const MIN_LITERAL_CHARS = 3
/** Same idea for a phone mask, counted in digits. */
const MIN_LITERAL_DIGITS = 4

export interface ResetPathInput {
  snapshot: SelfAuditSnapshot
  /** `SnapshotFinding.rawPath` -> the bytes, already read by the caller. */
  raws: Map<string, string>
}

/* ------------------------------------------------------------------ *
 * Mask consistency
 * ------------------------------------------------------------------ */

/**
 * Split a masked value into the literal fragments a site left visible, in order.
 * `te****@e*****.com` -> `['te', '@e', '.com']`
 */
export function maskFragments(mask: string): string[] {
  return mask
    .split(/[*•·×]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Literal characters a mask actually reveals, **excluding the TLD**.
 *
 * `t****@g****.com` leaves five alphanumerics visible if you count `com`, and identifies
 * nobody: it fits every Gmail address starting with t. The suffix is public knowledge
 * about the domain rather than information about the value, so it is not counted, and the
 * mask falls below the floor where it belongs.
 */
function literalCount(fragments: readonly string[]): number {
  const last = fragments[fragments.length - 1] ?? ''
  const counted = last.startsWith('.') ? fragments.slice(0, -1) : fragments
  return counted.join('').replace(/[^A-Za-z0-9]/g, '').length
}

/**
 * Is `candidate` consistent with `mask`?
 *
 * Consistency, never identity. The test is that the visible fragments occur in the
 * candidate in order, the first one at the start and the last one at the end — plus a
 * floor on how much was left visible, because a mask that reveals two characters and a
 * TLD is consistent with millions of addresses and drawing an edge from it would be
 * inventing a link.
 *
 * When the mask and the candidate are the same length the mask preserved length, and that
 * is checked too. Many sites do not preserve it, so a mismatch is not disqualifying.
 */
export function maskConsistent(mask: string, candidate: string): boolean {
  const m = mask.trim().toLowerCase()
  const c = candidate.trim().toLowerCase()
  if (!m || !c) return false
  if (!MASK_CHARS.test(m)) return m === c
  const fragments = maskFragments(m)
  if (!fragments.length) return false

  const isPhone = /^[+\d]/.test(m) && !m.includes('@')
  if (isPhone) {
    const digits = fragments.join('').replace(/\D/g, '')
    if (digits.length < MIN_LITERAL_DIGITS) return false
    const candidateDigits = c.replace(/\D/g, '')
    let at = 0
    for (const fragment of fragments) {
      const f = fragment.replace(/\D/g, '')
      if (!f) continue
      const found = candidateDigits.indexOf(f, at)
      if (found < 0) return false
      at = found + f.length
    }
    const first = fragments[0]?.replace(/\D/g, '') ?? ''
    const last = fragments[fragments.length - 1]?.replace(/\D/g, '') ?? ''
    return (!first || candidateDigits.startsWith(first)) && (!last || candidateDigits.endsWith(last))
  }

  if (literalCount(fragments) < MIN_LITERAL_CHARS) return false
  let at = 0
  for (const fragment of fragments) {
    const found = c.indexOf(fragment, at)
    if (found < 0) return false
    at = found + fragment.length
  }
  const first = fragments[0] as string
  const last = fragments[fragments.length - 1] as string
  if (!c.startsWith(first)) return false
  if (!c.endsWith(last)) return false
  if (m.length === c.length) {
    // Length was preserved, so every visible character must sit where the mask put it.
    for (let i = 0; i < m.length; i++) {
      const ch = m[i] as string
      if (/[*•·×]/.test(ch)) continue
      if (c[i] !== ch) return false
    }
  }
  return true
}

/* ------------------------------------------------------------------ *
 * Building the map
 * ------------------------------------------------------------------ */

interface HoleheRow {
  platform: string
  site: string
  address: string
  exists: boolean | null
  rateLimited: boolean
  method: string
  maskedEmail: string
  maskedPhone: string
  findingId: string
  /** When the capture behind this row was taken. See `ResetPathEdge.observedAt`. */
  observedAt: string
}

function holeheRows(input: ResetPathInput): HoleheRow[] {
  const out: HoleheRow[] = []
  const seenRaw = new Set<string>()

  for (const f of input.snapshot.findings) {
    if (f.tool !== 'holehe') continue
    const rawPath = f.rawPath
    if (!rawPath || seenRaw.has(rawPath)) continue
    seenRaw.add(rawPath)
    // The last time a run re-observed this claim, or the first time it saw it. This is the
    // date the edges from this capture carry, and the reason older edges can no longer
    // masquerade as today's.
    const observedAt = f.lastVerified ?? f.firstSeen

    const env = readRawEnvelope(input.raws.get(rawPath) ?? null)
    if (!env) continue
    const address = (env.target ?? '').trim()
    const artifacts = env.artifacts ?? {}
    const csvName = Object.keys(artifacts).find((n) => n.toLowerCase().endsWith('.csv'))
    if (!csvName) continue

    for (const row of parseCsv(artifacts[csvName] ?? null).rows) {
      const site = row['name'] || row['domain'] || 'unknown site'
      const domain = row['domain'] || site
      out.push({
        platform: siteOrigin(domain) || domain.toLowerCase(),
        site,
        address,
        exists: pyBool(row['exists']),
        rateLimited: pyBool(row['rateLimit']) === true,
        method: (row['method'] ?? '').trim(),
        maskedEmail: (row['emailrecovery'] ?? '').trim(),
        maskedPhone: (row['phoneNumber'] ?? '').trim(),
        findingId: f.id,
        observedAt
      })
    }
  }
  return out
}

export function buildResetPaths(input: ResetPathInput): ResetPathMap {
  const snapshot = input.snapshot
  const rows = holeheRows(input)

  const seededEmails = snapshot.seeds.filter((s) => s.kind === 'email')
  const seededPhones = snapshot.seeds.filter((s) => s.kind === 'phone')

  const edges: ResetPathEdge[] = []
  const unchecked: { platform: string; reason: string; tool: string }[] = []

  for (const row of rows) {
    if (row.rateLimited || row.exists === null) {
      unchecked.push({
        platform: row.platform,
        reason: row.rateLimited
          ? 'holehe was rate-limited here and got no verdict. Whether this address recovers an account on this site is unknown.'
          : 'holehe returned a row it could not read a verdict from.',
        tool: 'holehe'
      })
      continue
    }
    if (row.exists !== true) continue

    edges.push({
      fromKind: 'email',
      fromValue: row.address,
      masked: false,
      platform: row.platform,
      handle: null,
      mechanism: row.method || 'a public endpoint',
      status: 'observed',
      evidenceFindingIds: [row.findingId],
      observedAt: row.observedAt,
      note:
        `${row.site} behaved as though ${row.address} were already registered when asked through its ` +
        `${row.method || 'public'} flow. That is the endpoint's behaviour at the time of the capture, not a profile anyone has seen.`
    })

    // A masked hint is a constraint, not a value. It becomes an edge only where it is
    // consistent with something the operator seeded — and even then it says so.
    for (const [mask, kind] of [
      [row.maskedEmail, 'email'],
      [row.maskedPhone, 'phone']
    ] as const) {
      if (!mask) continue
      const pool: SnapshotSeed[] = kind === 'email' ? seededEmails : seededPhones
      const match = pool.find((s) => maskConsistent(mask, s.label) || maskConsistent(mask, s.value))
      if (!match) continue
      // The address the run was pointed at recovering itself is not a chain.
      if (kind === 'email' && match.label.toLowerCase() === row.address.toLowerCase()) continue
      edges.push({
        fromKind: kind,
        fromValue: match.label,
        masked: true,
        platform: row.platform,
        handle: null,
        mechanism: 'recovery hint on the account',
        status: 'consistent',
        evidenceFindingIds: [row.findingId],
        observedAt: row.observedAt,
        note:
          `${row.site} showed the masked recovery ${kind === 'email' ? 'address' : 'number'} "${mask}" for the account registered to ${row.address}. ` +
          `That mask is consistent with ${match.label}, which you seeded — consistent with, not proof of. A different ${kind} fitting the same mask would look identical.`
      })
    }
  }

  // Accounts a username tool found on a site the oracle never reached. Not an edge; a
  // hole, and one worth naming — "we do not know what recovers this" is the true sentence.
  const askedPlatforms = new Set(rows.map((r) => r.platform))
  const answeredPlatforms = new Set(rows.filter((r) => !r.rateLimited && r.exists !== null).map((r) => r.platform))
  for (const account of snapshot.accounts) {
    if (!account.platform || answeredPlatforms.has(account.platform)) continue
    unchecked.push({
      platform: account.platform,
      reason: askedPlatforms.has(account.platform)
        ? `An account was reported here, and holehe got no verdict on whether any seeded address recovers it.`
        : `An account was reported here, and no recovery oracle in this build covers this site. What recovers it is unknown.`,
      tool: askedPlatforms.has(account.platform) ? 'holehe' : 'none'
    })
  }

  // The most recent capture any edge came from. Anything older than this is history, and
  // says so rather than being drawn as the site's answer today.
  const newestAt = rows.reduce<string | null>(
    (best, r) => (r.observedAt && (!best || r.observedAt > best) ? r.observedAt : best),
    null
  )
  const drawn = dedupeEdges(edges, newestAt)
  const hubs = buildHubs(drawn)
  const chains = buildChains(drawn, hubs)

  const holeheChecks = snapshot.checks.filter((c) => c.adapterId === 'holehe')
  const degraded = holeheChecks.length > 0 && holeheChecks.every((c) => isSilent(c.outcome) || c.outcome === 'partial')
  const noOracle = holeheChecks.length === 0

  return {
    edges: drawn,
    hubs,
    unchecked: dedupeUnchecked(unchecked),
    chains,
    degraded: degraded || noOracle,
    degradedNote: noOracle
      ? 'No account-existence oracle ran for this level, so this map has no edges of its own. Everything below is what the username tools found, with the recovery question unanswered.'
      : degraded
        ? worstHoleheDetail(holeheChecks)
        : null
  }
}

function worstHoleheDetail(checks: readonly SelfAuditCheck[]): string {
  const worst = checks.find((c) => isSilent(c.outcome)) ?? checks[0]
  return (
    `The recovery oracle was refused more than it was answered: ${worst?.detail ?? 'no detail recorded'} ` +
    `Absent edges on this map mean "not checked", not "not recoverable".`
  )
}

/**
 * One edge per (address, platform, status) — the newest capture wins.
 *
 * The old version kept whichever edge it saw first, and because an edge carried no date
 * that meant a three-week-old holehe run survived alongside today's rate limit on the same
 * site: the platform appeared once as a confirmed recovery path and once as unchecked,
 * with nothing on screen to say which reading was current. Now the freshest capture per
 * pair is the one drawn, and an edge that is not from the newest run of the case says its
 * own date so it cannot be read as today's answer.
 */
function dedupeEdges(edges: readonly ResetPathEdge[], newestAt: string | null): ResetPathEdge[] {
  const byKey = new Map<string, ResetPathEdge>()
  for (const e of edges) {
    const key = `${e.fromKind}|${e.fromValue.toLowerCase()}|${e.platform}|${e.status}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...e })
      continue
    }
    const evidence = [...new Set([...prev.evidenceFindingIds, ...e.evidenceFindingIds])]
    const newer = (e.observedAt ?? '') > (prev.observedAt ?? '') ? e : prev
    byKey.set(key, { ...newer, evidenceFindingIds: evidence })
  }
  return [...byKey.values()]
    .map((e) => (newestAt && e.observedAt && e.observedAt < newestAt ? { ...e, note: datedNote(e) } : e))
    .sort((a, b) => a.fromValue.localeCompare(b.fromValue) || a.platform.localeCompare(b.platform))
}

/** An edge from an older capture says so, in the note, where the operator reads it. */
function datedNote(edge: ResetPathEdge): string {
  const day = (edge.observedAt ?? '').slice(0, 10)
  return `${edge.note} This is what the site said on ${day}, not in the most recent run — it may have been re-checked since, or not checked at all.`
}

function dedupeUnchecked(
  rows: readonly { platform: string; reason: string; tool: string }[]
): { platform: string; reason: string; tool: string }[] {
  const byPlatform = new Map<string, { platform: string; reason: string; tool: string }>()
  for (const r of rows) if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, r)
  return [...byPlatform.values()].sort((a, b) => a.platform.localeCompare(b.platform))
}

function buildHubs(edges: readonly ResetPathEdge[]): ResetPathHub[] {
  const byValue = new Map<string, ResetPathHub>()
  for (const e of edges) {
    const key = `${e.fromKind}|${e.fromValue.toLowerCase()}`
    const hub = byValue.get(key) ?? { kind: e.fromKind, value: e.fromValue, platforms: [], inferred: 0 }
    if (!hub.platforms.includes(e.platform)) hub.platforms.push(e.platform)
    if (e.status === 'consistent') hub.inferred++
    byValue.set(key, hub)
  }
  return [...byValue.values()]
    .map((h) => ({ ...h, platforms: h.platforms.sort() }))
    .sort((a, b) => b.platforms.length - a.platforms.length || a.value.localeCompare(b.value))
}

/**
 * Multi-step routes, spelled out.
 *
 * A chain is only drawn when an inferred edge lands on a value that is itself a hub —
 * that is the interesting case, because it is the step where one forgotten account leads
 * to the thing that recovers everything else. The inferred step keeps its own hedge in the
 * text rather than being laundered into certainty by being part of a longer story.
 */
function buildChains(
  edges: readonly ResetPathEdge[],
  hubs: readonly ResetPathHub[]
): { steps: string[]; note: string; evidenceFindingIds: string[] }[] {
  const out: { steps: string[]; note: string; evidenceFindingIds: string[] }[] = []
  const hubByValue = new Map(hubs.map((h) => [`${h.kind}|${h.value.toLowerCase()}`, h]))

  for (const inferred of edges) {
    if (inferred.status !== 'consistent') continue
    const hub = hubByValue.get(`${inferred.fromKind}|${inferred.fromValue.toLowerCase()}`)
    // A hub the inferred edge is the *only* member of leads nowhere.
    const onward = (hub?.platforms ?? []).filter((p) => p !== inferred.platform)
    if (!onward.length) continue

    const observedOnPlatform = edges.filter((e) => e.platform === inferred.platform && e.status === 'observed')
    const entry = observedOnPlatform[0]
    out.push({
      steps: [
        entry
          ? `${entry.platform} says an account is registered to ${entry.fromValue}.`
          : `${inferred.platform} holds an account of yours.`,
        `${inferred.platform} shows a masked recovery ${inferred.fromKind === 'email' ? 'address' : 'number'} on it.`,
        `That mask is consistent with ${inferred.fromValue} — an inference, not an observation.`,
        `${inferred.fromValue} also reaches ${onward.length} other site${onward.length === 1 ? '' : 's'}: ${onward.join(', ')}.`
      ],
      note:
        'Only the first and last steps were observed. The middle step is a mask being consistent with a value you seeded, ' +
        'which is exactly the kind of link that is easy to draw and hard to prove. Confirm it on the site before acting on it.',
      evidenceFindingIds: [...new Set([...(entry?.evidenceFindingIds ?? []), ...inferred.evidenceFindingIds])]
    })
  }

  return out.slice(0, 8)
}

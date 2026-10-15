/**
 * Applying the relevance model to this app's records.
 *
 * `relevance.ts` holds the model — what a signal is, what contradicts what, and which
 * kinds of conflict are allowed to sink a row. This file is the adapter between that model
 * and the three concrete things the case view puts on screen: the seed entities, the
 * findings table, and the review queue.
 *
 * It is deliberately separate. The model is the part worth arguing about and the part the
 * tests are pointed at; the mapping is bookkeeping, and mixing the two would make both
 * harder to read.
 *
 * Everything here is **derived and recomputed**, never stored. A relevance score is a
 * function of the seeds, and the seeds change — the operator adds a name at L2, states the
 * subject's gender, corrects a city. A stored score would be a number that used to be true,
 * which is the failure mode this codebase avoids everywhere else by deriving orphans,
 * candidate confidence and independence counts at read time rather than copying them.
 */

import {
  isRelative,
  type CandidateView,
  type Confidence,
  type Entity,
  type EntityKind,
  type Finding
} from './types'
import {
  assessRelevance,
  emptyStatedFields,
  resolveSubject,
  statedFields,
  unscored,
  type RelevanceAssessment,
  type RelevanceBand,
  type RelevanceRow,
  type ScoreOptions,
  type SeedContext,
  type StatedFields,
  type SubjectProfile
} from './relevance'
import { RELEVANCE_BANDS } from './relevance'

/**
 * Seed kinds unique enough that "the operator supplied this" is worth acting on.
 *
 * `username` is the conspicuous omission and the reason this list exists at all. A seeded
 * handle is precisely the thing that fans out to fifty strangers — anchoring on it would
 * mark every row in a username sweep as operator-supplied and the anchor would mean
 * nothing. A seeded **account** (`steamcommunity.com/somebody`), address, phone or domain
 * is a different animal: it names one thing, the operator named it, and rows about it are
 * the case's fixed points.
 */
const ANCHOR_KINDS: readonly EntityKind[] = ['account', 'email', 'phone', 'domain', 'ipaddr', 'image']

/**
 * Build the seed context from a case's entities and the operator's stated subject.
 *
 * Only `seed: true` entities count. A promoted candidate is in the graph and is a perfectly
 * real entity, but it is something the *app* proposed and a human accepted — using it to
 * rank later results would let one accepted guess quietly become the yardstick for
 * everything that follows, which is how a case drifts onto the wrong person and gets more
 * convincing as it goes.
 */
export function seedContextFrom(
  entities: readonly Entity[],
  subject: SubjectProfile | undefined | null
): SeedContext {
  const names: string[] = []
  const relatives: string[] = []
  const handles: string[] = []
  const accounts: string[] = []
  const places: string[] = []
  const literals: string[] = []

  for (const e of entities) {
    if (!e.seed) continue
    switch (e.kind) {
      case 'person':
        // A relative is a seeded `person` too, and treating one as the subject's own name
        // costs the case twice. `resolveSubject` reads every seeded name and returns
        // `ambiguous` the moment two of them read as different genders — so seeding a
        // sister's name switched the gender signal off, and the level that knew *more*
        // ranked worse than the level below it. And a row matching a relative's name
        // scored as if it were about the subject.
        if (isRelative(e)) relatives.push(e.label || e.value)
        else names.push(e.label || e.value)
        break
      case 'username':
        handles.push(e.value)
        break
      case 'account':
        accounts.push(e.value)
        break
      case 'location':
      case 'organisation':
        places.push(e.label || e.value)
        break
      case 'email':
      case 'phone':
      case 'domain':
      case 'ipaddr':
        literals.push(e.value)
        break
      default:
        break
    }
  }

  return {
    names,
    relatives,
    handles,
    accounts,
    places,
    literals,
    subject: resolveSubject(subject, names)
  }
}

/**
 * Whether an entity of this kind is capable of being an anchor at all.
 *
 * Exported because anchoring has a second route — a human confirming a finding — and that
 * route has to answer the same question. `username` and `person` are the kinds this
 * deliberately excludes, and they are excluded for the reason the whole app exists: a
 * handle or a name is the thing that fans out to fifty strangers, so treating one as a
 * fixed point makes every branch under it look load-bearing.
 */
export function isAnchorKind(kind: EntityKind): boolean {
  return ANCHOR_KINDS.includes(kind)
}

/** The seed entity ids whose rows count as anchors. */
export function anchorEntityIds(entities: readonly Entity[]): Set<string> {
  const out = new Set<string>()
  for (const e of entities) {
    if (e.seed && isAnchorKind(e.kind)) out.add(e.id)
  }
  return out
}

/**
 * Every anchor in a case: seeds that name one thing, plus entities a human has confirmed
 * something about — and **only** where the entity's kind could be an anchor at all.
 *
 * The second half is the one with teeth, and it was unreachable until the UI could confirm
 * a finding. Confirming a finding about a seeded *handle* would otherwise anchor the
 * handle, and a handle is precisely the thing a sweep fans out from: one sentence about
 * one site would have made every stranger collected under that entity look load-bearing,
 * unlocking deeper expansion for all of them at once. So the kinds excluded from the seed
 * route — `username` and `person` — are excluded from this one too.
 *
 * Confirming a finding raises that finding. Anchoring is a claim about an identity, and
 * the two are deliberately not the same act.
 */
export function anchorsFor(
  entities: readonly Entity[],
  findings: readonly { entityId: string; confidence: Confidence }[]
): Set<string> {
  const kinds = new Map(entities.map((e) => [e.id, e.kind]))
  const out = anchorEntityIds(entities)
  for (const f of findings) {
    if (f.confidence !== 'confirmed') continue
    const kind = kinds.get(f.entityId)
    if (kind && isAnchorKind(kind)) out.add(f.entityId)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

export interface FindingRowContext {
  /** Seed entity ids that make a row an anchor — see `anchorEntityIds`. */
  anchors: ReadonlySet<string>
}

export function rowFromFinding(f: Finding, ctx: FindingRowContext): RelevanceRow {
  return {
    text: f.claim,
    source: f.source,
    // A finding's source is already folded to the site's origin, which is exactly the
    // platform half of an account value. There is nothing more precise to be had here.
    platform: f.source.includes(':') ? null : f.source,
    /*
     * Deliberately null, and this is not an omission.
     *
     * A finding is always *about* the entity the run was pointed at, so its handle is the
     * seeded handle on every single row a username sweep produces. Reporting that as an
     * agreement would add the same points to all fifty strangers and rank them identically
     * — the scorer rewarding a row for the very reason the row is in front of him. The
     * handle is the query, not an observation.
     *
     * It is a real signal on a *candidate*, where the discovered handle can differ from the
     * seeded one (`krisi` against `krisi_dev`), and `rowFromCandidate` fills it in there.
     */
    handle: null,
    anchored: ctx.anchors.has(f.entityId),
    stated: statedFields(f.claim)
  }
}

/* ------------------------------------------------------------------ *
 * Candidates
 * ------------------------------------------------------------------ */

/**
 * A candidate carries more structure than a finding does, and this uses all of it.
 *
 * A `person` candidate's **value is a display name** — maigret and the profile enrichment
 * both propose one when a site prints a name — so it goes straight into `stated` rather
 * than being rediscovered by parsing the rationale. Same for a `location` candidate. That
 * is what makes the strongest negative signal fire reliably on a review queue: the two
 * Facebook rows carrying a different Bulgarian name arrive here as `person` candidates
 * with that name as the value.
 */
export function rowFromCandidate(
  c: CandidateView,
  seeds: SeedContext,
  /**
   * Findings **about** this candidate — everything learned after it was proposed.
   *
   * The proposing claims say why somebody thought this node existed. They are written
   * before anything has read it, so on their own they can never say the profile turned out
   * to belong to a different person. That is the whole point of fetching, and a disposition
   * that cannot be revised by what the fetch found is not evidence-driven, it is a first
   * impression with a loop around it.
   *
   * `Finding.entityId` is content-addressed with the same formula as `EntityCandidate.id`,
   * so a run pointed at a candidate as a provisional subject writes findings that already
   * carry its id. Nothing has to be threaded through; they just have to be read.
   */
  evidence: readonly Finding[] = []
): RelevanceRow {
  const attrs = c.attrs as { platform?: unknown; handle?: unknown; displayName?: unknown; url?: unknown }
  const platform = typeof attrs.platform === 'string' ? attrs.platform : null
  const handle = typeof attrs.handle === 'string' ? attrs.handle : null

  const stated: StatedFields = emptyStatedFields()
  if (c.kind === 'person') stated.displayNames.push(c.label || c.value)
  if (c.kind === 'location') stated.locations.push(c.label || c.value)
  if (c.kind === 'organisation') stated.locations.push(c.label || c.value)
  if (typeof attrs.displayName === 'string' && attrs.displayName.trim()) {
    stated.displayNames.push(attrs.displayName.trim())
  }
  // Everything the proposing findings said about it, plus everything a later run reading it
  // said, folded into one text so a name or a location printed in a claim is visible to the
  // scorer as well.
  const claimText = [...c.claims.map((cl) => cl.claim), ...evidence.map((f) => f.claim)].join('\n')
  const fromClaims = statedFields(claimText)
  for (const key of ['displayNames', 'locations', 'genders', 'countries', 'created'] as const) {
    for (const v of fromClaims[key]) if (!stated[key].includes(v)) stated[key].push(v)
  }
  for (const n of fromClaims.ages) if (!stated.ages.includes(n)) stated.ages.push(n)

  return {
    text: `${c.label}\n${c.value}\n${claimText}`,
    source: c.claims[0]?.source ?? evidence[0]?.source ?? platform ?? '',
    platform,
    handle,
    // An account the operator seeded himself, rediscovered by a tool. `EntityCandidate.id`
    // is content-addressed with the same formula as `entityId`, so equality of the value
    // is equality of the thing.
    anchored: seeds.accounts.includes(c.value),
    stated
  }
}

/* ------------------------------------------------------------------ *
 * Sorting and grouping
 * ------------------------------------------------------------------ */

export interface Ranked<T> {
  item: T
  relevance: RelevanceAssessment
}

/**
 * Rank a list, best first, with a stable tiebreak.
 *
 * The tiebreak matters more than it looks: without it a background run appending one
 * proposal reshuffles equal-scoring rows under the pointer. `key` is asked for rather than
 * derived so the caller can pick something that does not change — a finding id, a
 * candidate value.
 */
export function rankBy<T>(
  items: readonly T[],
  score: (item: T) => RelevanceAssessment,
  key: (item: T) => string
): Ranked<T>[] {
  return items
    .map((item) => ({ item, relevance: score(item) }))
    .sort(
      (a, b) =>
        BAND_ORDER[a.relevance.band] - BAND_ORDER[b.relevance.band] ||
        b.relevance.score - a.relevance.score ||
        key(a.item).localeCompare(key(b.item))
    )
}

const BAND_ORDER: Record<RelevanceBand, number> = {
  anchor: 0,
  supported: 1,
  silent: 2,
  questioned: 3,
  contradicted: 4
}

export interface BandGroup<T> {
  band: RelevanceBand
  items: Ranked<T>[]
}

/** Group a ranked list by band, in band order. Empty bands are omitted. */
export function groupByBand<T>(ranked: readonly Ranked<T>[]): BandGroup<T>[] {
  const by = new Map<RelevanceBand, Ranked<T>[]>()
  for (const r of ranked) {
    const list = by.get(r.relevance.band) ?? []
    list.push(r)
    by.set(r.relevance.band, list)
  }
  return RELEVANCE_BANDS.filter((b) => by.has(b)).map((band) => ({ band, items: by.get(band)! }))
}

/**
 * The one line a collapsed `contradicted` group shows.
 *
 * A count and a reason, never a bare count. "4 hidden" tells the operator nothing about
 * whether to look; "4 rows state a different personal name" tells him exactly whether to,
 * and makes the group's contents predictable before he expands it.
 */
export function contradictionSummary(items: readonly Ranked<unknown>[]): string {
  if (!items.length) return ''
  const counts = new Map<string, number>()
  for (const r of items) {
    const first = r.relevance.signals.find((s) => s.verdict === 'conflicts' && s.weight === 'strong')
    const label =
      first?.id === 'gender-conflict'
        ? 'read as the other gender'
        : first?.id === 'name-conflict'
          ? 'carry a different personal name'
          : 'state something that disagrees with your seeds'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} ${label}`)
  return `${items.length} row${items.length === 1 ? '' : 's'} set aside: ${parts.join(', ')}. Nothing is deleted — expand to read every one and the rule that put it here.`
}

/* ------------------------------------------------------------------ *
 * Convenience: score a whole case's worth of findings
 * ------------------------------------------------------------------ */

export function rankFindings(
  findings: readonly Finding[],
  seeds: SeedContext,
  ctx: FindingRowContext,
  options?: ScoreOptions
): Ranked<Finding>[] {
  return rankBy(
    findings,
    (f) => assessRelevance(rowFromFinding(f, ctx), seeds, options),
    (f) => f.id
  )
}

export function rankCandidates(
  candidates: readonly CandidateView[],
  seeds: SeedContext,
  options?: ScoreOptions,
  /**
   * Findings **about** each candidate, keyed by node id — everything learned after it was
   * proposed. Optional because the review queue scores a case that has fetched nothing;
   * the engine passes it, so a probe that reads a different person's profile can flip the
   * node to `contradicted` on the next pass instead of leaving the first impression to
   * stand.
   */
  evidence?: ReadonlyMap<string, readonly Finding[]>
): Ranked<CandidateView>[] {
  return rankBy(
    candidates,
    (c) => assessRelevance(rowFromCandidate(c, seeds, evidence?.get(c.id) ?? []), seeds, options),
    (c) => c.value
  )
}

export { unscored }

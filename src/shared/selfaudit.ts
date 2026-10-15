/**
 * Self-Audit — the shape of the thing, shared by main and renderer.
 *
 * This file is deliberately separate from `ipc.ts`: the self-audit is the one feature
 * whose vocabulary is a domain model rather than a transport, and putting it here means
 * the engine in `src/main/selfaudit/` and the views in the renderer cannot drift.
 *
 * Three ideas run through everything below, and all three come straight from DECISIONS.md
 * and PRODUCT.md:
 *
 *  1. **Each level is its own case folder.** Not a filter over one case. Five folders,
 *     five seed sets, five independent runs — because the question is what a *given*
 *     starting knowledge yields, and a filter over a shared graph would leak L4's
 *     discoveries into L0's answer.
 *  2. **The delta is the product.** The totals are context. What matters is which single
 *     added fact unlocked the biggest jump, and that has to read as a causal sentence,
 *     not as a count.
 *  3. **"Could not check" is never "nothing found."** holehe is rate-limited into
 *     uselessness from most home IPs and Reddit answers 403 to anything unauthenticated.
 *     A self-audit that renders a refusal as an absence gives false comfort, which is
 *     worse than giving none.
 */

import type { NameMatchRule, NameMatchStrength } from './names'
import type { Confidence, EntityKind, IsoTimestamp, JobState } from './types'

/* ------------------------------------------------------------------ *
 * The seed profile
 * ------------------------------------------------------------------ */

export type SeedFieldId =
  | 'usernames'
  | 'emails'
  | 'domains'
  | 'names'
  | 'cities'
  | 'schools'
  | 'phones'
  | 'family'

export type SelfAuditLevel = 0 | 1 | 2 | 3 | 4

export const SELF_AUDIT_LEVEL_VALUES: readonly SelfAuditLevel[] = [0, 1, 2, 3, 4] as const

export interface SeedField {
  id: SeedFieldId
  /** What each value becomes when it is materialised into a level's case. */
  kind: EntityKind
  label: string
  /**
   * Two concrete examples, one per line, shown as the placeholder.
   *
   * Two rather than one, and that is the whole point of them: the field takes a list and
   * nothing else on screen says so loudly enough. The operator read a single-line
   * placeholder as a single-value field, entered one username and assumed that was the
   * limit — which quietly made every level below L1 an audit of one handle instead of all
   * of his. A second line in the ghost text is the cheapest possible way to say "these
   * stack", and it is visible at exactly the moment he is deciding what to type.
   */
  hint: string
  /** Singular noun for the live count under the field: "2 usernames". */
  unit: string
  /** One line: what this field actually buys an adversary. Shown under the input. */
  buys: string
  /** The level at which this field enters the seed set. Cumulative from there up. */
  level: SelfAuditLevel
  /**
   * For a list field whose **first** value enters at `level` and whose **remaining**
   * values enter later: the level the rest arrive at.
   *
   * Only `usernames` uses it, and it is the whole shape of the ladder's first two rungs.
   * DECISIONS.md defines L0 as *one* username and L1 as *all known* usernames, and that
   * split is not decoration — the single delta the product exists to demonstrate is
   * **handle reuse across your own accounts**, and a reused handle can only show up as a
   * jump if the rung below it held one handle. Putting the whole list at L0 folded that
   * finding inside the baseline, where it has no rung to appear on and inflates every
   * total measured against it.
   *
   * The first value in the field is the primary. That is the operator's own ordering —
   * the vault preserves the order he typed — and it is the same rule
   * `buildLetterDefaults` already uses for picking one handle out of a list.
   */
  fullLevel?: SelfAuditLevel
  /**
   * True for a field whose absence does not make its level incomplete.
   *
   * Only `domains` is optional, and it is the one field not named in the ladder the
   * operator has already read. Plenty of people own no domain, and reporting L1 as
   * "missing domains" forever would make a complete level look unfinished.
   */
  optional?: boolean
}

/**
 * The eight fields, and the level each enters at.
 *
 * The ladder: L0 **one** username, L1 + the rest of your usernames and your email, L2 +
 * real name, L3 + city and school, L4 + phone and family names.
 *
 * The username rung is split across L0 and L1 rather than landing whole at L0. See
 * `SeedField.fullLevel` for why: with the whole list at L0, handle reuse — the one finding
 * DECISIONS.md names as the product — has no rung to appear on.
 *
 * `domains` is the one addition, and it rides along at L1 rather than getting a rung of
 * its own. A personal domain is almost always discovered *through* an address (or is the
 * address's own domain), so putting it anywhere else would model an adversary who found
 * the domain before knowing you had one. The UI says this out loud rather than hiding it.
 */
export const SEED_FIELDS: readonly SeedField[] = [
  {
    id: 'usernames',
    kind: 'username',
    label: 'Usernames',
    hint: 'torvalds\nlinus.torvalds',
    unit: 'username',
    buys: 'The whole username sweep. Every handle you have reused is a link between two accounts that were meant to be separate — which is why only the first one goes into L0, and the rest arrive at L1 where the reuse can show up as a jump.',
    level: 0,
    fullLevel: 1
  },
  {
    id: 'emails',
    kind: 'email',
    label: 'Email addresses',
    hint: 'name@example.com\nname.work@example.org',
    unit: 'address',
    buys: 'Account-existence oracles and breach lookups. An address is near-unique to one person, where a handle collision can be coincidence.',
    level: 1
  },
  {
    id: 'domains',
    kind: 'domain',
    label: 'Domains you own or use',
    hint: 'example.com\nexample.dev',
    unit: 'domain',
    buys: 'Subdomain enumeration, certificate transparency and the archive. Seeded at L1 with the addresses, because a personal domain is normally found through one. Optional — plenty of people own none.',
    level: 1,
    optional: true
  },
  {
    id: 'names',
    kind: 'person',
    label: 'Real name',
    hint: 'Linus Torvalds\nLinus B. Torvalds',
    unit: 'name',
    buys: 'Attribution. It does not make a new tool runnable; it decides which of the accounts already found are yours rather than a stranger with your handle.',
    level: 2
  },
  {
    id: 'cities',
    kind: 'location',
    label: 'City',
    hint: 'Sofia\nPlovdiv',
    unit: 'city',
    buys: 'Confirmation of a profile location field, and a discriminator between two people with the same name.',
    level: 3
  },
  {
    id: 'schools',
    kind: 'organisation',
    label: 'School or employer',
    hint: 'Example High School\nExample Ltd',
    unit: 'school or employer',
    buys: 'The same: it turns an unattributed bio line into a match. This is what a classmate has that a stranger does not.',
    level: 3
  },
  {
    id: 'phones',
    kind: 'phone',
    label: 'Phone numbers',
    hint: '+359 88 000 0000\n+44 20 0000 0000',
    unit: 'number',
    buys: 'The recovery graph. A number that recovers several accounts is the single highest-leverage thing on this page.',
    level: 4
  },
  {
    id: 'family',
    kind: 'person',
    label: 'Family names',
    hint: 'Anna Example\nPetar Example',
    unit: 'name',
    buys: 'A second attribution axis. A shared surname in a follower list is how an anonymous account gets tied to a household.',
    level: 4
  }
] as const

export interface SelfAuditLevelSpec {
  level: SelfAuditLevel
  code: string
  /** The line the empty state already shows: `username`, `+ email`, … */
  adds: string
  /** Who this level models. */
  simulates: string
  /** Fields that enter *at* this level. Cumulative sets come from `fieldsUpTo`. */
  fields: SeedFieldId[]
  /**
   * List fields whose first value entered lower down and whose remaining values arrive
   * here. Only L1 has one — see `SeedField.fullLevel`.
   *
   * Kept separate from `fields` because the two answer different questions: `fields` says
   * what this level *needs* before it can run (and drives `missingFor`), while this says
   * what it *gains* from a field the level below already had.
   */
  completes?: SeedFieldId[]
}

export const SELF_AUDIT_LEVELS: readonly SelfAuditLevelSpec[] = [
  {
    level: 0,
    code: 'L0',
    adds: 'one username',
    simulates: 'A stranger who saw you on one platform and nothing else.',
    fields: ['usernames']
  },
  {
    level: 1,
    code: 'L1',
    // Kept to the length of the longest other rung: the rail truncates with an ellipsis at
    // five across, and "+ your other u…" would say less than nothing.
    adds: '+ more handles, email',
    simulates:
      'Someone who has seen you across a few communities, or has had contact with you — a mailing list, a marketplace, a form.',
    fields: ['emails', 'domains'],
    completes: ['usernames']
  },
  {
    level: 2,
    code: 'L2',
    adds: '+ real name',
    simulates: 'Anyone who has met you once and remembers your name.',
    fields: ['names']
  },
  {
    level: 3,
    code: 'L3',
    adds: '+ city, school',
    simulates: 'A classmate. Someone who knows where you spend your days.',
    fields: ['cities', 'schools']
  },
  {
    level: 4,
    code: 'L4',
    adds: '+ phone, family names',
    simulates: 'A determined acquaintance. Roughly what an ex, a relative or a hostile classmate already holds.',
    fields: ['phones', 'family']
  }
] as const

export function levelSpec(level: SelfAuditLevel): SelfAuditLevelSpec {
  const found = SELF_AUDIT_LEVELS.find((l) => l.level === level)
  if (!found) throw new Error(`No such self-audit level: ${String(level)}`)
  return found
}

/**
 * Every field that contributes *anything* at or below `level`. Cumulative by definition.
 *
 * Field-level, not value-level: `usernames` is in the L0 set because L0 gets one of them.
 * How many values of a field a level is entitled to is `seedLevelOfValue`'s question, and
 * `seedsForLevel` in `main/selfaudit/vault.ts` is the only place that answers it.
 */
export function fieldsUpTo(level: SelfAuditLevel): SeedFieldId[] {
  return SEED_FIELDS.filter((f) => f.level <= level).map((f) => f.id)
}

/**
 * The level at which the value at `index` of a field's list enters.
 *
 * The first value of a split field enters at `field.level`; every later one waits for
 * `field.fullLevel`. Every other field returns `field.level` for every index, which is
 * what makes this safe to call unconditionally.
 */
export function seedLevelOfValue(field: SeedField, index: number): SelfAuditLevel {
  return index === 0 ? field.level : (field.fullLevel ?? field.level)
}

export function seedField(id: SeedFieldId): SeedField {
  const f = SEED_FIELDS.find((x) => x.id === id)
  if (!f) throw new Error(`No such seed field: ${id}`)
  return f
}

/**
 * What the operator knows about himself.
 *
 * This is real personal data. It lives in one file under the cases directory and is
 * handed out one level at a time — a level's case folder only ever receives the fields
 * that level is entitled to, which is the property that makes L0 an honest simulation of
 * a stranger rather than a filtered view of everything.
 */
export interface SelfAuditProfile {
  values: Record<SeedFieldId, string[]>
  updatedAt: IsoTimestamp | null
}

export function emptyProfile(): SelfAuditProfile {
  return {
    values: {
      usernames: [],
      emails: [],
      domains: [],
      names: [],
      cities: [],
      schools: [],
      phones: [],
      family: []
    },
    updatedAt: null
  }
}

/* ------------------------------------------------------------------ *
 * Checks — the honesty layer
 * ------------------------------------------------------------------ */

/**
 * What happened when one adapter was pointed at one seed.
 *
 * `no-answer` and `answered-none` are the two the whole feature turns on, and they are
 * deliberately different values:
 *
 *  - `answered-none` — the tool asked and the sites replied "no account here".
 *  - `no-answer`     — the tool asked and got refused: rate limits, 403s, bot walls.
 *
 * Collapsing the second into the first is the mistake that makes a self-audit dangerous,
 * because it reads as reassurance. Nothing in this codebase may render them the same.
 */
export type CheckOutcome =
  | 'answered'
  | 'answered-none'
  | 'partial'
  | 'no-answer'
  | 'failed'
  | 'unavailable'
  | 'skipped'

export const CHECK_OUTCOME_LABEL: Record<CheckOutcome, string> = {
  answered: 'answered',
  'answered-none': 'answered — nothing there',
  partial: 'partly answered',
  'no-answer': 'could not check',
  failed: 'failed',
  unavailable: 'not installed',
  skipped: 'not run'
}

/** True when this outcome says nothing whatsoever about the subject. */
export function isSilent(outcome: CheckOutcome): boolean {
  return outcome === 'no-answer' || outcome === 'failed' || outcome === 'unavailable' || outcome === 'skipped'
}

export interface CheckCoverage {
  /** Targets that gave a usable answer, either way. */
  answered: number
  /** Targets that refused: rate limit, block, bot wall, timeout. */
  refused: number
  total: number
}

export interface SelfAuditCheck {
  adapterId: string
  adapterTitle: string
  entityId: string | null
  entityKind: EntityKind | null
  entityLabel: string | null
  outcome: CheckOutcome
  /** Plain English, in the tool's own terms. Never a euphemism for "nothing found". */
  detail: string
  jobId: string | null
  jobState: JobState | null
  findingIds: string[]
  /** Present only when the tool counted its own targets. Never estimated. */
  coverage: CheckCoverage | null
  /**
   * The entity kinds this adapter accepts, as the registry described them at run time.
   *
   * Recorded so a later delta can ask the only question that makes "the seed unlocked
   * this tool" true: did *none* of its accepted kinds exist at the level below, and does
   * at least one exist here? Without it the delta can only see that an adapter has a job
   * now and did not before — which is equally true of a tool the operator deselected
   * below, a binary installed between runs, and a registry that changed.
   *
   * Optional: snapshots written before this field exists have none, and a reader that
   * finds it absent must fall back to the weaker `entityKind` test rather than assume.
   */
  adapterAccepts?: EntityKind[]
}

/* ------------------------------------------------------------------ *
 * Snapshots — what one run of one level saw
 * ------------------------------------------------------------------ */

export interface SnapshotSeed {
  entityId: string
  kind: EntityKind
  value: string
  label: string
  field: SeedFieldId
  /** The level at which this seed entered. Not necessarily the snapshot's own level. */
  level: SelfAuditLevel
}

export interface SnapshotFinding {
  id: string
  entityId: string
  source: string
  /** `independenceKey(source)` — the corroboration key, precomputed for the diff. */
  sourceKey: string
  tool: string
  claim: string
  confidence: Confidence
  firstSeen: IsoTimestamp
  lastVerified: IsoTimestamp | null
  /**
   * Where this finding's unparsed capture sits, relative to the case folder. Carried so a
   * later reader — the reset-path map, the coverage classifier — can re-derive from the
   * bytes rather than from the claim string. The renderer has no filesystem; it treats
   * this as an opaque label, exactly as it already does for `Finding.raw.path`.
   */
  rawPath: string
  /**
   * True when `source` is `local:<adapter>` — a derived claim about the *run*, not about
   * the subject. These are the run notes ("120 of 122 sites refused") and they must never
   * be counted alongside claims about the person.
   */
  derived: boolean
  /**
   * True when **this run** actually re-observed this claim.
   *
   * A level's case folder is reused on every re-run and `upsertFinding` never removes:
   * `findings.jsonl` is the level's whole history, not its present. Without this flag a
   * snapshot's finding set is a superset of the previous snapshot's by construction, so
   * the re-scan's `disappeared` bucket is **structurally always empty** and the operator
   * who deleted an account three weeks ago is told nothing changed. The set of findings a
   * run touched is carried out of the run itself (the orchestrator hands back the finding
   * ids each job produced), so this is observation, not inference from a clock.
   *
   * Optional because a snapshot is a file read back months later. Absent means the
   * snapshot predates the flag, and a reader must then fall back to treating every
   * finding as observed — which is exactly the old behaviour, and never a claim the old
   * file does not support.
   */
  observedThisRun?: boolean
  /**
   * True when the entity this claim is about no longer exists in the case.
   *
   * `deleteEntity` orphans findings rather than deleting them — the observation happened
   * and its raw capture is permanent. But after an explicit purge (`removeSeed` with
   * `purgeCases`) the operator has said he wants that seed gone, and counting what it
   * produced as current exposure, while `snapshot.seeds` no longer names the seed that
   * caused it, is a claim with no visible cause. Orphans get their own section and are
   * excluded from the counts and from remediation reach.
   */
  orphaned?: boolean
}

export interface SnapshotAccount {
  /** `platform/handle`, the same canonical form an `account` entity uses. */
  key: string
  platform: string
  handle: string
  url: string | null
  /** `entity` once a human promoted it; `candidate` while it is still a proposal. */
  state: 'entity' | 'candidate'
  confidence: Confidence
  independentSources: number
  tools: string[]
  findingIds: string[]
}

/**
 * A finding whose text contains a value seeded at some level.
 *
 * This is the mechanism behind L2–L4. Those levels add no new *tools* — nothing in the
 * toolbelt accepts a person, a city or a school — but they add the ability to say which
 * of the accounts already found is yours. A display name on a profile is anonymous until
 * you know the name; then it is attribution.
 *
 * **Every one of these is a lead, never a fact — and some are much weaker leads than
 * others.** A name is matched across scripts, across nicknames and across partial forms
 * (see `shared/names.ts`), because that is how names are actually written; the price of
 * that recall is that a `Chris` is not a `Christian` and a `Гошо` is not proof of a
 * `Георги`. So every attribution carries the rule that produced it and the weight that
 * rule earns, and the UI is required to render them differently. A fuzzy hit may never
 * appear at the weight of a literal one.
 */
export interface SeedAttribution {
  findingId: string
  field: SeedFieldId
  seedValue: string
  level: SelfAuditLevel
  where: 'claim' | 'raw'
  excerpt: string
  /**
   * Which matcher rule fired, how much it is worth, and one phrase naming the mechanism
   * ("diminutive: Сашо → Александър").
   *
   * Optional because a snapshot is a **file on disk that is read back months later**, and
   * every snapshot written before these three fields existed has an attribution without
   * them. A reader that finds them absent knows only that the match was made by the older
   * literal matcher; it must not invent a strength for it. Never make these required —
   * that would be a claim about the disk format that the disk does not honour.
   */
  rule?: NameMatchRule
  strength?: NameMatchStrength
  why?: string
  /**
   * The site that said it — **only for a `claim` match**, and empty for a `raw` one.
   *
   * A raw capture is one file per run covering every site the tool touched, so a match
   * inside it cannot be attributed to a particular site without parsing the tool's format
   * a second time. Naming the site the anchoring finding happened to be about would put a
   * hostname next to a sentence that hostname never said, which is the precise kind of
   * quiet fabrication this app exists to avoid. So a raw match names the tool and nothing
   * else, and the UI renders it that way.
   */
  sourceKey: string
  /** The adapter whose capture or claim this was found in. Always present. */
  tool: string
}

export interface SnapshotCounts {
  /**
   * Findings that assert something about the subject. Excludes run telemetry, and
   * excludes claims left behind by a seed the operator purged — those are reported in
   * their own section rather than counted as current exposure.
   */
  claims: number
  /**
   * Claims this run actually re-observed, and claims left behind by a purged seed.
   *
   * Both optional for the same reason `SeedAttribution`'s matcher fields are: a snapshot
   * is a file on disk read back months later, and one written before these existed says
   * nothing about them. A reader that finds them absent knows only that the snapshot
   * predates the distinction — it must not invent a number.
   */
  observedClaims?: number
  orphanedClaims?: number
  /** Derived `local:` findings: what the run itself reported about how it went. */
  telemetry: number
  accounts: number
  /** Distinct `independenceKey(source)` values across the claims. */
  sources: number
  /** Checks whose outcome says nothing about the subject. */
  silentChecks: number
}

export interface SelfAuditSnapshot {
  id: string
  level: SelfAuditLevel
  caseId: string
  at: IsoTimestamp
  seeds: SnapshotSeed[]
  checks: SelfAuditCheck[]
  findings: SnapshotFinding[]
  accounts: SnapshotAccount[]
  attributions: SeedAttribution[]
  counts: SnapshotCounts
}

/** The parts of a snapshot cheap enough to list without loading the whole file. */
export interface SnapshotRef {
  id: string
  level: SelfAuditLevel
  caseId: string
  at: IsoTimestamp
  counts: SnapshotCounts
}

/* ------------------------------------------------------------------ *
 * The delta — the actual product
 * ------------------------------------------------------------------ */

export interface DeltaSource {
  sourceKey: string
  findings: SnapshotFinding[]
  /** The seed the run that produced these was pointed at, when it can be named. */
  viaSeed: SnapshotSeed | null
}

export interface ConfidenceMove {
  findingId: string
  claim: string
  sourceKey: string
  from: Confidence
  to: Confidence
}

export interface SelfAuditDelta {
  from: SnapshotRef | null
  to: SnapshotRef
  /**
   * Seeds present in `to`, absent from `from`, and **belonging to a field this level
   * actually introduces**. The candidate causes, and only those.
   */
  addedSeeds: SnapshotSeed[]
  /**
   * Seeds new to the snapshot that belong to a *lower* level's entitlement.
   *
   * `addedSeeds` is a diff of two snapshots, not of two entitlements: run L0, add two
   * usernames, run L1, and those L0-level handles are new-to-the-diff. Crediting L1 with
   * them would answer "which single fact unlocked the biggest jump" with the wrong fact.
   * They mean the lower snapshot is **stale**, which is a blocking caveat and never part
   * of the causal sentence.
   */
  staleSeeds: SnapshotSeed[]
  /**
   * Sites that answered at `to`, were not represented at `from`, **and whose tool was
   * able to speak at `from`**. The only ones the headline may count.
   */
  newReach: DeltaSource[]
  /**
   * Sites new at `to` whose producing tool was silent or only partly answered at `from`.
   *
   * Not "newly findable" — not comparable. A tool that was rate-limited below and got
   * through here reached nothing the seed opened; it reached what the level below was
   * refused. Kept out of the headline count and reported as its own row.
   */
  incomparableReach: DeltaSource[]
  /** Sites represented at `from` and silent at `to`. Often a rate limit, not a removal. */
  lostReach: DeltaSource[]
  newAccounts: SnapshotAccount[]
  goneAccounts: SnapshotAccount[]
  promoted: ConfidenceMove[]
  demoted: ConfidenceMove[]
  /**
   * Adapters that ran at `to`, did not run at `from`, and could not have run at `from`:
   * none of the kinds they accept existed there, and at least one does here. That is the
   * only shape under which "the seed made this tool runnable" is a true sentence.
   */
  newlyRunnable: SelfAuditCheck[]
  /**
   * Adapters that ran at `to` and not at `from` for some reason **other** than the seed:
   * the operator deselected them below, the binary was installed since, the registry
   * moved. A hole the operator chose is still a hole, but it is not the seed's doing and
   * it never reaches the headline.
   */
  runnableForOtherReasons: SelfAuditCheck[]
  /** Findings that the newly added seeds made attributable. */
  attributions: SeedAttribution[]
  /**
   * The one sentence. A specific causal claim naming the seed and what it connected —
   * never a count on its own.
   */
  headline: string
  /** The evidence the headline rests on, so the claim can be checked rather than trusted. */
  headlineBasis: string[]
  /** Where this comparison is weaker than it looks. Never empty. */
  caveats: string[]
}

/* ------------------------------------------------------------------ *
 * The exposure report
 * ------------------------------------------------------------------ */

/**
 * One site, and everything this level's run learned about it.
 *
 * There is deliberately **no `independentSources` here**, and its absence is the honest
 * answer rather than an omission. An appearance is grouped *by* `independenceKey(source)`,
 * so every finding in it comes from the same origin by construction and the count could
 * only ever be 1 — a field named "independent sources" that can never say anything, in a
 * codebase whose entire confidence model turns on that number. `tools` is the real
 * question at this level: two tools reading the same site are one source agreeing with
 * itself, which is exactly what corroboration is not. Independence lives on
 * `SnapshotAccount`, where it is computed across origins and means something.
 */
export interface Appearance {
  sourceKey: string
  platform: string
  handles: string[]
  urls: string[]
  confidence: Confidence
  tools: string[]
  findingIds: string[]
  /** Attributed to you by a seed match, rather than merely by a handle collision. */
  attributed: boolean
}

/**
 * One thing to do, ordered by how much it actually disconnects.
 *
 * `reach` is a count of the things this action touches, and it is the ordering key. It is
 * rendered as the fact it is ("breaks the link between 6 accounts"), never as a score out
 * of ten and never with a colour bar. PRODUCT.md: the findings carry their own weight.
 */
export interface RemediationItem {
  id: string
  kind: 'recovery-hub' | 'handle-reuse' | 'account' | 'address-reuse' | 'archive' | 'unchecked'
  /** Imperative, specific, and something he can start now. */
  action: string
  /** What it disconnects, concretely. */
  effect: string
  /**
   * How many things this action touches — and the sole ordering key, so it may only ever
   * count things that survive scrutiny: a platform backed by a promoted entity, or by two
   * independent sources. A single anti-bot 200 is not a site that uses your handle.
   */
  reach: number
  /**
   * Candidates behind the same action that rest on one tool hit and nobody's judgement.
   *
   * Reported beside `reach` and never folded into it. A Sherlock sweep over a common
   * handle returns tens of 200s from anti-bot pages; stating that number as fact and then
   * ordering the page by it is how a report ends up recommending its own noise.
   */
  unverifiedReach: number
  effort: 'minutes' | 'an evening' | 'weeks of waiting'
  targets: string[]
  evidence: string[]
  /** The strength of the evidence under this recommendation. */
  confidence: Confidence
  /** Why this might be wrong, or nothing. */
  caveat: string | null
}

export interface ResetPathEdge {
  fromKind: 'email' | 'phone'
  /** A seeded address/number, or the masked hint the site returned. */
  fromValue: string
  masked: boolean
  platform: string
  handle: string | null
  /** The flow that answered: password recovery, registration, login. holehe's own word. */
  mechanism: string
  /**
   * - `observed`   — the site itself said an account exists for this address.
   * - `consistent` — a masked hint is consistent with a value you seeded. Not proof.
   */
  status: 'observed' | 'consistent'
  evidenceFindingIds: string[]
  note: string
  /**
   * When the capture behind this edge was taken.
   *
   * Without it an edge drawn from a three-week-old holehe run is rendered exactly like one
   * drawn from today's, and survives deduplication even when today's run was rate-limited
   * on the same site — so the same platform appears once as a confirmed recovery path and
   * once in `unchecked`. The newest capture per (address, platform) wins, and an edge that
   * is not from the newest run says its date in the note.
   *
   * Optional: maps rebuilt from a snapshot written before this existed carry no date, and
   * a reader must render such an edge without one rather than assume it is current.
   */
  observedAt?: IsoTimestamp
}

export interface ResetPathHub {
  kind: 'email' | 'phone'
  value: string
  platforms: string[]
  /** Edges where the site returned a mask consistent with this value, not a certainty. */
  inferred: number
}

export interface ResetPathMap {
  edges: ResetPathEdge[]
  hubs: ResetPathHub[]
  /** Sites the oracle could not reach a verdict on. No edge is drawn for these. */
  unchecked: { platform: string; reason: string; tool: string }[]
  /** Multi-step recovery routes, spelled out. Only drawn where every step has evidence. */
  chains: { steps: string[]; note: string; evidenceFindingIds: string[] }[]
  /** True when the run that produced this was too rate-limited to mean much. */
  degraded: boolean
  degradedNote: string | null
}

export interface ExposureReport {
  caseId: string
  level: SelfAuditLevel
  at: IsoTimestamp
  snapshotId: string
  appearances: Appearance[]
  /** Checks that said nothing. Rendered before the findings, never after them. */
  unchecked: SelfAuditCheck[]
  /** The `local:` run notes, verbatim, in the tools' own words. */
  telemetry: SnapshotFinding[]
  /**
   * Claims left behind by a seed the operator purged out of this case.
   *
   * Their own section, and out of every count above. The observation happened and its
   * capture is permanent, but nothing in this snapshot still names the seed that caused
   * it — so it cannot be read as current exposure, and it cannot be allowed to order a
   * remediation list.
   */
  orphaned: SnapshotFinding[]
  remediation: RemediationItem[]
  resetPaths: ResetPathMap
}

/* ------------------------------------------------------------------ *
 * Re-scan
 * ------------------------------------------------------------------ */

export interface RescanDiff {
  level: SelfAuditLevel
  caseId: string
  previous: SnapshotRef
  current: SnapshotRef
  appeared: SnapshotFinding[]
  disappeared: SnapshotFinding[]
  stillThere: number
  /**
   * A disappearance that is explained by the tool having been refused this time. This is
   * the difference between "the removal request worked" and "we could not look".
   */
  unexplained: SnapshotFinding[]
  explainedBySilence: { finding: SnapshotFinding; because: string }[]
  verdict: string
}

/* ------------------------------------------------------------------ *
 * GDPR letters
 * ------------------------------------------------------------------ */

export type GdprArticle = 'erasure' | 'objection'
export type GdprLang = 'bg' | 'en'

export interface PlatformContact {
  key: string
  name: string
  /** The EU/EEA establishment that is the controller for an EU data subject, when known. */
  controller: string | null
  email: string | null
  form: string | null
  postal: string | null
  /** Anything specific about how this platform actually handles requests. */
  note: string
  /**
   * Always false. Every contact here was transcribed from a published privacy policy at
   * a moment in time, and privacy contacts move. The UI says so beside every letter.
   */
  verified: false
}

export interface GdprLetterRequest {
  /** A platform key from the contact book, or a bare host the report turned up. */
  platform: string
  article: GdprArticle
  lang: GdprLang
  /** The handle on that platform, when there is one. */
  handle?: string
  /** The address the account is registered to. */
  email?: string
  fullName?: string
  postalAddress?: string
  /** Adds the Art. 17(1)(f) / Art. 8 clause for data collected from a child. */
  minorWhenCreated?: boolean
  /** Objection letters only: name AI/model training explicitly. */
  includeAiTraining?: boolean
  /** Anything the operator wants to add, verbatim. */
  extra?: string
}

export interface GdprLetter {
  subject: string
  body: string
  contact: PlatformContact | null
  /** The KZLD escalation paragraph, in the same language. */
  escalation: string
  /** Missing details, stale-contact reminders. Shown above the letter, never inside it. */
  warnings: string[]
}

export interface SavedLetter {
  path: string
  bytes: number
}

/**
 * The operator's own details, taken from the vault, for pre-filling a letter.
 *
 * The first value of each field. A controller identifies an account by one handle and one
 * address, and a letter listing four of each invites a reply asking which one — so this
 * picks the first and leaves the rest to be edited in.
 */
export function buildLetterDefaults(profile: SelfAuditProfile): {
  handle?: string
  email?: string
  fullName?: string
} {
  const first = (id: SeedFieldId): string | undefined => profile.values[id]?.[0]
  const out: { handle?: string; email?: string; fullName?: string } = {}
  const handle = first('usernames')
  const email = first('emails')
  const fullName = first('names')
  if (handle) out.handle = handle
  if (email) out.email = email
  if (fullName) out.fullName = fullName
  return out
}

/* ------------------------------------------------------------------ *
 * State the view renders
 * ------------------------------------------------------------------ */

export interface SelfAuditLevelState {
  level: SelfAuditLevel
  code: string
  caseId: string | null
  /** Seeds this level would materialise from the current profile. */
  seedCount: number
  /** Fields this level needs that the profile does not have. */
  missing: SeedFieldId[]
  latest: SnapshotRef | null
  snapshotCount: number
}

export type RunPhase = 'seeding' | 'running' | 'analysing' | 'done' | 'failed' | 'cancelled'

export interface SelfAuditRunState {
  level: SelfAuditLevel
  caseId: string
  phase: RunPhase
  startedAt: IsoTimestamp
  finishedAt: IsoTimestamp | null
  planned: number
  finished: number
  /** Adapter + seed pairs in flight right now. */
  running: { adapterId: string; entityLabel: string }[]
  message: string
  error: string | null
  snapshotId: string | null
}

export interface SelfAuditState {
  profile: SelfAuditProfile
  hasProfile: boolean
  levels: SelfAuditLevelState[]
  run: SelfAuditRunState | null
  /** Where the profile is written. Shown in the UI so it can be deleted by hand. */
  vaultPath: string
}

/* ---------------------------------------------------- removing one seed */

/**
 * One level's case folder, as seen from a single seed value the vault holds.
 *
 * A vault value is materialised into an entity in every level entitled to it, so
 * removing the value from the vault is only half the job — the other half is the entity
 * that was created from it, which may by now have findings hanging off it. This says
 * which levels hold it and what is attached there, so the operator is told before
 * anything is deleted rather than after.
 */
export interface SeedUsageInCase {
  level: SelfAuditLevel
  code: string
  caseId: string
  caseName: string
  entityId: string
  /** Findings about that entity in that level's case. */
  findings: number
}

export interface SeedUsage {
  field: SeedFieldId
  value: string
  kind: EntityKind
  /** True when the vault still holds this value. */
  inVault: boolean
  cases: SeedUsageInCase[]
  /** Total findings across every level. Non-zero means the removal wants confirming. */
  findings: number
}

export interface RemoveSeedRequest {
  field: SeedFieldId
  value: string
  /**
   * Also take the materialised entity out of the level cases that still hold it.
   *
   * Off by default, and deliberately: the vault is the operator's typing and removing a
   * line from it should be as clean as never having typed it, but a level's case folder
   * is an audit trail with raw captures behind it. Deleting the seed there is a second,
   * separate decision, and it orphans whatever that seed produced.
   */
  purgeCases?: boolean
}

export interface SeedRemoval {
  field: SeedFieldId
  value: string
  profile: SelfAuditProfile
  /** Level cases the entity was deleted from, and how many findings that orphaned. */
  purged: { level: SelfAuditLevel; code: string; caseId: string; orphanedFindings: number }[]
  /** Level cases that still hold it, because `purgeCases` was not asked for. */
  kept: SeedUsageInCase[]
}

export interface SelfAuditRunRequest {
  level: SelfAuditLevel
  /**
   * Restrict the chain to these adapters. Omitted means every adapter that accepts a seed
   * kind this level holds. The view offers it because maigret's full sweep can run for a
   * quarter of an hour and is not always what you want at four in the morning.
   */
  adapterIds?: string[]
}

export interface PlannedRun {
  adapterId: string
  adapterTitle: string
  entityKind: EntityKind
  entityLabel: string
}

/**
 * What a level would do, before it does it.
 *
 * Worth showing rather than hiding, because it is where the operator first sees that L2
 * adds no tools — that no adapter in this build accepts a person, a city or a school. Read
 * before the run that is a fact about the toolbelt; read after it, it looks like a failure.
 */
export interface SelfAuditPlan {
  level: SelfAuditLevel
  caseId: string | null
  seeds: { kind: EntityKind; label: string; field: SeedFieldId }[]
  runs: PlannedRun[]
  unavailable: { adapterId: string; adapterTitle: string; reason: string }[]
  /**
   * Seed entities sitting in this level's case folder that the level is **no longer**
   * entitled to seed, and that the next run will therefore not re-seed — but that every
   * query builder in the case still welds into its queries, because they are still
   * `seed: true` in `entities.json`.
   *
   * Two ways to get one, and both are real. The operator removed a value from the vault
   * without purging the case (the documented default, so the level keeps using it — which
   * matters most when the value went into the wrong field). Or the ladder itself moved
   * underneath an old folder: L0 used to seed every username and now seeds one, so an L0
   * folder from before that change holds handles L0 may not have.
   *
   * Surfaced rather than silently corrected, because deleting from a case folder is an
   * audit-trail decision and belongs to the operator.
   */
  strayCaseSeeds: { entityId: string; kind: EntityKind; label: string }[]
}

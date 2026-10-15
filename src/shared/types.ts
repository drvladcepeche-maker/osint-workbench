/**
 * The data model. Everything in the app is expressed in these types.
 *
 * Three rules encoded here, in order of importance:
 *
 *  1. **A single tool hit is never better than `unverified`.** Sherlock/Maigret have a
 *     known, unsolved false-positive problem: sites answer anti-bot redirects with a 200
 *     and the matcher reads "account exists". If one tool could mint a `confirmed`
 *     finding, the whole case file would be poisoned by that class of bug. Promotion is
 *     therefore a separate, audited operation — see `src/shared/confidence.ts`.
 *  2. **Raw output is permanent.** `Finding.raw` points at a byte-for-byte copy of what
 *     the tool printed, kept on disk forever. A parser bug is then a re-parse, not data
 *     loss.
 *  3. **A case's declared `basis` is load-bearing, not decoration.** It decides whether
 *     an export may be published. See `isPublishableBasis`.
 *
 * Schema version is stamped into every `case.json` so migrations are possible later.
 */

import type { SubjectProfile } from './relevance'
// Type-only, and therefore erased: `engine.ts` imports the ids from this file, and a
// value-level cycle between the two would be a real problem. A hop's mechanism is part of
// a proposal's contract, so the word has to be spellable here.
import type { ProvenanceMechanism } from './engine'

export const SCHEMA_VERSION = 1

/* ------------------------------------------------------------------ *
 * Scalars
 * ------------------------------------------------------------------ */

/** ISO-8601 UTC, always with milliseconds and a trailing `Z`. */
export type IsoTimestamp = string

export type CaseId = string
export type EntityId = string
export type FindingId = string
export type EvidenceId = string
export type RawId = string
export type JobId = string

/* ------------------------------------------------------------------ *
 * Case
 * ------------------------------------------------------------------ */

/**
 * Why we are allowed to look. This is the app's legal spine.
 *
 * - `self`          — the subject is the operator.
 * - `consent`       — a real person who has explicitly agreed. `subjectConsent` must be true.
 * - `ctf-fictional` — an invented persona from a challenge set. No real subject exists.
 * - `public-entity` — a company, domain, or organisation. Not personal data.
 * - `training`      — a geolocation/verification drill. The subject is a place or an artifact.
 */
export type CaseBasis = 'self' | 'consent' | 'ctf-fictional' | 'public-entity' | 'training'

export const CASE_BASES: readonly CaseBasis[] = [
  'self',
  'consent',
  'ctf-fictional',
  'public-entity',
  'training'
] as const

/**
 * Bases whose exports may be published.
 *
 * `self` is excluded on purpose: publishing your own audit publishes your own personal
 * data, and it is the one report guaranteed to contain everything about you. `consent`
 * is excluded because consent to be *investigated* is not consent to be *published* —
 * publishing takes you out of the household exemption (Lindqvist, C-101/01) and makes
 * you a controller with Art. 14 notice duties.
 */
export const PUBLISHABLE_BASES: readonly CaseBasis[] = ['ctf-fictional', 'training', 'public-entity'] as const

export function isPublishableBasis(basis: CaseBasis): boolean {
  return PUBLISHABLE_BASES.includes(basis)
}

export interface Case {
  id: CaseId
  name: string
  basis: CaseBasis
  /**
   * Whether the subject has given explicit consent. Required to be `true` when
   * `basis === 'consent'`; meaningless (and forced to `false`) for the other bases,
   * where there is either no subject or the subject is the operator.
   */
  subjectConsent: boolean
  createdAt: IsoTimestamp
  notes: string
  /**
   * What the operator states about the subject beyond the seed entities: the gender the
   * subject reads as, an age band, the countries he lives in.
   *
   * Not entities, because none of them is a thing a tool can be pointed at — you cannot
   * run a username sweep against "male, 25 – 34, Bulgaria". They exist for one purpose:
   * `shared/relevance.ts` uses them to rank and to *contradict* what the tools bring back,
   * which is what turns a sweep over a common handle from fifty rows in arbitrary order
   * into a list with the plausible ones at the top and the impossible ones named as such.
   *
   * Optional, and absent on every case created before this existed. An absent subject
   * simply switches those signals off; it never makes a case invalid.
   */
  subject?: SubjectProfile
}

/** What lands in `cases/<id>/case.json`. */
export interface CaseFile extends Case {
  schemaVersion: number
  updatedAt: IsoTimestamp
}

/* ------------------------------------------------------------------ *
 * Entity
 * ------------------------------------------------------------------ */

export type EntityKind =
  | 'person'
  | 'username'
  | 'email'
  | 'phone'
  | 'domain'
  | 'ipaddr'
  | 'image'
  | 'account'
  | 'location'
  | 'organisation'

export const ENTITY_KINDS: readonly EntityKind[] = [
  'person',
  'username',
  'email',
  'phone',
  'domain',
  'ipaddr',
  'image',
  'account',
  'location',
  'organisation'
] as const

export function isEntityKind(x: unknown): x is EntityKind {
  return typeof x === 'string' && (ENTITY_KINDS as readonly string[]).includes(x)
}

interface EntityBase<K extends EntityKind, A> {
  id: EntityId
  caseId: CaseId
  /** Discriminant. */
  kind: K
  /**
   * The canonical value — lowercased, trimmed, normalised per kind (see
   * `src/shared/normalise.ts`). Entity identity is derived from
   * `(caseId, kind, value)`, so two adapters that find the same thing converge on one
   * entity instead of two.
   */
  value: string
  /** What a human should see. Defaults to the value as originally typed. */
  label: string
  createdAt: IsoTimestamp
  /**
   * `true`  — the operator supplied this as a starting point.
   * `false` — an adapter discovered it.
   *
   * This is the axis the self-audit's adversary levels (L0..L4) turn on: you vary the
   * seed set and measure how much more becomes discoverable.
   */
  seed: boolean
  /** Kind-specific extras. Always present, may be empty. */
  attrs: A
}

/** A natural person. `value` is the normalised full name. */
export type PersonEntity = EntityBase<
  'person',
  {
    fullName?: string
    givenName?: string
    familyName?: string
    aliases?: string[]
    /** ISO date `YYYY-MM-DD`, or a partial `YYYY` / `YYYY-MM`. */
    bornOn?: string
    nationality?: string
    /**
     * Who this person is *to the case*. Absent means the subject, or unstated.
     *
     * `relative` exists because the self-audit's L4 seeds family names as `person`
     * entities exactly like the subject's own name at L2, and everything downstream then
     * read the two as the same thing: the gender inference saw two seeded names that
     * disagreed and switched itself off, so L4 ranked *worse* than L2; the query builder
     * welded a relative's name to the subject's school and city and filed the hits under
     * the subject; and the delta announced that an account "carries your family names".
     * A shared surname in a follower list is a real and useful signal — it is just not
     * the subject's own name, and every one of those three needs to know the difference.
     */
    role?: 'subject' | 'relative'
  }
>

/** A handle, detached from any particular platform. `value` is the handle, lowercased. */
export type UsernameEntity = EntityBase<
  'username',
  {
    /** Where it was first seen, if known. A username that is bound to one platform is an `account`. */
    originPlatform?: string
    caseSensitiveForm?: string
  }
>

/** `value` is the normalised address, lowercased. */
export type EmailEntity = EntityBase<
  'email',
  {
    local?: string
    domain?: string
    /** Gmail dots/plus-tags stripped, so `a.b+x@gmail.com` and `ab@gmail.com` converge. */
    canonicalForm?: string
    disposable?: boolean
  }
>

/** `value` is E.164 where parseable, otherwise digits only. */
export type PhoneEntity = EntityBase<
  'phone',
  {
    e164?: string
    countryCode?: string
    /** ISO 3166-1 alpha-2. */
    country?: string
    carrier?: string
    lineType?: 'mobile' | 'landline' | 'voip' | 'unknown'
  }
>

/** `value` is the punycode-normalised, lowercased hostname without a trailing dot. */
export type DomainEntity = EntityBase<
  'domain',
  {
    /** Registrable domain, e.g. `example.co.uk` for `mail.example.co.uk`. */
    apex?: string
    registrar?: string
    registeredAt?: IsoTimestamp
    expiresAt?: IsoTimestamp
    nameservers?: string[]
  }
>

export type IpAddrEntity = EntityBase<
  'ipaddr',
  {
    version: 4 | 6
    asn?: number
    asnOrg?: string
    country?: string
    reverseDns?: string
    /** Private/loopback/link-local. Adapters should refuse to look these up remotely. */
    reserved?: boolean
  }
>

/** A picture or video frame. `value` is the sha256 when we have the bytes, else the path/URL. */
export type ImageEntity = EntityBase<
  'image',
  {
    /** Absolute path on disk, when the file is local. */
    path?: string
    sourceUrl?: string
    sha256?: string
    mediaType?: string
    width?: number
    height?: number
    bytes?: number
    /** Perceptual hash, for near-duplicate matching across re-encodes. */
    phash?: string
  }
>

/**
 * A specific identity on a specific platform — the thing a username search actually
 * finds. `value` is `platform/handle`, which makes it unique and dedupe-able.
 */
export type AccountEntity = EntityBase<
  'account',
  {
    platform: string
    handle: string
    url?: string
    displayName?: string
    bio?: string
    avatarUrl?: string
    avatarSha256?: string
    createdOn?: IsoTimestamp
    /**
     * `true` only when a human or a second source confirmed the profile really exists.
     * Never set by a single adapter — see the confidence rules.
     */
    existsConfirmed?: boolean
  }
>

/** `value` is `lat,lon` at 6dp when coordinates are known, otherwise the place name. */
export type LocationEntity = EntityBase<
  'location',
  {
    lat?: number
    lon?: number
    /** Honest uncertainty. A geolocation guess without a radius is a lie. */
    radiusMeters?: number
    country?: string
    admin1?: string
    placeName?: string
    /** OpenStreetMap element, e.g. `way/12345`. */
    osmRef?: string
  }
>

export type OrganisationEntity = EntityBase<
  'organisation',
  {
    legalName?: string
    country?: string
    /** National register id — ЕИК in Bulgaria, company number elsewhere. */
    registrationId?: string
    website?: string
    industry?: string
  }
>

export type Entity =
  | PersonEntity
  | UsernameEntity
  | EmailEntity
  | PhoneEntity
  | DomainEntity
  | IpAddrEntity
  | ImageEntity
  | AccountEntity
  | LocationEntity
  | OrganisationEntity

/**
 * Is this entity somebody other than the subject — a relative, not the person the case is
 * about?
 *
 * Deliberately structural rather than typed: the callers are a query builder and a scorer
 * that read `entities.json` off disk, where the record is whatever was written months ago
 * and a field may simply be absent. Absent means "not marked", which reads as the subject,
 * which is the behaviour every entity had before the marker existed.
 */
export function isRelative(entity: { kind?: string; attrs?: unknown } | null | undefined): boolean {
  if (!entity || entity.kind !== 'person') return false
  const attrs = entity.attrs
  return !!attrs && typeof attrs === 'object' && (attrs as { role?: unknown }).role === 'relative'
}

/** Narrow an `Entity` by its kind: `EntityOf<'account'>` is `AccountEntity`. */
export type EntityOf<K extends EntityKind> = Extract<Entity, { kind: K }>

/** The attrs bag for a given kind. */
export type EntityAttrs<K extends EntityKind> = EntityOf<K>['attrs']

/** What a caller supplies; ids and timestamps are derived. */
export type NewEntity<K extends EntityKind = EntityKind> = {
  kind: K
  value: string
  label?: string
  seed?: boolean
  attrs?: Partial<EntityAttrs<K>>
}

/* ------------------------------------------------------------------ *
 * Confidence
 * ------------------------------------------------------------------ */

/**
 * - `unverified`   — one source said so. This is where everything starts and where most
 *                    things stay. Not a failure state; the honest default.
 * - `corroborated` — at least two *independent* sources agree. Independence is keyed on
 *                    `Finding.source`, not on `Finding.tool`: Sherlock and Maigret both
 *                    probing github.com is one source, not two.
 * - `confirmed`    — a human looked and vouched for it. Only a human can mint this.
 * - `refuted`      — actively disproved.
 */
export type Confidence = 'unverified' | 'corroborated' | 'confirmed' | 'refuted'

export const CONFIDENCE_LEVELS: readonly Confidence[] = [
  'unverified',
  'corroborated',
  'confirmed',
  'refuted'
] as const

/** Every finding is born here. There is no other starting value. */
export const DEFAULT_CONFIDENCE: Confidence = 'unverified'

/** The only confidence an adapter is permitted to emit. Enforced at parse time. */
export const ADAPTER_MAX_CONFIDENCE: Confidence = 'unverified'

/* ------------------------------------------------------------------ *
 * Raw payload
 * ------------------------------------------------------------------ */

/**
 * A pointer to the tool's unparsed output, stored byte-for-byte under
 * `cases/<caseId>/raw/`. Raw files are append-only and are never deleted or rewritten,
 * including when a finding is deleted — the whole point is that a parser bug is
 * recoverable.
 *
 * The bytes live on disk rather than inline in `findings.jsonl` so that a 40 MB Maigret
 * dump does not have to be loaded to render a table row. `excerpt` exists for display
 * only and is never authoritative.
 */
export interface RawPayload {
  rawId: RawId
  /** Path relative to the case folder, e.g. `raw/raw_01J....json`. Always POSIX-separated. */
  path: string
  sha256: string
  bytes: number
  /** `application/json`, `text/plain`, ... */
  mediaType: string
  /** First ~2 KB, for previews and full-text search. Never the source of truth. */
  excerpt: string
}

/* ------------------------------------------------------------------ *
 * Matcher quality — what the observation was structurally capable of meaning
 * ------------------------------------------------------------------ */

/**
 * How much a site probe can mean, judged from the shape of the probe alone.
 *
 * - `strong`   — the request names the handle *and* two independent things have to agree
 *                before it counts: the expected status code and a marker in the body.
 * - `moderate` — the request names the handle, but only one signal decides the answer.
 * - `weak`     — the request does not name the handle at all, or an anti-bot layer sits
 *                in front of the site and can answer instead of it.
 */
export type MatcherStrength = 'strong' | 'moderate' | 'weak'

/**
 * Why a particular probe is as reliable as it is.
 *
 * This exists because the username tools render every hit identically while the probes
 * behind them are not remotely equal. In the WhatsMyName dataset all three of them
 * descend from, `Gitea` and `Codeberg` request `/api/v1/users/{account}` and read a field
 * out of the user object that comes back; `Pikabu` posts to `https://pikabu.ru/ajax.php`,
 * a generic endpoint with no handle in the URL at all. A 200 from the first is about an
 * account. A 200 from the second is about the endpoint. Shown as identical rows, the
 * second one reads as evidence, and that is exactly the false confidence the confidence
 * model exists to prevent.
 */
export interface MatcherQuality {
  strength: MatcherStrength
  /** Two or three words for the row, e.g. `weak matcher`. */
  label: string
  /** One sentence, shown in the context panel: why this probe is as reliable as it is. */
  why: string
  /**
   * The specific structural facts that decided it, for the detail panel — plus, on the
   * last line and labelled as such, what the site did on the most recent run.
   *
   * The per-run measurement lives here rather than in the claim because a claim is an
   * identity: findings are content-addressed over `(caseId, entityId, tool, source,
   * claim)`, so a response time inside one mints a fresh finding on every re-run instead
   * of refreshing the old one. `matcher` is excluded from that id on purpose and is
   * refreshed in place on re-observation, which makes it the one field on a finding that
   * can carry a measurement without changing what the finding *is*.
   */
  reasons: string[]
}

/* ------------------------------------------------------------------ *
 * Finding
 * ------------------------------------------------------------------ */

/**
 * One assertion, from one source, at one moment.
 *
 * A Finding is deliberately *not* a fact. It is "tool X, reading source Y, asserted Z".
 * Facts are what you get after corroboration, and they are still represented as
 * Findings — just with a higher `confidence` and an entry in the confidence log
 * explaining who promoted them and on what grounds.
 */
export interface Finding {
  id: FindingId
  caseId: CaseId
  /** The entity this claim is *about*. */
  entityId: EntityId
  /**
   * Where the information came from, as the outside world would name it: a hostname, a
   * URL, a dataset name. This is the independence key for corroboration, so it must
   * identify the *origin* of the information, not the program that fetched it.
   */
  source: string
  /** The adapter id that produced this. `Adapter.id`. */
  tool: string
  /** One human-readable sentence. Shown verbatim in the UI. */
  claim: string
  confidence: Confidence
  /** Set when a screenshot/download was captured to back the claim. */
  evidenceRef: EvidenceId | null
  firstSeen: IsoTimestamp
  /** Last time a run re-observed this exact claim. `null` until it is seen a second time. */
  lastVerified: IsoTimestamp | null
  raw: RawPayload
  /**
   * How much the *probe* behind this claim was structurally capable of meaning.
   *
   * A property of the observation, never of the subject. It says nothing about whether the
   * account is the person's; it says whether the request that produced this row was even
   * shaped to answer a question about one particular handle.
   *
   * Deliberately independent of `confidence`, and deliberately not a component of it.
   * `confidence` is about corroboration — how many independent sources say the same thing,
   * and whether a human looked. This is about whether a single observation was capable of
   * carrying information at all. A `weak` matcher corroborated by a second site is still
   * `corroborated`; a `strong` matcher seen once is still `unverified`. Folding one into
   * the other would let a well-shaped probe promote itself, which is the one thing the
   * ladder exists to forbid.
   *
   * `undefined` on findings that predate the classifier and on adapters that do not probe
   * a site; `null` when the classifier ran and had nothing to say.
   *
   * **Not part of the finding id.** Ids are content-addressed over
   * `(caseId, entityId, tool, source, claim)`, so re-running after the classifier changes
   * updates the row in place instead of minting a second one for the same assertion.
   */
  matcher?: MatcherQuality | null
}

/** What `Adapter.parse` returns before the orchestrator stamps ids and timestamps. */
export type DraftFinding = Pick<Finding, 'caseId' | 'entityId' | 'source' | 'claim'> &
  Partial<Pick<Finding, 'confidence' | 'evidenceRef'>> & { tool?: string; raw?: RawPayload }

/* ------------------------------------------------------------------ *
 * Entity candidates — how the graph grows, and why it does not grow by itself
 * ------------------------------------------------------------------ */

/**
 * One finding's suggestion that a new entity exists.
 *
 * The proposal records *which finding* implies the entity, so the review UI can show the
 * claim and its confidence side by side with the thing being proposed. The confidence is
 * deliberately **not** copied here: it lives on the finding, it changes when the finding
 * is promoted, and a stale copy would be exactly the kind of quiet lie this app exists
 * to avoid. Read it from the finding.
 */
export interface CandidateProposal {
  findingId: FindingId
  /** The adapter that produced the proposing finding. */
  tool: string
  /** The proposing finding's `source` — the site or dataset, not the tool. */
  source: string
  /** One line: why this finding implies this entity. Written by the adapter. */
  rationale: string
  /**
   * The route the adapter says it took to reach this — `EntityProposal.mechanism`.
   *
   * Carried through to the provenance hop, where it decides whether a lead may be
   * followed without a human. Structural by construction: the adapter declares it from
   * what it parsed, and nothing downstream re-derives it from prose. Absent on proposals
   * written before adapters declared it, and on adapters with only one route — the hop
   * then falls back to the adapter's documented default.
   */
  mechanism?: ProvenanceMechanism
  at: IsoTimestamp
}

export type CandidateState = 'pending' | 'promoted' | 'dismissed'

/**
 * A discovered thing that is **not yet in the graph**.
 *
 * Adapters declare what they can discover through `produces`, and they say what they
 * actually found through `propose()`. Neither creates an `Entity`. That is the whole
 * point: almost every finding is `unverified`, and most username hits are false
 * positives from anti-bot redirects answering 200. Materialising them automatically
 * would flood a case with garbage and — worse — quietly corrupt the graph, because the
 * next adapter run would be pointed at things nobody ever looked at.
 *
 * So a discovery lands here, a human reviews it, and promotion is an explicit act. That
 * is the same rule the confidence ladder already encodes: only a human moves something
 * up.
 *
 * `id` is content-addressed over `(caseId, kind, canonical value)` — the *same* formula
 * as `entityId`, which buys three things: two adapters discovering the same account
 * converge on one candidate rather than two, a candidate that duplicates an existing
 * entity is detectable by id alone, and promotion yields an entity whose id was
 * predictable before it existed.
 */
export interface EntityCandidate {
  /** Equal to the `EntityId` this becomes if promoted. */
  id: EntityId
  caseId: CaseId
  kind: EntityKind
  /** Canonical form, per `normalise.ts`. */
  value: string
  label: string
  attrs: Record<string, unknown>
  /** Every finding that has proposed this, oldest first. Two proposals are two tools agreeing. */
  proposals: CandidateProposal[]
  state: CandidateState
  firstProposedAt: IsoTimestamp
  /** When a human promoted or dismissed it. */
  decidedAt: IsoTimestamp | null
}

/**
 * A candidate with the parts the review UI needs resolved: how confident the proposing
 * findings are, and how many *independent* sources are behind it.
 */
export interface CandidateView extends EntityCandidate {
  /** The strongest confidence among the proposing findings. */
  bestConfidence: Confidence
  /**
   * Distinct `independenceKey(source)` values across the proposals, **excluding derived
   * sources**. This is the number the queue may call corroboration.
   *
   * The exclusion is not a detail. Two photos out of one camera roll produce two proposals
   * sourced `file:img_1.jpg` and `file:img_2.jpg`, and counting those as two made the
   * review queue tell the operator that his own EXIF, read twice, was "2 independent
   * sources, so it is not one site's bug". It is one device, read twice, off files he
   * already had.
   */
  independentSources: number
  /**
   * The derived sources that were present and deliberately not counted, so the queue can
   * say what named this rather than pretending nothing did: "1 source, plus local analysis
   * that does not count."
   *
   * Optional only so the fixtures and test builders that hand-assemble a view do not each
   * have to carry an empty array. `listCandidates` always sets it; absent means none.
   */
  derivedSources?: string[]
  /**
   * The proposing claims, in proposal order, for display.
   *
   * `matcher` rides along because the review queue has to be able to tell a probe that
   * could mean something from one that could not. A candidate every one of whose
   * proposals came from a weak matcher is noise, and the queue hides it rather than
   * asking the operator to decide about it.
   */
  claims: {
    findingId: FindingId
    claim: string
    confidence: Confidence
    source: string
    tool: string
    matcher?: MatcherQuality
  }[]
}

/* ------------------------------------------------------------------ *
 * Removal — what is left behind when an entity is taken out of a case
 * ------------------------------------------------------------------ */

/**
 * A tombstone for an entity that was removed from a case.
 *
 * Written to `cases/<id>/removed-entities.jsonl`, append-only, **and only when the
 * removal left something behind**: findings that were about it, or a rename that
 * replaced it. Removing an entity that produced nothing produces nothing — a seed is
 * something the operator typed, and un-typing it should be as clean as never having
 * typed it.
 *
 * ## Why the findings are kept rather than deleted
 *
 * A finding is not a property of an entity; it is the record that *a tool, reading a
 * source, asserted something* at a moment in time. Raw captures are permanent and
 * append-only by design, and every finding points at one. Deleting the question does not
 * unobserve the answer — so the findings stay, and they are marked **orphaned**: their
 * `entityId` names something the case no longer holds.
 *
 * That is why this record exists at all. Without it an orphaned finding is a row about a
 * value nobody can name any more; with it the UI can say *"12 findings kept from
 * `username torvalds`, removed on the 30th"* and mean it. It is also why the count is
 * frozen here at the moment of removal rather than recomputed: it is a statement about
 * what happened, not a live query.
 */
export interface RemovedEntity {
  entityId: EntityId
  caseId: CaseId
  kind: EntityKind
  /** The canonical value it had. */
  value: string
  label: string
  /** Whether the operator supplied it, or an adapter's discovery was promoted into it. */
  seed: boolean
  removedAt: IsoTimestamp
  /**
   * `deleted` — taken out of the case.
   * `renamed` — its value was edited, which mints a new id, so the old one is removed.
   */
  reason: 'deleted' | 'renamed'
  /** The entity that took its place, for a rename. Null for a plain deletion. */
  replacedBy: EntityId | null
  /** Findings left pointing at it. Frozen at the moment of removal, never recomputed. */
  orphanedFindings: number
}

/* ------------------------------------------------------------------ *
 * Confidence audit log
 * ------------------------------------------------------------------ */

export type ConfidenceActor = 'human' | 'corroborator'

/**
 * Appended to `cases/<id>/confidence-log.jsonl` on every confidence change. Nothing
 * moves off `unverified` without one of these, and the UI links to it, so "why do I
 * believe this" is always answerable.
 */
export interface ConfidenceChange {
  id: string
  caseId: CaseId
  findingId: FindingId
  from: Confidence
  to: Confidence
  actor: ConfidenceActor
  /** Findings that justified the change. Empty only for a human vouch. */
  supportingFindingIds: FindingId[]
  /** The distinct `source` values behind those findings. */
  independentSources: string[]
  /** Required for a human vouch: what did you actually look at. */
  note: string
  at: IsoTimestamp
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

export type EvidenceType = 'screenshot' | 'html' | 'json' | 'text' | 'image' | 'archive' | 'file'

/**
 * A captured artifact backing a finding. `path` is relative to the case folder
 * (`evidence/<id>.<ext>`); `sha256` is over the stored bytes so the capture can be shown
 * to be unmodified since `capturedAt`.
 */
export interface Evidence {
  id: EvidenceId
  findingId: FindingId
  type: EvidenceType
  path: string
  sha256: string
  capturedAt: IsoTimestamp
  /** The URL the artifact was captured from, when there was one. */
  sourceUrl: string | null
}

/* ------------------------------------------------------------------ *
 * Jobs (orchestrator <-> UI)
 * ------------------------------------------------------------------ */

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout'

export const TERMINAL_JOB_STATES: readonly JobState[] = ['done', 'failed', 'cancelled', 'timeout'] as const

export function isTerminalJobState(s: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(s)
}

/**
 * What a running tool knows about its own progress.
 *
 * Structured on purpose. This used to be `{ pct?, note? }` and the UI recovered the
 * count and the current host by running regexes over the free-text note — which meant
 * the honesty of the progress line depended on an adapter author's phrasing. The fields
 * below are what the UI actually renders, so an adapter that knows a number reports the
 * number.
 *
 * Every field is optional and none may be invented. An adapter that cannot count reports
 * nothing and the UI degrades to an indeterminate rule; that is the correct outcome, and
 * it is why `note` survives as the last resort rather than as the primary channel.
 */
export interface JobProgress {
  /** 0..100 when the tool reports something usable, otherwise undefined. */
  pct?: number
  /** The adapter's own words. A fallback for anything the fields below cannot carry. */
  note?: string
  /** Units finished — sites probed, sources queried. Never estimated. */
  done?: number
  /** The denominator, when the tool states one. Omitted rather than guessed. */
  total?: number
  /** The unit being worked on right now: a site, a host, a dataset name. */
  current?: string
  /** Hits the tool itself has reported so far. Distinct from findings, which exist only after `parse`. */
  hits?: number
}

export interface Job {
  id: JobId
  caseId: CaseId
  entityId: EntityId
  adapterId: string
  state: JobState
  queuedAt: IsoTimestamp
  startedAt: IsoTimestamp | null
  finishedAt: IsoTimestamp | null
  progress: JobProgress
  /** Findings produced by this run. */
  findingIds: FindingId[]
  /** Populated for `failed` / `timeout`. Includes a stderr tail when there was one. */
  error: string | null
  /** Set once the raw output has been persisted — even for a failed run. */
  rawId: RawId | null
}

/* ------------------------------------------------------------------ *
 * Adapter documentation (mirrored into the renderer)
 * ------------------------------------------------------------------ */

/**
 * Mandatory per-adapter explanation. Every field must be filled; the registry throws at
 * startup otherwise. This is a product requirement, not documentation hygiene: the whole
 * point of the app is to understand the mechanism, and the UI renders this panel beside
 * every result.
 */
export interface AdapterDoc {
  /** One line: what it does. */
  what: string
  /** The actual mechanism. "Sends a password-reset request and reads the difference in the response." */
  how: string
  /** Why that mechanism reveals anything. */
  why: string
  /** When to reach for this instead of the alternatives. */
  betterAt: string
  /** Its failure modes and blind spots. */
  worseAt: string
  /** How it lies to you. */
  falsePositives: string
}

export const ADAPTER_DOC_FIELDS: readonly (keyof AdapterDoc)[] = [
  'what',
  'how',
  'why',
  'betterAt',
  'worseAt',
  'falsePositives'
] as const

/** Serialisable adapter description sent to the renderer over IPC. */
export interface AdapterInfo {
  id: string
  title: string
  version: string
  accepts: EntityKind[]
  produces: EntityKind[]
  requiresKey: boolean
  requiresNetwork: boolean
  doc: AdapterDoc
  /**
   * Option keys whose values must never be persisted. The run form renders these as
   * password fields, and the orchestrator scrubs them from everything it writes.
   */
  secretOptions: string[]
  /** True when the adapter implements `propose()` and can therefore grow the graph. */
  proposes: boolean
  concurrency: number
  minIntervalMs: number
  defaultTimeoutMs: number
  /** False when a required key or binary is missing; the UI greys the button out. */
  available: boolean
  unavailableReason: string | null
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/** `config/local.config.json`, documented by `config/example.config.json`. Never a dotfile. */
export interface AppConfig {
  /** Where case folders live. Absolute, or relative to the repo root. */
  casesDir: string
  /** Where the rebuildable SQLite index lives. */
  dataDir: string
  /** Root of the CLI toolbelt installed by Phase 0. */
  toolkitRoot: string
  /**
   * The opsec-kit checkout the Scrub view drives — the folder holding `scrub.py`,
   * `audit.py` and the `opsec/` package. Separate from `toolkitRoot` because it is a
   * source checkout this app spawns, not a binary the adapters call.
   */
  opsecKitRoot: string
  /**
   * An explicit Python interpreter for the scrubber. `null` searches, preferring 3.12 —
   * opsec-kit is documented against it and the machine default is newer. Set this when
   * the search picks the wrong one; Settings shows what it resolved to.
   */
  pythonPath: string | null
  orchestrator: {
    globalConcurrency: number
    defaultConcurrencyPerAdapter: number
    defaultTimeoutMs: number
    /** Hard cap on captured stdout+stderr per run, in bytes. */
    maxOutputBytes: number
  }
  /** Per-adapter overrides, keyed by adapter id. */
  adapters: Record<
    string,
    {
      enabled?: boolean
      concurrency?: number
      minIntervalMs?: number
      timeoutMs?: number
      /** Path to the binary/script, when it is not on PATH. */
      bin?: string
      /** Free-form knobs an adapter reads. Keys live here, and this file is gitignored. */
      options?: Record<string, unknown>
    }
  >
  ui: {
    startHiddenInTray: boolean
  }
}

/* ------------------------------------------------------------------ *
 * Index statistics
 * ------------------------------------------------------------------ */

/** What `rebuildIndex()` reports. Used by the test that proves the index is derivable. */
export interface IndexStats {
  cases: number
  entities: number
  findings: number
  evidence: number
  confidenceChanges: number
  candidates: number
  /** Case folders that failed to load, with the reason. A bad folder must not abort a rebuild. */
  skipped: { caseId: string; reason: string }[]
  durationMs: number
  at: IsoTimestamp
}

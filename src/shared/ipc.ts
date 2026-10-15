/**
 * The IPC surface, shared by main and preload so the channel names and payload shapes
 * cannot drift apart.
 *
 * One rule: the renderer never receives a file path it could turn into an `fs` call, and
 * never sends one that is used unvalidated. Case ids are validated against
 * `isSafeIdSegment` in the main process before they touch the filesystem.
 */

import type {
  AdapterInfo,
  AppConfig,
  Case,
  CaseBasis,
  CandidateView,
  Confidence,
  ConfidenceChange,
  Entity,
  EntityKind,
  Evidence,
  Finding,
  IndexStats,
  Job,
  RemovedEntity
} from './types'
import type {
  ExposureReport,
  GdprLetter,
  GdprLetterRequest,
  PlatformContact,
  RemoveSeedRequest,
  RescanDiff,
  ResetPathMap,
  SavedLetter,
  SeedRemoval,
  SeedUsage,
  SelfAuditDelta,
  SelfAuditLevel,
  SelfAuditPlan,
  SelfAuditProfile,
  SelfAuditRunRequest,
  SelfAuditRunState,
  SelfAuditState,
  SeedFieldId,
  SnapshotRef
} from './selfaudit'
import type { SubjectProfile } from './relevance'
import type {
  ActionRanking,
  EngineDecision,
  InvestigationBrief,
  InvestigationRequest,
  InvestigationRunState,
  ProvenanceChain,
  PruneRequest,
  PruneResult
} from './engine'

export const CH = {
  casesList: 'cases:list',
  casesCreate: 'cases:create',
  casesGet: 'cases:get',
  casesSetSubject: 'cases:setSubject',
  entitiesList: 'entities:list',
  entitiesAdd: 'entities:add',
  entitiesUsage: 'entities:usage',
  entitiesEdit: 'entities:edit',
  entitiesDelete: 'entities:delete',
  entitiesRemoved: 'entities:removed',
  candidatesList: 'candidates:list',
  candidatesPromote: 'candidates:promote',
  candidatesDismiss: 'candidates:dismiss',
  candidatesPromoteConfirmed: 'candidates:promoteConfirmed',
  findingsList: 'findings:list',
  findingsSearch: 'findings:search',
  findingsRaw: 'findings:raw',
  findingsPromote: 'findings:promote',
  findingsCorroborationCandidates: 'findings:corroborationCandidates',
  evidenceList: 'evidence:list',
  confidenceLog: 'confidence:log',
  adaptersList: 'adapters:list',
  jobsRun: 'jobs:run',
  jobsPlan: 'jobs:plan',
  jobsRunPlan: 'jobs:runPlan',
  jobsCancel: 'jobs:cancel',
  jobsCancelCase: 'jobs:cancelCase',
  jobsList: 'jobs:list',
  indexRebuild: 'index:rebuild',
  settingsGet: 'settings:get',
  settingsGetLaunchAtStartup: 'settings:getLaunchAtStartup',
  settingsSetLaunchAtStartup: 'settings:setLaunchAtStartup',
  settingsGetDataRoot: 'settings:getDataRoot',
  settingsSetDataRoot: 'settings:setDataRoot',
  settingsPickDataRoot: 'settings:pickDataRoot',
  appInfo: 'app:info',
  appQuit: 'app:quit',
  appRestart: 'app:restart',
  appOpenExternal: 'app:openExternal',
  appRevealInFolder: 'app:revealInFolder',
  rangeData: 'range:data',
  rangeIndex: 'range:index',
  rangeLive: 'range:live',
  scrubEnv: 'scrub:env',
  scrubPick: 'scrub:pick',
  scrubPickFolder: 'scrub:pickFolder',
  scrubInspect: 'scrub:inspect',
  scrubRun: 'scrub:run',
  scrubAudit: 'scrub:audit',
  selfAuditState: 'selfaudit:state',
  selfAuditSaveProfile: 'selfaudit:saveProfile',
  selfAuditClearProfile: 'selfaudit:clearProfile',
  selfAuditSeedUsage: 'selfaudit:seedUsage',
  selfAuditRemoveSeed: 'selfaudit:removeSeed',
  selfAuditPlan: 'selfaudit:plan',
  selfAuditRun: 'selfaudit:run',
  selfAuditCancel: 'selfaudit:cancel',
  selfAuditSnapshots: 'selfaudit:snapshots',
  selfAuditDelta: 'selfaudit:delta',
  selfAuditReport: 'selfaudit:report',
  selfAuditResetPaths: 'selfaudit:resetPaths',
  selfAuditRescan: 'selfaudit:rescan',
  selfAuditLastRescan: 'selfaudit:lastRescan',
  selfAuditContacts: 'selfaudit:contacts',
  selfAuditLetter: 'selfaudit:letter',
  selfAuditSaveLetter: 'selfaudit:saveLetter',
  exportGallery: 'export:gallery',
  exportPreview: 'export:preview',
  exportWrite: 'export:write',
  enginePlan: 'engine:plan',
  engineRun: 'engine:run',
  engineCancel: 'engine:cancel',
  engineState: 'engine:state',
  engineBrief: 'engine:brief',
  engineChains: 'engine:chains',
  engineChain: 'engine:chain',
  enginePrune: 'engine:prune',
  engineRestore: 'engine:restore',
  engineDecisions: 'engine:decisions',
  eventJobUpdate: 'event:job:update',
  eventSelfAuditRun: 'event:selfaudit:run',
  eventEngineRun: 'event:engine:run',
  eventNavigate: 'event:navigate'
} as const

/**
 * The left-nav sections, named here because the **tray menu has to be able to ask for
 * one**: "Run self-audit" opens the window and then pushes `eventNavigate` with
 * `'self-audit'`, because the main process cannot reach into React state.
 *
 * Keep this in step with `Section` in `renderer/src/App.tsx`. It lives in `shared/`
 * because it is the one piece of renderer vocabulary the main process needs to speak,
 * and the alternative — the same string literals typed out in two processes — drifts.
 */
export type NavSection = 'cases' | 'self-audit' | 'range' | 'scrub' | 'settings'

/**
 * Where the packaged app keeps cases, raw captures and the SQLite index.
 *
 * **This is never `%APPDATA%`.** Raw tool output is kept permanently and append-only, a
 * maigret sweep over 3,000 sites is a large capture, and one self-audit run creates five
 * case folders and is meant to be re-run — so the directory grows without bound and does
 * not belong on the system drive. It defaults to `Documents/OSINT Workbench`.
 *
 * The only thing left in the OS profile is `data-location.json` at the OS userData path: a few
 * hundred bytes naming the real directory, which has to live somewhere findable before
 * the real directory is known.
 */
export interface DataRootInfo {
  /** What the pointer file says — the value a restart would use. */
  root: string
  /** What this running process is actually using. */
  effective: string
  /** The pointer in the OS profile, shown so it is not a secret. */
  pointerFile: string
  /** True when `root` and `effective` have diverged: a restart is pending. */
  requiresRestart: boolean
}

export interface CaseSummary extends Case {
  publishable: boolean
  counts: {
    entities: number
    findings: number
    unverified: number
    corroborated: number
    confirmed: number
    refuted: number
    evidence: number
    /** Discovered entities awaiting a decision. Not in the graph. */
    candidates: number
  }
}

export interface CreateCaseRequest {
  name: string
  basis: CaseBasis
  subjectConsent?: boolean
  notes?: string
}

export interface AddEntityRequest {
  caseId: string
  kind: EntityKind
  value: string
  label?: string
  seed?: boolean
}

/* ------------------------------------------------- removing and renaming */

/**
 * What a removal would disturb, computed before anything happens.
 *
 * The confirmation the operator sees is built out of this, and the numbers have to be
 * real ones — "this will orphan 12 findings" is only worth saying if the 12 was counted
 * rather than guessed. An entity with nothing attached needs no confirmation at all, and
 * `attached` is how the UI knows which of the two it is looking at.
 */
export interface EntityUsage {
  caseId: string
  entityId: string
  kind: EntityKind
  value: string
  label: string
  seed: boolean
  /** Findings whose `entityId` is this one. These are what would be orphaned. */
  findings: number
  /** Captured artifacts hanging off those findings. Never deleted either. */
  evidence: number
  /** Runs still queued or running against it. A removal cancels them. */
  activeJobs: number
  /**
   * True when this entity exists because a candidate was promoted into it, so removing
   * it puts that candidate back in the review queue rather than losing the discovery.
   */
  returnsCandidate: boolean
  /** True when anything at all is attached, i.e. the removal needs confirming. */
  attached: boolean
  /**
   * Whether the value can be re-typed in place. Composite and derived values cannot:
   * an `account` is `platform/handle` and is built by the add form, and an `image`'s
   * value may be a digest of bytes rather than anything a person wrote.
   */
  editable: boolean
}

export interface DeleteEntityRequest {
  caseId: string
  entityId: string
}

/** What actually happened, in the same units the confirmation promised. */
export interface EntityRemoval {
  caseId: string
  entityId: string
  kind: EntityKind
  label: string
  /** Findings kept, now pointing at an entity the case no longer holds. */
  orphanedFindings: number
  /** Runs cancelled because their target stopped existing. */
  cancelledJobs: number
  /** True when a promoted candidate was returned to the review queue. */
  candidateReturned: boolean
  /**
   * Provenance nodes cut with it: the entity's own root, plus everything whose only route
   * into the case ran through it.
   *
   * Zero when the engine has never touched this case, which is the common one — a case
   * with no `provenance.jsonl` has no root to cut and the removal writes nothing extra.
   * The cut is a prune like any other, so `engine.restore()` puts all of it back.
   */
  provenanceCut: number
  /** Null when the removal left nothing behind, and therefore wrote nothing. */
  tombstone: RemovedEntity | null
}

/**
 * Re-type an entity's value.
 *
 * Entity ids are content-addressed over `(caseId, kind, canonical value)`, so changing
 * the value mints a different entity. The edit is therefore an add-and-remove, and it
 * carries the same orphan consequence as a deletion whenever the old value had findings
 * — which is honest: those findings really were about the misspelling.
 *
 * When only the spelling of the *label* changes and the canonical value does not — a
 * capitalisation, a `@` prefix — no id moves and nothing is orphaned.
 */
export interface EditEntityRequest {
  caseId: string
  entityId: string
  /** The new raw value, re-normalised through `normaliseEntityValue` on the way in. */
  value: string
  label?: string
}

export interface EntityEdit {
  entity: Entity
  /** True when the canonical value moved, so a new entity was minted for it. */
  renamed: boolean
  /** The removal of the old entity. Null when nothing moved. */
  removal: EntityRemoval | null
}

/* ------------------------------------------------------------ running many */

/** One adapter pointed at one entity. The unit the orchestrator queues. */
export interface RunPlanEntry {
  adapterId: string
  adapterTitle: string
  entityId: string
  entityKind: EntityKind
  entityLabel: string
}

/**
 * A selection, as the launcher expresses it.
 *
 * Both lists are "or everything": an empty or omitted `entityIds` means every entity in
 * the case, and an empty or omitted `adapterIds` means every adapter that is fit to run
 * unattended. That is what collapses four separate features into one — run everything,
 * one adapter across every entity, one entity across every adapter, and the intersection
 * of two hand-made selections are all the same call with different halves filled in.
 */
export interface RunPlanRequest {
  caseId: string
  entityIds?: string[]
  adapterIds?: string[]
}

/**
 * What a selection would actually do, before it does any of it.
 *
 * The lists that are *not* `runs` matter as much as the one that is. An adapter that
 * does not accept an entity's kind has not failed — it cannot answer the question, which
 * is a different thing and reads differently. A plan of zero runs is a legitimate answer
 * and the UI must be able to say why it is zero instead of appearing broken.
 */
export interface RunPlan {
  caseId: string
  runs: RunPlanEntry[]
  /** How many distinct entities and adapters `runs` actually touches. */
  entitiesCovered: number
  adaptersUsed: number
  /** Entities no selected adapter accepts, each with the reason in plain English. */
  idleEntities: { entityId: string; kind: EntityKind; label: string; reason: string }[]
  /** Selected adapters that accept none of the selected entities. */
  idleAdapters: { adapterId: string; adapterTitle: string; accepts: EntityKind[]; reason: string }[]
  /** Adapters left out before applicability was considered: unavailable, disabled, or unfit for a batch. */
  excluded: { adapterId: string; adapterTitle: string; reason: string }[]
  /** Pairs already queued or running. Enqueuing them again would only duplicate work. */
  alreadyQueued: RunPlanEntry[]
}

/**
 * Why a kind of entity has no tool pointed at it, for the kinds where that is the design
 * rather than a gap in this build. `null` when the absence is simply a gap.
 *
 * This exists because the operator has already been confused by exactly this: pointing
 * "run everything" at a name correctly enqueues nothing, and nothing is indistinguishable
 * from broken unless something says why. A name and a place are not queries — they are
 * things to *match against* text that other adapters read off profiles, which is what the
 * attribution matcher does with them.
 *
 * Each sentence says what the kind **is for**, never that nothing takes it: the caller has
 * already said that, and a second sentence restating it is the difference between an
 * explanation and a scolding.
 */
/**
 * `a username`, `an email`. Shared because the same sentence is built in the main
 * process, in the fixture bridge and in the launcher's hint, and "queries a account"
 * looks like a bug in the tool rather than a slip in a string.
 *
 * `username` is the one exception the letter rule gets wrong: it opens on a consonant
 * sound, so it takes "a" despite starting with a vowel.
 */
export function kindWithArticle(kind: EntityKind): string {
  if (kind === 'username') return 'a username'
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`
}

/**
 * Why nothing in a selection can be pointed at one kind of entity.
 *
 * Four different sentences, because they are four different facts, and telling them apart
 * is the whole point: no tool in the build takes this kind at all, the ones that do are
 * unavailable, the ones that do were not selected, or the kind is one this app matches
 * against text rather than queries. Rendering all four as "nothing ran" is how a correct
 * empty plan starts looking like a broken one.
 *
 * Lives here rather than in the service because the fixture bridge has to produce the
 * same sentences — a copy that only exists on the main side is a copy the design pass
 * never sees.
 */
export function idleKindReason(opts: {
  kind: EntityKind
  /** Titles of adapters that accept this kind and are fit to run unattended. */
  runnable: readonly string[]
  /** Of those, the ones available right now. */
  available: readonly string[]
  /** True when the caller named its adapters, so "nothing you selected" is the truth. */
  named: boolean
}): string {
  const named = kindWithArticle(opts.kind)
  if (!opts.runnable.length) {
    const base = `No adapter in this build queries ${named}.`
    const design = attributionOnlyKind(opts.kind)
    return design ? `${base} ${design}` : `${base} That is a gap in the toolbelt, not a fault in this case.`
  }
  if (!opts.available.length) {
    const one = opts.runnable.length === 1
    return `${opts.runnable.join(', ')} accept${one ? 's' : ''} ${named}, but ${one ? 'it is not' : 'none is'} available — see Settings for what is missing.`
  }
  if (opts.named) {
    return `Nothing you selected accepts ${named}. ${opts.available.join(', ')} would.`
  }
  return `Nothing available accepts ${named}.`
}

export function attributionOnlyKind(kind: EntityKind): string | null {
  switch (kind) {
    case 'person':
      return 'A name is used for attribution — matched against the text the profile adapters read off accounts — so it earns its keep once a sweep has produced something to match it against.'
    case 'location':
      return 'A place is used for attribution — matched against text an adapter has already read off a profile — which is why a country on its own is still a complete answer at its own scale.'
    case 'organisation':
      return 'An organisation is matched against the employer and bio text the profile adapters read; nothing here queries a company register.'
    default:
      return null
  }
}

/**
 * A run, as the renderer asks for it.
 *
 * `options` and `timeoutMs` are here because the orchestrator has always accepted them
 * and this surface used to drop them — which meant no per-run knob was reachable from
 * the UI at all, and `hibp-passwords`, whose candidate password is an option and cannot
 * be anything else, could not be run.
 *
 * `options` values that an adapter has declared secret (see `Adapter.secretOptions`) are
 * used for the run and then redacted from everything the run persists. Nothing here is
 * written to a case file by the IPC layer itself.
 */
export interface RunJobRequest {
  caseId: string
  entityId: string
  adapterId: string
  /** Per-run adapter options, merged over `config.adapters[id].options`. */
  options?: Record<string, unknown>
  /** Overrides the adapter's and the config's default deadline, in milliseconds. */
  timeoutMs?: number
}

export interface CandidateDecisionRequest {
  caseId: string
  candidateId: string
  /** Recorded on the entity's provenance; not required. */
  note?: string
}

export interface PromoteRequest {
  caseId: string
  findingId: string
  to: Confidence
  actor: 'human' | 'corroborator'
  note?: string
  supportingFindingIds?: string[]
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  chrome: string
  paths: {
    root: string
    casesDir: string
    dataDir: string
    dbFile: string
    toolkitRoot: string
    opsecKitRoot: string
    configFile: string
  }
  configSource: 'defaults' | 'file'
  configWarnings: string[]
  adapterCount: number
}

/* -------------------------------------------------------------------- Range */

/**
 * The scheme the Range's imagery arrives on.
 *
 * Panoramax is fetched by the main process and handed to the page over this, rather than
 * being loaded from the page directly. Two things fall out of that, and both were real
 * problems in the spike: the renderer's CSP can keep forbidding remote hosts outright,
 * and a federated instance that sends no `Access-Control-Allow-Origin` stops mattering —
 * there is no origin in the main process for CORS to refuse. geoint spike notes §6 measured
 * one such instance holding 7% of the index, and its failure mode was a spinner that
 * never resolved because a CORS rejection fires no error event.
 *
 * Declared here rather than in `main/range.ts` so the preload can build a URL without
 * importing a module that reaches for `net` and `protocol`, neither of which exists in
 * a preload.
 */
export const PANO_SCHEME = 'pano'

/** `pano://img/?u=<encoded https url>` — built in the preload, resolved in main. */
export function panoUrl(imageUrl: string): string {
  return `${PANO_SCHEME}://img/?u=${encodeURIComponent(imageUrl)}`
}

/**
 * The Range's bundled reference data: the clue atlas, the hand-reviewed L1 rounds and
 * the world outline the pin tiers draw.
 *
 * All three ship as app resources rather than being fetched, which is what lets the
 * Range work offline apart from the imagery itself. The shapes are the spike's own —
 * `atlas` is `window.ATLAS`, `curated` is `window.CURATED` — so `spikes/geoint/` stays
 * a readable reference for anything in here.
 */
export interface RangeData {
  atlas: AtlasData
  curated: CuratedData
  /** Flat `[lon, lat, lon, lat, …]` rings, Natural Earth 110m, 0.01° quantised. */
  basemap: { source: string; shapes: number[][] }
}

export interface AtlasClue {
  value: string
  meansWhat?: string
  where?: string[]
  note?: string
  /** Rendered as a visible badge. A lead to check, never a fact to guess on. */
  unverified?: boolean
}

export interface AtlasCategory {
  id: string
  name: string
  icon?: string
  why?: string
  how?: string
  clues?: AtlasClue[]
}

export interface AtlasCountry {
  name: string
  code?: string
  tells?: string[]
  script?: string
  plate?: string
  roadLines?: string
  bollard?: string
  poles?: string
  architecture?: string
  vegetation?: string
  domain?: string
  phone?: string
}

export interface AtlasData {
  categories: AtlasCategory[]
  countries: AtlasCountry[]
}

/** One frame's written lesson. A human opened this exact image and wrote these down. */
export interface CuratedLesson {
  first: string
  firstWhere?: string
  narrows?: string
  second?: string
  secondWhere?: string
  note?: string
  /** Deep links into the atlas: `road-signs`, `c:road-signs` or `n:Bulgaria`. */
  atlas?: { key: string; label: string }[]
}

/** A frame, in the shape both the index and the curated set use. */
export interface RangeFrame {
  id: string
  /** `[lon, lat]` — ground truth, and the only place it exists. */
  c: [number, number]
  url: string
  pano: boolean
  /** Capture time, ISO. Feeds the sun aid. */
  t?: string | null
  country?: string | null
  area?: string | null
  /** OSM signal kinds within 60 m — what makes hint 1 true for this image. */
  kinds?: string[]
  signal?: number
  n?: number
  difficulty?: string
  lesson?: CuratedLesson
}

export interface CuratedData {
  built: string
  count: number
  rounds: RangeFrame[]
}

export interface RangeIndex {
  built: string
  region: string
  attribution?: string
  candidates: RangeFrame[]
}

/* -------------------------------------------------------------------- Scrub */

/**
 * Where the scrubber's three external pieces resolved to, and what to say if they did
 * not. The UI shows this before it lets anything be scrubbed: a missing interpreter has
 * to read as an instruction, never as a stack trace or a silent no-op.
 */
export interface ScrubEnv {
  ok: boolean
  python: { path: string | null; version: string | null; how: string; error: string | null }
  kitRoot: { path: string; present: boolean }
  exiftool: { path: string | null; version: string | null; present: boolean }
  ffmpeg: { path: string | null; present: boolean }
  ffprobe: { path: string | null; present: boolean }
  /** Plain-English, actionable. Empty when `ok`. */
  problems: string[]
}

/** One metadata field, as `scrub.py` classifies it. */
export interface ScrubFinding {
  /** Grouped ExifTool key, e.g. `GPS:GPSLatitude`. */
  field: string
  /** Not always a string — `scrub.py` emits raw numbers for coordinates. */
  value: string | number | boolean | null
  category: 'SENSITIVE' | 'IDENTIFYING' | string
  /** The plain-English "why it matters", written by the Python. Never paraphrased here. */
  why: string
}

export interface ScrubVerification {
  /** `VERIFIED` · `RECOVERABLE` · `FAILED` · `unverifiable` — note the one lowercase. */
  status: string
  checked: number
  remaining: string[]
  recoverable_values: string[]
}

export interface ScrubResult {
  path: string
  ok: boolean
  action: 'report-only' | 'copy' | 'in-place' | 'skipped' | 'failed' | 'aborted' | 'written-unverified' | string
  output: string | null
  backup: string | null
  error: string | null
  warnings: string[]
  findings: ScrubFinding[]
  handler: string | null
  /** Report-only mode only. The same score the folder audit ranks by. */
  risk?: number
  verification?: ScrubVerification
}

export interface ScrubRunRequest {
  paths: string[]
  mode: 'copy' | 'in-place'
  /** Copy mode only. Omitted means "beside the original". */
  outDir?: string
}

/** One file in a folder audit, as `audit.py` ranks them — worst first, already sorted. */
export interface AuditEntry {
  path: string
  score: number
  gps: boolean
  /** `"48.858400 N, 2.294500 E"`, or empty even when `gps` is true. */
  gps_position: string
  sensitive_count: number
  identifying_count: number
  /** Bare tag names, no group prefix. Max 6, SENSITIVE only. */
  top: string[]
}

export interface AuditRequest {
  path: string
  recursive: boolean
  gpsOnly: boolean
}

/* ------------------------------------------------------- Avatars and export */

/**
 * One profile picture the case has actually fetched.
 *
 * `dhash`/`phash` are the 64-bit perceptual hashes from `adapters/support/image.ts`, and
 * they are `null` whenever the picture could not be decoded — a JPEG outside Electron, a
 * WebP, a 404 dressed as an image. `reason` then says which, because "we could not read
 * this picture" and "this account has no picture" must never render the same.
 */
export interface GalleryImage {
  /** `platform/handle` of the account this picture belongs to. */
  accountKey: string
  platform: string
  handle: string
  url: string
  mediaType: string
  bytes: number
  /** Digest of the bytes actually received. Byte equality, when it happens, is decisive. */
  sha256: string | null
  dhash: string | null
  phash: string | null
  /** The platform's stock picture. Excluded from grouping — see `AvatarGallery`. */
  isDefault: boolean
  /** Present whenever there is no hash: `http:404`, `undecodable:webp`, `blocked:…`. */
  reason: string | null
  /** The picture itself, inline, when the capture kept its bytes. */
  dataUri: string | null
}

/** Two or more accounts wearing the same picture. */
export interface GalleryGroup {
  id: string
  images: GalleryImage[]
  platforms: string[]
  accounts: string[]
  /** True when every pair in the group is byte-identical, not merely perceptually equal. */
  identical: boolean
  /** Bits of 64 the furthest pair in this group differs by. 0 when identical. */
  maxDistance: number
  note: string
}

/**
 * Every picture a case holds, grouped by which of them are the same picture.
 *
 * The four buckets are kept apart on purpose. `groups` is evidence. `singles` is a
 * picture on one account and nothing more. `defaults` are the platform's stock avatars,
 * which are excluded from grouping because a default matching a default is every account
 * on that platform matching every other. `unreadable` and `notFetched` are the two ways
 * this can be incomplete, and they are reported rather than dropped.
 */
export interface AvatarGallery {
  groups: GalleryGroup[]
  singles: GalleryImage[]
  defaults: GalleryImage[]
  /** Fetched, but no comparable hash came out. Unchecked, not absent. */
  unreadable: GalleryImage[]
  /** A sweep recorded this avatar URL and nothing has downloaded it yet. */
  notFetched: { platform: string; handle: string; url: string }[]
  capturesRead: number
  enrichRuns: number
  note: string
}

export type ExportFormat = 'html' | 'markdown'
export type ExportLang = 'bg' | 'en'

/**
 * A report written **for the person it is about**.
 *
 * `basis` is not asked for here: it is read from the case, which already enforced it at
 * creation. `subjectName` and `preparedBy` are, because a document handed to somebody has
 * to say who made it and who it is about in the first paragraph, and neither of those is
 * something the app can know.
 */
export interface ExportRequest {
  caseId: string
  format: ExportFormat
  lang: ExportLang
  /** Who ran the audit. Printed at the top, beside the declared basis. */
  preparedBy?: string
  /** The subject, as they would like to be named. */
  subjectName?: string
  /**
   * Include the collapsed "set aside as noise" section.
   *
   * On by default. It is what lets the reader check the filter instead of trusting it —
   * but there is a real case for handing somebody the clean version, so it is a choice
   * and not a rule.
   */
  includeNoise?: boolean
  /** Absolute path to write to. Omitted means a dated file inside the case folder. */
  outPath?: string
}

export interface ExportResult {
  path: string
  bytes: number
  format: ExportFormat
  /** Pictures inlined as data URIs, and how many bytes of the file that accounts for. */
  imagesInlined: number
  imageBytes: number
}

/** The shape `contextBridge` exposes as `window.osint`. */
export interface OsintApi {
  cases: {
    list(): Promise<CaseSummary[]>
    create(req: CreateCaseRequest): Promise<CaseSummary>
    get(caseId: string): Promise<CaseSummary | null>
    /**
     * Record what the operator states about the subject — gender, age band, countries.
     *
     * A separate call from `create` because it is edited constantly and creation happens
     * once: he adds the gender after the first sweep comes back full of the wrong people,
     * which is exactly when he wants it.
     */
    setSubject(caseId: string, subject: SubjectProfile): Promise<CaseSummary>
  }
  entities: {
    list(caseId: string): Promise<Entity[]>
    add(req: AddEntityRequest): Promise<Entity>
    /** What a removal would disturb. Read-only; nothing is changed by asking. */
    usage(caseId: string, entityId: string): Promise<EntityUsage | null>
    /**
     * Re-type a value. A changed canonical value mints a new entity and removes the old
     * one, with the same orphan consequence a deletion has — see `EditEntityRequest`.
     */
    edit(req: EditEntityRequest): Promise<EntityEdit>
    /**
     * Take an entity out of the case. Findings it produced are **kept and orphaned**;
     * raw captures are never touched. Idempotent.
     */
    delete(req: DeleteEntityRequest): Promise<EntityRemoval>
    /** The tombstones: what was removed, when, and how much it left behind. */
    removed(caseId: string): Promise<RemovedEntity[]>
  }
  /**
   * Discovered things awaiting a human decision. Nothing here is in the graph yet — see
   * `EntityCandidate` for why that is deliberate.
   */
  candidates: {
    list(caseId: string, state?: 'pending' | 'promoted' | 'dismissed' | 'all'): Promise<CandidateView[]>
    promote(req: CandidateDecisionRequest): Promise<Entity>
    dismiss(req: CandidateDecisionRequest): Promise<CandidateView>
    /** Promotes every pending candidate whose proposing findings include a confirmed one. */
    promoteConfirmed(caseId: string): Promise<Entity[]>
  }
  findings: {
    list(caseId: string): Promise<Finding[]>
    search(caseId: string, query: string): Promise<Finding[]>
    raw(caseId: string, findingId: string): Promise<string>
    promote(req: PromoteRequest): Promise<Finding>
    corroborationCandidates(caseId: string, findingId: string): Promise<Finding[]>
  }
  evidence: { list(caseId: string): Promise<Evidence[]> }
  confidence: { log(caseId: string): Promise<ConfidenceChange[]> }
  adapters: { list(): Promise<AdapterInfo[]> }
  jobs: {
    run(req: RunJobRequest): Promise<Job>
    /**
     * What a selection would run, without running it. Pure: nothing is queued by asking.
     *
     * This is shown before the runs start because some of them take minutes, and because
     * a plan of zero is a real answer that has to be able to explain itself.
     */
    plan(req: RunPlanRequest): Promise<RunPlan>
    /** Queue everything in the plan for that selection, in plan order. */
    runPlan(req: RunPlanRequest): Promise<Job[]>
    cancel(jobId: string): Promise<boolean>
    /** Cancel every queued and running job in one case. Returns how many were stopped. */
    cancelCase(caseId: string): Promise<number>
    list(caseId?: string): Promise<Job[]>
    onUpdate(cb: (job: Job) => void): () => void
  }
  index: { rebuild(): Promise<IndexStats> }
  settings: {
    get(): Promise<AppConfig>
    /**
     * Start with Windows. Off by default, and read back from
     * `app.getLoginItemSettings` rather than from a config file, so the toggle reflects
     * what Windows actually believes — including the user having turned it off in Task
     * Manager's Startup tab behind the app's back.
     */
    getLaunchAtStartup(): Promise<boolean>
    setLaunchAtStartup(enabled: boolean): Promise<boolean>
    /** Where cases, raw captures and the index live. See `DataRootInfo`. */
    getDataRoot(): Promise<DataRootInfo>
    /** Native directory picker. Resolves to `null` if he cancelled. */
    pickDataRoot(): Promise<string | null>
    /**
     * Repoints the data root. **Existing cases are not moved** — the new directory
     * starts empty and the old one is left alone. Takes effect on restart; the returned
     * `requiresRestart` says so.
     */
    setDataRoot(dir: string): Promise<DataRootInfo>
  }
  app: {
    info(): Promise<AppInfo>
    /** Opens an https URL in the real browser. Refused for any other scheme. */
    openExternal(url: string): Promise<void>
    /** Selects a file or folder in Explorer. */
    revealInFolder(path: string): Promise<void>
    /**
     * Really exits, rather than hiding to tray. This is what a File -> Quit item in the
     * renderer would call; closing the window never comes here.
     */
    quit(): Promise<void>
    /** Exits and starts again. What a data-root change needs in order to take effect. */
    restart(): Promise<void>
    /**
     * Fires when the tray menu asks for a section — currently only "Run self-audit".
     * Returns an unsubscribe function.
     *
     * Unhandled, the tray item still opens the window; wiring this up is what makes it
     * land on the right view.
     */
    onNavigate(cb: (section: NavSection) => void): () => void
  }
  /**
   * The Range. Reference data is bundled; only the imagery leaves the machine, and it
   * does so through the `pano:` protocol in the main process rather than from the page,
   * so the renderer's "no remote loads" CSP holds and a Panoramax instance without CORS
   * headers stops being the app's problem.
   */
  range: {
    /** Atlas, curated rounds and the world outline. One call, cached by the caller. */
    data(): Promise<RangeData>
    /** A signal-filtered frame index. `bulgaria` (L3) or `countries` (L1/L2). */
    index(region: 'bulgaria' | 'countries'): Promise<RangeIndex>
    /** L4 only: an unfiltered live sample from the Panoramax federation. */
    live(): Promise<RangeFrame | null>
    /** Wraps a Panoramax image URL as a `pano:` URL the renderer may load. */
    imageUrl(url: string): string
  }
  /**
   * The metadata scrubber, spawned from the opsec-kit checkout. The Python owns every
   * decision about what a field means and whether a scrub verified; nothing here
   * re-implements it.
   */
  scrub: {
    /**
     * The absolute path behind a dropped `File`.
     *
     * `File.path` was removed in Electron 32; `webUtils.getPathForFile` is the
     * replacement and it only exists in the preload, so drag-and-drop has to come
     * through the bridge rather than being read off the event in the page.
     */
    pathForFile(file: File): string
    /** Where Python, ExifTool and ffmpeg resolved to, and what to do when they did not. */
    env(): Promise<ScrubEnv>
    /** Native file picker. Returns absolute paths, or an empty array if cancelled. */
    pick(): Promise<string[]>
    /** Native folder picker. Returns one absolute path, or null if cancelled. */
    pickFolder(title?: string): Promise<string | null>
    /** `scrub.py --report-only`: reads, classifies, writes nothing. */
    inspect(paths: string[]): Promise<ScrubResult[]>
    /** `scrub.py`: strips and verifies. `in-place` always keeps a `.bak`. */
    run(req: ScrubRunRequest): Promise<ScrubResult[]>
    /** `audit.py`: a folder, ranked worst-first. */
    audit(req: AuditRequest): Promise<AuditEntry[]>
  }
  /**
   * The avatar gallery and the shareable export.
   *
   * Both are pure readers over the case folder: they fetch nothing, and opening either
   * makes no request to anybody. `write` is the only one that touches the disk, and the
   * path it wrote is returned so the UI can offer to reveal it.
   */
  exports: {
    /** Every picture the case has fetched, grouped by which of them are the same picture. */
    gallery(caseId: string): Promise<AvatarGallery>
    /** The finished document as a string, for previewing it before anyone is sent it. */
    preview(req: ExportRequest): Promise<string>
    write(req: ExportRequest): Promise<ExportResult>
  }
  /**
   * Self-Audit: the five adversary-knowledge levels, their deltas, the exposure report,
   * the reset-path map and the GDPR letters.
   *
   * The seed profile is real personal data and stays in the main process wherever it can:
   * `state()` returns it because the form has to render it, and `letter()` fills the
   * operator's own details in on the main side rather than making the page hold them.
   * Nothing here writes a seed value to a log.
   */
  selfAudit: {
    /** Profile, per-level case links and the run in progress, if any. */
    state(): Promise<SelfAuditState>
    saveProfile(profile: SelfAuditProfile): Promise<SelfAuditProfile>
    /** Deletes the vault file only. Case folders and their findings are untouched. */
    clearProfile(): Promise<SelfAuditProfile>
    /** Which levels materialised this seed value, and what is attached there. Read-only. */
    seedUsage(field: SeedFieldId, value: string): Promise<SeedUsage>
    /**
     * Take one value out of the vault.
     *
     * The vault side is clean — the levels that read it will not seed that value again.
     * The level *cases* keep their entity and its findings unless `purgeCases` is asked
     * for, because those are an audit trail with raw captures behind them.
     */
    removeSeed(req: RemoveSeedRequest): Promise<SeedRemoval>
    /** What a level would run, without running it. */
    plan(level: SelfAuditLevel): Promise<SelfAuditPlan>
    /** Starts a run and returns immediately; progress arrives on `onRun`. */
    run(req: SelfAuditRunRequest): Promise<SelfAuditRunState>
    cancel(): Promise<boolean>
    snapshots(level: SelfAuditLevel): Promise<SnapshotRef[]>
    /** `from` defaults to the level below. L0 returns a delta with a null `from`. */
    delta(level: SelfAuditLevel, from?: SelfAuditLevel): Promise<SelfAuditDelta | null>
    report(level: SelfAuditLevel, snapshotId?: string): Promise<ExposureReport | null>
    resetPaths(level: SelfAuditLevel, snapshotId?: string): Promise<ResetPathMap | null>
    /** Re-runs the level, then diffs it against the previous snapshot of the same level. */
    rescan(req: SelfAuditRunRequest): Promise<RescanDiff | null>
    /** Diffs the two most recent snapshots of a level without running anything. */
    lastRescan(level: SelfAuditLevel): Promise<RescanDiff | null>
    /** The platform contact book. Every entry is unverified, permanently. */
    contacts(): Promise<PlatformContact[]>
    letter(req: GdprLetterRequest): Promise<GdprLetter>
    /**
     * Writes to `cases/_selfaudit/letters/`. Deliberately takes no level: a letter is
     * filled in from the vault, so it carries the operator's real name and address, and
     * putting it in a level's folder would falsify the one property that makes that
     * folder proof of anything.
     */
    saveLetter(req: GdprLetterRequest): Promise<SavedLetter>
    onRun(cb: (state: SelfAuditRunState) => void): () => void
  }
  /**
   * The investigation engine: the loop that plans, runs, scores and stops on its own.
   *
   * Two things it is structurally incapable of, and both are why it is allowed to run
   * unattended at all. It never creates an `Entity` — a corroborated lead stays a
   * candidate and is probed as a provisional subject — and it never moves a finding up the
   * confidence ladder. Everything it does is either a run (which costs a run and leaves a
   * capture on disk) or a prune (which `restore` undoes).
   */
  engine: {
    /** What it would do next, ranked, with the reasoning. Pure: nothing is queued by asking. */
    plan(caseId: string, req?: Partial<InvestigationRequest>): Promise<ActionRanking>
    /** Starts the loop and returns immediately; progress arrives on `onRun`. */
    run(req: InvestigationRequest): Promise<InvestigationRunState>
    cancel(): Promise<boolean>
    state(): Promise<InvestigationRunState | null>
    /** The running state summary: established, pending, contradicted, and what it wants next. */
    brief(caseId: string): Promise<InvestigationBrief>
    /** Every route from a seed to a node, with the mechanism of each hop. */
    chains(caseId: string): Promise<ProvenanceChain[]>
    chain(caseId: string, nodeId: string): Promise<ProvenanceChain | null>
    /**
     * Cut a node and everything whose only route ran through it.
     *
     * Candidates under the cut are dismissed, which is recoverable. Entities under it are
     * named in the result and **not touched** — removing one orphans its findings and
     * writes a tombstone, and that is the operator's decision to make.
     */
    prune(req: PruneRequest): Promise<PruneResult>
    restore(caseId: string, nodeId: string): Promise<PruneResult>
    /** Every automatic decision, newest first, each with the reason it states. */
    decisions(caseId: string, limit?: number): Promise<EngineDecision[]>
    onRun(cb: (state: InvestigationRunState) => void): () => void
  }
}

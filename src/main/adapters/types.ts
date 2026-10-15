/**
 * The adapter contract.
 *
 * An adapter is the app's only way to learn anything from the outside world. One file
 * per tool. Adding a tool means adding a file here and registering it; removing a tool
 * that has rotted means deleting one file. Nothing else in the app knows that Maigret,
 * holehe or exiftool exist.
 *
 * Two invariants are enforced at runtime, not merely typed:
 *
 *  1. **`doc` must be completely filled in.** The registry throws at startup on an empty
 *     field. This is a product requirement (DECISIONS.md: "An adapter without a
 *     filled-in doc does not ship") because the app's purpose is to teach the mechanism
 *     — the UI shows this panel beside every result, and a blank one makes the result
 *     a magic number.
 *  2. **An adapter can only ever emit `unverified`.** See `src/shared/confidence.ts`.
 *
 * The lifecycle of a run, driven by the orchestrator:
 *
 *   run(input, ctx)      -> RawResult          the tool executes; nothing is interpreted
 *   store.writeRaw(...)  -> RawPayload         output persisted verbatim, ALWAYS, even
 *                                              on failure/timeout/non-zero exit
 *   raw.raw = payload                          the payload is attached to the RawResult
 *   parse(raw)           -> Finding[]          interpretation, and only now
 *   finaliseFinding(...)                       ids stamped, confidence forced
 *
 * `parse` is deliberately pure and separate from `run`: it takes only a `RawResult`, so
 * a parser bug is fixed by re-parsing the raw files that are already on disk, with no
 * network access and no re-running of anything.
 */

import type {
  AdapterDoc,
  AdapterInfo,
  AppConfig,
  CaseId,
  Entity,
  EntityId,
  EntityKind,
  Finding,
  IsoTimestamp,
  JobProgress,
  MatcherQuality,
  RawPayload
} from '../../shared/types'
import { ADAPTER_DOC_FIELDS, DEFAULT_CONFIDENCE } from '../../shared/types'
import type { ProvenanceMechanism } from '../../shared/engine'
import { adapterConfidence, independenceKey, isDerivedSource } from '../../shared/confidence'
import { findingId as makeFindingId } from '../../shared/ids'

export type { AdapterDoc }

/* ------------------------------------------------------------------ *
 * Run I/O
 * ------------------------------------------------------------------ */

export interface AdapterInput {
  caseId: CaseId
  /** The entity the adapter was asked to work on. Its `kind` is guaranteed to be in `accepts`. */
  entity: Entity
  /** Merged from `config.adapters[id].options`, plus anything the caller passed for this run. */
  options: Record<string, unknown>
}

/**
 * The verbatim result of one execution.
 *
 * `ok === false` is not exceptional. Tools time out, get rate-limited, and exit 1 with
 * something useful on stderr constantly; that is data. A failed run is still persisted
 * and is still shown in the UI, because "Maigret was blocked by Cloudflare" is a finding
 * about the world even though it is not a finding about the subject.
 */
export interface RawResult {
  adapterId: string
  caseId: CaseId
  entityId: EntityId
  ok: boolean
  /** `null` when the process was killed or never started. */
  exitCode: number | null
  /** Set when the process was terminated by a signal (including our own timeout kill). */
  signal: string | null
  stdout: string
  stderr: string
  /** What `parse` should expect in `stdout`. */
  mediaType: string
  startedAt: IsoTimestamp
  finishedAt: IsoTimestamp
  durationMs: number
  /** `true` when output hit `maxOutputBytes` and was cut. Parsers must not assume valid JSON then. */
  truncated: boolean
  timedOut: boolean
  /** The command line, for the UI's "what did it actually run" disclosure. */
  command: { file: string; args: string[] } | null
  /** Human-readable failure reason when `ok` is false. */
  error: string | null
  /**
   * Pointer to the persisted copy of this output. Attached by the orchestrator between
   * `run` and `parse`, so `parse` can build complete `Finding` objects.
   */
  raw: RawPayload
}

export interface SpawnOptions {
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Written to the child's stdin and then closed. */
  stdin?: string
  /**
   * Called with each chunk of stdout as it arrives, so an adapter can report real
   * progress while the tool is still running.
   *
   * The chunk is exactly what the child wrote — no line buffering, no decoding beyond
   * UTF-8 — because a progress bar redrawn with `\r` never emits a newline and a
   * line-buffered callback would therefore never fire for the one tool that reports the
   * most. Handlers must be cheap and must not throw; a throwing handler is caught and
   * ignored so a progress bug cannot kill a run that is otherwise working.
   */
  onStdout?(chunk: string): void
  onStderr?(chunk: string): void
}

export interface SpawnResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  /** Set when the process could not be started at all (ENOENT etc.). */
  spawnError: string | null
}

/** Everything an adapter is allowed to touch. Adapters never import `fs`, `net` or `child_process`. */
export interface AdapterContext {
  caseId: CaseId
  /** Absolute path to `cases/<id>/`. Adapters may read from it; writes go through the store. */
  caseDir: string
  /** `<toolkitRoot>` — the Phase 0 toolbelt. */
  toolkitRoot: string
  config: AppConfig
  /** Aborted on user cancellation. Long-running adapters must honour it. */
  signal: AbortSignal
  timeoutMs: number
  /**
   * Run a child process. Timeout, process-tree kill, output capping and cancellation are
   * handled here so no adapter has to reimplement them (and get them wrong).
   */
  spawn(file: string, options?: SpawnOptions): Promise<SpawnResult>
  /** Progress the UI shows on the job row. */
  progress(p: JobProgress): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void
  now(): IsoTimestamp
}

/* ------------------------------------------------------------------ *
 * Entity proposals — what `produces` finally means
 * ------------------------------------------------------------------ */

/**
 * "This finding implies an entity that is not in the case yet."
 *
 * An adapter's `produces` list is a declaration of *capability*; this is the declaration
 * of *fact* for one run. Neither creates an entity. The orchestrator turns these into
 * `EntityCandidate` records that sit outside the graph until a human promotes them,
 * because a username hit is `unverified` by construction and most of them are anti-bot
 * redirects answering 200. Auto-promotion would corrupt the graph silently, and silently
 * is the only way this app is allowed to be wrong about nothing.
 *
 * `fromFindingId` must be the id of a finding this same run produced. The orchestrator
 * drops a proposal that names anything else rather than trusting it — the link between
 * a proposal and its evidence is the only reason a human can review it at all.
 */
export interface EntityProposal {
  /** The finding that implies this entity. `makeFinding(...).id` for the finding in question. */
  fromFindingId: string
  kind: EntityKind
  /** Raw value; the store canonicalises it. `platform/handle` for an account. */
  value: string
  label?: string
  attrs?: Record<string, unknown>
  /** One line, for the review UI: why this finding implies this entity. */
  rationale: string
  /**
   * **How** this run reached the thing it is naming — the provenance hop's mechanism.
   *
   * Declared here, by the adapter, because the adapter is the only thing in the app that
   * knows. It parsed the response; it knows whether the URL came out of an `<a rel="me">`
   * or out of a sentence in a bio, whether the account came off a site list or off a
   * profile page. Nothing downstream can recover that from the finished sentence.
   *
   * The engine used to infer it by regex over `rationale` and `claim`, and that was a
   * forgery hole: adapters embed page titles and search snippets verbatim, so any web
   * page that wrote "rel=me" in its `<title>` could mint the strongest provenance the
   * system has. Mechanism is now structural or it is not claimed at all.
   *
   * Omit it and the hop falls back to the adapter's own default route — see
   * `ADAPTER_MECHANISM` in `engine/provenance.ts`. Set it only where *this* proposal took
   * a different route from the rest of the adapter's output. `seed` and `promotion` are
   * refused: only a human, or the operator's own typing, mints a root.
   */
  mechanism?: ProvenanceMechanism
}

/* ------------------------------------------------------------------ *
 * The interface
 * ------------------------------------------------------------------ */

export interface Adapter {
  /** Stable, lowercase, filename-safe. Written into every `Finding.tool`, so never rename casually. */
  id: string
  /** Human name for the UI. Defaults to `id`. */
  title?: string
  /** The adapter's own version, bumped when `parse` changes shape. */
  version?: string

  /** Entity kinds this adapter can be pointed at. */
  accepts: EntityKind[]
  /** Entity kinds it can discover. May be empty for an adapter that only annotates. */
  produces: EntityKind[]

  /** True if it cannot run without a key in `config.adapters[id].options`. */
  requiresKey: boolean
  /** True if it touches the network. Drives the offline/air-gapped filter and the politeness caps. */
  requiresNetwork: boolean

  /**
   * Option keys whose *values* must never reach disk.
   *
   * `hibp-passwords` takes a live password. Its own `run()` is careful never to put it in
   * the envelope, but "careful" is a property of one author on one afternoon. The
   * orchestrator therefore scrubs every declared secret value out of the raw body before
   * writing it and out of any error message before reporting it, so the guarantee holds
   * even for an adapter that gets it wrong — and for the failure paths, where a stack
   * trace or a stderr tail is the thing most likely to carry an input by accident.
   */
  secretOptions?: string[]

  /** MANDATORY. All six fields, all non-empty. The registry throws otherwise. */
  doc: AdapterDoc

  /** Max simultaneous runs of THIS adapter. Defaults to the orchestrator's per-adapter cap. */
  concurrency?: number
  /** Minimum gap between two starts of this adapter. The politeness knob. */
  minIntervalMs?: number
  defaultTimeoutMs?: number

  /**
   * Cheap availability probe: is the binary present, is the key configured. Never
   * touches the network. Returning a string marks the adapter unavailable and shows the
   * string as the reason.
   */
  check?(ctx: Pick<AdapterContext, 'config' | 'toolkitRoot'>): string | null

  /** Execute. Must not interpret anything — that is `parse`'s job. */
  run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult>

  /**
   * Interpret a stored `RawResult` into findings. Pure: no I/O, no network, no clock
   * beyond `raw.finishedAt`. That purity is what makes re-parsing old raw files a
   * supported operation.
   */
  parse(raw: RawResult): Finding[]

  /**
   * Name the entities this run's findings imply, without creating any of them.
   *
   * Pure and re-derivable from the raw capture, exactly like `parse` — so the candidate
   * list can be rebuilt from files years later, and a proposal bug is a re-derivation
   * rather than a lost discovery. Must never throw: return `[]` for anything unreadable.
   *
   * Optional. An adapter with an empty `produces` has nothing to implement, and an
   * adapter that only annotates an entity the operator already has should not implement
   * it either.
   */
  propose?(raw: RawResult): EntityProposal[]
}

/* ------------------------------------------------------------------ *
 * Doc validation
 * ------------------------------------------------------------------ */

export class AdapterDocError extends Error {
  constructor(
    readonly adapterId: string,
    readonly field: string,
    message: string
  ) {
    super(message)
    this.name = 'AdapterDocError'
  }
}

export class AdapterRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterRegistrationError'
  }
}

/** Shortest acceptable doc field. Long enough to reject "TODO", "n/a", "-". */
export const MIN_DOC_FIELD_LENGTH = 12

const PLACEHOLDERS = /^(todo|tbd|n\/?a|none|-+|\?+|xxx+|fixme|later)$/i

/**
 * Enforce the doc contract. Called by the registry, so an adapter with a blank field
 * fails at startup rather than shipping a result with an empty explanation panel.
 *
 * Rejects: missing fields, non-strings, whitespace-only, obvious placeholders, and
 * anything shorter than `MIN_DOC_FIELD_LENGTH`. The length floor is the part that
 * actually bites — it is what stops `how: 'scrapes'` from passing.
 */
export function assertAdapterDoc(adapterId: string, doc: unknown): asserts doc is AdapterDoc {
  if (!doc || typeof doc !== 'object') {
    throw new AdapterDocError(adapterId, '<doc>', `Adapter "${adapterId}" has no doc object. All six fields (${ADAPTER_DOC_FIELDS.join(', ')}) are mandatory.`)
  }
  const d = doc as Record<string, unknown>
  for (const field of ADAPTER_DOC_FIELDS) {
    const v = d[field]
    if (typeof v !== 'string') {
      throw new AdapterDocError(
        adapterId,
        field,
        `Adapter "${adapterId}" is missing doc.${field}. Every adapter must explain what it does, how, why that works, what it is better and worse at, and how it lies to you.`
      )
    }
    const t = v.trim()
    if (!t) {
      throw new AdapterDocError(adapterId, field, `Adapter "${adapterId}" has an empty doc.${field}.`)
    }
    if (PLACEHOLDERS.test(t)) {
      throw new AdapterDocError(
        adapterId,
        field,
        `Adapter "${adapterId}" has a placeholder in doc.${field} (${JSON.stringify(t)}).`
      )
    }
    if (t.length < MIN_DOC_FIELD_LENGTH) {
      throw new AdapterDocError(
        adapterId,
        field,
        `Adapter "${adapterId}" doc.${field} is ${t.length} characters; at least ${MIN_DOC_FIELD_LENGTH} are required. Describe the mechanism, do not name it.`
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * Finding construction helpers, used inside parse()
 * ------------------------------------------------------------------ */

export interface DraftFindingInput {
  /** Defaults to the entity the run was about. Set it when the claim is about a discovered entity. */
  entityId?: EntityId
  /** The origin of the information, as the world names it. The corroboration key. */
  source: string
  /**
   * One sentence asserting something, in the tool's own terms.
   *
   * **Nothing that varies from one run to the next may go in here.** The claim is part of
   * the finding's identity — `findingId` hashes `(caseId, entityId, tool, source, claim)`
   * — so a response time, an HTTP status, an elapsed duration or a timestamp inside a
   * claim makes the *same assertion* a different finding every time it is re-observed.
   * The row is inserted rather than refreshed, `lastVerified` never moves off `null`, and
   * the case's claim count climbs with the number of re-runs. Sherlock ending every claim
   * with "Answered in 0.77 s." is what this note is written from.
   *
   * A per-run measurement belongs in `matcher` (excluded from the id, refreshed in place)
   * or in the run's own permanent capture — never here. A `local:<adapter>` run note is
   * the one place a per-run *summary* is the point, and even there the wording should
   * describe the run rather than pad the claim with mechanics.
   */
  claim: string
  evidenceRef?: string | null
  /**
   * How much the probe behind this claim was structurally capable of meaning.
   *
   * A property of the observation, not of the subject, and deliberately independent of
   * confidence — see `MatcherQuality` in `shared/types.ts`. Omit it (or pass `null`) for a
   * claim that did not come from probing a website; `support/matcher.ts` returns `null` for
   * exactly those cases, so passing its result straight through is correct.
   */
  matcher?: MatcherQuality | null
}

/**
 * Build a `Finding` from inside `parse()`.
 *
 * The confidence is not a parameter. It is `unverified`, always, by construction — an
 * adapter physically cannot express anything else through this helper, and
 * `finaliseFinding` rejects it if one tries to bypass the helper.
 *
 * `matcher` is: it says nothing about how much to believe the claim, only about whether
 * the observation was shaped to mean anything. It is left off the object entirely when
 * there is none, so a finding from an adapter that does not probe sites is byte-identical
 * in `findings.jsonl` to what it was before the classifier existed.
 */
export function makeFinding(raw: RawResult, draft: DraftFindingInput): Finding {
  const entityId = draft.entityId ?? raw.entityId
  return {
    id: makeFindingId(raw.caseId, entityId, raw.adapterId, draft.source, draft.claim),
    caseId: raw.caseId,
    entityId,
    source: draft.source,
    tool: raw.adapterId,
    claim: draft.claim,
    confidence: DEFAULT_CONFIDENCE,
    evidenceRef: draft.evidenceRef ?? null,
    firstSeen: raw.finishedAt,
    lastVerified: null,
    raw: raw.raw,
    ...(draft.matcher ? { matcher: draft.matcher } : {})
  }
}

/**
 * The corroboration key, decided here rather than trusted from the adapter.
 *
 * `Finding.source` is the independence key: two findings whose sources fold to one string
 * are one source and cannot corroborate each other. That guarantee used to rest on
 * nineteen adapters each remembering to call `siteOrigin()` before writing the field, and
 * six of them did not — `gallery-dl` sourced media at the CDN (`pbs.twimg.com`), so a site
 * and its own content host read as two independent sources for one fact; `wayback` and
 * `hibp-passwords` hardcoded hosts the fold would have changed; two adapters put the tool's
 * own name in the field, which is the one thing ARCHITECTURE §2 says the source may never
 * be.
 *
 * So it is folded at the seam. Every finding in the app goes through `finaliseFinding`,
 * which means one check covers the sixteen adapters that exist and every one added later,
 * and an adapter cannot opt out by forgetting.
 *
 * Two things are refused rather than folded, because neither has a right answer:
 *
 *  - **A tool name.** `subfinder(unattributed)` and `theharvester(crtsh+otx)` name the
 *    program, not the source. Folding cannot fix that — the string is a category error —
 *    and silently keeping it would let two runs of one tool corroborate each other. A
 *    claim that genuinely has no external source is `localSource(adapterId)`, which says
 *    the same thing honestly and can never be counted.
 *  - Nothing else. An unrecognised name (`searxng`, `HaveIBeenPwned`) passes through: it
 *    will not collide with another tool's name for the same service, so the worst case is
 *    a missed corroboration, never a fabricated one.
 *
 * Derived sources pass through untouched, prefix and letter case intact. `file:Holiday.JPG`
 * is a file name a person will read, and folding it to a host would collide every `local:`
 * claim in the app onto the hostname `local`.
 */
export function foldFindingSource(adapterId: string, source: string): string {
  const s = source.trim()
  if (isDerivedSource(s)) return s
  if (/[()]/.test(s) || s.toLowerCase() === adapterId.toLowerCase()) {
    throw new AdapterRegistrationError(
      `Adapter "${adapterId}" produced a finding sourced ${JSON.stringify(s)}. ` +
        `Finding.source is where the information came from — a hostname or a dataset — never the ` +
        `program that fetched it: keying on the tool would let two wrappers around one site list ` +
        `corroborate every false positive in it. A claim with no external source is ` +
        `localSource("${adapterId}"), which cannot be counted toward corroboration at all.`
    )
  }
  return independenceKey(s) || s
}

/**
 * Last gate before a parsed finding is written.
 *
 * Applied by the orchestrator to everything `parse()` returns, including from adapters
 * that built their objects by hand instead of using `makeFinding`. It throws — rather
 * than silently correcting — so a mistaken adapter is a loud startup-time bug, not a
 * quiet data-quality one. The exception is `source`, which is *folded* rather than
 * refused: see `foldFindingSource`.
 */
export function finaliseFinding(adapterId: string, raw: RawResult, f: Finding): Finding {
  if (f.caseId !== raw.caseId) {
    throw new AdapterRegistrationError(
      `Adapter "${adapterId}" produced a finding for case ${f.caseId} during a run on case ${raw.caseId}.`
    )
  }
  if (f.tool !== adapterId) {
    throw new AdapterRegistrationError(
      `Adapter "${adapterId}" produced a finding attributed to tool "${f.tool}".`
    )
  }
  if (!f.source?.trim()) {
    throw new AdapterRegistrationError(
      `Adapter "${adapterId}" produced a finding with no source. The source is the corroboration key; a finding without one can never be corroborated.`
    )
  }
  if (!f.claim?.trim()) {
    throw new AdapterRegistrationError(`Adapter "${adapterId}" produced a finding with an empty claim.`)
  }
  // Throws if the adapter tried to mint anything above `unverified`.
  const confidence = adapterConfidence(adapterId, f.confidence)
  // The independence key, decided here rather than trusted. The id is derived from the
  // folded value, so two adapters that named one site differently converge on one finding.
  const source = foldFindingSource(adapterId, f.source)
  // The spread carries `matcher` through untouched, and the id below is deliberately not
  // derived from it: the same assertion re-observed after the classifier changed is the
  // same finding with a better explanation attached, never a second row for one fact.
  return {
    ...f,
    confidence,
    source,
    tool: adapterId,
    raw: raw.raw,
    id: makeFindingId(raw.caseId, f.entityId, adapterId, source, f.claim)
  }
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>()

  /**
   * Register an adapter. Throws on:
   *   - a malformed or duplicate id
   *   - an empty `accepts`
   *   - a missing `run` or `parse`
   *   - **any incomplete `doc` field**
   *
   * All of these are startup-time failures on purpose. A half-registered adapter that
   * only misbehaves once you click it is much worse than an app that refuses to boot.
   */
  register(adapter: Adapter): Adapter {
    if (!adapter || typeof adapter !== 'object') {
      throw new AdapterRegistrationError('register() expects an adapter object.')
    }
    if (!ID_RE.test(adapter.id ?? '')) {
      throw new AdapterRegistrationError(
        `Invalid adapter id ${JSON.stringify(adapter.id)}. Use lowercase letters, digits, dot, dash or underscore.`
      )
    }
    if (this.adapters.has(adapter.id)) {
      throw new AdapterRegistrationError(`Adapter "${adapter.id}" is already registered.`)
    }
    if (!Array.isArray(adapter.accepts) || adapter.accepts.length === 0) {
      throw new AdapterRegistrationError(`Adapter "${adapter.id}" must declare at least one accepted entity kind.`)
    }
    if (!Array.isArray(adapter.produces)) {
      throw new AdapterRegistrationError(`Adapter "${adapter.id}" must declare a produces array (it may be empty).`)
    }
    if (typeof adapter.run !== 'function' || typeof adapter.parse !== 'function') {
      throw new AdapterRegistrationError(`Adapter "${adapter.id}" must implement both run() and parse().`)
    }
    if (typeof adapter.requiresKey !== 'boolean' || typeof adapter.requiresNetwork !== 'boolean') {
      throw new AdapterRegistrationError(
        `Adapter "${adapter.id}" must declare requiresKey and requiresNetwork as booleans.`
      )
    }
    if (
      adapter.secretOptions !== undefined &&
      (!Array.isArray(adapter.secretOptions) || adapter.secretOptions.some((k) => typeof k !== 'string' || !k.trim()))
    ) {
      throw new AdapterRegistrationError(
        `Adapter "${adapter.id}" declares secretOptions that is not an array of non-empty option keys.`
      )
    }
    // An adapter that proposes entities it never claimed it could discover would grow the
    // graph in a shape nothing in the UI describes. `produces` is the declaration; a
    // proposal is the evidence for it.
    if (typeof adapter.propose === 'function' && adapter.produces.length === 0) {
      throw new AdapterRegistrationError(
        `Adapter "${adapter.id}" implements propose() but declares an empty produces[]. Declare the kinds it can discover.`
      )
    }

    // The hard product requirement.
    assertAdapterDoc(adapter.id, adapter.doc)

    this.adapters.set(adapter.id, adapter)
    return adapter
  }

  get(id: string): Adapter | undefined {
    return this.adapters.get(id)
  }

  require(id: string): Adapter {
    const a = this.adapters.get(id)
    if (!a) throw new AdapterRegistrationError(`No adapter registered with id "${id}".`)
    return a
  }

  list(): Adapter[] {
    return [...this.adapters.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Adapters that can be pointed at this kind of entity. */
  forKind(kind: EntityKind): Adapter[] {
    return this.list().filter((a) => a.accepts.includes(kind))
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  size(): number {
    return this.adapters.size
  }

  /** Test-only. */
  clear(): void {
    this.adapters.clear()
  }

  /** Serialisable descriptions for the renderer, including availability. */
  describe(config: AppConfig, toolkitRoot: string): AdapterInfo[] {
    return this.list().map((a) => {
      const override = config.adapters[a.id] ?? {}
      let unavailableReason: string | null = null
      if (override.enabled === false) {
        unavailableReason = 'Disabled in config/local.config.json'
      } else if (a.check) {
        try {
          unavailableReason = a.check({ config, toolkitRoot })
        } catch (err) {
          unavailableReason = `check() threw: ${(err as Error).message}`
        }
      }
      return {
        id: a.id,
        title: a.title ?? a.id,
        version: a.version ?? '0.0.0',
        accepts: a.accepts,
        produces: a.produces,
        requiresKey: a.requiresKey,
        requiresNetwork: a.requiresNetwork,
        doc: a.doc,
        secretOptions: [...(a.secretOptions ?? [])],
        proposes: typeof a.propose === 'function',
        concurrency: override.concurrency ?? a.concurrency ?? config.orchestrator.defaultConcurrencyPerAdapter,
        minIntervalMs: override.minIntervalMs ?? a.minIntervalMs ?? 0,
        defaultTimeoutMs: override.timeoutMs ?? a.defaultTimeoutMs ?? config.orchestrator.defaultTimeoutMs,
        available: unavailableReason === null,
        unavailableReason
      }
    })
  }
}

/** The process-wide registry. */
export const registry = new AdapterRegistry()

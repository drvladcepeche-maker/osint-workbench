/**
 * The job queue.
 *
 * One place decides when a tool is allowed to run, how long it may run for, and what
 * happens to its output. Adapters never touch a scheduler, a clock, or the filesystem.
 *
 * What it guarantees:
 *
 *  - **Concurrency caps**, globally and per adapter. Per-adapter matters more than
 *    global: without it a 3000-site Maigret sweep occupies every slot and nothing else
 *    in the case ever starts.
 *  - **Rate limiting** via `minIntervalMs` per adapter. This is the politeness knob —
 *    the difference between "looked someone up" and "hammered a site".
 *  - **Timeout + process-tree kill.** See `spawn.ts`.
 *  - **Raw output is persisted before parsing, always** — including for runs that timed
 *    out, exited non-zero, or crashed the parser. A parser bug then costs a re-parse,
 *    never data.
 *  - **Cancellation** of one job, or every job in a case, with the child tree killed.
 *  - **Progress events**, emitted for every state transition and forwarded to the UI.
 *
 * Failure policy: a job never throws out of the orchestrator. Everything becomes a
 * terminal job state with an `error` string, because in this domain failure is the
 * common case and it is itself informative.
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Database as Db } from 'better-sqlite3'
import {
  isEntityKind,
  isTerminalJobState,
  type AppConfig,
  type Entity,
  type Finding,
  type Job,
  type JobProgress,
  type JobState
} from '../shared/types'
import { jobId as makeJobId } from '../shared/ids'
import {
  finaliseFinding,
  makeFinding,
  type Adapter,
  type AdapterContext,
  type AdapterRegistry,
  type RawResult
} from './adapters/types'
import { localSource } from './adapters/support/sources'
import { isDerivedSource } from '../shared/confidence'
import type { CaseStore } from './store/caseStore'
import { upsertCandidateRow, upsertEntityRow, upsertFindingRow } from './db'
import { runProcess, stderrTail } from './spawn'

export interface OrchestratorEvents {
  'job:update': (job: Job) => void
  'job:log': (entry: { jobId: string; level: string; message: string; at: string }) => void
}

export interface EnqueueRequest {
  caseId: string
  entityId: string
  adapterId: string
  options?: Record<string, unknown>
  /** Overrides the adapter and config defaults. */
  timeoutMs?: number
  /**
   * A subject that is **not in the case's graph**, supplied by the caller.
   *
   * Added for the investigation engine and used by nothing else. The engine reaches nodes
   * that are `EntityCandidate`s — discovered, corroborated, and deliberately *not*
   * promoted, because automation is never allowed to mint an `Entity`. Running a tool
   * against one still needs a subject, and the alternatives were both worse: promoting it
   * (the one thing the architecture forbids) or building a second run path outside this
   * class (a second scheduler, with its own caps and its own bugs).
   *
   * So the caller hands over an entity-shaped object and nothing writes it to
   * `entities.json`. The findings it produces are **orphaned** in exactly the sense this
   * codebase already has a word for — a claim about something the case does not hold — and
   * the findings table already marks them as such. Because `EntityCandidate.id` is
   * content-addressed with the same formula as `EntityId`, promoting the candidate later
   * attaches every one of those findings to the new entity with no rewriting.
   *
   * A stored entity always wins: this is a fallback for an id the store does not have, not
   * an override of one it does.
   */
  subject?: Entity
}

interface QueueEntry {
  job: Job
  request: EnqueueRequest
  controller: AbortController
  resolve: (job: Job) => void
}

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrchestratorError'
  }
}

/** What replaces a secret option's value anywhere it would otherwise have been written. */
export const REDACTED = '[redacted: never written to disk]'

/**
 * Every string that must not survive a run.
 *
 * For each option key an adapter declared secret: the value itself, and its SHA-1 in
 * both cases. The hash is included because for `hibp-passwords` a full SHA-1 of a
 * human-chosen password is an offline cracking job rather than a secret — storing it
 * would defeat the exact property the k-anonymity design exists to provide.
 */
function secretStrings(adapter: Adapter, config: AppConfig, perRun: Record<string, unknown>): string[] {
  const keys = adapter.secretOptions ?? []
  if (!keys.length) return []
  const configured = config.adapters[adapter.id]?.options ?? {}
  const out: string[] = []
  for (const key of keys) {
    for (const bag of [configured, perRun]) {
      const v = (bag as Record<string, unknown>)[key]
      if (typeof v !== 'string' || !v) continue
      const hash = createHash('sha1').update(v, 'utf8').digest('hex')
      out.push(v, hash.toUpperCase(), hash.toLowerCase())
    }
  }
  // Longest first: redacting a value that contains another leaves no fragment behind.
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

/**
 * Blind substring replacement, and deliberately so.
 *
 * It over-redacts: a secret that happens to occur inside unrelated text takes that text
 * with it. Testing the canonical string `password` against Pwned Passwords rewrites the
 * recorded URL as `https://api.pwned[redacted…]s.com/range/5BAA6`, which looks wrong and
 * is. The alternative — matching only whole tokens, or only certain fields — leaks the
 * moment a tool embeds the value somewhere the rule did not anticipate, which is exactly
 * the case this exists for.
 *
 * So the error direction is chosen the same way `support/sources.ts` chooses its folding:
 * a mangled URL is visible, self-describing and recoverable; a leaked password is
 * permanent. The marker says what happened, so a reader is never left guessing why a
 * string looks wrong.
 */
function scrub(text: string, secrets: readonly string[]): string {
  if (!secrets.length || !text) return text
  let out = text
  for (const s of secrets) out = out.split(s).join(REDACTED)
  return out
}

export class Orchestrator extends EventEmitter {
  private readonly queue: QueueEntry[] = []
  private readonly active = new Map<string, QueueEntry>()
  private readonly jobs = new Map<string, Job>()
  /** Last start time per adapter id, for `minIntervalMs`. */
  private readonly lastStart = new Map<string, number>()
  private pumpTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly deps: {
      registry: AdapterRegistry
      store: CaseStore
      db: Db
      config: AppConfig
      toolkitRoot: string
    }
  ) {
    super()
  }

  /* ---------------- public API ---------------- */

  listJobs(caseId?: string): Job[] {
    const all = [...this.jobs.values()]
    return (caseId ? all.filter((j) => j.caseId === caseId) : all).sort((a, b) =>
      b.queuedAt.localeCompare(a.queuedAt)
    )
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /**
   * Queue a run. Returns immediately with a `queued` job; the promise on `whenSettled`
   * resolves when the job reaches a terminal state.
   */
  enqueue(request: EnqueueRequest): { job: Job; whenSettled: Promise<Job> } {
    const adapter = this.deps.registry.get(request.adapterId)
    if (!adapter) throw new OrchestratorError(`No adapter "${request.adapterId}".`)
    if (this.deps.config.adapters[adapter.id]?.enabled === false) {
      throw new OrchestratorError(`Adapter "${adapter.id}" is disabled in config.`)
    }

    const job: Job = {
      id: makeJobId(),
      caseId: request.caseId,
      entityId: request.entityId,
      adapterId: request.adapterId,
      state: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: {},
      findingIds: [],
      error: null,
      rawId: null
    }
    this.jobs.set(job.id, job)

    let resolve!: (j: Job) => void
    const whenSettled = new Promise<Job>((r) => {
      resolve = r
    })

    this.queue.push({ job, request, controller: new AbortController(), resolve })
    this.emitUpdate(job)
    this.pump()
    return { job, whenSettled }
  }

  /** Cancel one job, queued or running. Running children are killed as a tree. */
  cancel(jobId: string): boolean {
    const queuedIdx = this.queue.findIndex((q) => q.job.id === jobId)
    if (queuedIdx >= 0) {
      const [entry] = this.queue.splice(queuedIdx, 1)
      if (entry) this.settle(entry, 'cancelled', 'Cancelled before it started.')
      return true
    }
    const running = this.active.get(jobId)
    if (running) {
      running.controller.abort()
      return true
    }
    return false
  }

  /** Cancel everything belonging to one case. */
  cancelCase(caseId: string): number {
    let n = 0
    for (const j of this.listJobs(caseId)) {
      if (!isTerminalJobState(j.state) && this.cancel(j.id)) n++
    }
    return n
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    for (const entry of this.active.values()) entry.controller.abort()
    while (this.queue.length) {
      const entry = this.queue.pop()
      if (entry) this.settle(entry, 'cancelled', 'Shutting down.')
    }
  }

  /* ---------------- scheduling ---------------- */

  private effective(adapter: Adapter): { concurrency: number; minIntervalMs: number; timeoutMs: number } {
    const cfg = this.deps.config
    const o = cfg.adapters[adapter.id] ?? {}
    return {
      concurrency: o.concurrency ?? adapter.concurrency ?? cfg.orchestrator.defaultConcurrencyPerAdapter,
      minIntervalMs: o.minIntervalMs ?? adapter.minIntervalMs ?? 0,
      timeoutMs: o.timeoutMs ?? adapter.defaultTimeoutMs ?? cfg.orchestrator.defaultTimeoutMs
    }
  }

  private activeCountFor(adapterId: string): number {
    let n = 0
    for (const e of this.active.values()) if (e.job.adapterId === adapterId) n++
    return n
  }

  /**
   * Start whatever is eligible.
   *
   * Scans the queue in order but skips entries blocked by their own adapter's caps, so a
   * saturated adapter never head-of-line-blocks a different one. When something is
   * blocked only by a rate limit, a timer is armed for exactly when it becomes eligible
   * rather than polling.
   */
  private pump(): void {
    if (this.disposed) return
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
    }

    const globalCap = this.deps.config.orchestrator.globalConcurrency
    let nextWakeIn = Infinity

    for (let i = 0; i < this.queue.length && this.active.size < globalCap; ) {
      const entry = this.queue[i]
      if (!entry) break
      const adapter = this.deps.registry.get(entry.job.adapterId)
      if (!adapter) {
        this.queue.splice(i, 1)
        this.settle(entry, 'failed', `Adapter "${entry.job.adapterId}" disappeared from the registry.`)
        continue
      }

      const { concurrency, minIntervalMs } = this.effective(adapter)
      if (this.activeCountFor(adapter.id) >= concurrency) {
        i++
        continue
      }

      if (minIntervalMs > 0) {
        const last = this.lastStart.get(adapter.id) ?? 0
        const waitFor = last + minIntervalMs - Date.now()
        if (waitFor > 0) {
          nextWakeIn = Math.min(nextWakeIn, waitFor)
          i++
          continue
        }
      }

      this.queue.splice(i, 1)
      this.lastStart.set(adapter.id, Date.now())
      void this.execute(entry, adapter)
    }

    if (nextWakeIn !== Infinity && this.queue.length) {
      // Deliberately NOT unref'd. This timer owns the promise of every rate-limited job
      // still in the queue; unref'ing it lets Node exit with work silently abandoned,
      // which is invisible under Electron (the app holds the loop) and fatal anywhere
      // else. `dispose()` is what stops it.
      this.pumpTimer = setTimeout(() => this.pump(), Math.max(10, Math.ceil(nextWakeIn)))
    }
  }

  /* ---------------- execution ---------------- */

  private async execute(entry: QueueEntry, adapter: Adapter): Promise<void> {
    const { store, db, config, toolkitRoot } = this.deps
    const { job, controller } = entry
    this.active.set(job.id, entry)

    job.state = 'running'
    job.startedAt = new Date().toISOString()
    this.emitUpdate(job)

    const { timeoutMs } = this.effective(adapter)
    const effectiveTimeout = entry.request.timeoutMs ?? timeoutMs
    const options = entry.request.options ?? {}
    const secrets = secretStrings(adapter, config, options)

    // Belt and braces: even an adapter that ignores ctx.signal and never spawns a child
    // must not be able to hang the queue.
    const watchdog = setTimeout(() => controller.abort(), effectiveTimeout + 5_000)

    let raw: RawResult | null = null

    try {
      // The store first, always. A provisional subject is a fallback for an id the case
      // does not hold, never a way to run against a different thing than the graph says.
      const stored = await store.getEntity(job.caseId, job.entityId)
      const provisional = entry.request.subject
      const entity =
        stored ??
        (provisional && provisional.caseId === job.caseId && provisional.id === job.entityId ? provisional : null)
      if (!entity) throw new Error(`Entity ${job.entityId} is not in case ${job.caseId}.`)
      if (!adapter.accepts.includes(entity.kind)) {
        throw new Error(`Adapter "${adapter.id}" does not accept entities of kind "${entity.kind}".`)
      }

      const ctx: AdapterContext = {
        caseId: job.caseId,
        caseDir: store.dir(job.caseId),
        toolkitRoot,
        config,
        signal: controller.signal,
        timeoutMs: effectiveTimeout,
        spawn: (file, options) =>
          runProcess(file, {
            ...options,
            timeoutMs: options?.timeoutMs ?? effectiveTimeout,
            maxOutputBytes: config.orchestrator.maxOutputBytes,
            signal: controller.signal
          }),
        progress: (p: JobProgress) => {
          job.progress = { ...job.progress, ...p }
          this.emitUpdate(job)
        },
        log: (level, message, data) => {
          this.emit('job:log', { jobId: job.id, level, message, at: new Date().toISOString() })
          if (data !== undefined) {
            this.emit('job:log', {
              jobId: job.id,
              level,
              message: typeof data === 'string' ? data : JSON.stringify(data),
              at: new Date().toISOString()
            })
          }
        },
        now: () => new Date().toISOString()
      }

      raw = await adapter.run({ caseId: job.caseId, entity, options }, ctx)
      raw = { ...raw, adapterId: adapter.id, caseId: job.caseId, entityId: entity.id }
    } catch (err) {
      const cancelled = controller.signal.aborted
      // The run threw. Synthesise a RawResult so the failure is still persisted and
      // visible in the case file — "this tool crashed on this input" is a durable fact
      // about the tool, and losing it means rediscovering it every time.
      const at = new Date().toISOString()
      raw = {
        adapterId: adapter.id,
        caseId: job.caseId,
        entityId: job.entityId,
        ok: false,
        exitCode: null,
        signal: cancelled ? 'SIGKILL' : null,
        stdout: '',
        stderr: (err as Error).stack ?? String(err),
        mediaType: 'text/plain',
        startedAt: job.startedAt ?? at,
        finishedAt: at,
        durationMs: 0,
        truncated: false,
        timedOut: false,
        command: null,
        error: (err as Error).message,
        raw: { rawId: '', path: '', sha256: '', bytes: 0, mediaType: 'text/plain', excerpt: '' }
      }
    }

    clearTimeout(watchdog)
    this.active.delete(job.id)

    // A declared secret must not survive the run in any form, on any path. The failure
    // paths matter most: a stack trace, a stderr tail or a command line is where an input
    // ends up by accident, and this is applied before anything is written or reported.
    //
    // It also happens **before `parse()`**, and that is load-bearing rather than
    // incidental: `parse` is pure and sees nothing but this object, so a parser
    // physically cannot put the secret into a claim. The findings inherit the guarantee
    // from the structure instead of from every parser author remembering it.
    if (secrets.length) {
      raw = {
        ...raw,
        stdout: scrub(raw.stdout, secrets),
        stderr: scrub(raw.stderr, secrets),
        error: raw.error ? scrub(raw.error, secrets) : raw.error,
        command: raw.command
          ? { file: scrub(raw.command.file, secrets), args: raw.command.args.map((a) => scrub(a, secrets)) }
          : null
      }
    }

    // --- persist raw, unconditionally ---
    try {
      const body =
        raw.mediaType.includes('json') && raw.ok
          ? raw.stdout
          : JSON.stringify(
              {
                adapterId: raw.adapterId,
                caseId: raw.caseId,
                entityId: raw.entityId,
                ok: raw.ok,
                exitCode: raw.exitCode,
                signal: raw.signal,
                timedOut: raw.timedOut,
                truncated: raw.truncated,
                command: raw.command,
                error: raw.error,
                startedAt: raw.startedAt,
                finishedAt: raw.finishedAt,
                durationMs: raw.durationMs,
                stdout: raw.stdout,
                stderr: raw.stderr
              },
              null,
              2
            )
      const mediaType = raw.mediaType.includes('json') && raw.ok ? raw.mediaType : 'application/json'
      const payload = await store.writeRaw(job.caseId, body, { mediaType })
      raw = { ...raw, raw: payload }
      job.rawId = payload.rawId
    } catch (err) {
      this.emit('job:log', {
        jobId: job.id,
        level: 'error',
        message: `Failed to persist raw output: ${(err as Error).message}`,
        at: new Date().toISOString()
      })
    }

    if (controller.signal.aborted && !raw.ok) {
      this.settle(entry, 'cancelled', raw.error ?? 'Cancelled.')
      this.pump()
      return
    }

    // A run that did not succeed still has something to say, and until now nothing heard
    // it: the job settled `failed` here and returned, before the only `parse()` call in
    // the app. Every refusal template an adapter had written for exactly this case was
    // dead code — `websearch`'s "all N queries were refused by every backend … this is a
    // fact about the search engines, not about the person" is reachable only when
    // `ok: served > 0` is false, which is the branch that used to return above.
    //
    // So the run's outcome decides the job's **state**, not whether its capture is
    // interpreted. What lands from a failed run is filtered, though, and the filter is the
    // point rather than caution: only **derived** claims are kept. A `local:` claim is the
    // app describing its own experience — "archive.today refused every mirror" — which is
    // true regardless of the exit code. A site-sourced claim from a failed run would be an
    // observation about the world made by a run that did not observe the world, and that
    // is how "the listing endpoint returned 403" becomes "the account has no public posts".
    const failure = raw.ok
      ? null
      : {
          state: (raw.timedOut ? 'timeout' : 'failed') as 'timeout' | 'failed',
          message: [raw.error ?? `exit code ${raw.exitCode}`, stderrTail(raw.stderr)].filter(Boolean).join('\n')
        }

    // --- parse ---
    let findings: Finding[] = []
    try {
      findings = adapter.parse(raw).map((f) => finaliseFinding(adapter.id, raw as RawResult, f))
      if (failure) findings = findings.filter((f) => isDerivedSource(f.source))
    } catch (err) {
      // The raw output is already safe on disk, so this is recoverable: fix the parser,
      // re-parse. That is exactly why parse() is pure and separate from run().
      const note = `Parser threw: ${(err as Error).message}\nRaw output is preserved at ${raw.raw.path} and can be re-parsed once the parser is fixed.`
      // A parser that throws on a failed capture has not lost anything the run was going
      // to produce, so the run's own failure stays the headline and the parser note sits
      // under it. Overwriting it would hide why the run failed behind why the parse did.
      this.settle(entry, failure?.state ?? 'failed', failure ? `${failure.message}\n${note}` : note)
      this.pump()
      return
    }

    // Every failed run leaves a durable record, whether or not its adapter had a refusal
    // template. A red job row lives in memory and is gone when the window closes; the
    // brief, the planner, the export and the yield table read `findings.jsonl` and would
    // otherwise see a case where the tool was simply never run. `local:` sourced, so it
    // can never be counted toward corroboration — it is a fact about the run, not about
    // the subject.
    if (failure && !findings.length) {
      findings = [
        finaliseFinding(
          adapter.id,
          raw as RawResult,
          makeFinding(raw as RawResult, {
            source: localSource(adapter.id),
            claim:
              `${adapter.id} did not complete against ${job.entityId}: ${failure.message.split('\n')[0]}. ` +
              `Nothing was learned about the subject from this run, and nothing here may be read as an absence — ` +
              `the tool failing to answer is not the site answering "no".`
          })
        )
      ]
    }

    // --- persist findings ---
    try {
      for (const f of findings) {
        const { finding } = await store.upsertFinding(job.caseId, {
          entityId: f.entityId,
          source: f.source,
          tool: f.tool,
          claim: f.claim,
          raw: f.raw,
          evidenceRef: f.evidenceRef,
          // Carried explicitly: `upsertFinding` rebuilds the record from these fields, so
          // anything not named here never reaches findings.jsonl.
          matcher: f.matcher ?? null,
          at: raw.finishedAt
        })
        upsertFindingRow(db, finding)
        job.findingIds.push(finding.id)
      }
      // Keep the index in step with any entity the adapter enriched.
      const entity = await store.getEntity(job.caseId, job.entityId)
      if (entity) upsertEntityRow(db, entity as Entity)
    } catch (err) {
      const note = `Failed to write findings: ${(err as Error).message}`
      this.settle(entry, failure?.state ?? 'failed', failure ? `${failure.message}\n${note}` : note)
      this.pump()
      return
    }

    // A failed run stops here. Its refusal is on disk and readable by everything that
    // reads the case; what it does not get is a candidate queue entry. A proposal is a
    // discovery the operator is asked to approve, and a run that did not complete has not
    // discovered anything — the partial output of a tool that was blocked, killed or timed
    // out is exactly the material this app refuses to promote on.
    if (failure) {
      this.settle(entry, failure.state, failure.message)
      this.pump()
      return
    }

    // --- propose discovered entities, and create none of them ---
    //
    // This is what `produces` finally means. The adapter names the entities its findings
    // imply; they land in the candidate queue and stay outside the graph until a human
    // promotes one. Auto-creating them would be the single fastest way to fill a case with
    // anti-bot false positives and make every later run point at things nobody looked at.
    //
    // A failure here never fails the job: the findings are already on disk, and a
    // proposal is re-derivable from the raw capture by definition.
    try {
      await this.recordProposals(job, adapter, raw, findings)
    } catch (err) {
      this.emit('job:log', {
        jobId: job.id,
        level: 'error',
        message: `propose() failed for ${adapter.id}; findings are unaffected and proposals can be re-derived from ${raw.raw.path}: ${(err as Error).message}`,
        at: new Date().toISOString()
      })
    }

    this.settle(entry, 'done', null)
    this.pump()
  }

  /**
   * Turn an adapter's `EntityProposal[]` into candidates.
   *
   * Three things are checked rather than trusted, because a proposal is the one place an
   * adapter gets to name something the operator never typed:
   *
   *  - the kind must be a real `EntityKind`;
   *  - `fromFindingId` must name a finding *this run* produced, so every candidate in the
   *    queue has visible evidence behind it;
   *  - anything that is already an `Entity` is skipped — it is in the graph, so proposing
   *    it again would ask the operator to approve something he already has.
   */
  private async recordProposals(
    job: Job,
    adapter: Adapter,
    raw: RawResult,
    findings: readonly Finding[]
  ): Promise<void> {
    if (typeof adapter.propose !== 'function') return
    const { store, db } = this.deps
    const proposals = adapter.propose(raw)
    if (!proposals.length) return

    const byId = new Map(findings.map((f) => [f.id, f]))
    const existing = new Set((await store.readEntities(job.caseId)).map((e) => e.id))
    const at = raw.finishedAt

    for (const p of proposals) {
      if (!isEntityKind(p.kind) || typeof p.value !== 'string' || !p.value.trim()) continue
      const from = byId.get(p.fromFindingId)
      if (!from) {
        this.emit('job:log', {
          jobId: job.id,
          level: 'warn',
          message: `${adapter.id} proposed a ${p.kind} citing finding ${p.fromFindingId}, which this run did not produce. Dropped — a candidate without its evidence cannot be reviewed.`,
          at: new Date().toISOString()
        })
        continue
      }

      const { candidate } = await store.proposeCandidate(job.caseId, {
        kind: p.kind,
        value: p.value,
        label: p.label,
        attrs: p.attrs,
        proposal: {
          findingId: from.id,
          tool: from.tool,
          source: from.source,
          rationale: (p.rationale || from.claim).slice(0, 400),
          // Carried verbatim and validated where it is used, not here: `mechanismFor`
          // refuses anything that is not a real mechanism and refuses the two root
          // mechanisms outright, so a bad value degrades to the adapter's default rather
          // than being silently dropped at the boundary.
          ...(p.mechanism ? { mechanism: p.mechanism } : {}),
          at
        }
      })

      if (existing.has(candidate.id)) {
        // Already in the graph. Keep the proposal on disk — it is a true record that a
        // tool found this — but mark it decided so it never appears in the review queue.
        const promoted = await store.decideCandidate(job.caseId, candidate.id, 'promoted', at)
        upsertCandidateRow(db, promoted)
        continue
      }
      upsertCandidateRow(db, candidate)
    }
  }

  private settle(entry: QueueEntry, state: JobState, error: string | null): void {
    const job = entry.job
    job.state = state
    job.error = error
    job.finishedAt = new Date().toISOString()
    if (state === 'done') job.progress = { ...job.progress, pct: 100 }
    this.active.delete(job.id)
    this.emitUpdate(job)
    entry.resolve(job)
  }

  private emitUpdate(job: Job): void {
    this.emit('job:update', { ...job, findingIds: [...job.findingIds] })
  }
}

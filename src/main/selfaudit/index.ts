/**
 * The Self-Audit engine.
 *
 * This is the feature the whole project was started for: *"seeing the information I have
 * on me."* It runs the same subject five times against escalating starting knowledge and
 * reports what each additional fact unlocked.
 *
 * ## Five case folders, not one case with a filter
 *
 * `basis: 'self'`, one case per level, named `Self-Audit L0` … `Self-Audit L4`. The
 * mapping from level to case id lives in the vault so a level's history survives a rename
 * and so the same folder is reused on every re-run — which is what makes the re-scan diff
 * possible at all.
 *
 * A filter over a single shared case would be cheaper and would be wrong. The question a
 * level asks is *what does this starting knowledge yield*, and a shared graph leaks L4's
 * discoveries into L0's answer the moment anything is promoted. Separate folders also mean
 * L0's folder is greppable proof that L0 never saw a phone number, which is the property
 * that makes the simulation honest rather than decorative.
 *
 * ## What is deliberately not automated
 *
 * - **Nothing is promoted.** Every finding a level produces is `unverified`, and every
 *   account an adapter discovers lands in the candidate queue exactly as it does in a
 *   normal case. The self-audit gets no special path through the confidence ladder;
 *   DECISIONS.md's "a single tool hit is never better than unverified" has no exception
 *   for the subject being yourself.
 * - **`hibp-passwords` never runs.** Its input is a live password and its option is
 *   declared secret. A sweep that quietly asked for one would be exactly the kind of thing
 *   this app exists to be the opposite of.
 * - **No adapter that requires a key runs**, because DECISIONS.md #10 says there are no
 *   paid services, so a key-requiring adapter is by definition unconfigured.
 *
 * ## The write path for personal data
 *
 * The profile is in the vault (see `vault.ts`). A level's case receives only the seeds it
 * is entitled to. Beyond that, seed values reach exactly three places, all of them
 * intended: `entities.json` in that level's case, the raw captures of the tools that were
 * pointed at them (which is the argument the tool was given, and the whole point), and the
 * snapshots, which have to name the seed to explain the delta.
 *
 * They reach **no log**. Nothing in this module logs a seed value at any level, no error
 * message here interpolates one, and a test drives a run while recording every `job:log`
 * the orchestrator emits and asserts none of them contains a seed.
 */

import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  SELF_AUDIT_LEVELS,
  buildLetterDefaults,
  emptyProfile,
  levelSpec,
  type ExposureReport,
  type GdprLetter,
  type GdprLetterRequest,
  type PlannedRun,
  type RemoveSeedRequest,
  type RescanDiff,
  type ResetPathMap,
  type SavedLetter,
  type SeedFieldId,
  type SeedRemoval,
  type SeedUsage,
  type SeedUsageInCase,
  type SelfAuditDelta,
  type SelfAuditLevel,
  type SelfAuditLevelState,
  type SelfAuditPlan,
  type SelfAuditProfile,
  type SelfAuditRunRequest,
  type SelfAuditRunState,
  type SelfAuditSnapshot,
  type SelfAuditState,
  type SnapshotRef,
  type SnapshotSeed
} from '../../shared/selfaudit'
import { seedField } from '../../shared/selfaudit'
import { entityId as makeEntityId, ulid } from '../../shared/ids'
import { normaliseEntityValue } from '../../shared/normalise'
import { upsertEntityRow } from '../db'
import type { Entity, EntityKind, Job } from '../../shared/types'
import type { OsintService } from '../service'
import { SeedVault, missingFor, seedsForLevel } from './vault'
import { buildSnapshot, listSnapshots, snapshotRef, writeSnapshot } from './snapshot'
import { computeDelta } from './delta'
import { computeRescan } from './rescan'
import { buildResetPaths } from './resetpaths'
import { buildReport } from './report'
import { buildLetter, findContact, listContacts } from './gdpr'

export { findContact, listContacts }

/** Adapters the self-audit never runs, and why. */
const NEVER_RUN = new Map<string, string>([
  ['echo', 'The self-test adapter. It asserts nothing about the world.'],
  [
    'hibp-passwords',
    'Its input is a live password typed at the moment of use. A sweep that asked for one automatically would be the opposite of what this app is for.'
  ]
])

/**
 * Run last, on its own, because these re-read the captures the others just made.
 *
 * Every correlator that opens `ctx.caseDir` belongs here, not only the obvious one. Run
 * concurrently with the collectors, a correlator reads whatever the folder happened to
 * hold when it started: on a first run, nothing; on a second, the *previous* run's output.
 * That is bad on its own and worse inside the delta — whichever level ran second gets
 * correlator output the first lacked, and the difference is then reported as reach the
 * seed unlocked.
 *
 * `pivot` and `profile-enrich` read `entities.json`, `candidates.jsonl` and the whole
 * `raw/` directory; `pattern-timezone` re-reads the captures for timestamps. All three
 * also run once per level rather than once per seed, because they read the case rather
 * than the entity they are pointed at.
 */
const SECOND_PHASE = ['pattern-timezone', 'pivot', 'profile-enrich']

export class SelfAudit extends EventEmitter {
  private readonly vault: SeedVault
  private run: SelfAuditRunState | null = null
  private cancelling = false

  constructor(private readonly service: OsintService) {
    super()
    this.vault = new SeedVault(service.loaded.paths.casesDir)
  }

  /* ---------------- profile ---------------- */

  async profile(): Promise<SelfAuditProfile> {
    return this.vault.read()
  }

  async saveProfile(input: unknown): Promise<SelfAuditProfile> {
    return this.vault.write(input)
  }

  async clearProfile(): Promise<SelfAuditProfile> {
    return this.vault.clear()
  }

  /**
   * Which levels materialised one seed value, and what is attached to it there.
   *
   * Read-only, and the thing the confirmation is built out of. A value typed and never
   * run against is in no case at all and comes back with an empty list, which is what
   * lets the UI remove it without asking.
   */
  async seedUsage(field: SeedFieldId, value: string): Promise<SeedUsage> {
    const profile = await this.vault.read()
    const spec = seedField(field)
    const target = value.trim()
    const inVault = (profile.values[field] ?? []).some((v) => v.toLowerCase() === target.toLowerCase())
    const links = await this.vault.readLinks()
    const cases: SeedUsageInCase[] = []

    for (const level of SELF_AUDIT_LEVELS) {
      // A level only ever received the fields it is entitled to, so a level below the one
      // this field enters at cannot be holding it.
      if (level.level < spec.level) continue
      const caseId = links.cases[level.code]
      if (!caseId || !(await this.caseExists(caseId))) continue
      const entityId = makeEntityId(caseId, spec.kind, normaliseEntityValue(spec.kind, target).value)
      const entity = await this.service.store.getEntity(caseId, entityId)
      if (!entity) continue
      const summary = await this.service.getCase(caseId)
      const usage = await this.service.entityUsage(caseId, entityId)
      cases.push({
        level: level.level,
        code: level.code,
        caseId,
        caseName: summary?.name ?? caseId,
        entityId,
        findings: usage?.findings ?? 0
      })
    }

    return {
      field,
      value: target,
      kind: spec.kind,
      inVault,
      cases,
      findings: cases.reduce((n, c) => n + c.findings, 0)
    }
  }

  /**
   * Remove one value from the vault, and optionally from the level cases it reached.
   *
   * The two halves are deliberately separate. Removing it from the vault is clean and
   * always happens: the file stops holding it, and because every level reads the vault at
   * the moment it runs, the level is immediately re-runnable without it — no stale seed,
   * no re-materialisation.
   *
   * The level *case* is an audit trail with raw captures behind it, so deleting the
   * entity there is a second decision the caller has to ask for. When it is asked for, it
   * goes through `service.deleteEntity`, which keeps the findings and orphans them like
   * any other removal — the same rule everywhere, rather than a special one for seeds.
   */
  async removeSeed(req: RemoveSeedRequest): Promise<SeedRemoval> {
    const usage = await this.seedUsage(req.field, req.value)
    const profile = await this.vault.removeValue(req.field, req.value)

    const purged: SeedRemoval['purged'] = []
    const kept: SeedUsageInCase[] = []
    for (const c of usage.cases) {
      if (!req.purgeCases) {
        kept.push(c)
        continue
      }
      const removal = await this.service.deleteEntity({ caseId: c.caseId, entityId: c.entityId })
      purged.push({
        level: c.level,
        code: c.code,
        caseId: c.caseId,
        orphanedFindings: removal.orphanedFindings
      })
    }

    return { field: req.field, value: usage.value, profile, purged, kept }
  }

  /* ---------------- state ---------------- */

  async state(): Promise<SelfAuditState> {
    const profile = await this.vault.read()
    const links = await this.vault.readLinks()
    const levels: SelfAuditLevelState[] = []

    for (const spec of SELF_AUDIT_LEVELS) {
      const caseId = links.cases[spec.code] ?? null
      let latest: SnapshotRef | null = null
      let snapshotCount = 0
      if (caseId && (await this.caseExists(caseId))) {
        const snaps = await listSnapshots(this.service.store.dir(caseId))
        snapshotCount = snaps.length
        latest = snaps[0] ? snapshotRef(snaps[0]) : null
      }
      levels.push({
        level: spec.level,
        code: spec.code,
        caseId: caseId && (await this.caseExists(caseId)) ? caseId : null,
        seedCount: seedsForLevel(profile, spec.level).length,
        missing: missingFor(profile, spec.level),
        latest,
        snapshotCount
      })
    }

    return {
      profile,
      hasProfile: levels.some((l) => l.seedCount > 0),
      levels,
      run: this.run,
      vaultPath: this.vault.profilePath
    }
  }

  private async caseExists(caseId: string): Promise<boolean> {
    try {
      await this.service.store.readCase(caseId)
      return true
    } catch {
      return false
    }
  }

  /* ---------------- planning ---------------- */

  /**
   * What this level would do, without doing it.
   *
   * Shown before the run so the operator can see the chain and drop anything from it —
   * maigret's full sweep is the obvious candidate, since it can take a quarter of an hour.
   * It also makes the "L2 adds no tools" fact visible *before* the run rather than as a
   * disappointing result afterwards, which is the honest way round.
   */
  async plan(level: SelfAuditLevel): Promise<SelfAuditPlan> {
    const profile = await this.vault.read()
    const seeds = seedsForLevel(profile, level)
    const links = await this.vault.readLinks()
    const caseId = links.cases[levelSpec(level).code] ?? null

    const adapters = this.service.registry.describe(this.service.config, this.service.loaded.paths.toolkitRoot)
    const runs: PlannedRun[] = []
    const unavailable: { adapterId: string; adapterTitle: string; reason: string }[] = []
    const kinds = new Set(seeds.map((s) => s.kind))

    for (const a of adapters) {
      if (NEVER_RUN.has(a.id)) continue
      if (a.requiresKey) continue
      if (!a.accepts.some((k) => kinds.has(k))) continue
      if (!a.available) {
        unavailable.push({
          adapterId: a.id,
          adapterTitle: a.title,
          reason: a.unavailableReason ?? 'Unavailable, with no reason given.'
        })
        continue
      }
      for (const seed of seeds) {
        if (!a.accepts.includes(seed.kind)) continue
        runs.push({
          adapterId: a.id,
          adapterTitle: a.title,
          entityKind: seed.kind,
          entityLabel: seed.value
        })
      }
    }

    return {
      level,
      caseId,
      seeds: seeds.map((s) => ({ kind: s.kind, label: s.value, field: s.field })),
      runs,
      unavailable,
      strayCaseSeeds: caseId ? await this.strayCaseSeeds(caseId, seeds) : []
    }
  }

  /**
   * Seed entities in this level's case that the level would not seed today.
   *
   * Two causes, both real and both silent until now. A value removed from the vault
   * without purging the case stays `seed: true` there, so every websearch and dork query
   * the level runs still welds it in — which matters most when the value went into the
   * wrong field, the mistake the form most invites. And the ladder can move underneath an
   * old folder: L0 used to seed every username and now seeds one, so an L0 folder written
   * before that change holds handles L0 is no longer entitled to.
   *
   * Read-only. Nothing is deleted here — a case folder is an audit trail, and what to do
   * about a stray seed is the operator's decision, taken with `removeSeed`.
   */
  private async strayCaseSeeds(
    caseId: string,
    entitled: readonly { kind: EntityKind; value: string }[]
  ): Promise<{ entityId: string; kind: EntityKind; label: string }[]> {
    const allowed = new Set(
      entitled.map((s) => `${s.kind} ${normaliseEntityValue(s.kind, s.value).value}`)
    )
    const entities = await this.service.listEntities(caseId).catch(() => [] as Entity[])
    return entities
      .filter((e) => e.seed === true && !allowed.has(`${e.kind} ${e.value}`))
      .map((e) => ({ entityId: e.id, kind: e.kind, label: e.label || e.value }))
  }

  /* ---------------- running ---------------- */

  cancel(): boolean {
    if (!this.run || this.run.phase === 'done' || this.run.phase === 'failed') return false
    this.cancelling = true
    this.service.orchestrator.cancelCase(this.run.caseId)
    return true
  }

  /**
   * Run one level end to end: seed, sweep, snapshot.
   *
   * Returns as soon as the run is registered; progress arrives on `run:update`. The
   * promise on `whenFinished` is there for the test suite and for the re-scan path, which
   * has to wait for a snapshot before it can diff against one.
   */
  start(req: SelfAuditRunRequest): { state: SelfAuditRunState; whenFinished: Promise<SelfAuditRunState> } {
    if (this.run && this.run.phase !== 'done' && this.run.phase !== 'failed' && this.run.phase !== 'cancelled') {
      throw new Error(`A self-audit run is already in progress at L${this.run.level}.`)
    }
    this.cancelling = false
    const state: SelfAuditRunState = {
      level: req.level,
      caseId: '',
      phase: 'seeding',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      planned: 0,
      finished: 0,
      running: [],
      message: 'Preparing the case folder for this level.',
      error: null,
      snapshotId: null
    }
    this.run = state
    this.emitRun()

    const whenFinished = this.execute(req, state).catch((err) => {
      state.phase = 'failed'
      state.finishedAt = new Date().toISOString()
      // Deliberately the message only. Nothing here interpolates a seed value into an
      // error, because an error is the one string in the app most likely to be logged.
      state.error = (err as Error).message
      state.message = 'The run stopped.'
      this.emitRun()
      return state
    })

    return { state, whenFinished }
  }

  private emitRun(): void {
    if (this.run) this.emit('run:update', { ...this.run, running: [...this.run.running] })
  }

  private async execute(req: SelfAuditRunRequest, state: SelfAuditRunState): Promise<SelfAuditRunState> {
    const level = req.level
    const spec = levelSpec(level)
    const profile = await this.vault.read()
    const materialised = seedsForLevel(profile, level)
    if (!materialised.length) {
      throw new Error(
        `L${level} has nothing to start from. Fill in ${spec.fields.map((f) => seedField(f).label.toLowerCase()).join(' or ')} above, then run it.`
      )
    }

    /* --- the case folder --- */
    const caseId = await this.ensureCase(level)
    state.caseId = caseId
    this.emitRun()

    /* --- seeds --- */
    const entities: Entity[] = []
    for (const seed of materialised) {
      // A relative is materialised as a `person`, exactly like the subject's own name at
      // L2, and downstream that made the two indistinguishable: the gender inference read
      // two seeded names that disagreed and switched itself off, so L4 ranked *worse* than
      // L2; the query builder welded a relative's name to the subject's school and city;
      // and the delta's bridge headline said "carries your family names" about a name that
      // is not the subject's. One marker on the entity fixes all three, because all three
      // read the entity record rather than the vault.
      //
      // Written through the store rather than `service.addEntity`, which has no `attrs` on
      // its request shape. Same two steps that method takes — file first, then the index,
      // which the files can rebuild from at any time.
      const stored = await this.service.store.upsertEntity(caseId, {
        kind: seed.kind,
        value: seed.value,
        seed: true,
        ...(seed.field === 'family' ? { attrs: { role: 'relative' } } : {})
      })
      upsertEntityRow(this.service.db, stored)
      entities.push(stored)
    }
    const seedRecords: SnapshotSeed[] = materialised.map((m, i) => {
      const entity = entities[i] as Entity
      return {
        entityId: entity.id,
        kind: entity.kind,
        value: entity.value,
        label: entity.label,
        field: m.field,
        level: m.level
      }
    })

    /* --- plan --- */
    const adapters = this.service.registry.describe(this.service.config, this.service.loaded.paths.toolkitRoot)
    const titles = new Map(adapters.map((a) => [a.id, a.title]))
    const wanted = req.adapterIds ? new Set(req.adapterIds) : null
    const unavailable = new Map<string, string>()

    interface Planned {
      adapterId: string
      entity: Entity
      phase: 1 | 2
    }
    const planned: Planned[] = []
    const skipped: { adapterId: string; entityId: string; reason: string }[] = []

    for (const a of adapters) {
      if (NEVER_RUN.has(a.id)) continue
      if (a.requiresKey) continue
      const applicable = entities.filter((e) => a.accepts.includes(e.kind))
      if (!applicable.length) continue
      if (wanted && !wanted.has(a.id)) {
        // A tool the operator dropped from the chain used to be `continue`d with no entry
        // in `unavailable` and none in `skipped` — it left no trace at all. Two things
        // then went wrong. The report counted the ground it would have covered as covered,
        // which is the one thing this feature exists not to do. And the delta, seeing the
        // adapter appear at the level above, credited the *seed* with making it runnable —
        // "adding email addresses made Maigret runnable", about a tool that accepts
        // usernames and was simply switched off below. A hole the operator chose is still
        // a hole; `snapshot.ts` makes the same argument about an uninstalled binary.
        for (const entity of applicable) {
          skipped.push({
            adapterId: a.id,
            entityId: entity.id,
            reason: 'You dropped it from this level’s chain before the run.'
          })
        }
        continue
      }
      if (!a.available) {
        unavailable.set(a.id, a.unavailableReason ?? 'Unavailable, with no reason given.')
        continue
      }
      const phase: 1 | 2 = SECOND_PHASE.includes(a.id) ? 2 : 1
      // The local re-analysis runs once against the first seed rather than once per seed:
      // it reads the whole case folder, so pointing it at five entities would produce the
      // same analysis five times.
      const targets = phase === 2 ? applicable.slice(0, 1) : applicable
      for (const entity of targets) planned.push({ adapterId: a.id, entity, phase })
    }

    state.planned = planned.length
    state.phase = 'running'
    state.message = planned.length
      ? `Running ${planned.length} check${planned.length === 1 ? '' : 's'} against ${entities.length} seed${entities.length === 1 ? '' : 's'}.`
      : 'No adapter in this build accepts any of this level’s seed kinds. The level still produces a report; it will say so.'
    this.emitRun()

    /* What *this* run touched.
     *
     * `findings.jsonl` is a level's whole history — `upsertFinding` inserts or refreshes
     * and never removes — so a snapshot built from the file alone is a superset of the
     * previous one by construction, and the re-scan can never report a removal. The jobs
     * hand back the finding ids they produced, which is an observation rather than a
     * guess about a clock, and the job ids keep `checks` describing this run rather than
     * every run the process has served since it started. */
    const observedFindingIds = new Set<string>()
    const runJobIds = new Set<string>()

    for (const phase of [1, 2] as const) {
      const batch = planned.filter((p) => p.phase === phase)
      if (!batch.length) continue
      if (this.cancelling) {
        for (const p of batch) {
          skipped.push({
            adapterId: p.adapterId,
            entityId: p.entity.id,
            reason: 'The run was stopped before this one started.'
          })
        }
        continue
      }

      const settled = batch.map((p) => {
        let enqueued: { job: Job; whenSettled: Promise<Job> }
        try {
          enqueued = this.service.orchestrator.enqueue({
            caseId,
            entityId: p.entity.id,
            adapterId: p.adapterId
          })
        } catch (err) {
          // A disabled adapter or a vanished registration. Recorded as a hole, never
          // silently dropped.
          unavailable.set(p.adapterId, (err as Error).message)
          return Promise.resolve(null)
        }
        runJobIds.add(enqueued.job.id)
        state.running.push({ adapterId: p.adapterId, entityLabel: p.entity.label })
        this.emitRun()
        return enqueued.whenSettled.then((job) => {
          for (const id of job.findingIds) observedFindingIds.add(id)
          state.finished++
          const at = state.running.findIndex(
            (r) => r.adapterId === p.adapterId && r.entityLabel === p.entity.label
          )
          if (at >= 0) state.running.splice(at, 1)
          state.message = `${state.finished} of ${state.planned} checks finished.`
          this.emitRun()
          return job
        })
      })

      await Promise.all(settled)
    }

    /* --- snapshot --- */
    state.phase = 'analysing'
    state.message = 'Reading what the run produced.'
    this.emitRun()

    const snapshot = await this.snapshotCase({
      caseId,
      level,
      seeds: seedRecords,
      profile,
      adapterTitles: titles,
      adapterAccepts: new Map(adapters.map((a) => [a.id, a.accepts])),
      unavailable,
      skipped,
      observedFindingIds,
      runJobIds
    })
    await writeSnapshot(this.service.store.dir(caseId), snapshot)

    state.snapshotId = snapshot.id
    state.phase = this.cancelling ? 'cancelled' : 'done'
    state.finishedAt = new Date().toISOString()
    state.message = this.cancelling
      ? 'Cancelled. What finished before the stop is on disk and in the snapshot.'
      : `L${level} finished: ${snapshot.counts.claims} claims from ${snapshot.counts.sources} sources, ${snapshot.counts.silentChecks} checks that said nothing.`
    this.emitRun()
    return state
  }

  private async ensureCase(level: SelfAuditLevel): Promise<string> {
    const spec = levelSpec(level)
    const links = await this.vault.readLinks()
    const existing = links.cases[spec.code]
    if (existing && (await this.caseExists(existing))) return existing

    const created = await this.service.createCase({
      name: `Self-Audit ${spec.code}`,
      basis: 'self',
      notes:
        `Adversary knowledge level ${spec.code}: ${spec.adds}. ${spec.simulates}\n` +
        'Seeded by the Self-Audit view from the seed vault. This folder only ever receives the fields this level is entitled to.'
    })
    await this.vault.linkLevel(spec.code, created.id)
    return created.id
  }

  private async snapshotCase(input: {
    caseId: string
    level: SelfAuditLevel
    seeds: SnapshotSeed[]
    profile: SelfAuditProfile
    adapterTitles: Map<string, string>
    adapterAccepts: Map<string, EntityKind[]>
    unavailable: Map<string, string>
    skipped: { adapterId: string; entityId: string; reason: string }[]
    observedFindingIds: ReadonlySet<string>
    runJobIds: ReadonlySet<string>
  }): Promise<SelfAuditSnapshot> {
    const { caseId, runJobIds } = input
    const caseDir = this.service.store.dir(caseId)
    const [entities, candidates, findings] = await Promise.all([
      this.service.listEntities(caseId),
      this.service.listCandidates(caseId, 'all'),
      this.service.listFindings(caseId)
    ])
    // Job history is in-memory and per-process, so `listJobs` returns every run this
    // session has served for the case — including the previous run of this very level.
    // Left unfiltered, `checks` and `findings` describe different time spans: silent
    // checks get counted twice, and the re-scan can explain away today's disappearance
    // with a stale silent check from an hour ago. `checks` is about this run.
    const jobs = this.service.orchestrator.listJobs(caseId).filter((j) => runJobIds.has(j.id))

    return buildSnapshot({
      level: input.level,
      caseId,
      caseDir,
      seeds: input.seeds,
      entities,
      candidates,
      findings,
      jobs,
      profile: input.profile,
      adapterTitles: input.adapterTitles,
      adapterAccepts: input.adapterAccepts,
      unavailable: input.unavailable,
      skipped: input.skipped,
      observedFindingIds: input.observedFindingIds,
      readRaw: (rel) => this.readRelative(caseId, rel)
    })
  }

  private async readRelative(caseId: string, relative: string): Promise<string | null> {
    // The path came out of a finding this app wrote, but it is still joined and checked
    // rather than trusted: a case folder is editable by hand and by git.
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) return null
    try {
      return await fsp.readFile(path.join(this.service.store.dir(caseId), relative), 'utf8')
    } catch {
      return null
    }
  }

  /* ---------------- reading it back ---------------- */

  async snapshots(level: SelfAuditLevel): Promise<SnapshotRef[]> {
    const caseId = await this.caseFor(level)
    if (!caseId) return []
    return (await listSnapshots(this.service.store.dir(caseId))).map(snapshotRef)
  }

  private async caseFor(level: SelfAuditLevel): Promise<string | null> {
    const links = await this.vault.readLinks()
    const id = links.cases[levelSpec(level).code]
    return id && (await this.caseExists(id)) ? id : null
  }

  private async loadSnapshot(level: SelfAuditLevel, snapshotId?: string): Promise<SelfAuditSnapshot | null> {
    const caseId = await this.caseFor(level)
    if (!caseId) return null
    const all = await listSnapshots(this.service.store.dir(caseId))
    if (!all.length) return null
    return (snapshotId ? all.find((s) => s.id === snapshotId) : all[0]) ?? null
  }

  /**
   * The delta between two levels.
   *
   * `from` defaults to the level below, which is the comparison the ladder is built for.
   * L0 has nothing below it and returns a delta whose `from` is null — the view then reads
   * as a baseline rather than as a change of nothing.
   */
  async delta(level: SelfAuditLevel, fromLevel?: SelfAuditLevel): Promise<SelfAuditDelta | null> {
    const below = fromLevel ?? ((level - 1) as SelfAuditLevel)
    // The ladder only runs one way. An inverted comparison produces an empty
    // `addedSeeds`, a large `lostReach` and the sentence "Nothing was added between L4 and
    // L2" — a confident, well-formed answer to a question nobody can ask. `fromLevel`
    // arrives over IPC, which the MCP server makes a live surface, so it is refused here
    // rather than trusted.
    if (fromLevel !== undefined && below >= level) {
      throw new Error(
        `A delta reads up the ladder: the level compared against must be below L${level}, and L${below} is not.`
      )
    }
    const to = await this.loadSnapshot(level)
    if (!to) return null
    const from = level === 0 || below < 0 ? null : await this.loadSnapshot(below)
    return computeDelta(to, from)
  }

  async resetPaths(level: SelfAuditLevel, snapshotId?: string): Promise<ResetPathMap | null> {
    const snapshot = await this.loadSnapshot(level, snapshotId)
    if (!snapshot) return null
    return buildResetPaths({ snapshot, raws: await this.readRawsFor(snapshot) })
  }

  async report(level: SelfAuditLevel, snapshotId?: string): Promise<ExposureReport | null> {
    const snapshot = await this.loadSnapshot(level, snapshotId)
    if (!snapshot) return null
    const resetPaths = buildResetPaths({ snapshot, raws: await this.readRawsFor(snapshot) })
    return buildReport(snapshot, resetPaths)
  }

  /** Only the captures the reset-path map needs. A maigret dump is tens of megabytes. */
  private async readRawsFor(snapshot: SelfAuditSnapshot): Promise<Map<string, string>> {
    const wanted = new Set(
      snapshot.findings.filter((f) => f.tool === 'holehe' && f.rawPath).map((f) => f.rawPath)
    )
    const out = new Map<string, string>()
    for (const rel of wanted) {
      const text = await this.readRelative(snapshot.caseId, rel)
      if (text) out.set(rel, text)
    }
    return out
  }

  /**
   * Re-run a level and diff it against the last run of the same level.
   *
   * This is the only honest way to answer "did the removal request work". The diff
   * separates a claim that disappeared while the tool was answering from one that
   * disappeared while the tool was being refused, and only the first supports the good
   * news. See `rescan.ts`.
   */
  async rescan(req: SelfAuditRunRequest): Promise<RescanDiff | null> {
    const before = await this.loadSnapshot(req.level)
    const { whenFinished } = this.start(req)
    const state = await whenFinished
    if (state.phase === 'failed') throw new Error(state.error ?? 'The re-scan failed.')
    const after = state.snapshotId ? await this.loadSnapshot(req.level, state.snapshotId) : null
    if (!after) return null
    if (!before) return null
    return computeRescan(after, before)
  }

  /** Diff the two most recent snapshots of a level without running anything. */
  async lastRescan(level: SelfAuditLevel): Promise<RescanDiff | null> {
    const caseId = await this.caseFor(level)
    if (!caseId) return null
    const all = await listSnapshots(this.service.store.dir(caseId))
    if (all.length < 2) return null
    const current = all[0]
    const previous = all[1]
    if (!current || !previous) return null
    return computeRescan(current, previous)
  }

  /* ---------------- letters ---------------- */

  async letter(req: GdprLetterRequest): Promise<GdprLetter> {
    return buildLetter(await this.fillFromProfile(req))
  }

  /**
   * Fill in the operator's own details from the vault when the caller left them blank.
   *
   * The renderer could do this, but then the profile would have to be sent to it in full
   * on a page that is mostly about a third party's address. Doing it here keeps the
   * personal data on one side of the bridge for one more hop.
   */
  private async fillFromProfile(req: GdprLetterRequest): Promise<GdprLetterRequest> {
    const profile = await this.vault.read()
    const defaults = buildLetterDefaults(profile)
    return {
      ...req,
      handle: req.handle ?? defaults.handle,
      email: req.email ?? defaults.email,
      fullName: req.fullName ?? defaults.fullName
    }
  }

  /**
   * Write the letter into the vault directory, never into a level's case folder.
   *
   * A letter is the operator's, not a level's. `fillFromProfile` completes it from the
   * vault, so an erasure letter carries his real name (L2), his address (L1) and his
   * postal address — and saving one while L0 was on screen used to put all three inside
   * L0's folder. Nothing reads `letters/*.txt`, so no conclusion changed; what changed was
   * that the invariant this design leans on twice in prose — *"L0's folder is greppable
   * proof that L0 never saw a phone number"* — stopped being true, which is worse, because
   * the proof is the product.
   *
   * `cases/_selfaudit/letters/` sits beside the profile that filled the letter in, is
   * skipped by `listCaseIds` for the same reason the vault is, and gives the operator one
   * directory to delete for all of it. There is no `level` parameter, because there is no
   * level this belongs to.
   */
  async saveLetter(req: GdprLetterRequest): Promise<SavedLetter> {
    const letter = await this.letter(req)
    const dir = path.join(this.vault.dir, 'letters')
    await fsp.mkdir(dir, { recursive: true })

    const slug = req.platform.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || 'controller'
    const file = path.join(dir, `${slug}-${req.article}-${req.lang}-${ulid().slice(-8).toLowerCase()}.txt`)
    const body = [
      letter.subject,
      '='.repeat(Math.min(letter.subject.length, 78)),
      '',
      letter.body,
      '',
      '',
      '--',
      letter.escalation
    ].join('\n')
    await fsp.writeFile(file, body, 'utf8')
    return { path: file, bytes: Buffer.byteLength(body, 'utf8') }
  }

  /* ---------------- lifecycle ---------------- */

  dispose(): void {
    this.removeAllListeners()
  }
}

export { emptyProfile }

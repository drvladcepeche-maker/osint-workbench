/**
 * The application service: everything the app can do, with no Electron in sight.
 *
 * Keeping this free of `electron` imports is what lets the test suite drive the entire
 * app — cases, adapters, orchestrator, index, rebuild — in plain Node, with no window
 * and no display. The Electron layer (`index.ts`, `ipc.ts`) is a thin shell over it.
 */

import type { Database as Db } from 'better-sqlite3'
import {
  isPublishableBasis,
  type AppConfig,
  type CandidateState,
  type CandidateView,
  type ConfidenceChange,
  type Entity,
  type Evidence,
  type Finding,
  type IndexStats,
  type Job
} from '../shared/types'
import type {
  AddEntityRequest,
  CandidateDecisionRequest,
  CaseSummary,
  CreateCaseRequest,
  DeleteEntityRequest,
  EditEntityRequest,
  EntityEdit,
  EntityRemoval,
  EntityUsage,
  PromoteRequest,
  RunJobRequest,
  RunPlan,
  RunPlanEntry,
  RunPlanRequest
} from '../shared/ipc'
import { idleKindReason, kindWithArticle } from '../shared/ipc'
import type { AdapterInfo, EntityKind, RemovedEntity } from '../shared/types'
import { isTerminalJobState } from '../shared/types'
import { entityId as makeEntityId } from '../shared/ids'
import { normaliseEntityValue } from '../shared/normalise'
import { cleanSubject } from '../shared/relevance'
import { loadConfig, type LoadedConfig } from './config'
import { CaseStore } from './store/caseStore'
import {
  caseCounts,
  deleteEntityRow,
  entityAttachments,
  findCorroborationCandidates,
  listCandidates,
  listEntities,
  listFindings,
  openIndex,
  rebuildIndex,
  searchFindings,
  upsertCandidateRow,
  upsertCaseRow,
  upsertConfidenceChangeRow,
  upsertEntityRow,
  upsertEvidenceRow,
  upsertFindingRow
} from './db'
import { Orchestrator } from './orchestrator'
import { registerBuiltInAdapters, registry, type AdapterRegistry } from './adapters'
import { promote } from '../shared/confidence'
import { confidenceChangeId } from '../shared/ids'

/** A run may not be given a deadline shorter than this. Below it nothing finishes. */
export const MIN_RUN_TIMEOUT_MS = 1_000
/** Nor one longer than this. Two hours is already far past any adapter's useful ceiling. */
export const MAX_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1_000

/**
 * Options and a timeout arrive from the renderer, which is the only untrusted caller in
 * the app. Two things are checked here rather than downstream:
 *
 *  - `options` must be a plain object of JSON values. An array, a prototype-polluting
 *    key, or a function would reach `mergedOptions` and from there an adapter's argv.
 *  - `timeoutMs` must be a finite number in a sane range. A `NaN` deadline turns the
 *    orchestrator's watchdog into `NaN` and the run never gets killed at all.
 *
 * Values are copied, not referenced, so nothing the renderer holds can be mutated under
 * a running job.
 */
export function sanitiseRunRequest(req: RunJobRequest): RunJobRequest {
  const out: RunJobRequest = { caseId: req.caseId, entityId: req.entityId, adapterId: req.adapterId }

  if (req.options !== undefined) {
    if (typeof req.options !== 'object' || req.options === null || Array.isArray(req.options)) {
      throw new Error('Run options must be a plain object of adapter settings.')
    }
    const options: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(req.options)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (typeof value === 'function' || typeof value === 'symbol') {
        throw new Error(`Run option "${key}" is not a value an adapter can be given.`)
      }
      options[key] = value
    }
    out.options = options
  }

  if (req.timeoutMs !== undefined) {
    const t = Number(req.timeoutMs)
    if (!Number.isFinite(t) || t < MIN_RUN_TIMEOUT_MS || t > MAX_RUN_TIMEOUT_MS) {
      throw new Error(
        `timeoutMs must be between ${MIN_RUN_TIMEOUT_MS} and ${MAX_RUN_TIMEOUT_MS} milliseconds; got ${String(req.timeoutMs)}.`
      )
    }
    out.timeoutMs = Math.round(t)
  }

  return out
}

/**
 * Kinds whose value is a thing a person typed, and can therefore re-type.
 *
 * `account` is excluded because its canonical value is the composite `platform/handle`,
 * which the add form builds from a link or a platform picker — dropping the operator in
 * front of the raw composite is the exact confusion that form exists to remove.
 * `image` is excluded because its value may be a digest of bytes rather than a path.
 */
export const EDITABLE_KINDS: readonly EntityKind[] = [
  'person',
  'username',
  'email',
  'phone',
  'domain',
  'ipaddr',
  'location',
  'organisation'
] as const

/**
 * Adapters a batch never reaches for on its own, and why.
 *
 * Only applied when the caller did **not** name its adapters. Naming one is an explicit
 * instruction and this is not a veto over it — except for a declared secret, which no
 * batch can carry: its value has to be typed at the moment of use, and there is nowhere
 * in a fan-out to type it.
 */
const FANOUT_SKIPS_BY_DEFAULT = new Map<string, string>([
  [
    'echo',
    'The self-test adapter. It accepts every kind and asserts nothing about the world, so a sweep would only add a row per entity saying the plumbing works.'
  ]
])

/** `a username`, `a username or an email`, `a username, an email or a domain`. */
function listKinds(kinds: readonly EntityKind[]): string {
  const words = kinds.map(kindWithArticle)
  if (words.length <= 1) return words[0] ?? 'nothing'
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}

function unfitForBatch(a: AdapterInfo): string | null {
  if (a.secretOptions.length > 0) {
    return `Its input is a secret typed at the moment of use and never stored, so there is nowhere in a batch to supply it. Run ${a.title} on its own.`
  }
  return null
}

/**
 * What an entity's removal has to tell anything that keeps its own record of the graph.
 *
 * There is exactly one such thing today — the investigation engine's provenance file — and
 * this is a hook rather than a direct call because the dependency only runs one way: the
 * engine is built on the service, so the service cannot import it back. The engine wires
 * itself to this in its own constructor, which is the only place guaranteed to run for
 * every caller.
 *
 * The handler runs **after** the entity is out of `entities.json` and out of the index, so
 * anything it re-reads sees the case as it now is, and **before** a promoted candidate is
 * returned to the review queue, so cutting the branch cannot dismiss the very row the
 * removal just reopened.
 */
export interface EntityRemovedEvent {
  caseId: string
  entity: Entity
  reason: 'deleted' | 'renamed'
  /** For a rename, the entity that replaced it. Null for a deletion. */
  replacedBy: string | null
}

/**
 * The engine, as far as a removal needs to know it: something that can cut a node.
 *
 * Typed structurally rather than imported, which is the whole trick. `InvestigationEngine`
 * is built **on** the service, so importing it here would be a cycle; describing the one
 * method a removal uses costs nothing and lets the test suite wire a stub in its place.
 */
export interface ProvenancePruner {
  prune(
    req: { caseId: string; nodeId: string; reason: string },
    actor?: 'engine' | 'human'
  ): Promise<{ cut: readonly unknown[] }>
}

/**
 * Make an entity's removal cut its provenance root, and everything under it.
 *
 * `InvestigationEngine`'s constructor calls this, so having an engine is the same thing as
 * having the hook. It stays exported because the tests below wire a stub in the engine's
 * place: the store half of a removal has to be correct on its own terms, and proving that
 * needs a pruner that is not the engine.
 *
 * Until something calls it, a removal is still correct on its own terms — the entity leaves
 * the case, the findings are orphaned, the tombstone is written. What it is missing is the
 * record that the branch is gone, and this is what supplies it.
 *
 * The reason is written for the operator, because he is the one who will read it in the
 * decision log and decide whether to restore. It does not repeat the replacement id of a
 * rename: the tombstone in `removed-entities.jsonl` already names it, and a second copy is
 * a second thing to keep in step.
 */
export function pruneProvenanceOnRemoval(service: OsintService, engine: ProvenancePruner): void {
  service.onEntityRemoved = async ({ caseId, entity, reason }): Promise<number> => {
    const result = await engine.prune(
      {
        caseId,
        nodeId: entity.id,
        reason:
          reason === 'renamed'
            ? `${entity.label} was re-typed, so the value this branch grew from no longer exists in the case. ` +
              `Everything reached through it was reached through the old spelling; the corrected entity starts a new root. ` +
              `Restore this if the discoveries under it were about the right person after all.`
            : `${entity.label} was removed from the case, so nothing connects this branch to a seed any more. ` +
              `Nothing is deleted: restore it and every node comes back.`
      },
      'human'
    )
    return result.cut.length
  }
}

export class OsintService {
  /**
   * Set by `InvestigationEngine`'s constructor, or by a test wiring a stub in its place.
   * Null until one of those happens, which is deliberate: the store half of a removal must
   * be correct on its own.
   *
   * A throwing handler never fails the removal — the entity is already gone and the files
   * are the truth. It is logged and reported as zero nodes cut.
   */
  onEntityRemoved: ((event: EntityRemovedEvent) => Promise<number>) | null = null

  private constructor(
    readonly loaded: LoadedConfig,
    readonly store: CaseStore,
    readonly db: Db,
    readonly registry: AdapterRegistry,
    readonly orchestrator: Orchestrator,
    readonly startupRebuild: IndexStats | null
  ) {}

  static async create(root: string): Promise<OsintService> {
    const loaded = loadConfig(root)
    const store = new CaseStore(loaded.paths.casesDir)
    await store.ensureRoot()

    // Registration validates every adapter's doc. A bad doc throws here, at startup,
    // which is the whole point.
    registerBuiltInAdapters(registry)

    const { db, rebuilt } = await openIndex(loaded.paths.dbFile, store)
    const orchestrator = new Orchestrator({
      registry,
      store,
      db,
      config: loaded.config,
      toolkitRoot: loaded.paths.toolkitRoot
    })
    return new OsintService(loaded, store, db, registry, orchestrator, rebuilt)
  }

  get config(): AppConfig {
    return this.loaded.config
  }

  /* ---------------- cases ---------------- */

  async listCases(): Promise<CaseSummary[]> {
    const ids = await this.store.listCaseIds()
    const out: CaseSummary[] = []
    for (const id of ids) {
      const summary = await this.getCase(id)
      if (summary) out.push(summary)
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async getCase(caseId: string): Promise<CaseSummary | null> {
    let c
    try {
      c = await this.store.readCase(caseId)
    } catch {
      return null
    }
    // The index is a cache; if a case folder appeared from outside the app (copied in,
    // pulled from git) it is picked up here rather than requiring a manual rebuild.
    if (!this.db.prepare('SELECT 1 FROM cases WHERE id = ?').get(caseId)) {
      await this.reindexCase(caseId)
    }
    const counts = caseCounts(this.db, caseId)
    return {
      id: c.id,
      name: c.name,
      basis: c.basis,
      subjectConsent: c.subjectConsent,
      createdAt: c.createdAt,
      notes: c.notes,
      subject: cleanSubject(c.subject),
      publishable: isPublishableBasis(c.basis),
      counts: {
        entities: counts.entities ?? 0,
        findings: counts.findings ?? 0,
        unverified: counts.unverified ?? 0,
        corroborated: counts.corroborated ?? 0,
        confirmed: counts.confirmed ?? 0,
        refuted: counts.refuted ?? 0,
        evidence: counts.evidence ?? 0,
        candidates: counts.candidates ?? 0
      }
    }
  }

  async createCase(req: CreateCaseRequest): Promise<CaseSummary> {
    const file = await this.store.createCase(req)
    upsertCaseRow(this.db, file, this.store.dir(file.id))
    const summary = await this.getCase(file.id)
    if (!summary) throw new Error(`Case ${file.id} vanished immediately after creation.`)
    return summary
  }

  /**
   * Record what the operator states about the subject: gender, age band, countries.
   *
   * Sanitised here rather than trusted, because the renderer is this app's only untrusted
   * caller and `cleanSubject` drops anything it cannot name — a country code the app has
   * no name for would contradict every row in the case with no way to see why.
   *
   * Nothing about a finding changes. The subject is read at render time by
   * `shared/ranking.ts` and never written into a finding, a candidate or a confidence
   * level: relevance and confidence are orthogonal axes and stay that way.
   */
  async setCaseSubject(caseId: string, subject: unknown): Promise<CaseSummary> {
    const file = await this.store.updateCase(caseId, { subject: cleanSubject(subject) })
    upsertCaseRow(this.db, file, this.store.dir(caseId))
    const summary = await this.getCase(caseId)
    if (!summary) throw new Error(`Case ${caseId} vanished while its subject was being saved.`)
    return summary
  }

  /** Pull one case folder into the index without touching the others. */
  async reindexCase(caseId: string): Promise<void> {
    const data = await this.store.readAll(caseId)
    upsertCaseRow(this.db, data.case, this.store.dir(caseId))
    this.db.transaction(() => {
      for (const e of data.entities) upsertEntityRow(this.db, e)
      for (const c of data.candidates) upsertCandidateRow(this.db, c)
      for (const f of data.findings) upsertFindingRow(this.db, f)
      for (const ev of data.evidence) upsertEvidenceRow(this.db, caseId, ev)
      for (const cc of data.confidenceChanges) upsertConfidenceChangeRow(this.db, cc)
    })()
  }

  /* ---------------- entities ---------------- */

  async listEntities(caseId: string): Promise<Entity[]> {
    return listEntities(this.db, caseId)
  }

  async addEntity(req: AddEntityRequest): Promise<Entity> {
    const entity = await this.store.upsertEntity(req.caseId, {
      kind: req.kind,
      value: req.value,
      label: req.label,
      seed: req.seed ?? true
    })
    upsertEntityRow(this.db, entity)
    return entity
  }

  /** The tombstones for this case, newest first. */
  async removedEntities(caseId: string): Promise<RemovedEntity[]> {
    const { records } = await this.store.readRemovedEntities(caseId)
    return records.sort((a, b) => b.removedAt.localeCompare(a.removedAt))
  }

  /**
   * What a removal would disturb. Read-only — nothing changes by asking.
   *
   * The UI turns this into the confirmation, so every number here has to be counted
   * rather than estimated: "12 findings will be orphaned" is only worth putting in front
   * of somebody if the 12 is real.
   */
  async entityUsage(caseId: string, entityId: string): Promise<EntityUsage | null> {
    const entity = await this.store.getEntity(caseId, entityId)
    if (!entity) return null
    const { findings, evidence } = entityAttachments(this.db, caseId, entityId)
    const activeJobs = this.orchestrator
      .listJobs(caseId)
      .filter((j) => j.entityId === entityId && !isTerminalJobState(j.state)).length
    // A candidate shares its id with the entity it was promoted into, by construction.
    const candidate = await this.store.getCandidate(caseId, entityId)
    const returnsCandidate = candidate?.state === 'promoted'
    return {
      caseId,
      entityId,
      kind: entity.kind,
      value: entity.value,
      label: entity.label,
      seed: entity.seed,
      findings,
      evidence,
      activeJobs,
      returnsCandidate,
      attached: findings > 0 || evidence > 0 || activeJobs > 0,
      editable: EDITABLE_KINDS.includes(entity.kind)
    }
  }

  /**
   * Take an entity out of a case.
   *
   * Three things happen, in this order, and each is a decision rather than a detail:
   *
   *  1. **Runs pointed at it are cancelled.** The orchestrator would otherwise fail them
   *     seconds later with "entity is not in case", which is true but reads as a bug.
   *  2. **Findings are kept and become orphaned.** Raw captures are permanent and
   *     append-only by design and every finding points at one; deleting the question does
   *     not unobserve the answer. A tombstone records what was removed and how much it
   *     left behind, so an orphaned row can still name what it was about.
   *  3. **A candidate that was promoted into it goes back to the review queue.** This is
   *     the one deliberate exception to "a decided candidate stays decided": that rule
   *     exists so a *tool* re-proposing something cannot overturn a human's decision, and
   *     here the human is reversing his own. Without it, removing a promoted account
   *     would delete the discovery outright and there would be no way to add it back.
   *
   * Idempotent. Removing something that is already gone reports zero of everything
   * rather than throwing — two clicks on the same row are not an error.
   */
  async deleteEntity(req: DeleteEntityRequest): Promise<EntityRemoval> {
    const { caseId, entityId } = req
    const entity = await this.store.getEntity(caseId, entityId)
    if (!entity) {
      return {
        caseId,
        entityId,
        kind: 'username',
        label: entityId,
        orphanedFindings: 0,
        cancelledJobs: 0,
        candidateReturned: false,
        provenanceCut: 0,
        tombstone: null
      }
    }
    return this.removeEntity(caseId, entity, 'deleted', null)
  }

  /**
   * Re-type an entity's value.
   *
   * The typo case, and the reason this is offered at all: a seed with a letter out of
   * place is otherwise permanent, and deleting-and-re-adding loses the seed flag and the
   * position in the case.
   *
   * Because entity ids are content-addressed over the canonical value, a changed value
   * is a different entity. So this adds the new one and removes the old, and the
   * findings the old one collected are orphaned exactly as a deletion would orphan them
   * — which is the honest outcome: those findings really were about the misspelling, and
   * re-pointing them would mint different findings and lose their history.
   *
   * A change that normalises to the same value moves no id and orphans nothing; only the
   * label is updated.
   */
  async editEntity(req: EditEntityRequest): Promise<EntityEdit> {
    const { caseId, entityId } = req
    const existing = await this.store.getEntity(caseId, entityId)
    if (!existing) throw new Error(`No entity ${entityId} in case ${caseId}.`)
    if (!EDITABLE_KINDS.includes(existing.kind)) {
      throw new Error(
        `A ${existing.kind} value is not free text — it is built from its parts. Add the corrected one and remove this one.`
      )
    }
    const raw = req.value.trim()
    if (!raw) throw new Error('An entity needs a value.')

    const norm = normaliseEntityValue(existing.kind, raw)
    const nextId = makeEntityId(caseId, existing.kind, norm.value)

    // Same canonical value: nothing moves, only what a human reads changes.
    if (nextId === entityId) {
      const updated = await this.store.upsertEntity(caseId, {
        kind: existing.kind,
        value: raw,
        label: req.label ?? norm.label,
        seed: existing.seed
      })
      upsertEntityRow(this.db, updated)
      return { entity: updated, renamed: false, removal: null }
    }

    const created = await this.store.upsertEntity(caseId, {
      kind: existing.kind,
      value: raw,
      label: req.label ?? norm.label,
      // The corrected value inherits the old one's provenance. A seed that was mistyped
      // is still a seed, and the self-audit's "what did this seed unlock" question would
      // answer wrong if a correction quietly turned it into a discovery.
      seed: existing.seed,
      attrs: existing.attrs as never
    })
    upsertEntityRow(this.db, created)

    const removal = await this.removeEntity(caseId, existing, 'renamed', created.id)
    return { entity: created, renamed: true, removal }
  }

  /** The shared body of a deletion and the removal half of a rename. */
  private async removeEntity(
    caseId: string,
    entity: Entity,
    reason: 'deleted' | 'renamed',
    replacedBy: string | null
  ): Promise<EntityRemoval> {
    const { findings } = entityAttachments(this.db, caseId, entity.id)

    let cancelledJobs = 0
    for (const job of this.orchestrator.listJobs(caseId)) {
      if (job.entityId !== entity.id || isTerminalJobState(job.state)) continue
      if (this.orchestrator.cancel(job.id)) cancelledJobs++
    }

    await this.store.removeEntity(caseId, entity.id)
    deleteEntityRow(this.db, entity.id)

    // The provenance graph keeps its own record of how everything was reached, and an
    // entity's node is a **root** in it. Leaving that root behind leaves the whole branch
    // under it reachable: the planner keeps spending runs on leads whose only route into
    // the case starts at something the operator deleted, and every chain the brief prints
    // for them names a seed that is no longer there. So the root is cut with it, which is
    // an ordinary prune — recorded, reasoned, and undone by `engine.restore()`.
    //
    // Ordering matters and is the reason this sits here rather than at the end: a prune
    // dismisses pending candidates under the cut, and the candidate that was *promoted
    // into this entity* is reopened three lines below. Cutting first means the prune sees
    // it as promoted, leaves it alone, and the reopen has the last word.
    let provenanceCut = 0
    if (this.onEntityRemoved) {
      try {
        provenanceCut = await this.onEntityRemoved({ caseId, entity, reason, replacedBy })
      } catch (err) {
        // The entity is already gone and the files are the truth. A failure to record the
        // cut is worth saying out loud and worth nothing else.
        console.error(
          `[service] removing ${entity.id} from ${caseId}: the provenance root could not be pruned:`,
          (err as Error).message
        )
      }
    }

    let candidateReturned = false
    const candidate = await this.store.getCandidate(caseId, entity.id)
    if (candidate?.state === 'promoted') {
      const reopened = await this.store.decideCandidate(caseId, candidate.id, 'pending')
      upsertCandidateRow(this.db, reopened)
      candidateReturned = true
    }

    // The tombstone exists to explain something. A removal that left nothing behind has
    // nothing to explain, and writing a record of it would make correcting a typo a
    // permanent note that a typo was made.
    let tombstone: RemovedEntity | null = null
    if (findings > 0 || reason === 'renamed') {
      tombstone = {
        entityId: entity.id,
        caseId,
        kind: entity.kind,
        value: entity.value,
        label: entity.label,
        seed: entity.seed,
        removedAt: new Date().toISOString(),
        reason,
        replacedBy,
        orphanedFindings: findings
      }
      await this.store.appendRemovedEntity(caseId, tombstone)
    }

    return {
      caseId,
      entityId: entity.id,
      kind: entity.kind,
      label: entity.label,
      orphanedFindings: findings,
      cancelledJobs,
      candidateReturned,
      provenanceCut,
      tombstone
    }
  }

  /* ---------------- candidates ---------------- */

  /**
   * The review queue: things adapters discovered that are not in the graph.
   *
   * Defaults to `pending` because that is the only list with anything to decide. The
   * promoted and dismissed lists exist so a decision is inspectable afterwards — the
   * record of what was rejected is part of the case, not litter.
   */
  async listCandidates(caseId: string, state: CandidateState | 'all' = 'pending'): Promise<CandidateView[]> {
    return listCandidates(this.db, caseId, state)
  }

  /**
   * Promote a candidate into the graph. **The only way an adapter's discovery becomes an
   * entity**, and it requires a human at this end of the call.
   *
   * The new entity is `seed: false` — discovered, not supplied — which is what keeps the
   * self-audit's adversary-level analysis honest: the whole question there is what a
   * given seed set unlocked, and a promoted discovery counted as a seed would answer it
   * wrong.
   *
   * The proposing findings are deliberately **not** re-pointed at the new entity. A
   * finding's id is content-addressed over the entity it was about, so moving it would
   * mint a different finding and lose the original's history. The claim stays attached to
   * the thing the run was pointed at; the candidate record is what links the two.
   */
  async promoteCandidate(req: CandidateDecisionRequest): Promise<Entity> {
    const candidate = await this.store.getCandidate(req.caseId, req.candidateId)
    if (!candidate) throw new Error(`No candidate ${req.candidateId} in case ${req.caseId}.`)
    if (candidate.state === 'promoted') {
      const already = await this.store.getEntity(req.caseId, candidate.id)
      if (already) return already
    }

    const entity = await this.store.upsertEntity(req.caseId, {
      kind: candidate.kind,
      value: candidate.value,
      label: candidate.label,
      seed: false,
      attrs: candidate.attrs as never
    })
    upsertEntityRow(this.db, entity)

    const decided = await this.store.decideCandidate(req.caseId, candidate.id, 'promoted')
    upsertCandidateRow(this.db, decided)
    return entity
  }

  /** Record that the operator looked and said no. The candidate stays on disk as a record. */
  async dismissCandidate(req: CandidateDecisionRequest): Promise<CandidateView> {
    const candidate = await this.store.getCandidate(req.caseId, req.candidateId)
    if (!candidate) throw new Error(`No candidate ${req.candidateId} in case ${req.caseId}.`)
    const decided = await this.store.decideCandidate(req.caseId, candidate.id, 'dismissed')
    upsertCandidateRow(this.db, decided)
    const view = listCandidates(this.db, req.caseId, 'dismissed').find((c) => c.id === decided.id)
    if (!view) throw new Error(`Candidate ${decided.id} vanished from the index immediately after being dismissed.`)
    return view
  }

  /**
   * Promote every pending candidate backed by a **confirmed** finding.
   *
   * Safe as a bulk action precisely because `confirmed` cannot be reached without a human
   * and a written note — so this promotes nothing that a person has not already vouched
   * for individually. There is deliberately no "promote all" and no "promote all
   * corroborated": corroboration is two tools agreeing, and two tools agreeing about an
   * anti-bot redirect is the failure mode this whole app is built around.
   *
   * **One confirmation is one vouch, not one per thing the finding mentioned.** A pivot
   * finding — a profile page whose bio lists five links — is a single claim that proposes
   * five candidates, and confirming it says "that page really does list those links". It
   * does not say the five accounts are the subject's, and letting it promote all five in
   * one click would rebuild auto-promotion out of parts that are each individually
   * defensible. So a candidate whose only confirmed backing is shared with other
   * candidates is skipped here and stays in the queue, where it costs one deliberate click
   * each. This became reachable the moment the UI could confirm a finding at all.
   */
  async promoteConfirmedCandidates(caseId: string): Promise<Entity[]> {
    const pending = await this.listCandidates(caseId, 'pending')

    // How many *distinct* candidates each finding proposed, across the whole case rather
    // than the pending slice: a finding that proposed four things and had three of them
    // dismissed still proposed four things, and the operator's confirmation of it still
    // was not a statement about the fourth.
    const proposedBy = new Map<string, number>()
    for (const c of await this.listCandidates(caseId, 'all')) {
      for (const id of new Set(c.claims.map((cl) => cl.findingId))) {
        proposedBy.set(id, (proposedBy.get(id) ?? 0) + 1)
      }
    }

    const out: Entity[] = []
    for (const c of pending) {
      if (c.bestConfidence !== 'confirmed') continue
      const vouchedForThisAlone = c.claims.some(
        (cl) => cl.confidence === 'confirmed' && (proposedBy.get(cl.findingId) ?? 0) === 1
      )
      if (!vouchedForThisAlone) continue
      out.push(await this.promoteCandidate({ caseId, candidateId: c.id }))
    }
    return out
  }

  /* ---------------- findings ---------------- */

  async listFindings(caseId: string): Promise<Finding[]> {
    return listFindings(this.db, caseId)
  }

  async searchFindings(caseId: string, query: string): Promise<Finding[]> {
    return searchFindings(this.db, caseId, query)
  }

  /** Read the permanently stored, unparsed tool output behind a finding. */
  async readRaw(caseId: string, findingId: string): Promise<string> {
    const finding = await this.store.getFinding(caseId, findingId)
    if (!finding) throw new Error(`No finding ${findingId} in case ${caseId}.`)
    return this.store.readRaw(caseId, finding.raw)
  }

  async corroborationCandidates(caseId: string, findingId: string): Promise<Finding[]> {
    const finding = await this.store.getFinding(caseId, findingId)
    if (!finding) return []
    return findCorroborationCandidates(this.db, finding)
  }

  /**
   * The only path by which a finding's confidence changes. Delegates the rules to
   * `promote()` in shared/confidence.ts, writes the updated finding, and appends the
   * audit record.
   */
  async promoteFinding(req: PromoteRequest): Promise<Finding> {
    const finding = await this.store.getFinding(req.caseId, req.findingId)
    if (!finding) throw new Error(`No finding ${req.findingId} in case ${req.caseId}.`)

    let supporting: Finding[] = []
    if (req.supportingFindingIds?.length) {
      const { records } = await this.store.readFindings(req.caseId)
      const wanted = new Set(req.supportingFindingIds)
      supporting = records.filter((f) => wanted.has(f.id))
    } else if (req.actor === 'corroborator') {
      // Convenience: if the caller did not name the supporting findings, offer every
      // independent finding making the same claim. The rule still has to pass.
      supporting = findCorroborationCandidates(this.db, finding)
    }

    const { finding: updated, change } = promote({
      finding,
      to: req.to,
      actor: req.actor,
      supporting,
      note: req.note,
      idFactory: () => confidenceChangeId()
    })

    await this.store.replaceFinding(req.caseId, updated)
    await this.store.appendConfidenceChange(req.caseId, change)

    upsertFindingRow(this.db, updated)
    upsertConfidenceChangeRow(this.db, change)
    return updated
  }

  async listEvidence(caseId: string): Promise<Evidence[]> {
    return (await this.store.readEvidence(caseId)).records
  }

  async confidenceLog(caseId: string): Promise<ConfidenceChange[]> {
    return (await this.store.readConfidenceLog(caseId)).records
  }

  /* ---------------- jobs ---------------- */

  runJob(req: RunJobRequest): Job {
    return this.orchestrator.enqueue(sanitiseRunRequest(req)).job
  }

  runJobAndWait(req: RunJobRequest): Promise<Job> {
    return this.orchestrator.enqueue(sanitiseRunRequest(req)).whenSettled
  }

  /**
   * What a selection would run, without running any of it.
   *
   * One call covers four things the launcher used to be unable to express at all: run
   * everything applicable, one adapter across every entity it accepts, one entity across
   * every adapter that accepts it, and the intersection of two hand-made selections. An
   * omitted or empty list on either side means "all of them", so the four are the same
   * question with different halves left blank.
   *
   * **The lists that are not `runs` carry the honest half of the answer.** An adapter
   * that does not accept an entity's kind has not failed and is not broken — it cannot
   * answer that question. Pointing this at a name correctly enqueues nothing, and a
   * silent nothing is indistinguishable from a bug, so every entity and adapter left out
   * comes back with the reason written next to it.
   */
  async planRuns(req: RunPlanRequest): Promise<RunPlan> {
    const entities = await this.listEntities(req.caseId)
    const adapters = this.registry.describe(this.config, this.loaded.paths.toolkitRoot)

    const wantedEntities = new Set((req.entityIds ?? []).filter(Boolean))
    const wantedAdapters = new Set((req.adapterIds ?? []).filter(Boolean))
    const chosenEntities = wantedEntities.size
      ? entities.filter((e) => wantedEntities.has(e.id))
      : entities
    // An explicitly named adapter is an instruction, so the default skips do not apply to
    // it. `unfitForBatch` still does: no batch can carry a secret that has to be typed.
    const named = wantedAdapters.size > 0

    const excluded: RunPlan['excluded'] = []
    const usable: AdapterInfo[] = []
    for (const a of adapters) {
      if (named && !wantedAdapters.has(a.id)) continue
      const unfit = unfitForBatch(a)
      if (unfit) {
        excluded.push({ adapterId: a.id, adapterTitle: a.title, reason: unfit })
        continue
      }
      if (!named) {
        const skip = FANOUT_SKIPS_BY_DEFAULT.get(a.id)
        if (skip) {
          excluded.push({ adapterId: a.id, adapterTitle: a.title, reason: skip })
          continue
        }
      }
      if (!a.available) {
        excluded.push({
          adapterId: a.id,
          adapterTitle: a.title,
          reason: a.unavailableReason ?? 'Unavailable, with no reason given.'
        })
        continue
      }
      usable.push(a)
    }

    // Pairs already in flight. Queueing them twice is the definition of flooding, and the
    // orchestrator would happily do it because a job carries no identity beyond its id.
    const inFlight = new Set(
      this.orchestrator
        .listJobs(req.caseId)
        .filter((j) => !isTerminalJobState(j.state))
        .map((j) => `${j.adapterId}\u0000${j.entityId}`)
    )

    const runs: RunPlanEntry[] = []
    const alreadyQueued: RunPlanEntry[] = []
    const busyEntities = new Set<string>()
    const busyAdapters = new Set<string>()

    // Entity-major so the queue arrives grouped by subject rather than by tool: when
    // fourteen runs are listed, "everything about torvalds, then everything about
    // example.com" is a list somebody can read.
    for (const entity of chosenEntities) {
      for (const a of usable) {
        if (!a.accepts.includes(entity.kind)) continue
        const entry: RunPlanEntry = {
          adapterId: a.id,
          adapterTitle: a.title,
          entityId: entity.id,
          entityKind: entity.kind,
          entityLabel: entity.label
        }
        busyEntities.add(entity.id)
        busyAdapters.add(a.id)
        if (inFlight.has(`${a.id}\u0000${entity.id}`)) alreadyQueued.push(entry)
        else runs.push(entry)
      }
    }

    const idleEntities = chosenEntities
      .filter((e) => !busyEntities.has(e.id))
      .map((e) => ({
        entityId: e.id,
        kind: e.kind,
        label: e.label,
        reason: this.whyIdle(e.kind, usable, adapters, named)
      }))

    const idleAdapters = usable
      .filter((a) => !busyAdapters.has(a.id))
      .map((a) => ({
        adapterId: a.id,
        adapterTitle: a.title,
        accepts: a.accepts,
        reason: `${a.title} takes ${listKinds(a.accepts)}. Nothing selected is one.`
      }))

    return {
      caseId: req.caseId,
      runs,
      entitiesCovered: new Set(runs.map((r) => r.entityId)).size,
      adaptersUsed: new Set(runs.map((r) => r.adapterId)).size,
      idleEntities,
      idleAdapters,
      excluded,
      alreadyQueued
    }
  }

  /**
   * Why nothing in the selection can be pointed at this kind.
   *
   * The sentences live in `shared/ipc.ts` so the fixture bridge produces the same ones;
   * what belongs here is the registry knowledge that decides which of them is true.
   */
  private whyIdle(
    kind: EntityKind,
    usable: readonly AdapterInfo[],
    all: readonly AdapterInfo[],
    named: boolean
  ): string {
    const runnable = all.filter(
      (a) => a.accepts.includes(kind) && !unfitForBatch(a) && !FANOUT_SKIPS_BY_DEFAULT.has(a.id)
    )
    return idleKindReason({
      kind,
      runnable: runnable.map((a) => a.title),
      available: runnable.filter((a) => a.available).map((a) => a.title),
      named: named && !usable.some((a) => a.accepts.includes(kind))
    })
  }

  /**
   * Queue everything a selection plans, in plan order.
   *
   * Enqueued one at a time and never awaited: the orchestrator owns the concurrency caps
   * and the per-adapter rate limits, so handing it fourteen jobs at once is not fourteen
   * processes — it is fourteen queue entries it starts as its own rules allow. Doing the
   * throttling here as well would be a second, disagreeing scheduler.
   */
  async runPlan(req: RunPlanRequest): Promise<Job[]> {
    const plan = await this.planRuns(req)
    const jobs: Job[] = []
    for (const entry of plan.runs) {
      jobs.push(
        this.orchestrator.enqueue({
          caseId: req.caseId,
          entityId: entry.entityId,
          adapterId: entry.adapterId
        }).job
      )
    }
    return jobs
  }

  /** Stop every queued and running job in one case. Returns how many were stopped. */
  cancelCase(caseId: string): number {
    return this.orchestrator.cancelCase(caseId)
  }

  /* ---------------- index ---------------- */

  async rebuildIndex(): Promise<IndexStats> {
    return rebuildIndex(this.db, this.store)
  }

  async dispose(): Promise<void> {
    await this.orchestrator.dispose()
    this.db.close()
  }
}

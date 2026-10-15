/**
 * The investigation engine.
 *
 * `seed -> plan -> run -> extract leads -> score -> {expand | ask | park} -> repeat`,
 * until the budget, the depth cap, novelty decay or contradiction density says stop.
 *
 * ## What it is allowed to do, and what it is not
 *
 * It may **point tools at things**. That is the whole of its authority, and it is
 * deliberately recoverable: a run that was not worth doing costs a run and leaves a raw
 * capture on disk.
 *
 * It may **not** create an `Entity`, and it may not move a finding up the confidence
 * ladder. Automation never promotes. A wrongly promoted node poisons everything descending
 * from it and gets more convincing with depth, and there is no undo for that shape of
 * mistake — whereas an automatic dismissal keeps its record and a prune is one restore away
 * from undone. So the asymmetry in DECISIONS.md is the asymmetry here: **auto-dismiss is
 * recoverable, auto-promote is not.**
 *
 * ## How it expands without promoting
 *
 * A corroborated lead is a `pending` candidate, not an entity, and the orchestrator's job
 * needs a subject. So the engine hands the orchestrator the candidate **as a provisional
 * subject** — an entity-shaped object that is never written to `entities.json`. Two
 * consequences, both intended:
 *
 *  - The findings it produces are **orphaned** in exactly the sense this codebase already
 *    has a word for: a claim about something the case does not hold. The findings table
 *    already marks them, and the brief says which are the engine's and why.
 *  - `EntityCandidate.id` is content-addressed with the same formula as `EntityId`, so the
 *    moment a human promotes that candidate, every finding the engine already wrote about
 *    it attaches to the new entity with no rewriting and no duplication.
 *
 * The alternative — creating the entity — is the one thing the whole architecture forbids,
 * and the alternative to *that* is stopping at depth 1, which is the problem this file
 * exists to solve.
 */

import { EventEmitter } from 'node:events'
import type { CandidateView, Entity, Finding, Job } from '../../shared/types'
import {
  DEFAULT_BUDGET,
  nodeLabel,
  type ActionRanking,
  type Budget,
  type EngineDecision,
  type InvestigationBrief,
  type InvestigationRequest,
  type InvestigationRunState,
  type LeadDisposition,
  type LeadVerdict,
  type NodeRef,
  type PlannedAction,
  type ProvenanceChain,
  type ProvenanceHop,
  type PruneRequest,
  type PruneResult
} from '../../shared/engine'
import { anchorsFor, rankCandidates, seedContextFrom } from '../../shared/ranking'
import type { RelevanceAssessment } from '../../shared/relevance'
import { MIN_RUN_TIMEOUT_MS, pruneProvenanceOnRemoval, type OsintService } from '../service'
import { buildBrief } from './brief'
import { corroborationOf, disposeLead, isDerivedSource } from './corroboration'
import { planActions } from './planner'
import { ProvenanceGraph, mechanismFor } from './provenance'
import { EngineStore } from './store'
import { branchDensities, contradictedBranches, evaluateStops } from './stops'
import { YieldTable } from './yield'

export { EngineStore, PROVENANCE_FILE, ENGINE_LOG_FILE } from './store'
export { ProvenanceGraph, mechanismFor } from './provenance'
export { planActions, NEVER_AUTO } from './planner'
export { disposeLead, corroborationOf, engineSourceKey, independentSourcesOf } from './corroboration'
export { evaluateStops, contradictedBranches, branchDensities } from './stops'
export { YieldTable, ADAPTER_PRIOR } from './yield'
export { buildBrief } from './brief'

/** Everything one iteration of the loop needs to read. Assembled fresh every time. */
interface Snapshot {
  entities: Entity[]
  candidates: CandidateView[]
  allCandidates: CandidateView[]
  findings: Awaited<ReturnType<OsintService['listFindings']>>
  adapters: ReturnType<OsintService['registry']['describe']>
  graph: ProvenanceGraph
  hops: ProvenanceHop[]
  yields: YieldTable
  bands: Map<string, RelevanceAssessment>
  dispositions: Map<string, LeadVerdict>
  /** Findings **about** each node, keyed by the node's id. Post-fetch evidence. */
  evidenceAbout: Map<string, Finding[]>
  /** Folded sources that reached a node by linking back to what declared it. */
  reciprocal: Map<string, string[]>
}

export class InvestigationEngine extends EventEmitter {
  private readonly store: EngineStore
  private current: InvestigationRunState | null = null
  private cancelling = false

  /**
   * Building the engine is what joins a removal to the provenance graph.
   *
   * Removing an entity has to cut its provenance root, or the branch under it stays
   * reachable: the planner keeps spending runs on leads whose only route into the case
   * starts at something the operator deleted, and every chain the brief prints for them
   * names a seed that is no longer there.
   *
   * The service cannot call the engine — the engine is built on the service — so a removal
   * reaches it through `OsintService.onEntityRemoved`, and something has to connect the
   * two. That something used to be `ipc.ts`, which meant it happened only in the packaged
   * app: every test that constructed an engine got one with the hook unwired, so the defect
   * this closes was invisible to exactly the code written to catch it. Wiring it here
   * instead means every caller gets it, because there is no way to have an engine without
   * having run this line.
   *
   * The ordering the cut depends on — before a promoted candidate is returned to the review
   * queue, or the prune dismisses the very row the removal just reopened — lives in
   * `service.removeEntity`, not here, and is unaffected by where the wiring happens.
   *
   * Wiring is last-writer-wins on purpose. Two engines over one service both install the
   * same behaviour, and a test that wants a stub installs it after constructing whatever it
   * needs.
   */
  constructor(private readonly service: OsintService) {
    super()
    this.store = new EngineStore((caseId) => service.store.dir(caseId))
    pruneProvenanceOnRemoval(service, this)
  }

  /* ---------------- reading ---------------- */

  state(): InvestigationRunState | null {
    return this.current
  }

  async decisions(caseId: string, limit = 0): Promise<EngineDecision[]> {
    return this.store.readDecisions(caseId, limit)
  }

  async chains(caseId: string): Promise<ProvenanceChain[]> {
    return (await this.snapshot(caseId)).graph.chains()
  }

  async chain(caseId: string, nodeId: string): Promise<ProvenanceChain | null> {
    return (await this.snapshot(caseId)).graph.chainFor(nodeId)
  }

  /**
   * What the engine would do next, without doing any of it.
   *
   * Pure: nothing is queued and nothing is written by asking. Shown before a run starts,
   * because some of the actions take minutes and because a plan of nothing is a real answer
   * that has to be able to explain itself.
   */
  async plan(caseId: string, req?: Partial<InvestigationRequest>): Promise<ActionRanking> {
    const snap = await this.snapshot(caseId)
    return planActions({
      caseId,
      entities: snap.entities,
      candidates: snap.candidates,
      findings: snap.findings,
      adapters: snap.adapters,
      graph: snap.graph,
      yields: snap.yields,
      budget: mergeBudget(req?.budget),
      bands: snap.bands,
      alreadyRun: new Set(),
      dispositions: snap.dispositions,
      contradictedBranches: new Set(),
      adapterIds: req?.adapterIds,
      roots: rootSet(req?.rootEntityIds),
      at: new Date().toISOString()
    })
  }

  async brief(caseId: string): Promise<InvestigationBrief> {
    const snap = await this.snapshot(caseId)
    const ranking = planActions({
      caseId,
      entities: snap.entities,
      candidates: snap.candidates,
      findings: snap.findings,
      adapters: snap.adapters,
      graph: snap.graph,
      yields: snap.yields,
      budget: this.current?.budget ?? DEFAULT_BUDGET,
      bands: snap.bands,
      alreadyRun: new Set(),
      dispositions: snap.dispositions,
      contradictedBranches: new Set(),
      at: new Date().toISOString()
    })
    return buildBrief({
      caseId,
      graph: snap.graph,
      entities: snap.entities,
      candidates: snap.allCandidates,
      findings: snap.findings,
      bands: snap.bands,
      dispositions: snap.dispositions,
      ranking,
      run: this.current?.caseId === caseId ? this.current : null,
      decisions: await this.store.readDecisions(caseId, 40),
      neverRun: !(await this.store.hasRun(caseId))
    })
  }

  /* ---------------- pruning ---------------- */

  /**
   * Cut a node and everything whose only route ran through it.
   *
   * The operation the whole provenance model exists to make possible, and the reason
   * automation is safe enough to run at all: a wrong hop is one call away from undone,
   * together with every conclusion that descended from it.
   *
   * Candidates under the cut are **dismissed**, which is recoverable — a dismissal keeps
   * the record and `restore` puts them back. Entities under the cut are **named and not
   * touched**: removing one orphans its findings and writes a tombstone, and that is a
   * decision with visible consequences the operator has to make himself.
   */
  async prune(req: PruneRequest, actor: 'engine' | 'human' = 'human'): Promise<PruneResult> {
    const reason = req.reason.trim()
    if (!reason) throw new Error('A prune needs a reason. Cutting a branch without recording why is the failure this model exists to prevent.')

    const snap = await this.snapshot(req.caseId)
    const node = snap.graph.node(req.nodeId)
    const at = new Date().toISOString()
    if (!node) {
      return { caseId: req.caseId, node: null, action: 'prune', cut: [], candidatesDismissed: 0, entitiesAffected: [], reason, at }
    }

    const cut = [node, ...snap.graph.descendantsOf(req.nodeId)]
    for (const n of cut) {
      await this.store.appendPrune({ caseId: req.caseId, nodeId: n.id, action: 'prune', actor, reason, at })
    }

    const inGraph = new Set(snap.entities.map((e) => e.id))
    const pendingIds = new Set(snap.allCandidates.filter((c) => c.state === 'pending').map((c) => c.id))
    let dismissed = 0
    for (const n of cut) {
      if (!pendingIds.has(n.id)) continue
      await this.service.dismissCandidate({ caseId: req.caseId, candidateId: n.id })
      dismissed++
    }

    await this.store.appendDecision({
      caseId: req.caseId,
      kind: 'pruned',
      node,
      reason: `${reason} Cut ${cut.length} node${cut.length === 1 ? '' : 's'}; ${dismissed} candidate${dismissed === 1 ? '' : 's'} dismissed. Nothing was deleted and restoring the node puts every one of them back.`,
      at
    })

    return {
      caseId: req.caseId,
      node,
      action: 'prune',
      cut,
      candidatesDismissed: dismissed,
      entitiesAffected: cut.filter((n) => inGraph.has(n.id)),
      reason,
      at
    }
  }

  /** Undo a prune: the node, and everything that was cut with it, come back. */
  async restore(caseId: string, nodeId: string): Promise<PruneResult> {
    const { prunes } = await this.store.readProvenance(caseId)
    const at = new Date().toISOString()
    const snap = await this.snapshot(caseId)
    const node = snap.graph.node(nodeId)

    // Everything cut by the same prune reason at the same moment comes back together. The
    // records carry the timestamp of the prune that made them, which is what makes a
    // multi-node cut one reversible act rather than a pile of separate ones.
    const target = [...prunes].reverse().find((p) => p.nodeId === nodeId && p.action === 'prune')
    if (!target) {
      return { caseId, node, action: 'restore', cut: [], candidatesDismissed: 0, entitiesAffected: [], reason: 'Nothing to restore: this node has not been pruned.', at }
    }
    const together = prunes.filter((p) => p.action === 'prune' && p.at === target.at && p.reason === target.reason)

    const restored: NodeRef[] = []
    for (const p of together) {
      await this.store.appendPrune({
        caseId,
        nodeId: p.nodeId,
        action: 'restore',
        actor: 'human',
        reason: `Restored. The cut said: ${p.reason}`,
        at
      })
      const n = snap.graph.node(p.nodeId)
      if (n) restored.push(n)
    }

    let reopened = 0
    for (const c of snap.allCandidates) {
      if (c.state !== 'dismissed') continue
      if (!together.some((p) => p.nodeId === c.id)) continue
      await this.service.store.decideCandidate(caseId, c.id, 'pending')
      reopened++
    }
    // The index holds a copy of the candidate's state; re-read the case rather than
    // hand-patching rows, so the two cannot disagree.
    if (reopened) await this.service.reindexCase(caseId)

    await this.store.appendDecision({
      caseId,
      kind: 'pruned',
      node,
      reason: `Restored ${restored.length} node${restored.length === 1 ? '' : 's'} and reopened ${reopened} candidate${reopened === 1 ? '' : 's'}. The original cut said: ${target.reason}`,
      at
    })

    return {
      caseId,
      node,
      action: 'restore',
      cut: restored,
      candidatesDismissed: reopened,
      entitiesAffected: [],
      reason: target.reason,
      at
    }
  }

  /* ---------------- running ---------------- */

  cancel(): boolean {
    if (!this.current || this.current.phase === 'done' || this.current.phase === 'failed' || this.current.phase === 'stopped') {
      return false
    }
    this.cancelling = true
    this.service.orchestrator.cancelCase(this.current.caseId)
    return true
  }

  /**
   * Start an investigation. Returns as soon as it is registered; progress arrives on
   * `run:update`, and `whenFinished` is what the tests and the brief wait on.
   */
  start(req: InvestigationRequest): { state: InvestigationRunState; whenFinished: Promise<InvestigationRunState> } {
    if (this.current && !isTerminal(this.current)) {
      throw new Error(`An investigation is already running on case ${this.current.caseId}.`)
    }
    this.cancelling = false
    const budget = mergeBudget(req.budget)
    const state: InvestigationRunState = {
      caseId: req.caseId,
      phase: 'planning',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      budget,
      runsUsed: 0,
      running: [],
      depthReached: 0,
      quietExpansions: 0,
      leads: { expanded: 0, probed: 0, asked: 0, parked: 0 },
      pruned: 0,
      stop: null,
      message: 'Recording where the case starts from.',
      error: null
    }
    this.current = state
    this.emitRun()

    const whenFinished = this.execute(req, state).catch(async (err) => {
      state.phase = 'failed'
      state.error = (err as Error).message
      state.finishedAt = new Date().toISOString()
      state.message = 'The investigation stopped on an error. Everything it had already written is on disk.'
      await this.store
        .appendDecision({ caseId: req.caseId, kind: 'stopped', reason: `Stopped on an error: ${state.error}` })
        .catch(() => undefined)
      this.emitRun()
      return state
    })

    return { state, whenFinished }
  }

  private emitRun(): void {
    if (this.current) this.emit('run:update', { ...this.current, running: [...this.current.running] })
  }

  private async execute(req: InvestigationRequest, state: InvestigationRunState): Promise<InvestigationRunState> {
    const caseId = req.caseId
    const startedMs = Date.now()

    await this.ensureRoots(caseId, req.rootEntityIds)

    const alreadyRun = new Set<string>()
    const prunedBranches = new Set<string>()
    // What the engine last said about each lead, so a disposition that changes can be
    // reported as a change rather than silently replaced.
    const recorded = new Map<string, LeadDisposition>()
    let failure: string | null = null

    state.phase = 'running'
    this.emitRun()

    for (;;) {
      const snap = await this.snapshot(caseId)
      const densities = branchDensities({
        candidates: snap.candidates,
        bands: snap.bands,
        graph: snap.graph
      })
      const branches = contradictedBranches({ densities, budget: state.budget })

      // A branch that is mostly contradicted is cut before the next action is chosen, so
      // the budget is never spent on it a second time.
      for (const b of branches) {
        if (prunedBranches.has(b.branchId)) continue
        prunedBranches.add(b.branchId)
        const result = await this.prune({ caseId, nodeId: b.branchId, reason: b.reason }, 'engine')
        state.pruned += result.cut.length
        this.emitRun()
      }
      if (branches.length) continue

      const ranking = planActions({
        caseId,
        entities: snap.entities,
        candidates: snap.candidates,
        findings: snap.findings,
        adapters: snap.adapters,
        graph: snap.graph,
        yields: snap.yields,
        budget: state.budget,
        bands: snap.bands,
        alreadyRun,
        dispositions: snap.dispositions,
        contradictedBranches: new Set(branches.map((b) => b.branchId)),
        adapterIds: req.adapterIds,
        // The same scope the roots were recorded under. Without this the request means
        // "record a root for this one and then work on everything", which is not what
        // "follow this account and nothing else" says.
        roots: rootSet(req.rootEntityIds),
        at: new Date().toISOString()
      })

      const stops = evaluateStops({
        budget: state.budget,
        runsUsed: state.runsUsed,
        elapsedMs: Date.now() - startedMs,
        depthReached: state.depthReached,
        quietExpansions: state.quietExpansions,
        // Contradiction density is reported, never fired on, and it is reported **per
        // branch** because that is the only level at which it means anything. The queue as a
        // whole includes every candidate an earlier manual sweep left lying around, so a
        // global reading could — and did — halt the run before its first action, on the
        // arithmetic of a seed it was not even working.
        branches: densities,
        branchesPruned: prunedBranches.size,
        exhausted: ranking.exhausted,
        blockedByDepth: ranking.blocked.filter((a) => a.blocked?.includes('hops out')).length,
        cancelled: this.cancelling,
        failure
      })

      if (stops.fired) {
        state.stop = stops.fired
        await this.store.appendDecision({
          caseId,
          kind: 'stopped',
          reason: `Stopped: ${stops.fired.detail}`
        })
        break
      }

      const action = ranking.actions[0]
      if (!action) {
        // `evaluateStops` should have caught this as `exhausted`; if the two ever disagree,
        // the loop stops rather than spinning, and says so.
        state.stop = { id: 'exhausted', fired: true, pressure: 1, detail: 'Nothing left that the engine is allowed to do.' }
        await this.store.appendDecision({ caseId, kind: 'stopped', reason: 'Nothing left that the engine is allowed to do.' })
        break
      }

      // The ranking is the teaching surface, so the runners-up are recorded too — not just
      // the winner. Two is enough to show the shape of the decision without turning the log
      // into a transcript of the whole table.
      for (const runnerUp of ranking.actions.slice(1, 3)) {
        await this.store.appendDecision({
          caseId,
          kind: 'skipped',
          node: runnerUp.node,
          adapterId: runnerUp.adapterId,
          gain: runnerUp.gain,
          reason: `Ranked ${runnerUp.gain} against ${action.gain} for ${action.adapterTitle} on ${nodeLabel(action.node)}. ${runnerUp.reason}`
        })
      }

      const remaining = state.budget.maxWallClockMs - (Date.now() - startedMs)
      if (remaining < MIN_RUN_TIMEOUT_MS) continue

      const before = actionableIds(snap)
      const job = await this.runAction(caseId, action, snap, remaining)
      state.runsUsed++
      alreadyRun.add(action.key)
      state.depthReached = Math.max(state.depthReached, action.depth)

      // The hops are written **before** the state is re-read, and the order is load-bearing.
      // Whether a lead may be followed depends on how it was reached — a link the subject
      // wrote is followed, a name printed on a page is not — so a snapshot taken before the
      // hops exist scores every new lead as unreachable, and the loop then stops on novelty
      // decay one run after finding exactly the thing it was looking for.
      await this.recordHops(caseId, action.node, job, await this.snapshot(caseId))

      const after = await this.snapshot(caseId)
      // How deep the *investigation* got, not how deep the last action was pointed. A lead
      // reached at depth 2 and left for the operator is still a depth-2 result, and
      // reporting the action's depth instead would understate what the run actually did.
      for (const c of after.graph.chains()) state.depthReached = Math.max(state.depthReached, c.depth)
      const newlyActionable = [...actionableIds(after)].filter((id) => !before.has(id))

      const disposed = await this.disposeNewLeads(caseId, action.node, job, state, after, recorded)
      // Everything the engine already had an opinion about, re-read against what this run
      // learned. This is the half that makes the loop evidence-driven rather than
      // first-impression-driven: the node it just fetched is scored again, now including the
      // findings the fetch produced about it, and a profile that turned out to belong to
      // somebody else is parked here.
      const revised = await this.reviseDispositions(caseId, state, after, recorded)
      state.quietExpansions = newlyActionable.length > 0 ? 0 : state.quietExpansions + 1

      state.message =
        `${state.runsUsed} run${state.runsUsed === 1 ? '' : 's'}. ` +
        `${state.leads.expanded} expanded, ${state.leads.probed} probed, ${state.leads.asked} waiting on you, ${state.leads.parked} parked.` +
        (disposed === 0 && revised === 0 ? ' The last run produced no new leads.' : '')
      this.emitRun()
    }

    state.phase = this.cancelling ? 'stopped' : 'done'
    state.finishedAt = new Date().toISOString()
    state.running = []
    state.message = summarise(state)
    this.emitRun()
    return state
  }

  /* ---------------- one action ---------------- */

  private async runAction(
    caseId: string,
    action: PlannedAction,
    snap: Snapshot,
    remainingMs: number
  ): Promise<Job> {
    const state = this.current
    const candidate = snap.allCandidates.find((c) => c.id === action.node.id)
    const inGraph = snap.entities.some((e) => e.id === action.node.id)

    await this.store.appendDecision({
      caseId,
      kind: 'ran',
      node: action.node,
      adapterId: action.adapterId,
      gain: action.gain,
      reason: `Chose ${action.adapterTitle} on ${nodeLabel(action.node)} at ${action.depth} hop${action.depth === 1 ? '' : 's'} out, expected gain ${action.gain}${action.basis === 'prior' ? ' (estimated, not measured)' : ' (measured in this case)'}. ${action.reason}`
    })

    // A candidate is not in the graph, so it is handed over as a provisional subject: an
    // entity-shaped object the orchestrator runs against and nothing ever writes to
    // `entities.json`. This is the one thing that lets depth exceed 1 without automation
    // promoting anything.
    const subject: Entity | undefined =
      inGraph || !candidate
        ? undefined
        : ({
            id: candidate.id,
            caseId,
            kind: candidate.kind,
            value: candidate.value,
            label: candidate.label,
            createdAt: candidate.firstProposedAt,
            seed: false,
            attrs: candidate.attrs
          } as Entity)

    if (state) {
      state.running.push({ adapterId: action.adapterId, nodeLabel: nodeLabel(action.node) })
      this.emitRun()
    }

    const enqueued = this.service.orchestrator.enqueue({
      caseId,
      entityId: action.node.id,
      adapterId: action.adapterId,
      subject,
      // Never let one adapter's default outlive the whole investigation's budget. Maigret's
      // ceiling is a quarter of an hour on its own.
      timeoutMs: Math.max(MIN_RUN_TIMEOUT_MS, Math.floor(remainingMs))
    })
    const job = await enqueued.whenSettled

    if (state) {
      const at = state.running.findIndex((r) => r.adapterId === action.adapterId && r.nodeLabel === nodeLabel(action.node))
      if (at >= 0) state.running.splice(at, 1)
      this.emitRun()
    }

    if (job.state !== 'done') {
      await this.store.appendDecision({
        caseId,
        kind: 'skipped',
        node: action.node,
        adapterId: action.adapterId,
        reason: `${action.adapterTitle} finished as "${job.state}"${job.error ? `: ${firstLine(job.error)}` : '.'} The capture is on disk either way — a tool failing on an input is a durable fact about the tool.`
      })
    }

    return job
  }

  /**
   * Turn this run's proposals into hops.
   *
   * One hop per (candidate, proposing finding), so a candidate reached twice by two routes
   * carries two hops and `ProvenanceChain.alternates` can say so. The mechanism comes from
   * **the adapter that produced the proposal** — see `mechanismFor` — because "the account
   * holder linked to it" and "a site list says the handle is taken" are not the same claim,
   * a chain that renders them identically is worthless, and a chain that lets a fetched
   * page's own words decide which of the two it is can be forged by that page.
   */
  private async recordHops(caseId: string, from: NodeRef, job: Job, snap: Snapshot): Promise<void> {
    if (!job.findingIds.length) return
    const produced = new Set(job.findingIds)
    const existing = new Set(snap.hops.filter((h) => h.findingId).map((h) => `${h.to.id}|${h.findingId}`))

    for (const c of snap.allCandidates) {
      for (const p of c.proposals) {
        if (!produced.has(p.findingId)) continue
        const key = `${c.id}|${p.findingId}`
        if (existing.has(key)) continue
        existing.add(key)
        const mechanism = mechanismFor(p.tool, p.mechanism)
        await this.store.appendHop({
          caseId,
          to: { id: c.id, kind: c.kind, value: c.value, label: c.label },
          from,
          mechanism,
          findingId: p.findingId,
          tool: p.tool,
          source: p.source,
          detail: p.rationale,
          at: p.at
        })
      }
    }
  }

  /** Score every lead this run proposed and record what the engine decided about it. */
  private async disposeNewLeads(
    caseId: string,
    from: NodeRef,
    job: Job,
    state: InvestigationRunState,
    snap: Snapshot,
    recorded: Map<string, LeadDisposition>
  ): Promise<number> {
    if (!job.findingIds.length) return 0
    const produced = new Set(job.findingIds)
    let n = 0

    for (const c of snap.candidates) {
      if (!c.proposals.some((p) => produced.has(p.findingId))) continue
      if (recorded.has(c.id)) continue
      const verdict = snap.dispositions.get(c.id)
      if (!verdict) continue
      n++
      recorded.set(c.id, verdict.disposition)
      count(state, verdict.disposition, 1)
      await this.store.appendDecision({
        caseId,
        kind: decisionKind(verdict.disposition),
        node: verdict.node,
        reason: `${nodeLabel(verdict.node)}, reached from ${nodeLabel(from)}. ${verdict.reason}`
      })
    }
    return n
  }

  /**
   * Re-read every lead the engine already decided about, and record the ones that changed.
   *
   * A disposition is a reading of the evidence at a moment, and fetching a node is how the
   * evidence changes. Before this existed, `rowFromCandidate` scored a candidate on the
   * claims that *proposed* it — written before anything had opened it — so the engine could
   * expand a lead, read a profile plainly belonging to a differently-named person, write
   * that finding into the case, and leave the node sitting at `expand` with the contradiction
   * visible on the findings table and invisible to the loop. The per-branch prune did not
   * catch it either: one profile read yields one contradicted `person` among a location, an
   * organisation and an avatar, which is nowhere near the density that cuts a branch.
   *
   * Both directions are recorded. A lead that gains a second source and moves from `probe`
   * to `expand` is as much a change of mind as one that is parked, and an engine that only
   * logs the bad news is not showing its work.
   */
  private async reviseDispositions(
    caseId: string,
    state: InvestigationRunState,
    snap: Snapshot,
    recorded: Map<string, LeadDisposition>
  ): Promise<number> {
    let n = 0
    for (const c of snap.candidates) {
      const was = recorded.get(c.id)
      if (!was) continue
      const verdict = snap.dispositions.get(c.id)
      if (!verdict || verdict.disposition === was) continue
      n++
      recorded.set(c.id, verdict.disposition)
      count(state, was, -1)
      count(state, verdict.disposition, 1)
      await this.store.appendDecision({
        caseId,
        kind: decisionKind(verdict.disposition),
        node: verdict.node,
        reason:
          `${nodeLabel(verdict.node)} was ${DISPOSITION_PAST[was]} and is now ${DISPOSITION_PAST[verdict.disposition]}, ` +
          `because reading it produced evidence the first scoring could not have seen. ${verdict.reason}`
      })
    }
    return n
  }

  /* ---------------- state assembly ---------------- */

  /**
   * Record a root for anything in the case that has none.
   *
   * A seed gets a `seed` hop; an entity a human promoted before the engine ever ran gets a
   * `promotion` hop that says out loud that its route was not recorded. Inventing a route
   * for it would be worse than admitting there is none — the entire value of the chain is
   * that it is true.
   */
  private async ensureRoots(caseId: string, rootEntityIds?: readonly string[]): Promise<void> {
    const entities = await this.service.listEntities(caseId)
    const { hops } = await this.store.readProvenance(caseId)
    const known = new Set(hops.map((h) => h.to.id))
    const wanted = rootEntityIds?.length ? new Set(rootEntityIds) : null
    const at = new Date().toISOString()

    for (const e of entities) {
      if (known.has(e.id)) continue
      if (wanted && !wanted.has(e.id)) continue
      const seed = e.seed
      await this.store.appendHop({
        caseId,
        to: { id: e.id, kind: e.kind, value: e.value, label: e.label },
        from: null,
        mechanism: seed ? 'seed' : 'promotion',
        findingId: null,
        tool: null,
        source: null,
        detail: seed
          ? `You put this into the case yourself. Everything the engine reaches from here is measured against it.`
          : `Promoted into the case by hand before the engine ran, so how it was originally reached is not recorded. The engine treats it as ground because a person looked at it.`,
        at
      })
      await this.store.appendDecision({
        caseId,
        kind: 'seeded',
        node: { id: e.id, kind: e.kind, value: e.value, label: e.label },
        reason: seed
          ? `${nodeLabel(e)} is where this investigation starts.`
          : `${nodeLabel(e)} was already in the case and had no recorded route, so it is treated as a root.`,
        at
      })
    }
  }

  private async snapshot(caseId: string): Promise<Snapshot> {
    const summary = await this.service.getCase(caseId)
    const [entities, allCandidates, findings] = await Promise.all([
      this.service.listEntities(caseId),
      this.service.listCandidates(caseId, 'all'),
      this.service.listFindings(caseId)
    ])
    const adapters = this.service.registry.describe(this.service.config, this.service.loaded.paths.toolkitRoot)
    const { hops, prunes } = await this.store.readProvenance(caseId)

    // Seeds that name one thing, plus whatever a human has confirmed — with `username` and
    // `person` excluded from *both* routes. See `anchorsFor`, which owns the rule and the
    // reason it is not simply "any confirmed finding".
    const anchors = anchorsFor(entities, findings)

    const graph = new ProvenanceGraph(hops, prunes, {
      seeds: new Set(entities.filter((e) => e.seed).map((e) => e.id)),
      anchors,
      inGraph: new Set(entities.map((e) => e.id))
    })

    const candidates = allCandidates.filter((c) => c.state === 'pending')
    const seeds = seedContextFrom(entities, summary?.subject)

    // Everything **a source** has said about a node, keyed by the node it is about. A
    // finding's `entityId` is content-addressed with the same formula as a candidate's id,
    // so a run pointed at a candidate as a provisional subject already writes rows that
    // land here.
    //
    // This is what lets a disposition be revised by what the fetch found. Scoring a
    // candidate on its proposing claims alone asks "why did somebody think this existed",
    // which was answered before anything read it — so the engine could open a profile, read
    // a different person's name off it, and leave the node exactly where it was.
    //
    // Derived rows are excluded, and that matters more since `parse()` began running on
    // failed runs: a blocked tool now always leaves a `local:<adapter>` record, and those
    // records describe *the app's own run* rather than the node. They routinely quote the
    // query that was refused — which means the seeded name — and a scorer reading that
    // would score a row as agreeing with the seeds because the seeds are what it was asked
    // about. `ranking.ts` already refuses to count the handle for exactly that reason: it
    // is the query, not an observation.
    const evidenceAbout = new Map<string, Finding[]>()
    for (const f of findings) {
      if (isDerivedSource(f.source)) continue
      const list = evidenceAbout.get(f.entityId) ?? []
      list.push(f)
      evidenceAbout.set(f.entityId, list)
    }

    const bands = new Map<string, RelevanceAssessment>()
    for (const r of rankCandidates(candidates, seeds, undefined, evidenceAbout)) {
      bands.set(r.item.id, r.relevance)
    }

    // Reciprocity, per node: the far end publishing the same connection back.
    //
    // A hop `X -> P` means a run pointed at X produced a claim naming P. When P is also the
    // node X was reached *from* by a declared link, that is the other site operator asserting
    // the connection the subject asserted — the second source the declared-link argument was
    // always about, and which the engine used to collect and drop on the floor because the
    // proposal it arrives as is about P, not about X.
    const reciprocal = new Map<string, string[]>()
    for (const hop of hops) {
      if (!hop.from || !hop.source) continue
      if (hop.mechanism !== 'declared-link') continue
      const back = graph.chainFor(hop.from.id)
      const cameFrom = back?.hops[back.hops.length - 1]
      // `hop` goes from.id -> to.id; it reciprocates when the route that reached `from`
      // arrived from `to` by a declaration of its own.
      if (!cameFrom?.from || cameFrom.from.id !== hop.to.id) continue
      if (cameFrom.mechanism !== 'declared-link') continue
      const list = reciprocal.get(hop.from.id) ?? []
      list.push(hop.source)
      reciprocal.set(hop.from.id, list)
    }

    const dispositions = new Map<string, LeadVerdict>()
    const budget = this.current?.budget ?? DEFAULT_BUDGET
    const inGraph = new Set(entities.map((e) => e.id))
    for (const c of candidates) {
      const chain = graph.chainFor(c.id)
      const depth = chain?.depth ?? 1
      const allowance = chain?.rootIsAnchor ? budget.maxDepth + 1 : budget.maxDepth
      // The declaring node, not just the last mechanism. Reading only the last hop asks "was
      // the final step a declaration", which constrains nothing about the ladder underneath
      // it — and `MECHANISM_STRENGTH` calls `seed` and `promotion` declared too, so a root's
      // own hop used to read as one. `hops[0]` is the root's own hop and has no `from`.
      const route = chain?.hops ?? []
      const last = route.length > 1 ? route[route.length - 1] : undefined
      const declaredRoute = Boolean(last?.from) && last?.mechanism === 'declared-link'
      const parent = last?.from ?? null
      const parentCandidate = parent ? allCandidates.find((x) => x.id === parent.id) : undefined
      // Trusted means the engine already stands on it: an entity a person put in the case,
      // or a lead two independent sources agree on. A probe result is neither, which is what
      // makes the permission non-transitive.
      const parentTrusted = Boolean(
        parent &&
          (inGraph.has(parent.id) ||
            (parentCandidate ? corroborationOf(parentCandidate, reciprocal.get(parent.id) ?? []).corroborated : false))
      )
      dispositions.set(
        c.id,
        disposeLead({
          node: { id: c.id, kind: c.kind, value: c.value, label: c.label },
          candidate: c,
          band: bands.get(c.id)?.band ?? 'silent',
          depth,
          withinDepth: depth <= allowance,
          declaredRoute,
          parentTrusted,
          reciprocalSources: reciprocal.get(c.id) ?? []
        })
      )
    }

    return {
      entities,
      candidates,
      allCandidates,
      findings,
      adapters,
      graph,
      hops,
      yields: new YieldTable({
        decisions: await this.store.readDecisions(caseId),
        candidates: allCandidates,
        hops,
        reciprocal
      }),
      bands,
      dispositions,
      evidenceAbout,
      reciprocal
    }
  }

  dispose(): void {
    this.removeAllListeners()
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function mergeBudget(patch?: Partial<Budget>): Budget {
  const b = { ...DEFAULT_BUDGET, ...(patch ?? {}) }
  return {
    maxRuns: clampInt(b.maxRuns, 1, 500, DEFAULT_BUDGET.maxRuns),
    maxWallClockMs: clampInt(b.maxWallClockMs, 5_000, 4 * 60 * 60 * 1_000, DEFAULT_BUDGET.maxWallClockMs),
    maxDepth: clampInt(b.maxDepth, 1, 5, DEFAULT_BUDGET.maxDepth),
    noveltyWindow: clampInt(b.noveltyWindow, 1, 50, DEFAULT_BUDGET.noveltyWindow),
    contradictionShare: Number.isFinite(b.contradictionShare)
      ? Math.max(0.05, Math.min(1, b.contradictionShare))
      : DEFAULT_BUDGET.contradictionShare,
    contradictionFloor: clampInt(b.contradictionFloor, 1, 200, DEFAULT_BUDGET.contradictionFloor)
  }
}

/**
 * The requested roots as a set, or undefined for "the whole case".
 *
 * An empty array means the same as no array — the request named nothing, so nothing is
 * excluded. Treating it as "no roots are in scope" would turn a harmless empty field into
 * an investigation that refuses to do anything and cannot say why.
 */
function rootSet(ids?: readonly string[]): ReadonlySet<string> | undefined {
  return ids?.length ? new Set(ids) : undefined
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.round(v)))
}

function isTerminal(s: InvestigationRunState): boolean {
  return s.phase === 'done' || s.phase === 'failed' || s.phase === 'stopped'
}

/**
 * Leads the engine may act on without asking — `expand` **and** `probe`.
 *
 * The novelty counter is measured on this rather than on corroboration alone, because this
 * is what "the loop is still going somewhere" actually means here: a run that produced
 * fifteen single-source handle hits has produced nothing the engine may act on, and a run
 * that produced one link the subject published has.
 *
 * Both dispositions count, and only for this. Everywhere else the two are kept apart —
 * `brief.ts` files a probe under Pending, `yield.ts` credits it nothing — because "may the
 * engine spend a run on this" and "is this believed" are different questions and answering
 * both with one word is what let a fetch permission read as a corroborated fact.
 */
function actionableIds(snap: Snapshot): Set<string> {
  const out = new Set<string>()
  for (const [id, v] of snap.dispositions) {
    if (v.disposition === 'expand' || v.disposition === 'probe') out.add(id)
  }
  return out
}

const DISPOSITION_PAST: Record<LeadDisposition, string> = {
  expand: 'being followed on two independent sources',
  probe: 'cleared for one run on the subject’s own link',
  ask: 'a question for you',
  park: 'parked as contradicted'
}

function decisionKind(d: LeadDisposition): 'expanded' | 'probed' | 'parked' | 'asked' {
  if (d === 'expand') return 'expanded'
  if (d === 'probe') return 'probed'
  if (d === 'park') return 'parked'
  return 'asked'
}

/** Move one lead between the run's counters. `delta` is +1 on a new reading, -1 on a revised one. */
function count(state: InvestigationRunState, d: LeadDisposition, delta: number): void {
  const leads = state.leads
  if (d === 'expand') leads.expanded = Math.max(0, leads.expanded + delta)
  else if (d === 'probe') leads.probed = Math.max(0, leads.probed + delta)
  else if (d === 'park') leads.parked = Math.max(0, leads.parked + delta)
  else leads.asked = Math.max(0, leads.asked + delta)
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? s
}

function summarise(state: InvestigationRunState): string {
  const { expanded, probed, asked, parked } = state.leads
  const head = `${state.runsUsed} run${state.runsUsed === 1 ? '' : 's'}, ${state.depthReached} hop${state.depthReached === 1 ? '' : 's'} out.`
  const leads = `${expanded} expanded on two sources, ${probed} read once on a link the subject published, ${asked} waiting on you, ${parked} parked.`
  const stop = state.stop ? ` Stopped on ${state.stop.id.replace('-', ' ')}: ${state.stop.detail}` : ''
  return `${head} ${leads}${stop}`
}

/**
 * When to stop, and which of the four reasons it was.
 *
 * Nothing in the app previously knew when it was done, because nothing was ever running on
 * its own. An automatic loop needs all four of these and needs them to be separable, since
 * "it ran out of budget" and "it stopped finding anything new" are opposite diagnoses:
 * the first says give it more, the second says the technique is spent and the next move is
 * a better anchor.
 *
 *  - **Budget** — a cap on runs and on wall-clock.
 *  - **Depth** — 2 by default, and 3 only from an anchor a human has confirmed.
 *  - **Novelty decay** — if the last N expansions produced no newly corroborated lead, the
 *    loop is spinning and more of it will not help.
 *  - **Contradiction density** — a branch producing mostly leads that contradict the seeds
 *    is pruned rather than spent on further. This one **never ends the run**: it is reported
 *    with its pressure so the brief can show how close the worst branch is to being cut, and
 *    the cut itself is the action. Measuring it case-wide and halting on it contradicted the
 *    rationale and could stop an investigation before its first action.
 *
 * Every condition is reported whether or not it fired, with a `pressure` between 0 and 1,
 * so the brief can show headroom instead of only announcing the ending. Knowing the run
 * stopped one expansion short of the novelty window is worth more than knowing it stopped.
 */

import type { Budget, StopCondition, StopReasonId, StopState } from '../../shared/engine'
import type { CandidateView } from '../../shared/types'
import type { RelevanceAssessment } from '../../shared/relevance'
import type { ProvenanceGraph } from './provenance'

export interface StopInput {
  budget: Budget
  runsUsed: number
  elapsedMs: number
  depthReached: number
  /**
   * Consecutive expansions that produced no lead the engine may act on.
   *
   * "Act on" rather than "corroborate" because those are the same thing under this engine's
   * own steering: `corroboration.ts` is the only thing that decides an expansion, and a run
   * whose leads it will not follow has moved the case no further forward whatever it
   * printed. Counting corroboration alone would stop a run that had just found a link the
   * subject wrote and was about to follow it.
   */
  quietExpansions: number
  /**
   * Contradiction density **per branch**, as `branchDensities` measured it.
   *
   * Per branch and never case-wide, because case-wide is not the same quantity and reading
   * it as one halted runs that were doing fine. See the note above `contradictedBranches`.
   */
  branches: readonly BranchDensity[]
  /** Branches this run has already cut for contradiction density. */
  branchesPruned: number
  /** The planner had nothing runnable left. */
  exhausted: boolean
  /** Actions the planner refused solely because of the depth cap. */
  blockedByDepth: number
  cancelled: boolean
  failure: string | null
}

function ratio(n: number, of: number): number {
  if (of <= 0) return 0
  return Math.max(0, Math.min(1, n / of))
}

/**
 * Evaluate all four, plus the three terminal states that are not conditions at all
 * (cancelled, failed, exhausted). The first fired one in this order is the answer, and the
 * order is a judgement: an operator pressing stop outranks everything, a failure outranks a
 * budget, and "nothing left to do" is only reported when nothing else explains it.
 */
export function evaluateStops(input: StopInput): StopState {
  const { budget } = input
  const conditions: StopCondition[] = []

  const push = (id: StopReasonId, fired: boolean, pressure: number, detail: string): void => {
    conditions.push({ id, fired, pressure: Math.max(0, Math.min(1, pressure)), detail })
  }

  push(
    'budget-runs',
    input.runsUsed >= budget.maxRuns,
    ratio(input.runsUsed, budget.maxRuns),
    `${input.runsUsed} of ${budget.maxRuns} runs used.`
  )
  push(
    'budget-time',
    input.elapsedMs >= budget.maxWallClockMs,
    ratio(input.elapsedMs, budget.maxWallClockMs),
    `${Math.round(input.elapsedMs / 1000)}s of ${Math.round(budget.maxWallClockMs / 1000)}s used.`
  )
  push(
    'depth',
    input.exhausted && input.blockedByDepth > 0,
    input.depthReached >= budget.maxDepth ? 1 : ratio(input.depthReached, budget.maxDepth),
    input.blockedByDepth > 0
      ? `${input.blockedByDepth} action${input.blockedByDepth === 1 ? '' : 's'} sit past the ${budget.maxDepth}-hop cap. Depth ${budget.maxDepth + 1} opens only from an anchor you have confirmed.`
      : `Deepest hop reached: ${input.depthReached} of ${budget.maxDepth} allowed.`
  )
  push(
    'novelty',
    input.quietExpansions >= budget.noveltyWindow,
    ratio(input.quietExpansions, budget.noveltyWindow),
    input.quietExpansions === 0
      ? `The last expansion produced a lead the engine can follow on its own.`
      : `${input.quietExpansions} of the last ${budget.noveltyWindow} expansions produced no lead the engine may act on — nothing corroborated, and no link the subject declared. At ${budget.noveltyWindow} it stops: more of the same sweep will not turn into a different answer.`
  )

  // Contradiction density **prunes a branch and never stops the run**, and the two are not
  // interchangeable. `contradictedBranches` documents the rationale — one handle collision
  // producing eleven strangers should cost that branch and nothing else — but the condition
  // here was fed the whole pending queue and could fire, halting everything, *before the
  // first action of the run*. A case holding eight leftover candidates from an earlier
  // manual sweep, five of them contradicted, stopped the engine at zero runs and explained
  // it in terms of a seed it had not touched. The vouched account with declared links on it
  // was never read.
  //
  // So this reports and never fires. It is kept, rather than deleted, because headroom is
  // worth showing: the pressure is the worst *branch* against the threshold, which is the
  // number that actually predicts the next prune.
  const worst = [...input.branches].sort((a, b) => b.share - a.share || b.leads - a.leads)[0] ?? null
  const eligible = worst && worst.leads >= budget.contradictionFloor
  const share = worst?.share ?? 0
  push(
    'contradiction',
    false,
    eligible ? share / Math.max(budget.contradictionShare, 0.01) : 0,
    contradictionDetail(worst, input.branchesPruned, budget)
  )

  push('exhausted', input.exhausted, input.exhausted ? 1 : 0, input.exhausted ? 'Nothing left that the engine is allowed to do.' : 'Actions remain.')
  push('cancelled', input.cancelled, input.cancelled ? 1 : 0, input.cancelled ? 'You stopped it.' : 'Running.')
  push('failed', Boolean(input.failure), input.failure ? 1 : 0, input.failure ?? 'No failure.')

  // `contradiction` is deliberately absent: it prunes branches, it does not end runs. Every
  // other condition is here in the order an operator would want them explained.
  const order: StopReasonId[] = [
    'cancelled',
    'failed',
    'budget-runs',
    'budget-time',
    'novelty',
    'depth',
    'exhausted'
  ]
  const fired = order.map((id) => conditions.find((c) => c.id === id)).find((c) => c?.fired) ?? null

  return {
    runsUsed: input.runsUsed,
    elapsedMs: input.elapsedMs,
    depthReached: input.depthReached,
    quietExpansions: input.quietExpansions,
    contradictedShare: share,
    conditions,
    fired: fired ?? null
  }
}

function contradictionDetail(
  worst: BranchDensity | null,
  pruned: number,
  budget: Budget
): string {
  const cut = pruned
    ? `${pruned} branch${pruned === 1 ? '' : 'es'} cut for contradiction density so far. `
    : ''
  if (!worst || worst.leads === 0) {
    return `${cut}No branch has produced a scored lead yet. Contradiction density cuts a branch; it never stops the run.`
  }
  return (
    `${cut}The most contradicted branch still standing is "${worst.branchLabel}": ` +
    `${worst.contradicted} of ${worst.leads} leads under it disagree with your seeds (${Math.round(worst.share * 100)}%). ` +
    `At ${Math.round(budget.contradictionShare * 100)}% over ${budget.contradictionFloor} leads that branch is cut — the branch, not the investigation. ` +
    `A handle collision producing eleven strangers should cost the branch it is on and nothing else.`
  )
}

/* ------------------------------------------------------------------ *
 * Contradiction density, per branch
 * ------------------------------------------------------------------ */

export interface BranchDensity {
  branchId: string
  branchLabel: string
  leads: number
  contradicted: number
  share: number
}

export interface BranchVerdict extends BranchDensity {
  /** The sentence recorded on the prune. */
  reason: string
}

/**
 * How contradicted each branch is. The measurement, with no threshold applied.
 *
 * Measured per branch rather than over the whole case on purpose. One handle collision
 * producing eleven strangers should cost that branch and nothing else; measured globally it
 * would stop an investigation that is doing perfectly well everywhere the collision is not.
 * The quantity is separated from the verdict because both callers need it and only one of
 * them acts on it: the loop cuts what is over the line, and the brief shows how far the
 * worst branch still is from it.
 *
 * The band comes from `shared/relevance.ts` — the one contradiction scorer in this codebase
 * — and is passed in already computed. Nothing here re-decides what a contradiction is.
 */
export function branchDensities(input: {
  candidates: readonly CandidateView[]
  bands: ReadonlyMap<string, RelevanceAssessment>
  graph: ProvenanceGraph
}): BranchDensity[] {
  const counts = new Map<string, { label: string; leads: number; contradicted: number }>()
  for (const c of input.candidates) {
    const branch = input.graph.branchOf(c.id)
    // A lead directly off a seed has no branch above it, and pruning a seed is not the
    // engine's decision to make.
    if (!branch) continue
    const cell = counts.get(branch.id) ?? { label: branch.label || branch.value, leads: 0, contradicted: 0 }
    cell.leads++
    if (input.bands.get(c.id)?.band === 'contradicted') cell.contradicted++
    counts.set(branch.id, cell)
  }

  const out: BranchDensity[] = []
  for (const [branchId, cell] of counts) {
    out.push({
      branchId,
      branchLabel: cell.label,
      leads: cell.leads,
      contradicted: cell.contradicted,
      share: cell.leads ? cell.contradicted / cell.leads : 0
    })
  }
  return out.sort((a, b) => b.share - a.share || b.leads - a.leads)
}

/** The branches over the threshold, with the sentence the prune records. */
export function contradictedBranches(input: {
  densities: readonly BranchDensity[]
  budget: Budget
}): BranchVerdict[] {
  const out: BranchVerdict[] = []
  for (const d of input.densities) {
    if (d.leads < input.budget.contradictionFloor) continue
    if (d.share < input.budget.contradictionShare) continue
    out.push({
      ...d,
      reason:
        `${d.contradicted} of ${d.leads} leads under "${d.branchLabel}" state a name, a gender or a place that disagrees with your seeds — ${Math.round(d.share * 100)}%, above the ${Math.round(input.budget.contradictionShare * 100)}% at which a branch is being shared by several different people. ` +
        `Cut rather than spent on further. Nothing is deleted: the rows stay, and restoring the branch puts it back.`
    })
  }
  return out.sort((a, b) => b.share - a.share || b.leads - a.leads)
}

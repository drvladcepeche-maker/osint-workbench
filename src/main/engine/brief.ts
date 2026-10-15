/**
 * The brief: what the operator reads instead of ninety rows.
 *
 * The target is **three decisions per investigation, not ninety**. Everything the engine
 * can settle it settles; what reaches this page is the running state of the case and the
 * two or three questions whose ground truth lives in the operator's head and nowhere the
 * engine can fetch from.
 *
 * Four sections, and the order is the argument:
 *
 *  - **Established** — corroborated by two independent sources, or confirmed by a human.
 *    The only things the case can actually stand on.
 *  - **Pending** — reached, plausible, one source. The honest middle, and where most of a
 *    real investigation correctly sits. A lead the engine has been authorised to *probe* —
 *    one run, on the strength of a link the subject published — lives here and nowhere
 *    higher: fetching something is not evidence about it.
 *  - **Contradicted** — states something that disagrees with the seeds. Kept and shown,
 *    never deleted: the seed could be the thing that is wrong.
 *  - **Pruned** — cut, with the reason, and restorable.
 *
 * Voice, per PRODUCT.md: patient, exacting, unimpressed. Forty-seven accounts is not a
 * win, it is a starting point that is mostly wrong. Nothing here celebrates and nothing
 * here alarms.
 */

import type { CandidateView, Entity, Finding } from '../../shared/types'
import {
  DEFAULT_BUDGET,
  nodeLabel,
  type ActionRanking,
  type BriefItem,
  type BriefQuestion,
  type EngineDecision,
  type InvestigationBrief,
  type InvestigationRunState,
  type LeadVerdict,
  type NodeRef
} from '../../shared/engine'
import type { RelevanceAssessment } from '../../shared/relevance'
import { engineSourceKey, isDerivedSource } from './corroboration'
import type { ProvenanceGraph } from './provenance'
import { branchDensities, evaluateStops } from './stops'

export interface BriefInput {
  caseId: string
  graph: ProvenanceGraph
  entities: readonly Entity[]
  /** Every candidate, in every state — the brief has to be able to show what was cut. */
  candidates: readonly CandidateView[]
  findings: readonly Finding[]
  bands: ReadonlyMap<string, RelevanceAssessment>
  dispositions: ReadonlyMap<string, LeadVerdict>
  ranking: ActionRanking
  run: InvestigationRunState | null
  decisions: readonly EngineDecision[]
  neverRun: boolean
}

/** How many questions the page shows before it says how many more there are. */
export const QUESTIONS_SHOWN = 3

export function buildBrief(input: BriefInput): InvestigationBrief {
  const { graph, entities, candidates, findings, bands, dispositions, ranking } = input
  const at = new Date().toISOString()
  const inGraph = new Set(entities.map((e) => e.id))

  const established: BriefItem[] = []
  const pending: BriefItem[] = []
  const contradicted: BriefItem[] = []
  const pruned: BriefItem[] = []

  /* --- entities, judged by the findings attached to them --- */

  const byEntity = new Map<string, Finding[]>()
  for (const f of findings) {
    const list = byEntity.get(f.entityId) ?? []
    list.push(f)
    byEntity.set(f.entityId, list)
  }

  for (const e of entities) {
    const ref: NodeRef = { id: e.id, kind: e.kind, value: e.value, label: e.label }
    const rows = byEntity.get(e.id) ?? []
    const chain = graph.chainFor(e.id)
    const sources = independentCount(rows.map((f) => f.source))
    const best = rows.some((f) => f.confidence === 'confirmed')
      ? 'confirmed'
      : rows.some((f) => f.confidence === 'corroborated')
        ? 'corroborated'
        : 'unverified'

    if (graph.isPruned(e.id)) {
      pruned.push({
        node: ref,
        route: chain?.line ?? '',
        depth: chain?.depth ?? 0,
        independentSources: sources,
        note: `Cut, and still in the case as an entity — the engine does not remove entities. ${graph.prunedReason(e.id) ?? ''}`.trim(),
        inGraph: true
      })
      continue
    }

    const item: BriefItem = {
      node: ref,
      route: chain?.line ?? '',
      depth: chain?.depth ?? 0,
      independentSources: sources,
      note: entityNote(e, rows.length, sources, best),
      inGraph: true
    }
    if (best === 'confirmed' || best === 'corroborated' || e.seed) established.push(item)
    else pending.push(item)
  }

  /* --- candidates, judged by what corroboration decided about them --- */

  for (const c of candidates) {
    const ref: NodeRef = { id: c.id, kind: c.kind, value: c.value, label: c.label }
    if (inGraph.has(c.id)) continue
    const chain = graph.chainFor(c.id)
    const verdict = dispositions.get(c.id)
    const band = bands.get(c.id)?.band
    const item: BriefItem = {
      node: ref,
      route: chain?.line ?? '',
      depth: chain?.depth ?? 0,
      independentSources: verdict?.independentSources ?? 0,
      note: verdict?.reason ?? candidateNote(c),
      inGraph: false
    }

    if (graph.isPruned(c.id) || c.state === 'dismissed') {
      item.note = graph.prunedReason(c.id) ?? 'Dismissed. The record stays in the case; restoring the branch puts it back in the queue.'
      pruned.push(item)
      continue
    }
    if (c.state !== 'pending') continue
    if (verdict?.disposition === 'park' || band === 'contradicted') contradicted.push(item)
    else if (verdict?.disposition === 'expand') established.push(item)
    // `probe` is a permission to spend one run, not a belief about the node. It is one
    // source — the subject's own link — so it belongs under a heading that says one source,
    // and the row carries the verdict's own sentence explaining what was authorised.
    else pending.push(item)
  }

  const order = (a: BriefItem, b: BriefItem): number =>
    b.independentSources - a.independentSources || a.depth - b.depth || a.node.value.localeCompare(b.node.value)
  established.sort(order)
  pending.sort(order)
  contradicted.sort(order)
  pruned.sort(order)

  /* --- the questions --- */

  const questions = buildQuestions({ graph, candidates, dispositions, bands, ranking })

  /* --- where the budget stands --- */

  // The run's own counters are fed back in rather than recomputed from zero, so the
  // conditions the brief renders are the ones that actually stopped the loop. Contradiction
  // density is measured per branch here for the same reason the loop measures it that way:
  // a case-wide number is a different quantity that happens to look like this one.
  const stops = evaluateStops(
    stopInput(
      input,
      branchDensities({
        candidates: candidates.filter((c) => c.state === 'pending'),
        bands,
        graph
      })
    )
  )

  return {
    caseId: input.caseId,
    generatedAt: at,
    headline: headlineFor({ input, established, pending, contradicted, pruned, questions }),
    established,
    pending,
    contradicted,
    pruned,
    next: ranking.actions.slice(0, 5),
    blocked: ranking.blocked.slice(0, 8),
    questions: questions.slice(0, QUESTIONS_SHOWN),
    questionsTotal: questions.length,
    stops,
    decisions: [...input.decisions],
    chains: graph.chains(),
    neverRun: input.neverRun
  }
}

/* ------------------------------------------------------------------ *
 * Questions
 * ------------------------------------------------------------------ */

/**
 * The calls the engine cannot make.
 *
 * There is exactly one class of them and it is worth naming precisely: *is this the same
 * person*. Two profiles can share a handle, a picture and a city and belong to two people;
 * two profiles can share nothing visible and belong to one. The evidence that settles it is
 * in the operator's head — he knows the subject — and no amount of unauthenticated fetching
 * substitutes for that.
 *
 * Weighted so the questions worth answering come first: a corroborated lead outranks a
 * single-source one, a route the subject declared outranks a route inferred from a string,
 * and a shallow lead outranks a deep one because answering it unblocks more.
 */
function buildQuestions(input: {
  graph: ProvenanceGraph
  candidates: readonly CandidateView[]
  dispositions: ReadonlyMap<string, LeadVerdict>
  bands: ReadonlyMap<string, RelevanceAssessment>
  ranking: ActionRanking
}): BriefQuestion[] {
  const out: BriefQuestion[] = []
  for (const c of input.candidates) {
    if (c.state !== 'pending') continue
    const verdict = input.dispositions.get(c.id)
    if (!verdict || verdict.disposition !== 'ask') continue
    if (input.graph.isPruned(c.id)) continue

    const chain = input.graph.chainFor(c.id)
    const root = chain?.root
    const attrs = c.attrs as { url?: unknown }
    const url = typeof attrs.url === 'string' && /^https?:\/\//i.test(attrs.url) ? attrs.url : null
    const blockedHere = input.ranking.blocked.filter((a) => a.node.id === c.id && a.blocked?.startsWith('Waiting on you')).length

    out.push({
      node: { id: c.id, kind: c.kind, value: c.value, label: c.label },
      question: questionText(c, root),
      why:
        'Two profiles can carry the same handle, the same picture and the same city and still belong to two people. ' +
        'What settles it is knowing the subject, and that is the one thing here that is not on a page the engine can fetch.',
      route: chain?.line ?? '',
      unlocks: blockedHere
        ? `Say yes and ${blockedHere} action${blockedHere === 1 ? '' : 's'} against it open up, including anything one hop further out.`
        : 'Answering it settles the lead; nothing further is waiting on it right now.',
      weight:
        (input.bands.get(c.id)?.score ?? 40) +
        verdict.independentSources * 12 +
        (chain?.fullyDeclared ? 20 : 0) -
        (chain?.depth ?? 1) * 6,
      url
    })
  }
  return out.sort((a, b) => b.weight - a.weight || a.node.value.localeCompare(b.node.value))
}

function questionText(c: CandidateView, root: NodeRef | undefined): string {
  const from = root ? nodeLabel(root) : 'the seed'
  switch (c.kind) {
    case 'account':
    case 'username':
      return `Is ${c.label || c.value} the same person as ${from}?`
    case 'person':
      return `Is "${c.label || c.value}" the subject's real name?`
    case 'location':
      return `Has the subject actually lived in ${c.label || c.value}, or is this a field somebody typed once?`
    case 'email':
    case 'phone':
      return `Is ${c.label || c.value} the subject's?`
    case 'domain':
      return `Is ${c.label || c.value} the subject's own domain rather than a host they happen to appear on?`
    case 'image':
      return `Is this the subject's picture, or a platform default?`
    case 'organisation':
      return `Is the subject actually connected to ${c.label || c.value}, or is this a field on a profile page?`
    default:
      return `Does ${nodeLabel(c as unknown as NodeRef)} belong with ${from}?`
  }
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

function entityNote(e: Entity, rows: number, sources: number, best: string): string {
  if (rows === 0) {
    return e.seed
      ? 'You supplied this and nothing has been pointed at it yet.'
      : 'In the case, with nothing said about it yet.'
  }
  const bit = `${rows} claim${rows === 1 ? '' : 's'} from ${sources} independent source${sources === 1 ? '' : 's'}.`
  if (best === 'confirmed') return `${bit} You have confirmed at least one of them by hand.`
  if (best === 'corroborated') return `${bit} At least one claim is corroborated.`
  // A seed is established because a person put it there, not because anything about it has
  // been verified — and saying only the second half under a heading that reads "Established"
  // is the interface arguing with itself.
  if (e.seed) {
    return `You supplied it, so it is the ground this case stands on. ${bit} What the tools have said about it is still unverified, which is the honest default.`
  }
  return `${bit} Everything about it is still unverified, which is the honest default and where most things correctly stay.`
}

function candidateNote(c: CandidateView): string {
  return `Proposed by ${c.proposals.length} finding${c.proposals.length === 1 ? '' : 's'} and not in the case. Nothing enters the graph without you.`
}

function headlineFor(input: {
  input: BriefInput
  established: BriefItem[]
  pending: BriefItem[]
  contradicted: BriefItem[]
  pruned: BriefItem[]
  questions: BriefQuestion[]
}): string {
  const { run } = input.input
  if (input.input.neverRun) {
    return 'The engine has not run on this case. It starts from what you supplied, follows what it can corroborate on its own, and comes back with the questions it cannot answer.'
  }
  const parts = [
    `${input.established.length} established`,
    `${input.pending.length} pending`,
    `${input.contradicted.length} contradicted`
  ]
  if (input.pruned.length) parts.push(`${input.pruned.length} pruned`)
  const stop = run?.stop ? ` Stopped on ${run.stop.id.replace('-', ' ')}.` : ''
  const asks = input.questions.length
    ? ` ${input.questions.length} question${input.questions.length === 1 ? '' : 's'} for you.`
    : ' Nothing is waiting on you.'
  return `${parts.join(', ')}.${asks}${stop}`
}

/* ------------------------------------------------------------------ *
 * Bits
 * ------------------------------------------------------------------ */

function independentCount(sources: readonly string[]): number {
  const keys = new Set<string>()
  for (const s of sources) {
    if (isDerivedSource(s)) continue
    const k = engineSourceKey(s)
    if (k) keys.add(k)
  }
  return keys.size
}

function stopInput(
  input: BriefInput,
  branches: ReturnType<typeof branchDensities>
): Parameters<typeof evaluateStops>[0] {
  const run = input.run
  return {
    budget: run?.budget ?? DEFAULT_BUDGET,
    runsUsed: run?.runsUsed ?? 0,
    elapsedMs: run ? Date.parse(run.finishedAt ?? new Date().toISOString()) - Date.parse(run.startedAt) : 0,
    depthReached: run?.depthReached ?? 0,
    quietExpansions: run?.quietExpansions ?? 0,
    branches,
    branchesPruned: run?.pruned ?? 0,
    exhausted: input.ranking.exhausted,
    blockedByDepth: input.ranking.blocked.filter((a) => a.blocked?.includes('hops out')).length,
    cancelled: run?.phase === 'stopped',
    failure: run?.error ?? null
  }
}

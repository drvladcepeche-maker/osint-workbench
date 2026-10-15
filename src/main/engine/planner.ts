/**
 * The planner: what is the highest-value thing to do next, and why.
 *
 * "Run everything" is brute force, not investigation. A real planner asks what the state
 * of the case makes worth doing, ranks it, and spends the budget where it pays. The
 * strategy document's table is the specification and every row of it appears here as a
 * signal:
 *
 * | Higher value | Lower value |
 * |---|---|
 * | Enriching a confirmed account nobody has read | Probing another username variant |
 * | An account that declares outbound links | One with an empty profile |
 * | A distinctive handle | A dictionary-word handle |
 * | An anchor the operator supplied | A depth-2 discovery |
 * | A lead corroborated by two sources | A single unverified hit |
 *
 * ## The row that has no signal of its own, and why
 *
 * Row two — *an account that declares outbound links* — used to be a `declares-links`
 * signal worth +24, the largest positive in the table. It could not fire, and the reason it
 * could not fire is the reason it should not exist:
 *
 *  - Whether a node declares links is only knowable **after** a profile reader has opened
 *    it, because reading the page is what finds the links. It was gated on
 *    `!hasAnyProfileRead(node)` — deliberately, with a correct argument attached: once the
 *    links are known they are leads of their own and the move is to follow *them*, not to
 *    point a fifth tool at the page that listed them. The two conditions are mutually
 *    exclusive, so the signal was dead in every real case and quietly reserved 24 points
 *    nothing could ever earn.
 *  - It was also derived by regex over `Finding.claim`, and claims embed page titles and
 *    search snippets verbatim. Any page whose title said `rel=me` could have awarded itself
 *    the planner's top score, for the same reason a page could once forge a `declared-link`
 *    hop. Provenance stopped taking dictation from fetched text; so does this.
 *
 * The row is served by the two signals either side of the read: `unenriched` (+20) says
 * nobody has opened the page, which is what makes it worth opening; `declared-hop` (+12)
 * says the thing on the far end of the link was reached by the subject's own assertion,
 * which is what makes *it* worth following. Nothing is silently missing.
 *
 * ## Two rules the shape enforces
 *
 * **Rank, never silently drop.** Everything applicable is scored, and an action that will
 * not run comes back in `blocked` with the sentence that says why. A plan of nothing has to
 * be able to explain itself; a silent nothing is indistinguishable from a bug, and this
 * operator has already been caught by exactly that.
 *
 * **Show the reasoning.** Every signal keeps its own points and its own sentence, so the
 * total is auditable rather than magic — the same discipline `relevance.ts` and `pivot.ts`
 * already use. A planner that picks silently teaches nothing, and teaching is the point.
 */

import type { AdapterInfo, CandidateView, Entity, Finding } from '../../shared/types'
import {
  PLANNER_BASE,
  PLANNER_POINTS,
  type ActionRanking,
  type Budget,
  type GainBasis,
  type NodeRef,
  type PlannedAction,
  type LeadVerdict,
  type PlannerSignal,
  type PlannerSignalId
} from '../../shared/engine'
import { ANCHORED_DEPTH_BONUS } from '../../shared/engine'
import { handleAdvice, SHORT_HANDLE_LENGTH, type RelevanceAssessment } from '../../shared/relevance'
import { corroborationOf, isDerivedSource } from './corroboration'
import type { ProvenanceGraph } from './provenance'
import type { YieldTable } from './yield'

/**
 * Adapters automation never reaches for on its own, and why.
 *
 * Same list the self-audit refuses, for the same reasons. `hibp-passwords` is the one that
 * matters: its input is a live password typed at the moment of use, and a loop that asked
 * for one automatically would be the exact opposite of what this application is for.
 */
export const NEVER_AUTO = new Map<string, string>([
  ['echo', 'The self-test adapter. It asserts nothing about the world, so a run would add a row saying the plumbing works.'],
  [
    'hibp-passwords',
    'Its input is a live password typed at the moment of use and never stored. There is nowhere in an automatic loop to type one, and asking would be the opposite of what this app is for.'
  ]
])

/**
 * The adapters whose job is the page *behind* an account.
 *
 * Named explicitly because "has this account been read yet" is the single highest-value
 * question the planner asks, and it cannot be derived from `accepts`/`produces` — maigret
 * also produces a `person` from a `username` without ever opening the profile. An adapter
 * missing from this list is not punished; it simply does not satisfy the "already read"
 * test, which is the conservative direction.
 */
const PROFILE_READERS = new Set(['profile-enrich', 'reddit-profile'])

export interface PlanInput {
  caseId: string
  entities: readonly Entity[]
  /** Pending candidates only. A decided one is not a frontier. */
  candidates: readonly CandidateView[]
  findings: readonly Finding[]
  adapters: readonly AdapterInfo[]
  graph: ProvenanceGraph
  yields: YieldTable
  budget: Budget
  /** Relevance band per candidate id, from `shared/ranking.ts`. Never recomputed here. */
  bands: ReadonlyMap<string, RelevanceAssessment>
  /** `<adapterId>:<nodeId>` pairs this investigation has already run. */
  alreadyRun: ReadonlySet<string>
  /**
   * What corroboration decided about each candidate — see `corroboration.ts`.
   *
   * This is where the engine's steering actually bites. A candidate the corroboration
   * model says `expand` is a frontier node the loop may act on with no human in the hop; one
   * it says `ask` is ranked, shown, and **not run against** until a person answers. That is
   * the difference between an engine and a sweep with extra steps.
   */
  dispositions: ReadonlyMap<string, LeadVerdict>
  /** Branch root ids whose leads are mostly contradicted. */
  contradictedBranches: ReadonlySet<string>
  /** Restrict to these adapters, when the operator named some. */
  adapterIds?: readonly string[]
  /**
   * Restrict to nodes reachable from these roots, when the operator named some.
   *
   * `InvestigationRequest.rootEntityIds` is documented as "follow this account and nothing
   * else", and it used to mean rather less than that: it filtered which *new* roots
   * `ensureRoots` recorded, and then the planner ranked every entity in the case anyway. On
   * a case holding four seeds, asking the engine to follow one of them spent the budget on
   * all four — and on a case where a root had been recorded by an earlier run, it planned
   * against branches the operator had explicitly left out.
   *
   * Empty or absent means the whole case, which is the normal use.
   */
  roots?: ReadonlySet<string>
  at: string
}

interface NodeFacts {
  ref: NodeRef
  state: 'entity' | 'candidate'
  depth: number
  isSeed: boolean
  isAnchor: boolean
  hasConfirmed: boolean
  declaredRoute: boolean
  inferredRoute: boolean
  probedBy: Set<string>
  /** Tools that produced a claim about it from a source that actually answered. */
  readBy: Set<string>
  independentSources: number
  allWeakMatchers: boolean
  contradictedBranch: boolean
  /** True when the run named roots and this node does not descend from any of them. */
  outOfScope: boolean
  /** Depth this node may be acted on up to, given whether its chain is anchored. */
  depthAllowance: number
  chainLine: string
  pruned: boolean
}

export function planActions(input: PlanInput): ActionRanking {
  const {
    entities,
    candidates,
    findings,
    adapters,
    graph,
    yields,
    budget,
    bands,
    alreadyRun,
    dispositions,
    contradictedBranches
  } = input

  const confirmedEntities = new Set(findings.filter((f) => f.confidence === 'confirmed').map((f) => f.entityId))

  // Two different questions, and a refused run answers them differently.
  //
  //  - `probed` is "has anything been pointed at this **at all**". A run that came back
  //    refused still counts: something was pointed at it, the attempt is on record, and
  //    saying "nothing has been pointed at this" afterwards would be false.
  //  - `read` is "did a source actually answer **about this node**". A refusal does not.
  //
  // The distinction became load-bearing when `parse()` started running on failed runs: a
  // blocked tool now always leaves a `local:<adapter>` record, so a profile-enrich run that
  // Cloudflare refused writes a finding whose `tool` is `profile-enrich`. Read naively,
  // that makes the node look *already enriched* — the planner drops `unenriched` (+20, its
  // second-largest positive) and stops ranking the one thing most worth doing, because a
  // tool failed. That is blocked-as-absent inside the planner, which is the exact failure
  // this application exists to be the opposite of.
  //
  // A source that answered is a source that is not `local:`/`file:`, which is the same fold
  // corroboration uses. Nothing here re-decides what derived means.
  const probed = new Map<string, Set<string>>()
  const read = new Map<string, Set<string>>()
  for (const f of findings) {
    const attempts = probed.get(f.entityId) ?? new Set<string>()
    attempts.add(f.tool)
    probed.set(f.entityId, attempts)
    if (isDerivedSource(f.source)) continue
    const answered = read.get(f.entityId) ?? new Set<string>()
    answered.add(f.tool)
    read.set(f.entityId, answered)
  }

  const assessmentsByBranch = new Map<string, RelevanceAssessment[]>()
  for (const c of candidates) {
    const branch = graph.branchOf(c.id)?.id ?? c.id
    const list = assessmentsByBranch.get(branch) ?? []
    const a = bands.get(c.id)
    if (a) list.push(a)
    assessmentsByBranch.set(branch, list)
  }

  const facts: NodeFacts[] = []

  for (const e of entities) {
    const chain = graph.chainFor(e.id)
    facts.push(
      nodeFacts({
        ref: { id: e.id, kind: e.kind, value: e.value, label: e.label },
        state: 'entity',
        chain,
        isSeed: e.seed,
        hasConfirmed: confirmedEntities.has(e.id),
        probedBy: probed.get(e.id) ?? new Set(),
        readBy: read.get(e.id) ?? new Set(),
        independentSources: 0,
        allWeakMatchers: false,
        contradictedBranches,
        roots: input.roots,
        graph,
        budget
      })
    )
  }

  for (const c of candidates) {
    const chain = graph.chainFor(c.id)
    const corr = corroborationOf(c)
    facts.push(
      nodeFacts({
        ref: { id: c.id, kind: c.kind, value: c.value, label: c.label },
        state: 'candidate',
        chain,
        isSeed: false,
        hasConfirmed: c.bestConfidence === 'confirmed',
        probedBy: probed.get(c.id) ?? new Set(),
        readBy: read.get(c.id) ?? new Set(),
        independentSources: corr.count,
        allWeakMatchers: corr.allWeakMatchers,
        contradictedBranches,
        roots: input.roots,
        graph,
        budget
      })
    )
  }

  const wanted = input.adapterIds?.length ? new Set(input.adapterIds) : null
  const actions: PlannedAction[] = []
  const blocked: PlannedAction[] = []

  for (const node of facts) {
    for (const adapter of adapters) {
      if (!adapter.accepts.includes(node.ref.kind)) continue
      if (wanted && !wanted.has(adapter.id)) continue

      const est = yields.estimate(adapter.id, node.ref.kind)
      const signals = scoreSignals(node, adapter, est, assessmentsByBranch)
      const gain = clamp(PLANNER_BASE + signals.reduce((n, s) => n + s.points, 0))
      const action: PlannedAction = {
        key: `${adapter.id}:${node.ref.id}`,
        adapterId: adapter.id,
        adapterTitle: adapter.title,
        node: node.ref,
        nodeState: node.state,
        depth: node.depth,
        gain,
        signals,
        reason: reasonLine(signals, gain),
        basis: est.basis as GainBasis,
        blocked: blockReason(node, adapter, alreadyRun, dispositions)
      }
      if (action.blocked) blocked.push(action)
      else actions.push(action)
    }
  }

  const order = (a: PlannedAction, b: PlannedAction): number =>
    b.gain - a.gain || a.depth - b.depth || a.key.localeCompare(b.key)

  actions.sort(order)
  blocked.sort(order)

  return {
    caseId: input.caseId,
    at: input.at,
    actions,
    blocked,
    nodesConsidered: facts.length,
    exhausted: actions.length === 0
  }
}

/* ------------------------------------------------------------------ *
 * One node's facts
 * ------------------------------------------------------------------ */

function nodeFacts(input: {
  ref: NodeRef
  state: 'entity' | 'candidate'
  chain: ReturnType<ProvenanceGraph['chainFor']>
  isSeed: boolean
  hasConfirmed: boolean
  probedBy: Set<string>
  readBy: Set<string>
  independentSources: number
  allWeakMatchers: boolean
  contradictedBranches: ReadonlySet<string>
  roots?: ReadonlySet<string>
  graph: ProvenanceGraph
  budget: Budget
}): NodeFacts {
  const { chain, budget } = input
  const branch = input.graph.branchOf(input.ref.id)
  // Depth 3 is reachable only from an anchor a human stands behind. That is the whole
  // exemption: verified ground buys one more hop and nothing else does.
  const depthAllowance = chain?.rootIsAnchor ? budget.maxDepth + ANCHORED_DEPTH_BONUS : budget.maxDepth
  return {
    ref: input.ref,
    state: input.state,
    depth: chain?.depth ?? 0,
    isSeed: input.isSeed || Boolean(chain?.rootIsSeed && chain.depth === 0),
    // Anchored at any depth, not only at the root itself. The strategy's rule is that an
    // anchor the operator supplied outranks a depth-2 discovery, and a lead hanging off
    // that anchor inherits the distinction — it is what makes the engine follow the link on
    // a vouched-for profile before running a fifth tool against the profile itself.
    isAnchor: Boolean(chain?.rootIsAnchor),
    hasConfirmed: input.hasConfirmed,
    declaredRoute: Boolean(chain?.fullyDeclared && chain.depth > 0),
    inferredRoute: chain?.weakest === 'inferred' && (chain?.depth ?? 0) > 0,
    probedBy: input.probedBy,
    readBy: input.readBy,
    independentSources: input.independentSources,
    allWeakMatchers: input.allWeakMatchers,
    contradictedBranch: branch ? input.contradictedBranches.has(branch.id) : false,
    // In scope when the operator named no roots, when this **is** one of them, or when the
    // route that reached it starts at one. A node with no recorded route cannot be shown to
    // descend from a named root, so it is out — which is the conservative direction and the
    // right one: `ensureRoots` records a root only for the entities the request named, so
    // everything else in the case correctly has nothing tying it to the run.
    outOfScope: Boolean(
      input.roots?.size &&
        !input.roots.has(input.ref.id) &&
        !(chain && input.roots.has(chain.root.id))
    ),
    depthAllowance,
    chainLine: chain?.line ?? '',
    pruned: Boolean(chain?.pruned) || input.graph.isPruned(input.ref.id)
  }
}

/* ------------------------------------------------------------------ *
 * Signals
 * ------------------------------------------------------------------ */

function scoreSignals(
  node: NodeFacts,
  adapter: AdapterInfo,
  est: { value: number; basis: string; detail: string },
  assessmentsByBranch: ReadonlyMap<string, RelevanceAssessment[]>
): PlannerSignal[] {
  const out: PlannerSignal[] = []
  const add = (id: PlannerSignalId, detail: string, points = PLANNER_POINTS[id]): void => {
    out.push({ id, points, detail })
  }

  if (node.isSeed) {
    add('operator-supplied', `You put ${node.ref.label || node.ref.value} into the case yourself. It is the ground the rest of the case hangs from.`)
  }
  if (node.hasConfirmed) {
    add('confirmed-anchor', 'A human has confirmed something about this, which is the only way anything in this app reaches "confirmed". Work from it is work from verified ground.')
  } else if (node.isAnchor && !node.isSeed) {
    add('anchor-root', 'It descends from an account, address or domain you supplied rather than from something a tool guessed at.')
  } else if (node.isAnchor) {
    add('anchor-root', 'It is an account, address or domain you supplied rather than something a tool guessed at.')
  }

  if (PROFILE_READERS.has(adapter.id) && !hasAnyProfileRead(node)) {
    add(
      'unenriched',
      `Nothing has read the page behind this yet. A sweep establishes that a handle is taken; the profile is where the name, the picture and the declared links are.`
    )
  }

  if (node.state === 'candidate') {
    if (node.independentSources >= 2) {
      add('corroborated-lead', `${node.independentSources} independent sources named it, folded to the site operator so one site answering twice does not count as two.`)
    } else if (node.independentSources <= 1) {
      add('single-unverified', 'One source and nothing else. Unverified by construction, and most things here correctly stay that way.')
    }
    if (node.allWeakMatchers) {
      add('weak-matcher', 'Every probe behind this was structurally incapable of meaning much — the request did not name the handle, or an anti-bot layer could have answered instead of the site.')
    }
  }

  if (node.declaredRoute) {
    add('declared-hop', `Every hop that reached it is the subject's own assertion: ${node.chainLine}`)
  } else if (node.inferredRoute) {
    add('inferred-route', `It was reached by inference rather than by observation: ${node.chainLine}`)
  }

  // `username` only, and that is the whole point of the signal rather than an oversight.
  // Handle commonality is a statement about *enumeration*: fifty people share the handle,
  // the probe cannot tell them apart, and no scorer invents the evidence that was never
  // fetched. An `account` names one platform and one handle — a specific page — and its
  // commonality says nothing about whether reading that page is worth doing. Penalising
  // `twitter.com/simonw` for a six-letter handle when the subject linked to it himself is
  // exactly the mistake this narrowing prevents.
  if (node.ref.kind === 'username') {
    const handle = node.ref.value
    const rows = assessmentsByBranch.get(node.ref.id) ?? []
    const advice = handleAdvice(handle, rows)
    if (advice) {
      add('common-handle', `${advice.reasons[0]?.detail ?? 'This handle is common enough that a hit means somebody used it, not that they are your subject.'}`)
    } else if (handle.replace(/[^\p{L}\p{N}]/gu, '').length >= SHORT_HANDLE_LENGTH) {
      add('distinctive-handle', `"${handle}" is long enough and unremarkable enough that a collision is a fluke rather than the norm.`)
    }
  }

  // `probedBy`, deliberately: a tool that ran and was refused is still a tool that was
  // pointed at this, and the honest reading of a second attempt is that it may be refused
  // too. Claiming nothing has been tried would over-rank a node the app has already
  // bounced off.
  if (node.probedBy.size === 0) {
    add('never-probed', 'Nothing has been pointed at this at all, so anything it says will be new.')
  }

  if (node.depth > 1) {
    add('depth-cost', `${node.depth} hops from the seed. Every hop multiplies the chance that the chain left the subject somewhere behind it.`, PLANNER_POINTS['depth-cost'] * (node.depth - 1))
  }

  if (node.contradictedBranch) {
    add('contradicted-branch', 'The branch this sits on is producing mostly leads that contradict your seeds. More runs down it buy more of the same.')
  }

  // Signed: an adapter with a poor record here costs points rather than merely failing to
  // earn them. Scaled to ±PLANNER_POINTS['adapter-yield'] so measurement can reorder the
  // list without ever outvoting the structural facts above it.
  add('adapter-yield', est.detail, Math.round(PLANNER_POINTS['adapter-yield'] * (est.value * 2 - 1)))

  return out
}

/**
 * Has the page behind this actually been read?
 *
 * Reads `readBy`, not `probedBy`. A profile reader that was refused leaves a record that it
 * ran and no record of what the page says, and the page is still unread — which is the
 * whole point of the `unenriched` signal.
 */
function hasAnyProfileRead(node: NodeFacts): boolean {
  for (const tool of node.readBy) if (PROFILE_READERS.has(tool)) return true
  return false
}

/* ------------------------------------------------------------------ *
 * Blocking
 * ------------------------------------------------------------------ */

function blockReason(
  node: NodeFacts,
  adapter: AdapterInfo,
  alreadyRun: ReadonlySet<string>,
  dispositions: ReadonlyMap<string, LeadVerdict>
): string | null {
  const never = NEVER_AUTO.get(adapter.id)
  if (never) return never
  if (adapter.secretOptions.length > 0) {
    return `${adapter.title} takes a secret typed at the moment of use and never stored. There is nowhere in an automatic loop to supply it.`
  }
  if (adapter.requiresKey) {
    return `${adapter.title} needs an API key, and this build has none by design — there are no paid services here.`
  }
  if (!adapter.available) {
    return adapter.unavailableReason ?? `${adapter.title} is unavailable, with no reason given.`
  }
  if (node.pruned) {
    return 'This node has been pruned, or everything it was reached through has been. Restore it to spend runs on it again.'
  }
  // Ranked and refused rather than filtered out, like everything else here: a plan that is
  // deliberately narrow should be able to show what it is leaving alone, or "follow this
  // account and nothing else" is indistinguishable from a case with nothing else in it.
  if (node.outOfScope) {
    return 'You scoped this investigation to other roots, and nothing connects this to one of them. Run it without naming roots, or name this one, to spend runs here.'
  }
  if (node.state === 'candidate') {
    const verdict = dispositions.get(node.ref.id)
    if (!verdict) {
      return 'The engine has not scored this lead yet, so it does not know whether it is allowed to act on it.'
    }
    if (verdict.disposition === 'park') return verdict.reason
    if (verdict.disposition === 'ask') return `Waiting on you. ${verdict.reason}`
    // `probe` is not blocked: it is a permission to spend exactly one run, which is what
    // the planner deals in. What it does *not* buy is anything downstream — nothing may be
    // reached from a probe result on the strength of the probe, and `corroboration.ts`
    // enforces that where it belongs, on the next lead, rather than here.
  }
  if (alreadyRun.has(`${adapter.id}:${node.ref.id}`)) {
    return `${adapter.title} has already been run against this in this investigation. Running it again would re-read the same page.`
  }
  if (node.depth > node.depthAllowance) {
    return node.depthAllowance > 0 && node.depth === node.depthAllowance + 1
      ? `${node.depth} hops out, and this route is capped at ${node.depthAllowance}. Depth ${node.depthAllowance + 1} is reachable only from an anchor a human has confirmed; confirm something on this route and it opens.`
      : `${node.depth} hops out, past the ${node.depthAllowance}-hop cap on this route.`
  }
  return null
}

/* ------------------------------------------------------------------ *
 * The one line
 * ------------------------------------------------------------------ */

/**
 * Signals that are about *this adapter on this node*, rather than about the node.
 *
 * They matter for the sentence rather than for the arithmetic. Five actions against one
 * seed all share the node's strongest signal — "you put this into the case yourself" — so a
 * reason built from the top term alone reads identically five times and distinguishes
 * nothing. One node clause plus one action clause is what makes the ranking legible.
 */
const ACTION_SIGNALS = new Set<PlannerSignalId>(['unenriched', 'never-probed', 'adapter-yield'])

/**
 * Why this action sits where it does: the strongest thing for the node, the strongest thing
 * for this particular tool against it, and the strongest thing against. Never a list — the
 * list is one click away in the brief and is always complete.
 */
function reasonLine(signals: readonly PlannerSignal[], gain: number): string {
  const positives = signals.filter((s) => s.points > 0).sort((a, b) => b.points - a.points)
  const negatives = signals.filter((s) => s.points < 0).sort((a, b) => a.points - b.points)
  const parts: string[] = []
  const node = positives.find((s) => !ACTION_SIGNALS.has(s.id))
  const action = positives.find((s) => ACTION_SIGNALS.has(s.id))
  if (node) parts.push(node.detail)
  if (action) parts.push(action.detail)
  if (!parts.length && positives[0]) parts.push(positives[0].detail)
  if (negatives[0]) parts.push(negatives[0].detail)
  if (!parts.length) {
    return `Nothing argues either way; it scores the neutral ${gain}.`
  }
  // Several of these details end with a rendered route rather than with punctuation, and
  // two of them joined by a space read as one run-on sentence.
  return parts.map((p) => (/[.?!]$/.test(p.trim()) ? p.trim() : `${p.trim()}.`)).join(' ')
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

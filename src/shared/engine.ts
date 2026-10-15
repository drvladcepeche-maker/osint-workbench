/**
 * The investigation engine's vocabulary.
 *
 * Lives beside `selfaudit.ts` for the same reason that file exists: the renderer has to
 * speak these words too, and a type duplicated across the bridge drifts. Nothing here
 * performs work — `src/main/engine/` does that.
 *
 * ## What the engine is for
 *
 * Before it, the loop was `entity -> adapter -> findings -> candidates -> [HUMAN] ->
 * entity`, with a person in **every** hop. Depth therefore never exceeded one and the
 * yield was whatever a single sweep happened to return. The engine closes the loop:
 *
 * ```
 * seed -> plan -> run -> extract leads -> score
 *                          |- corroborated -> expand automatically
 *                          |- ambiguous    -> ask the operator
 *                          '- contradicted -> park with a reason
 *                       -> repeat until exhausted / budget / no novelty
 * ```
 *
 * ## The four rules the types are shaped around
 *
 *  1. **Nothing is promoted.** Automation never mints an `Entity` and never moves a
 *     finding up the confidence ladder. Auto-expansion means *pointing more tools at
 *     something*, which is recoverable; auto-promotion is not, because a wrongly promoted
 *     node poisons everything descending from it and grows more convincing with depth.
 *  2. **Every automatic decision states its reason.** `EngineDecision` has no optional
 *     `reason` field. An engine that silently prunes teaches nothing, and understanding
 *     the mechanism is the whole point of the project.
 *  3. **Provenance is what makes depth safe.** A depth-3 finding whose route is unknown
 *     is unauditable and therefore worthless — you cannot tell whether it descends from a
 *     verified anchor or from a stranger who happened to share a handle at depth 1. So
 *     every node records the ordered path back to a seed, with the mechanism of each hop,
 *     and that path is what pruning cuts.
 *  4. **Rank, never silently drop.** `ActionRanking` carries the actions it will not take
 *     alongside the ones it will, each with the sentence that says why.
 */

import type { EntityId, EntityKind, FindingId, IsoTimestamp } from './types'
import type { RelevanceBand } from './relevance'

/* ------------------------------------------------------------------ *
 * Provenance — how a thing was reached
 * ------------------------------------------------------------------ */

/**
 * The mechanism of one hop: not *that* the engine got from A to B, but *how*.
 *
 * This is the distinction the whole model turns on. "GitHub's profile page carries a link
 * the account holder wrote to a Keybase account" and "a site list reported that the handle
 * is taken on Keybase" both produce an edge from one node to another, and they are not
 * remotely the same claim. The first is the subject asserting a connection; the second is
 * an assertion about a string.
 */
export type ProvenanceMechanism =
  /** The operator typed it into the case. The root of trust, and the only kind of root worth having. */
  | 'seed'
  /** A human promoted a candidate into the graph. A root as far as the engine is concerned. */
  | 'promotion'
  /** The profile links out to it. The account holder wrote that link: the subject's own assertion. */
  | 'declared-link'
  /** A field printed on the profile — display name, location, company, address. */
  | 'profile-field'
  /** A username probe reported that the handle is taken on a site. */
  | 'handle-sweep'
  /** The picture matched, by bytes or by perceptual hash. */
  | 'avatar-hash'
  /** A reverse image engine returned the page. */
  | 'reverse-image'
  /** An archived capture named it. */
  | 'archive'
  /** An aggregator, register, certificate log or breach dataset named it. */
  | 'dataset'
  /** A search engine returned a page for a query the case built. */
  | 'search-result'
  /** Read out of a file's own bytes — EXIF, container metadata. */
  | 'file-metadata'
  /** Local analysis over captures already in the case. Fetches nothing and proves nothing new. */
  | 'correlation'
  /** The tool asserted it and did not say by what route. The honest label for an unclassifiable hop. */
  | 'tool-claim'

export const PROVENANCE_MECHANISMS: readonly ProvenanceMechanism[] = [
  'seed',
  'promotion',
  'declared-link',
  'profile-field',
  'handle-sweep',
  'avatar-hash',
  'reverse-image',
  'archive',
  'dataset',
  'search-result',
  'file-metadata',
  'correlation',
  'tool-claim'
] as const

/** Two or three words, for the arrow between two nodes in a rendered chain. */
export const MECHANISM_LABEL: Record<ProvenanceMechanism, string> = {
  seed: 'seed',
  promotion: 'you promoted it',
  'declared-link': 'declared link',
  'profile-field': 'profile field',
  'handle-sweep': 'handle sweep',
  'avatar-hash': 'avatar hash',
  'reverse-image': 'reverse image',
  archive: 'archived capture',
  dataset: 'dataset',
  'search-result': 'search result',
  'file-metadata': 'file metadata',
  correlation: 'local correlation',
  'tool-claim': 'tool claim'
}

/** One sentence, shown beside a hop: what this route actually establishes. */
export const MECHANISM_MEANING: Record<ProvenanceMechanism, string> = {
  seed: 'You supplied this. It is the ground the rest of the chain stands on, and nothing the engine finds can be better evidence than this.',
  promotion:
    'You promoted a discovery into the case by hand. The engine treats it as ground, because a person looked at it.',
  'declared-link':
    'The account holder put a link to this on their own profile, in a field that means ownership — a rel="me", a verified link, the profile\'s own website box. It is the only assertion in this whole model that comes from the subject rather than from a guess, which is why the engine is allowed to read the far end once on it. It is still one source, and the source is the subject. A link back from the far end is what makes it two.',
  'profile-field':
    'A site printed this on the profile — a name, a city, an address. The person typed it; the site is only repeating it. True often, checked never.',
  'handle-sweep':
    'A site list reported that this handle is taken somewhere. That is a claim about a string, not about a person, and it is the single largest source of false positives in this app.',
  'avatar-hash':
    'The picture is the same picture. A person chose that image; two profiles wearing it is hard to arrange by accident — unless both are wearing the platform default, which is why a default never fires this.',
  'reverse-image':
    'A reverse image engine returned this page for the picture. The engine decided the images match; nobody has checked what it means.',
  archive: 'An archived capture of a page named this. The page said so at the time of the capture, and may not now.',
  dataset:
    'An aggregator, register or certificate log named it. Second-hand by construction: the dataset is repeating something it was told.',
  'search-result':
    'A search engine returned this page for a query the case put together. A page matched some words; whether it is about your subject is the next question, not this one.',
  'file-metadata': "Read out of the file's own bytes. The camera or the editor wrote it, not a person.",
  correlation:
    'Local analysis over captures already in the case. It fetched nothing and observed nothing new — it can only rearrange what is already here, so it can never corroborate anything on its own.',
  'tool-claim': 'The tool asserted this without saying how it got there. Treat it as the weakest kind of lead.'
}

/**
 * How much weight a hop of this kind carries, structurally.
 *
 * - `declared` — the subject said so. Nothing an unauthenticated lookup can do beats it.
 * - `observed` — a site answered a question about this specific thing.
 * - `inferred` — something was deduced from a string, a list or existing captures.
 *
 * The depth rule and the planner both read this rather than the mechanism itself, so
 * adding a mechanism is one table entry rather than a search through the engine.
 */
export type MechanismStrength = 'declared' | 'observed' | 'inferred'

export const MECHANISM_STRENGTH: Record<ProvenanceMechanism, MechanismStrength> = {
  seed: 'declared',
  promotion: 'declared',
  'declared-link': 'declared',
  'profile-field': 'observed',
  'avatar-hash': 'observed',
  'reverse-image': 'observed',
  archive: 'observed',
  dataset: 'observed',
  'file-metadata': 'observed',
  'handle-sweep': 'inferred',
  'search-result': 'inferred',
  correlation: 'inferred',
  'tool-claim': 'inferred'
}

/**
 * A node in the provenance graph.
 *
 * `id` is an `EntityId` and that is deliberate: `EntityCandidate.id` is content-addressed
 * with the *same* formula, so a candidate and the entity it would become share one id. A
 * chain therefore survives promotion without being rewritten, and the findings the engine
 * wrote about an unpromoted candidate attach to the entity the moment a human promotes it.
 */
export interface NodeRef {
  id: EntityId
  kind: EntityKind
  /** Canonical value, per `normalise.ts`. */
  value: string
  label: string
}

/** `username torvalds`, `account github.com/torvalds`. */
export function nodeLabel(node: NodeRef): string {
  return `${node.kind} ${node.label || node.value}`
}

/**
 * One edge, appended to `cases/<id>/provenance.jsonl` and never rewritten.
 *
 * Append-only for the same reason the confidence log is: this file is the answer to *how
 * did I get here*, and a route that can be edited after the fact answers nothing.
 */
export interface ProvenanceHop {
  id: string
  caseId: string
  /** Where the hop arrived. */
  to: NodeRef
  /** Where it came from. `null` only for a root — a seed, or a hand-promoted entity. */
  from: NodeRef | null
  mechanism: ProvenanceMechanism
  /** The finding that carried the hop, when a finding did. */
  findingId: FindingId | null
  /** The adapter that produced that finding. */
  tool: string | null
  /** The site or dataset, as `Finding.source` names it. The corroboration key. */
  source: string | null
  /** One sentence naming the specific thing that made this hop. Never a template alone. */
  detail: string
  at: IsoTimestamp
}

/**
 * A prune, or the undoing of one. Appended to the same file the hops live in.
 *
 * Recorded rather than applied destructively because **auto-dismiss has to be
 * recoverable**. Cutting a node cuts everything descending from it, which is exactly the
 * point — and exactly why the operation has to be reversible when the engine gets it
 * wrong.
 */
export interface ProvenancePrune {
  id: string
  caseId: string
  nodeId: EntityId
  action: 'prune' | 'restore'
  /** Who did it. The engine prunes contradicted branches; a human prunes anything. */
  actor: 'engine' | 'human'
  /** Mandatory. A prune with no stated reason is the failure mode this whole model exists to avoid. */
  reason: string
  at: IsoTimestamp
}

export type ProvenanceRecord = ({ record: 'hop' } & ProvenanceHop) | ({ record: 'prune' } & ProvenancePrune)

/**
 * The ordered path from a seed to one node, with the mechanism of every hop.
 *
 * ```
 * seed:username(quillfern) -> github.com/quillfern -> declared link -> keybase.io/ark
 *     -> keybase proof -> twitter.com/quillfern_ -> avatar pHash -> steam/765611...
 * ```
 */
export interface ProvenanceChain {
  node: NodeRef
  root: NodeRef
  /** Root first, target last. A root's own chain is a single `seed` hop. */
  hops: ProvenanceHop[]
  /** Hops away from the root. A seed is 0; something found on a seed's own profile is 1. */
  depth: number
  /** The root is something the operator typed in. */
  rootIsSeed: boolean
  /**
   * The root is an anchor a human stands behind: a seeded account, address, phone, domain
   * or image, or an entity with a `confirmed` finding on it. This is what the depth-3
   * exemption turns on — depth 3 is allowed from verified ground and from nowhere else.
   */
  rootIsAnchor: boolean
  /** Every hop on the path is `declared`: the subject asserted the whole route. */
  fullyDeclared: boolean
  /** The weakest link on the path. A chain is worth exactly what its weakest hop is worth. */
  weakest: MechanismStrength
  /** Other routes to the same node that were found and not chosen. More routes is better evidence. */
  alternates: number
  /** True when this node, or something it descends from, has been pruned. */
  pruned: boolean
  /** The rendered one-liner, for the brief and for a hover. */
  line: string
}

/** Render a chain the way the strategy document writes them. */
export function chainLine(hops: readonly ProvenanceHop[]): string {
  if (!hops.length) return ''
  const first = hops[0]
  if (!first) return ''
  const parts: string[] = [
    first.mechanism === 'seed' ? `seed:${first.to.kind}(${first.to.label || first.to.value})` : nodeLabel(first.to)
  ]
  for (const hop of hops.slice(1)) {
    parts.push(MECHANISM_LABEL[hop.mechanism], hop.to.label || hop.to.value)
  }
  return parts.join(' → ')
}

/* ------------------------------------------------------------------ *
 * Decisions — the engine's running commentary
 * ------------------------------------------------------------------ */

export type EngineDecisionKind =
  /** A root was recorded for something already in the case. */
  | 'seeded'
  /** An adapter was pointed at a node. */
  | 'ran'
  /** A lead was corroborated and the engine will keep going from it, with no human in the hop. */
  | 'expanded'
  /** A lead was read once on the strength of a link the subject published. Nothing was believed. */
  | 'probed'
  /** A lead only a human can settle. It goes in the brief's question list. */
  | 'asked'
  /** A lead contradicts the seeds. Kept, shown, and not spent on. */
  | 'parked'
  /** A node and everything descending from it was cut. */
  | 'pruned'
  /** An action was ranked and not taken. */
  | 'skipped'
  /** A stopping condition fired. */
  | 'stopped'

/**
 * One automatic decision, appended to `cases/<id>/engine-log.jsonl`.
 *
 * `reason` is not optional and never will be. This file is the difference between an
 * engine and a black box, and the operator's stated priority is understanding the
 * mechanism rather than pressing buttons.
 */
export interface EngineDecision {
  id: string
  caseId: string
  kind: EngineDecisionKind
  at: IsoTimestamp
  /** One sentence, in the operator's terms. Mandatory. */
  reason: string
  node: NodeRef | null
  adapterId: string | null
  /** The expected gain the planner scored, when the decision was about an action. */
  gain: number | null
}

/* ------------------------------------------------------------------ *
 * The planner
 * ------------------------------------------------------------------ */

/**
 * The reasons an action is worth more or less than another one.
 *
 * Every entry in the strategy document's higher-value / lower-value table appears here,
 * plus the two the engine can measure for itself: the adapter's own yield in this case,
 * and whether the node was reached by a route worth trusting.
 */
export type PlannerSignalId =
  | 'operator-supplied'
  | 'confirmed-anchor'
  | 'anchor-root'
  | 'unenriched'
  | 'corroborated-lead'
  | 'declared-hop'
  | 'distinctive-handle'
  | 'never-probed'
  | 'adapter-yield'
  | 'single-unverified'
  | 'weak-matcher'
  | 'common-handle'
  | 'inferred-route'
  | 'depth-cost'
  | 'contradicted-branch'

/**
 * Points per signal. Base is `PLANNER_BASE`; the sum is clamped to 0..100.
 *
 * An ordering with arithmetic attached, never a probability — the same disclaimer the
 * relevance and pivot scorers carry, for the same reason. Every term is shown in the
 * brief, so the operator can disagree with the total rather than having to trust it.
 *
 * The two largest positives are the two things the strategy document says are worth most:
 * a profile that declares outbound links, and an account the operator vouched for that
 * nothing has read yet. `adapter-yield` is deliberately small — it is the only term
 * derived from measurement rather than from structure, and early in a case there is no
 * measurement to derive it from.
 */
export const PLANNER_POINTS: Record<PlannerSignalId, number> = {
  'operator-supplied': 26,
  'confirmed-anchor': 22,
  'anchor-root': 16,
  unenriched: 20,
  'corroborated-lead': 16,
  'declared-hop': 12,
  'distinctive-handle': 10,
  'never-probed': 6,
  'adapter-yield': 14,
  'single-unverified': -12,
  'weak-matcher': -14,
  'common-handle': -20,
  'inferred-route': -10,
  'depth-cost': -8,
  'contradicted-branch': -30
}

/** Two or three words, for the ranked list. The sentence is one hover away. */
export const PLANNER_SHORT: Record<PlannerSignalId, string> = {
  'operator-supplied': 'you supplied it',
  'confirmed-anchor': 'confirmed anchor',
  'anchor-root': 'anchored',
  unenriched: 'not yet read',
  'corroborated-lead': 'two sources',
  'declared-hop': 'subject-declared route',
  'distinctive-handle': 'distinctive handle',
  'never-probed': 'never probed',
  'adapter-yield': 'measured yield',
  'single-unverified': 'one unverified hit',
  'weak-matcher': 'weak matcher',
  'common-handle': 'common handle',
  'inferred-route': 'inferred route',
  'depth-cost': 'deep',
  'contradicted-branch': 'contradicted branch'
}

/** A row nothing has been measured against scores here: neither promising nor discouraging. */
export const PLANNER_BASE = 40

export interface PlannerSignal {
  id: PlannerSignalId
  /** Signed contribution. Kept per signal so the sum is auditable rather than magic. */
  points: number
  /** One sentence naming the actual evidence. */
  detail: string
}

/**
 * Where an expected-gain number came from.
 *
 * `measured` means this case's own engine log records runs of this adapter against this
 * kind and the yield is arithmetic over them. `prior` means it is a documented default
 * written by hand. The distinction is surfaced rather than hidden because a guess
 * presented as a measurement is the kind of quiet lie this app exists to be the opposite
 * of.
 */
export type GainBasis = 'measured' | 'prior'

export interface PlannedAction {
  /** `<adapterId>:<nodeId>`. Stable, so a re-plan does not reshuffle equal scores. */
  key: string
  adapterId: string
  adapterTitle: string
  node: NodeRef
  /** In the case's graph, or reached by the engine and awaiting a human. */
  nodeState: 'entity' | 'candidate'
  /** Hops from the chain's root. */
  depth: number
  /** 0..100. `PLANNER_BASE` is "no reason to think either way". */
  gain: number
  signals: PlannerSignal[]
  /** One line: why this is worth doing, or why it is not. Always present. */
  reason: string
  basis: GainBasis
  /** Set when the action was ranked and will not run. Ranked, never silently dropped. */
  blocked: string | null
}

export interface ActionRanking {
  caseId: string
  at: IsoTimestamp
  /** Runnable, best first. */
  actions: PlannedAction[]
  /** Ranked and refused, with the sentence that says why. */
  blocked: PlannedAction[]
  /** Frontier nodes considered, whether or not any action came out of them. */
  nodesConsidered: number
  /** True when the planner had nothing left it was allowed to do. */
  exhausted: boolean
}

/* ------------------------------------------------------------------ *
 * Stopping
 * ------------------------------------------------------------------ */

export type StopReasonId =
  | 'budget-runs'
  | 'budget-time'
  | 'depth'
  | 'novelty'
  | 'contradiction'
  | 'exhausted'
  | 'cancelled'
  | 'failed'

export const STOP_LABEL: Record<StopReasonId, string> = {
  'budget-runs': 'run budget',
  'budget-time': 'time budget',
  depth: 'depth limit',
  novelty: 'novelty decay',
  contradiction: 'contradiction density',
  exhausted: 'nothing left to do',
  cancelled: 'you stopped it',
  failed: 'the run failed'
}

export interface StopCondition {
  id: StopReasonId
  fired: boolean
  /** One sentence. Reads the same whether it fired or not, so the brief can show headroom. */
  detail: string
  /** 0..1: how close this condition is to firing. `1` is fired. */
  pressure: number
}

/**
 * What the engine is allowed to spend, and where it stops.
 *
 * Defaults are deliberately small. A first run that finishes in a minute and says what it
 * would do next is worth more than one that spends twenty minutes proving the operator
 * should have anchored better.
 */
export interface Budget {
  /** Hard cap on adapter runs the engine starts. */
  maxRuns: number
  /** Hard cap on wall-clock for the whole investigation. */
  maxWallClockMs: number
  /**
   * Hops from a root. 2 by default; 3 is reachable **only** from a chain whose root is an
   * anchor a human stands behind — see `ProvenanceChain.rootIsAnchor`.
   */
  maxDepth: number
  /** Stop when this many consecutive expansions produce no newly corroborated lead. */
  noveltyWindow: number
  /** A branch this contradicted is pruned rather than spent on further. */
  contradictionShare: number
  /** ...but only once the branch has produced at least this many scored leads. */
  contradictionFloor: number
}

export const DEFAULT_BUDGET: Budget = {
  maxRuns: 24,
  maxWallClockMs: 15 * 60 * 1_000,
  maxDepth: 2,
  noveltyWindow: 3,
  contradictionShare: 0.5,
  contradictionFloor: 4
}

/** Depth beyond `maxDepth` that an anchored chain may reach. */
export const ANCHORED_DEPTH_BONUS = 1

export interface StopState {
  runsUsed: number
  elapsedMs: number
  depthReached: number
  /** Expansions since the last newly corroborated lead. */
  quietExpansions: number
  /** Share of this investigation's leads that contradict the seeds. */
  contradictedShare: number
  conditions: StopCondition[]
  /** The one that actually stopped the loop, or null while it is still allowed to run. */
  fired: StopCondition | null
}

/* ------------------------------------------------------------------ *
 * Leads
 * ------------------------------------------------------------------ */

/**
 * What the engine does with a lead.
 *
 * ## Why there are four rather than three
 *
 * `expand` used to mean two different things and the ambiguity was load-bearing in the
 * wrong direction. It meant *this is believed* — corroborated by two independent sources,
 * listed as Established, counted as useful yield, treated as ground for the next hop — and
 * it also meant *the engine may spend one run on this*, which is what a link the subject
 * published actually buys. One word, and four consumers reading it four ways: `brief.ts` as
 * Established, `yield.ts` as useful, `index.ts` as novelty, the planner as permission.
 *
 * Belief and permission are not the same size of claim. A fetch costs a run and a raw
 * capture and is recoverable; a belief propagates and gets more convincing with depth. So
 * the permission gets its own word.
 */
export type LeadDisposition =
  /** Believed enough to work from: two independent sources agree. */
  | 'expand'
  /**
   * One run authorised, nothing believed.
   *
   * The subject published a link to it, which is one source — the subject — and the only
   * way to learn whether a second exists is to read the far end. Non-transitive, restricted
   * to genuine ownership declarations, and never rendered above `pending`. If the far end
   * links back, *that* is the second source and the lead is corroborated by the ordinary
   * rule rather than by an exception to it.
   */
  | 'probe'
  /** Only a human can settle it. It goes in the brief's question list. */
  | 'ask'
  /** It contradicts the seeds. Kept, shown, and not spent on. */
  | 'park'

/**
 * *Which* rule produced a disposition, as a value rather than as a sentence.
 *
 * Consumers that care about the difference read this instead of parsing prose, which is
 * what stops "the subject linked to it" and "two sites agree" from being rendered as the
 * same claim.
 */
export type LeadBasis =
  /** Two independent sources, folded to the site operator, agree. */
  | 'corroborated'
  /** Two independent sources, one of which is the far end linking back. Still corroboration. */
  | 'reciprocated'
  /** One source: a link the account holder published as their own. One run, no belief. */
  | 'declared-link'
  /** It states something that disagrees with the seeds. */
  | 'contradicted'
  /** Corroborated, but every probe behind it was structurally incapable of meaning much. */
  | 'weak-matchers'
  /** Corroborated, and further out than this route is allowed to expand automatically. */
  | 'past-depth'
  /** One source and nothing else. */
  | 'single-source'
  /** A declared link whose declaring node is not itself trusted. See `disposeLead`. */
  | 'declared-chain'

export interface LeadVerdict {
  node: NodeRef
  disposition: LeadDisposition
  /** Which rule decided it. `disposition` says what happens; this says why, machine-readably. */
  basis: LeadBasis
  /** Mandatory sentence. Shown next to the lead in the brief. */
  reason: string
  /** Distinct independent sources behind it, after folding and after dropping local analysis. */
  independentSources: number
  /** The folded keys themselves, so "which two" is answerable. */
  sources: string[]
  band: RelevanceBand
  /** Hops from the root of its chain. */
  depth: number
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

export type InvestigationPhase = 'planning' | 'running' | 'summarising' | 'done' | 'stopped' | 'failed'

export interface InvestigationRequest {
  caseId: string
  /**
   * Where to start. Omitted means every seed entity in the case, which is the normal
   * case; naming one is how the operator says "follow this account and nothing else".
   *
   * It means both halves of that sentence. A root is recorded only for the entities named,
   * **and** the planner refuses every node that does not descend from one of them — ranked
   * and refused with a reason, not filtered out, so a deliberately narrow plan can still
   * show what it is leaving alone. It used to mean only the first half, which spent the
   * budget on branches the operator had explicitly excluded.
   */
  rootEntityIds?: string[]
  /** Overrides on top of `DEFAULT_BUDGET`. Anything omitted keeps the default. */
  budget?: Partial<Budget>
  /** Restrict the engine to these adapters. Omitted means everything available. */
  adapterIds?: string[]
}

export interface InvestigationRunState {
  caseId: string
  phase: InvestigationPhase
  startedAt: IsoTimestamp
  finishedAt: IsoTimestamp | null
  budget: Budget
  runsUsed: number
  /** Adapter runs in flight right now. */
  running: { adapterId: string; nodeLabel: string }[]
  /** Deepest hop the engine actually reached. */
  depthReached: number
  /**
   * Consecutive expansions that produced nothing newly corroborated.
   *
   * Carried on the state rather than left inside the loop because the brief has to be able
   * to say *why* the run stopped, and a summary that recomputes this from zero would show
   * "the last expansion produced something newly corroborated" underneath a headline saying
   * the run stopped on novelty decay. An interface arguing with itself is worse than one
   * that says less.
   */
  quietExpansions: number
  /**
   * `probed` is counted apart from `expanded` on purpose: one is a run the engine spent on
   * the strength of the subject's own link, the other is a lead two sources agreed on.
   * Adding them would report a number nobody could act on.
   */
  leads: { expanded: number; probed: number; asked: number; parked: number }
  pruned: number
  stop: StopCondition | null
  /** One line for the header. Never a spinner's worth of nothing. */
  message: string
  error: string | null
}

/* ------------------------------------------------------------------ *
 * The brief
 * ------------------------------------------------------------------ */

export interface BriefItem {
  node: NodeRef
  /** The chain's rendered line. */
  route: string
  depth: number
  /** How many independent sources back it, after folding. */
  independentSources: number
  /** One sentence: what is actually known about this. */
  note: string
  /** True when this is an entity in the case rather than something the engine reached. */
  inGraph: boolean
}

/**
 * A question only the operator can answer.
 *
 * The whole point of the engine is that there should be two or three of these per
 * investigation rather than ninety rows to review. `question` is written as a question and
 * `why` says why the engine cannot settle it — because "is this account him" has its
 * ground truth in his head and nowhere else.
 */
export interface BriefQuestion {
  node: NodeRef
  question: string
  why: string
  route: string
  /** What the answer unlocks: the actions that become available if he says yes. */
  unlocks: string
  /** Ranked; the brief shows the top few and says how many more there are. */
  weight: number
  /** URL to look at, when there is one worth opening. */
  url: string | null
}

export interface InvestigationBrief {
  caseId: string
  generatedAt: IsoTimestamp
  /** One line. States what happened; never celebrates and never alarms. */
  headline: string
  /** Corroborated or human-confirmed. What the case can actually stand on. */
  established: BriefItem[]
  /**
   * Reached, plausible, and backed by one source. The honest middle, and where most things
   * sit — including every lead the engine was authorised to `probe`, because a probe is
   * permission to spend one run and not a claim that the run will find anything.
   */
  pending: BriefItem[]
  /** States something that disagrees with the seeds. Kept and shown, never deleted. */
  contradicted: BriefItem[]
  /** Cut, with the reason. Restorable. */
  pruned: BriefItem[]
  /** What the engine wants to do next, and why. Top of the ranking. */
  next: PlannedAction[]
  /** Ranked and refused, so a plan of nothing can explain itself. */
  blocked: PlannedAction[]
  questions: BriefQuestion[]
  /** How many questions there are in total, when the list above is trimmed. */
  questionsTotal: number
  stops: StopState
  /** The engine's own commentary, newest first. */
  decisions: EngineDecision[]
  /** Every chain, for the route view. */
  chains: ProvenanceChain[]
  /** Present when the engine has never been run on this case. */
  neverRun: boolean
}

/* ------------------------------------------------------------------ *
 * Pruning
 * ------------------------------------------------------------------ */

export interface PruneRequest {
  caseId: string
  nodeId: EntityId
  /** Mandatory when a human prunes: the engine will not invent a reason on his behalf. */
  reason: string
}

export interface PruneResult {
  caseId: string
  node: NodeRef | null
  action: 'prune' | 'restore'
  /** The node itself plus everything whose every route ran through it. */
  cut: NodeRef[]
  /** Candidates dismissed as a consequence. Recoverable — a dismissal keeps the record. */
  candidatesDismissed: number
  /**
   * Cut nodes that are **entities in the case**.
   *
   * The engine does not remove these, and that is not timidity. Taking an entity out of a
   * case orphans its findings and writes a tombstone; it is a decision with consequences
   * the operator has to see. They are named here so he can act on them.
   */
  entitiesAffected: NodeRef[]
  reason: string
  at: IsoTimestamp
}

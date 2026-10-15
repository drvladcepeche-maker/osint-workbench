/**
 * The provenance graph: how every node in an investigation was reached.
 *
 * This is the first thing built and everything else rests on it. Without it a depth-3
 * finding is unauditable and therefore worthless — you cannot tell whether it descends
 * from an account the operator vouched for or from a stranger who happened to share a
 * handle at depth 1. Provenance is what makes depth *safe*.
 *
 * It is also what makes a wrong hop **recoverable**. Cut a node and everything whose only
 * route ran through it goes with it, in one operation, with the reason recorded. That
 * property is the entire reason automation is allowed to run at all here: a mistake is
 * one prune away from undone rather than something that has to be picked out of a case
 * file by hand.
 *
 * ## The one identity trick this depends on
 *
 * `EntityCandidate.id` is content-addressed over `(caseId, kind, canonical value)` — the
 * *same* formula as `EntityId`. So a node keeps one id whether it is a discovery, a
 * candidate the engine has been probing, or an entity a human has promoted. Chains do not
 * have to be rewritten on promotion, and the findings the engine wrote about an
 * unpromoted candidate attach to the entity the moment somebody promotes it.
 */

import {
  MECHANISM_STRENGTH,
  PROVENANCE_MECHANISMS,
  chainLine,
  type MechanismStrength,
  type NodeRef,
  type ProvenanceChain,
  type ProvenanceHop,
  type ProvenanceMechanism,
  type ProvenancePrune
} from '../../shared/engine'

/* ------------------------------------------------------------------ *
 * Classifying a hop
 * ------------------------------------------------------------------ */

/**
 * The default mechanism for each adapter that can discover anything.
 *
 * Keyed by adapter because an adapter's *route to information* is a property of the
 * adapter: sherlock probes a site list, subfinder reads certificate logs, exiftool reads
 * bytes. Where one adapter has two genuinely different routes — profile enrichment is the
 * important one, since "the site printed a name" and "the account holder wrote a link to
 * another account of theirs" are not the same claim — the adapter says so per proposal
 * via `EntityProposal.mechanism`, from the structure it actually parsed.
 */
const ADAPTER_MECHANISM: Record<string, ProvenanceMechanism> = {
  sherlock: 'handle-sweep',
  maigret: 'handle-sweep',
  blackbird: 'handle-sweep',
  holehe: 'dataset',
  subfinder: 'dataset',
  theharvester: 'dataset',
  wayback: 'archive',
  'archive-today': 'archive',
  websearch: 'search-result',
  dorks: 'search-result',
  exiftool: 'file-metadata',
  'gallery-dl': 'file-metadata',
  'reverse-image': 'reverse-image',
  'profile-enrich': 'profile-field',
  'reddit-profile': 'profile-field',
  pivot: 'correlation',
  'pattern-timezone': 'correlation'
}

/**
 * Mechanisms an adapter is never allowed to claim.
 *
 * A root is the operator typing something in, or a human promoting a candidate. Both are
 * acts of a person, and both are minted by the engine itself in `ensureRoots`. An adapter
 * that could declare one would be manufacturing ground truth out of a fetch.
 */
const ADAPTER_MAY_NOT_CLAIM: ReadonlySet<ProvenanceMechanism> = new Set(['seed', 'promotion'])

const KNOWN = new Set<string>(PROVENANCE_MECHANISMS)

/**
 * How a candidate was reached: what the adapter declared, or the adapter's own default.
 *
 * ## Why this reads no text
 *
 * It used to. It pattern-matched an adapter's rationale and the finding's claim against a
 * list of phrases, on the argument that those strings are written by this repository. They
 * are not, entirely: `websearch.ts` embeds a result's **title and snippet verbatim** in the
 * claim it writes, and `profile-enrich` quotes bios. So a page that put `rel=me` in its
 * title could mint a `declared-link` hop — the strongest provenance the system has,
 * manufactured by an arbitrary stranger's web page, and enough on its own to authorise the
 * engine to keep fetching. Provenance decided by text of unknown origin is not provenance.
 *
 * So: the adapter declares the mechanism as part of its output contract, from structure it
 * parsed — an `<a rel="me">` element, an API's `website` field, a site-list row. Anything
 * it does not declare falls back to the route that adapter structurally *is*. Anything
 * unrecognised, and anything an adapter is not allowed to claim, falls back the same way.
 *
 * The last fallback is `tool-claim` — "the tool asserted it and did not say how" — rather
 * than anything flattering. An unclassified route is the weakest kind of lead and the model
 * should say so out loud instead of quietly borrowing a stronger label.
 */
export function mechanismFor(tool: string, declared?: ProvenanceMechanism | null): ProvenanceMechanism {
  if (declared && KNOWN.has(declared) && !ADAPTER_MAY_NOT_CLAIM.has(declared)) return declared
  return ADAPTER_MECHANISM[tool] ?? 'tool-claim'
}

/* ------------------------------------------------------------------ *
 * The graph
 * ------------------------------------------------------------------ */

const STRENGTH_RANK: Record<MechanismStrength, number> = { declared: 0, observed: 1, inferred: 2 }

interface Path {
  hops: ProvenanceHop[]
  depth: number
  rootIsSeed: boolean
  rootIsAnchor: boolean
  weakestRank: number
}

export interface GraphContext {
  /** Entity ids the operator supplied himself. */
  seeds: ReadonlySet<string>
  /**
   * Entity ids a human stands behind: a seeded account/address/phone/domain/image, or
   * anything carrying a `confirmed` finding. The depth-3 exemption turns on this and on
   * nothing else, which is what keeps "3 only from a confirmed anchor" a structural rule
   * rather than a hopeful comment.
   */
  anchors: ReadonlySet<string>
  /** Entity ids currently in `entities.json`. */
  inGraph: ReadonlySet<string>
}

export class ProvenanceGraph {
  private readonly nodes = new Map<string, NodeRef>()
  /** Every distinct hop that arrives at a node, keyed by the node's id. */
  private readonly inbound = new Map<string, ProvenanceHop[]>()
  private readonly children = new Map<string, Set<string>>()
  private readonly roots = new Set<string>()
  private readonly prunedSet = new Set<string>()
  private readonly pruneReason = new Map<string, string>()
  private best = new Map<string, Path>()

  constructor(
    hops: readonly ProvenanceHop[],
    prunes: readonly ProvenancePrune[],
    private readonly ctx: GraphContext
  ) {
    // Identical hops are folded here rather than at write time: the fold is visible,
    // reversible and does not throw away the raw record. Two hops that differ in mechanism
    // or in the finding behind them are two routes and both survive.
    const seen = new Set<string>()
    for (const hop of hops) {
      const key = `${hop.from?.id ?? ''}>${hop.to.id}|${hop.mechanism}|${hop.findingId ?? ''}|${hop.source ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)

      this.nodes.set(hop.to.id, hop.to)
      if (hop.from) this.nodes.set(hop.from.id, hop.from)

      const list = this.inbound.get(hop.to.id) ?? []
      list.push(hop)
      this.inbound.set(hop.to.id, list)

      if (!hop.from) {
        this.roots.add(hop.to.id)
      } else {
        const kids = this.children.get(hop.from.id) ?? new Set<string>()
        kids.add(hop.to.id)
        this.children.set(hop.from.id, kids)
      }
    }

    // Prune and restore replay in order. The last word wins, which is what makes a wrong
    // automatic prune one click away from undone.
    for (const p of [...prunes].sort((a, b) => a.at.localeCompare(b.at))) {
      if (p.action === 'prune') {
        this.prunedSet.add(p.nodeId)
        this.pruneReason.set(p.nodeId, p.reason)
      } else {
        this.prunedSet.delete(p.nodeId)
        this.pruneReason.delete(p.nodeId)
      }
    }

    this.best = this.relax(new Set())
  }

  /* ---------------- reading ---------------- */

  node(id: string): NodeRef | null {
    return this.nodes.get(id) ?? null
  }

  nodeIds(): string[] {
    return [...this.nodes.keys()]
  }

  isPruned(id: string): boolean {
    if (this.prunedSet.has(id)) return true
    // A node whose every route has been cut is pruned by consequence, not by decree.
    return !this.best.has(id) && this.nodes.has(id)
  }

  prunedReason(id: string): string | null {
    if (this.pruneReason.has(id)) return this.pruneReason.get(id) ?? null
    if (!this.isPruned(id)) return null
    return 'Everything it was reached through has been cut, so nothing connects it to a seed any more.'
  }

  /**
   * The route to one node, or null when it has none.
   *
   * When several routes exist the chosen one is: anchored root first (that is what the
   * depth exemption reads), then shortest, then the route whose weakest hop is strongest,
   * then oldest. `alternates` counts the rest — and more routes to one node is genuinely
   * better evidence, so the number is shown rather than hidden by the choice.
   */
  chainFor(id: string): ProvenanceChain | null {
    const node = this.nodes.get(id)
    const path = this.best.get(id)
    if (!node || !path) return null
    const first = path.hops[0]
    const root = first ? first.to : node
    return {
      node,
      root,
      hops: path.hops,
      depth: path.depth,
      rootIsSeed: path.rootIsSeed,
      rootIsAnchor: path.rootIsAnchor,
      fullyDeclared: path.hops.every((h) => MECHANISM_STRENGTH[h.mechanism] === 'declared'),
      weakest: (Object.keys(STRENGTH_RANK) as MechanismStrength[]).find(
        (s) => STRENGTH_RANK[s] === path.weakestRank
      ) ?? 'inferred',
      alternates: Math.max(0, (this.inbound.get(id)?.length ?? 0) - 1),
      pruned: this.isPruned(id),
      line: chainLine(path.hops)
    }
  }

  /** Every route in the case, deepest last, so the brief can read them in discovery order. */
  chains(): ProvenanceChain[] {
    const out: ProvenanceChain[] = []
    for (const id of this.nodes.keys()) {
      const c = this.chainFor(id)
      if (c) out.push(c)
    }
    return out.sort((a, b) => a.depth - b.depth || a.node.value.localeCompare(b.node.value))
  }

  /**
   * What cutting this node would take with it.
   *
   * Defined as *reachability*, not as a subtree: a node reached by two independent routes
   * survives the loss of one of them, and it should — that is the whole value of a second
   * route. So the answer is "everything that can currently be reached from a root, and
   * cannot be once this node is gone".
   */
  descendantsOf(id: string): NodeRef[] {
    if (!this.nodes.has(id)) return []
    const before = new Set(this.relax(new Set()).keys())
    const after = new Set(this.relax(new Set([id])).keys())
    const out: NodeRef[] = []
    for (const nodeId of before) {
      if (nodeId === id || after.has(nodeId)) continue
      const n = this.nodes.get(nodeId)
      if (n) out.push(n)
    }
    return out.sort((a, b) => a.value.localeCompare(b.value))
  }

  /**
   * Nodes one hop below a root — the branches of the investigation.
   *
   * Contradiction density is measured per branch, and this is what a branch is: the first
   * thing reached from something the operator supplied. Pruning at this level is the
   * difference between abandoning a wrong lead and abandoning the case.
   */
  branchOf(id: string): NodeRef | null {
    const path = this.best.get(id)
    if (!path || path.hops.length < 2) return null
    return path.hops[1]?.to ?? null
  }

  /* ---------------- the relaxation ---------------- */

  /**
   * Best-known route to every reachable node, with `excluded` treated as absent.
   *
   * A relaxation loop rather than a recursive walk because the graph is small (tens of
   * nodes), can contain cycles — two profiles linking to each other is the *good* case —
   * and the comparator is not a simple minimum. Bounded by the node count, so a cycle
   * costs an iteration rather than a stack.
   */
  private relax(excluded: ReadonlySet<string>): Map<string, Path> {
    const best = new Map<string, Path>()

    for (const rootId of this.roots) {
      if (excluded.has(rootId) || this.prunedSet.has(rootId)) continue
      const hop = (this.inbound.get(rootId) ?? []).find((h) => !h.from)
      if (!hop) continue
      best.set(rootId, {
        hops: [hop],
        depth: 0,
        rootIsSeed: this.ctx.seeds.has(rootId) || hop.mechanism === 'seed',
        rootIsAnchor: this.ctx.anchors.has(rootId),
        weakestRank: STRENGTH_RANK[MECHANISM_STRENGTH[hop.mechanism]]
      })
    }

    for (let round = 0; round < this.nodes.size + 1; round++) {
      let changed = false
      for (const [nodeId, hops] of this.inbound) {
        if (excluded.has(nodeId) || this.prunedSet.has(nodeId)) continue
        for (const hop of hops) {
          if (!hop.from) continue
          if (excluded.has(hop.from.id) || this.prunedSet.has(hop.from.id)) continue
          const parent = best.get(hop.from.id)
          if (!parent) continue
          // A route that revisits a node is not a route. Two profiles linking to each
          // other is normal and must not become an infinite ladder of hops.
          if (parent.hops.some((h) => h.to.id === nodeId)) continue
          const candidate: Path = {
            hops: [...parent.hops, hop],
            depth: parent.depth + 1,
            rootIsSeed: parent.rootIsSeed,
            rootIsAnchor: parent.rootIsAnchor,
            weakestRank: Math.max(parent.weakestRank, STRENGTH_RANK[MECHANISM_STRENGTH[hop.mechanism]])
          }
          const current = best.get(nodeId)
          if (!current || better(candidate, current)) {
            best.set(nodeId, candidate)
            changed = true
          }
        }
      }
      if (!changed) break
    }

    return best
  }
}

function better(a: Path, b: Path): boolean {
  if (a.rootIsAnchor !== b.rootIsAnchor) return a.rootIsAnchor
  if (a.depth !== b.depth) return a.depth < b.depth
  if (a.weakestRank !== b.weakestRank) return a.weakestRank < b.weakestRank
  if (a.rootIsSeed !== b.rootIsSeed) return a.rootIsSeed
  const at = a.hops[a.hops.length - 1]?.at ?? ''
  const bt = b.hops[b.hops.length - 1]?.at ?? ''
  return at < bt
}

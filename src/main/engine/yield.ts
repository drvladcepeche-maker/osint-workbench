/**
 * How much a run of this adapter, against this kind of thing, is actually worth here.
 *
 * The strategy document's claim is that expected gain is *estimable*: "a profile with
 * declared links has a known-high yield; a bare username hit on a weak matcher has a
 * known-low one." That is true, and it comes from two different places, which this file
 * keeps apart on purpose:
 *
 *  - **Measured.** This case's own engine log records every run the engine started, with
 *    the adapter and the kind of node it was pointed at. Divide the useful leads that came
 *    out by the runs that went in and the number is arithmetic over things that happened.
 *  - **Prior.** Before there is any history, a documented default per adapter, written by
 *    hand from what the tool structurally *is*. A number somebody chose.
 *
 * Every estimate says which it is, and the brief renders that word next to the number. A
 * guess presented as a measurement is exactly the kind of quiet lie this application exists
 * to be the opposite of, and the honest answer for a case's first investigation is that
 * every estimate on screen is a prior.
 *
 * ## The population, and why it has to be one population
 *
 * The denominator is the engine's own runs, because those are the ones on record: jobs are
 * not persisted, so a manual run that produced nothing leaves no trace and counting only
 * the ones that produced findings would bias every yield upward.
 *
 * The numerator has to be drawn from **the same population**, and for a while it was not.
 * It counted useful leads from every candidate in the case, including ones the operator's
 * own manual sweeps proposed before the engine ever started. Five manual sherlock runs
 * producing three good candidates, then two engine runs producing nothing, measured 1.5
 * useful per run and called it "measured in this case" — and the planner then over-valued
 * whichever adapter the operator happened to run by hand.
 *
 * So the numerator is read off the **provenance hops**, which only the engine writes,
 * credited to the tool named on the hop, and indexed by the kind of node that run was
 * *pointed at* — which is what the denominator counts. Numerator and denominator now
 * describe the same thing: what this engine did in this case. Anything the operator ran by
 * hand is in neither number, and `YieldEstimate.detail` says so rather than leaving it to
 * be assumed.
 */

import type { CandidateView, EntityKind } from '../../shared/types'
import type { EngineDecision, GainBasis, ProvenanceHop } from '../../shared/engine'
import { corroborationOf } from './corroboration'

/**
 * Runs of one adapter against one kind before measurement is trusted over the prior.
 *
 * Two. At one run the ratio is 0 or "everything", and neither is information — it is the
 * outcome of a single draw being read as a rate.
 */
export const MEASURED_MIN_RUNS = 2

/**
 * Useful leads per run at which the estimate saturates.
 *
 * Two. One genuinely useful lead per run is a good adapter and lands at 0.5; anything
 * beyond two per run is already the top of the scale and the extra is not worth modelling.
 */
const SATURATION = 2

export interface YieldEstimate {
  /** 0..1. How often a run of this adapter moves the investigation forward. */
  value: number
  basis: GainBasis
  /** Runs behind the number. Zero for a prior. */
  runs: number
  /** One sentence, shown beside the ranked action. */
  detail: string
}

/**
 * Hand-written defaults, with the reason each one is where it is.
 *
 * These are the honest part of the honesty: they are judgements about what a tool
 * structurally does, not observations. They exist so a case's first investigation ranks
 * sensibly instead of ranking arbitrarily, and they are replaced by measurement as soon as
 * there is any.
 */
export const ADAPTER_PRIOR: Record<string, { value: number; why: string }> = {
  'profile-enrich': {
    value: 0.8,
    why: 'the only adapter that answers "who is this" rather than "does this exist", and the only one that recovers a link the account holder wrote themselves'
  },
  websearch: {
    value: 0.6,
    why: 'it is the only adapter that takes a *person* rather than an identifier, and for a human being a search over the name welded to a city or a school is the primary technique rather than the supporting one'
  },
  dorks: {
    value: 0.3,
    why: 'operator-scoped queries find the thing a plain search buries, and most of the value is the query it hands you rather than the rows it brings back on its own'
  },
  'archive-today': {
    value: 0.3,
    why: 'it holds captures Wayback does not, and for most pages neither of them holds anything'
  },
  subfinder: {
    value: 0.45,
    why: 'a domain is the one kind where enumeration genuinely converges — the answer set is finite and mostly real'
  },
  'reverse-image': {
    value: 0.55,
    why: 'an avatar match is among the strongest links an unauthenticated lookup can produce, and it also returns nothing at all a good share of the time'
  },
  pivot: {
    value: 0.45,
    why: 'it correlates captures already here, so it ranks well and observes nothing new — it can never be the second source'
  },
  holehe: {
    value: 0.4,
    why: 'an address either has an account on a site or it does not, and the answer is cheap'
  },
  wayback: {
    value: 0.35,
    why: 'an archived capture is often the only copy of a page that has since been taken down, and often there is none'
  },
  theharvester: { value: 0.35, why: 'aggregates several second-hand datasets; broad, shallow, and repeating what it was told' },
  maigret: {
    value: 0.35,
    why: 'thousands of probes of which a handful mean anything — this is where the anti-bot false-positive class lives'
  },
  'gallery-dl': { value: 0.35, why: 'metadata riding along with media; rich when the platform allows it and empty when it does not' },
  sherlock: { value: 0.3, why: 'the same site list as maigret with fewer sites and the same failure mode' },
  blackbird: { value: 0.3, why: 'the same technique again; its value is the comparison, not additional independence' },
  exiftool: { value: 0.5, why: "reads the file's own bytes, so either the metadata is there or it is not — no guessing either way" },
  'pattern-timezone': {
    value: 0.25,
    why: 'a histogram over captures already here; it characterises what is known and never adds to it'
  },
  'reddit-profile': {
    value: 0.2,
    why: 'the endpoint answers unauthenticated clients with HTTP 403 as of this build, so it usually reports a refusal aimed at us rather than anything about the account'
  },
  'hibp-passwords': { value: 0, why: 'its input is a live password typed at the moment of use; no automation may ask for one' },
  echo: { value: 0, why: 'the self-test adapter; it asserts nothing about the world' }
}

/** Adapters nobody wrote a prior for. Neither promising nor discouraging. */
export const DEFAULT_PRIOR = { value: 0.3, why: 'no prior was written for this adapter, so it is scored as neither promising nor discouraging' }

interface Cell {
  runs: number
  useful: number
}

export class YieldTable {
  private readonly cells = new Map<string, Cell>()

  /** Runs the engine has recorded in this case, across every adapter. */
  readonly measuredRuns: number

  constructor(input: {
    decisions: readonly EngineDecision[]
    candidates: readonly CandidateView[]
    hops: readonly ProvenanceHop[]
    /** Folded sources that reached a node by linking back — see `snapshot()`. */
    reciprocal?: ReadonlyMap<string, readonly string[]>
  }) {
    let total = 0
    for (const d of input.decisions) {
      if (d.kind !== 'ran' || !d.adapterId || !d.node) continue
      total++
      const cell = this.cell(d.adapterId, d.node.kind)
      cell.runs++
    }
    this.measuredRuns = total

    // A lead is "useful" when two independent sources agree on it. That is the only thing
    // this engine will work from, so it is the only thing worth spending a run to produce.
    //
    // A declared link on its own is deliberately **not** useful, and that is a change of
    // mind with a reason. It used to be, and the effect was that profile-enrich's measured
    // yield counted every URL anybody had ever mentioned in a bio — the adapter scoring
    // itself on the strength of having read a page. A declared link buys one run and
    // proves nothing until the far end answers; when the far end links back, that is a
    // second source, `corroborated` is true, and it counts here like anything else.
    const by = new Map(input.candidates.map((c) => [c.id, c] as const))
    const useful = new Set<string>()
    for (const [id, c] of by) {
      if (corroborationOf(c, input.reciprocal?.get(id) ?? []).corroborated) useful.add(id)
    }

    // Credited off the hops, because a hop is a record the **engine** made: `recordHops`
    // writes one per (candidate, proposing finding) for findings an engine run produced,
    // and nothing else writes them. A proposal that reached the case some other way has no
    // hop and therefore no vote, which is what keeps this arithmetic over one population.
    //
    // Keyed on `hop.from.kind` — the kind of node the run was **pointed at** — because that
    // is what the denominator counts, and a cell whose two halves are indexed differently
    // is not a rate. `maigret` pointed at a `username` produces `account` leads; crediting
    // those to `maigret|account` while the runs land in `maigret|username` divides one
    // number by an unrelated one and reports the result as measurement.
    const credited = new Set<string>()
    for (const hop of input.hops) {
      if (!hop.from || !hop.tool) continue
      if (!useful.has(hop.to.id)) continue
      // Credit every adapter that reached it. Two tools finding the same useful thing is
      // two adapters that did something worth doing, not a race one of them won.
      const key = `${hop.tool}|${hop.from.kind}|${hop.to.id}`
      if (credited.has(key)) continue
      credited.add(key)
      this.cell(hop.tool, hop.from.kind).useful++
    }
  }

  private cell(adapterId: string, kind: EntityKind): Cell {
    const key = `${adapterId}|${kind}`
    let cell = this.cells.get(key)
    if (!cell) {
      cell = { runs: 0, useful: 0 }
      this.cells.set(key, cell)
    }
    return cell
  }

  /**
   * The estimate for one adapter against one kind.
   *
   * Falls back to the prior below `MEASURED_MIN_RUNS`, and says so. It never blends the
   * two: a number that is half measurement and half judgement cannot be argued with, and
   * arguing with it is what the operator is here to do.
   */
  estimate(adapterId: string, kind: EntityKind): YieldEstimate {
    const cell = this.cells.get(`${adapterId}|${kind}`)
    if (cell && cell.runs >= MEASURED_MIN_RUNS) {
      const perRun = cell.useful / cell.runs
      const value = Math.max(0, Math.min(1, perRun / SATURATION))
      return {
        value,
        basis: 'measured',
        runs: cell.runs,
        detail:
          `Measured over this engine's own runs in this case: ${cell.runs} runs against ${kind} entities ` +
          `reached ${cell.useful} lead${cell.useful === 1 ? '' : 's'} that two independent sources agree on — ` +
          `${perRun.toFixed(2)} per run. Runs you started by hand are in neither number.`
      }
    }
    const prior = ADAPTER_PRIOR[adapterId] ?? DEFAULT_PRIOR
    const seen = cell?.runs ?? 0
    return {
      value: prior.value,
      basis: 'prior',
      runs: seen,
      detail:
        `Estimated, not measured — ${seen === 0 ? 'the engine has not run this here yet' : `only ${seen} run so far, below the ${MEASURED_MIN_RUNS} it takes to be a rate`}. ` +
        `The prior says ${prior.value.toFixed(2)} because ${prior.why}.`
    }
  }
}

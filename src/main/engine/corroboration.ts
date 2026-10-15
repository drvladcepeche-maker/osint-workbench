/**
 * Corroboration as steering, not as a badge.
 *
 * Confidence was already computed and displayed. This is what makes it *act*: two
 * independent sources agreeing is the trigger to keep going with no human in the hop; a
 * contradiction is the trigger to stop spending on a branch. That turns the confidence
 * model from a label into the engine's steering wheel.
 *
 * ## Belief and permission are different sizes of claim
 *
 * The two-source rule governs **belief**: what may be called corroborated, listed as
 * Established, counted as measured yield, used as ground for the next hop. For belief it is
 * right, and nothing here weakens it.
 *
 * A single-anchor investigation needs something smaller and separate — *may the engine
 * spend one run looking at this?* Fetching costs a run and a raw capture and is
 * recoverable; believing propagates and gets more convincing with depth. That permission is
 * `probe`, and it exists as its own word because it used to be spelled `expand`: one token
 * that `brief.ts` read as Established, `yield.ts` as useful and `index.ts` as novelty. The
 * rule was never cheated around. It was overloaded, and the overload is what produced a
 * heading saying two sources agreed over a lead that had one.
 *
 * ## Independence, and where the fold lives
 *
 * There is **one** fold in this app and it is `independenceKey` in `shared/confidence.ts`:
 * it collapses a source to the site operator — `api.github.com` and `github.com` are
 * GitHub answering twice, not two sources — and leaves a derived `local:`/`file:` prefix
 * alone so it can never collide with a hostname.
 *
 * This file used to keep a second copy of that rule, on the argument that adapters were
 * only *supposed* to fold at emit time and a second application cost nothing. That was
 * true of the risk and wrong about the remedy: `finaliseFinding` now folds every
 * `Finding.source` through the one function as it is written, so the guarantee is at the
 * boundary where sources are minted rather than re-derived by each reader. Two
 * implementations of one rule is how the two answers drift apart, and the failure it was
 * guarding against is the app's worst one — three wrappers around a single site list
 * "corroborating" the same anti-bot false positive, at which point the engine expands into
 * fabricated agreement and gets more convincing with depth.
 *
 * ## Why local analysis never counts
 *
 * `local:` sources — the pivot correlator, the timezone histogram — observe nothing. They
 * rearrange captures already in the case. Letting one count toward the two independent
 * sources would let analysis promote itself, and then let that promotion authorise more
 * analysis. `sources.ts` says this out loud about the `local:` prefix; this enforces it.
 */

import { independenceKey, isDerivedSource } from '../../shared/confidence'
import type { CandidateView, MatcherQuality } from '../../shared/types'
import type { LeadBasis, LeadDisposition, LeadVerdict, NodeRef } from '../../shared/engine'
import type { RelevanceBand } from '../../shared/relevance'

/** Number of independent sources that authorises an automatic expansion. */
export const EXPANSION_THRESHOLD = 2

/**
 * Sources that describe where the app looked rather than who answered.
 *
 * Re-exported rather than reimplemented: `local:` is analysis over the case's own files,
 * `file:` is a claim read out of bytes the operator already had, and there is one place
 * that decides which is which.
 */
export { isDerivedSource }

/**
 * The independence key the engine compares on — an alias for the app's one fold.
 *
 * Kept as a name because the engine's callers read better saying what they are doing, and
 * kept as an *alias* because it used to be a second implementation of `independenceKey`
 * and a rule with two implementations has two answers the moment either is edited.
 */
export const engineSourceKey = independenceKey

/** Distinct independent sources in a list, with derived ones removed. Sorted, for display. */
export function independentSourcesOf(sources: readonly string[]): string[] {
  const keys = new Set<string>()
  for (const s of sources) {
    if (isDerivedSource(s)) continue
    const k = engineSourceKey(s)
    if (k) keys.add(k)
  }
  return [...keys].sort()
}

export interface Corroboration {
  /** The folded, independent keys. */
  sources: string[]
  count: number
  corroborated: boolean
  /** Derived sources that were present and deliberately not counted, for the explanation. */
  derived: string[]
  /** Folded keys that came from a link back rather than from a proposal. Subset of `sources`. */
  reciprocal: string[]
  /** True when every proposing probe was structurally incapable of meaning much. */
  allWeakMatchers: boolean
}

/**
 * What is actually behind one candidate.
 *
 * Recomputed here rather than read off `CandidateView.independentSources`, which the index
 * derives with the plain `independenceKey`. The two agree most of the time; where they
 * disagree, this one is the conservative answer, and conservative is the direction that
 * matters — the cost of missing a corroboration is one question the operator answers, and
 * the cost of manufacturing one is an automatic expansion into nothing.
 */
export function corroborationOf(
  candidate: CandidateView,
  /**
   * Sources that observed this node without proposing it.
   *
   * There is exactly one of these today and it is the one the declared-link argument was
   * always about: the **reciprocal link**. When A's profile declares a link to B and the
   * engine reads B, a link on B pointing back to A is B's operator publishing the same
   * connection A did. That is two different site operators asserting it — two independent
   * sources under the ordinary rule, not an exception to it. The observation was already
   * being made and thrown away, because it lands as a proposal about *A* (which the case
   * already holds) rather than about B.
   *
   * Folded and de-duplicated with the proposing sources, so a far end that merely repeats
   * its own origin cannot count twice.
   */
  alsoObservedBy: readonly string[] = []
): Corroboration {
  const all = [...candidate.claims.map((c) => c.source), ...alsoObservedBy]
  const sources = independentSourcesOf(all)
  const derived = [...new Set(all.filter(isDerivedSource).map((s) => s.trim().toLowerCase()))].sort()
  const reciprocal = independentSourcesOf(alsoObservedBy)
  const matchers = candidate.claims.map((c) => c.matcher).filter(Boolean) as MatcherQuality[]
  return {
    sources,
    count: sources.length,
    corroborated: sources.length >= EXPANSION_THRESHOLD,
    derived,
    reciprocal,
    // Only a claim that came from probing a site carries a matcher at all, so "no matchers
    // anywhere" is not weakness — it is a different kind of claim, and must not read as one.
    allWeakMatchers: matchers.length > 0 && matchers.length === candidate.claims.length && matchers.every((m) => m.strength === 'weak')
  }
}

export interface DispositionInput {
  node: NodeRef
  candidate: CandidateView
  band: RelevanceBand
  depth: number
  /** False when the depth budget will not let the engine act on it even if it wanted to. */
  withinDepth: boolean
  /**
   * True when the **last** hop that reached this is a `declared-link` — a link the account
   * holder published as their own, in a place that means ownership: `rel="me"`, a
   * platform-verified link, the profile's own website field. Never a URL that merely turned
   * up inside bio text; the adapter decides that, from what it parsed.
   *
   * On its own this is not enough to do anything. See `parentTrusted`.
   */
  declaredRoute: boolean
  /**
   * True when the node that *made* the declaration is ground the engine already stands on:
   * an entity in the case (a seed, or something a human promoted), or a candidate two
   * independent sources agree on.
   *
   * This is what makes the allowance non-transitive, and it is the whole difference between
   * "authorises one run" and "authorises a belief". A probe result is a single-source lead;
   * if its own declared links were probable in turn, one unconfirmed profile would walk an
   * arbitrarily long ladder on nobody's authority, every rung labelled `declared` and none
   * of them checked. The far end of a probe has to earn its second source before it can
   * declare anything the engine will act on — and it can, by linking back.
   */
  parentTrusted: boolean
  /**
   * Sources that observed this node without proposing it — the reciprocal link. Passed
   * straight to `corroborationOf`.
   */
  reciprocalSources: readonly string[]
}

/**
 * Expand, probe, ask, or park — and say which and why.
 *
 * The order of the tests is the argument:
 *
 *  1. **A contradiction parks it**, before anything else gets a say. A profile stating a
 *     different personal name outweighs the handle matching, because the handle matching is
 *     the very reason the row is in front of anybody. Parked is not deleted: the row stays,
 *     the reason stays, and the seed itself could be the thing that is wrong.
 *  2. **Two independent sources expand it.** This is the trigger the whole engine turns on,
 *     and a link the far end sent back counts as one of the two — see rule 4.
 *  3. **Unless every probe behind it was a weak matcher.** Two weak matchers agreeing is
 *     precisely the false-positive class this app was built around — a site answering an
 *     anti-bot challenge with 200, read as "the account exists". Source independence stops
 *     two wrappers around one list agreeing; it does not stop two different sites both
 *     lying the same way. So this goes to the operator instead.
 *  4. **A link the subject declared buys one run, and nothing else.** This looks like an
 *     exception to rule 2 and is not one. It is a *smaller permission* that rule 2 never
 *     granted, and the difference is worth stating precisely.
 *
 *     A `rel="me"` link on a profile is one source asserting a connection. The **second**
 *     source is the reciprocal link on the far end — a different site operator publishing
 *     the same connection — and there is no way to observe a reciprocal link without
 *     reading the far end. `shared/pivot.ts` already ranks `reciprocal-link` as its only
 *     decisive signal; that signal is unreachable if a single-source declared link can
 *     never be read at all. So the engine gets **one run**: `probe`. Nothing is believed,
 *     nothing is promoted, nothing is listed above `pending`, and no yield is credited.
 *
 *     Three things keep "one run" honest rather than aspirational:
 *
 *      - **Only a genuine ownership declaration counts.** `rel="me"`, a platform-verified
 *        link, the profile's own website field. A URL that merely appeared in bio text is a
 *        `profile-field`, because linking to something is not claiming it.
 *      - **The declaring node has to be trusted.** A probe result is single-source; letting
 *        it authorise the next probe is how one unconfirmed profile becomes a ladder.
 *      - **The depth cap applies** exactly as it does to everything else.
 *
 *     And then the payoff. If the far end links back, `reciprocalSources` carries that
 *     observation into rule 2 and the lead is **corroborated normally** — two independent
 *     site operators, which is what the rule always said. The declared-link case rejoins
 *     the rule instead of bypassing it, which is why there is no belief here to smuggle.
 *  5. **Everything else is a question**, and questions are the resource being conserved:
 *     the target is three decisions per investigation, not ninety.
 */
export function disposeLead(input: DispositionInput): LeadVerdict {
  const { node, candidate, band, depth } = input
  const c = corroborationOf(candidate, input.reciprocalSources)
  const base = { node, independentSources: c.count, sources: c.sources, band, depth }

  const verdict = (disposition: LeadDisposition, basis: LeadBasis, reason: string): LeadVerdict => ({
    ...base,
    disposition,
    basis,
    reason
  })

  if (band === 'contradicted') {
    return verdict(
      'park',
      'contradicted',
      `Parked: it states something that disagrees with your seeds — a different personal name, or a gender the seeded name does not read as. Nothing is deleted and the seed could be the thing that is wrong, but the engine will not spend runs down this route.`
    )
  }

  if (c.corroborated && c.allWeakMatchers) {
    return verdict(
      'ask',
      'weak-matchers',
      `${c.count} independent sources (${c.sources.join(', ')}) — but every probe behind them was a weak matcher, which is the exact shape of the anti-bot false positive this app is built around. Two sites lying the same way is not corroboration. Yours to judge.`
    )
  }

  if (c.corroborated && !input.withinDepth) {
    return verdict(
      'ask',
      'past-depth',
      `Corroborated by ${c.count} independent sources (${c.sources.join(', ')}), and ${depth} hops out — past the depth this investigation is allowed to expand into automatically. Confirm it and the engine may go one further from it.`
    )
  }

  if (c.corroborated) {
    // Reciprocity is named out loud because it is the case the whole declared-link argument
    // turns on, and because "the far end agrees" is a different sentence from "two sweeps
    // agree" even where the arithmetic is identical.
    return c.reciprocal.length
      ? verdict(
          'expand',
          'reciprocated',
          `${c.count} independent sources agree: ${c.sources.join(', ')} — and ${c.reciprocal.join(', ')} is the far end linking back. The subject declared the link one way and the other site publishes it the other way, so two different site operators assert the same connection. That is corroboration under the ordinary rule, not an exception to it.`
        )
      : verdict(
          'expand',
          'corroborated',
          `${c.count} independent sources agree: ${c.sources.join(', ')}. Independence is folded to the site operator, so this is two different sites and not one site answering twice. Expanding without asking.`
        )
  }

  // One run, on the strength of the subject's own link. See rule 4 above.
  if (input.declaredRoute && input.parentTrusted && input.withinDepth && !c.allWeakMatchers) {
    return verdict(
      'probe',
      'declared-link',
      `One run authorised, nothing believed. It was reached by a link the account holder published as their own — one source (${c.sources[0] ?? 'the profile itself'}), and the only way to learn whether the far end says the same thing is to read the far end. Reading it is not believing it: it stays unverified, stays out of the case, is not counted as yield, and nothing may be reached from it on this alone. If the far end links back, that is the second source and it becomes corroborated the ordinary way. If it does not, it comes back to you as a question.`
    )
  }

  if (input.declaredRoute && !input.parentTrusted) {
    return verdict(
      'ask',
      'declared-chain',
      `A link the account holder published — but the profile that published it is itself a single unverified lead nobody has confirmed, so this would be a second unearned hop on one route. A declared link buys one run, not a ladder: every rung would be labelled "declared" and none of them would have a second source behind it. Confirm the profile it came from, or wait for something to corroborate it, and the engine may go on.`
    )
  }

  const only = c.sources[0] ?? c.derived[0] ?? 'one source'
  const derivedNote = c.derived.length
    ? ` ${c.derived.join(', ')} also named it, and local analysis is not a second opinion — it only rearranges captures already here.`
    : ''
  return verdict(
    'ask',
    'single-source',
    `One independent source so far (${only}), so it is unverified and stays that way until something else says the same thing.${derivedNote} Whether this is the same person is the call the engine cannot make.`
  )
}

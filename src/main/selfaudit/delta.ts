/**
 * The delta. This is the product; the totals are context.
 *
 * DECISIONS.md, verbatim: *"The interesting output is the delta — which single piece of
 * seed data unlocks the biggest jump in what's findable. That's the actionable finding:
 * 'your Steam username being the same as your Reddit username is what connects your gaming
 * identity to your real name.'"*
 *
 * That sentence is a **causal claim with named parts**, not a count, and reproducing its
 * shape is what this module is for. Four detectors run in decreasing order of specificity
 * and the first that fires writes the headline:
 *
 *  1. **A bridge.** One handle present on two platforms, where the second platform also
 *     carries a fact the operator only just seeded. That is a two-step route from an
 *     anonymous account to a person, and it is the most useful thing this app can say.
 *  2. **Attribution.** A newly seeded fact appears inside results the previous level had
 *     already found but could not attribute. Reach did not change; ownership did.
 *  3. **New reach.** A new kind of seed made a tool runnable and that tool reached sites
 *     the previous level could not.
 *  4. **Nothing moved** — and then it says *why*, which is usually that everything the
 *     new seed unlocked was refused rather than answered.
 *
 * Every headline is accompanied by `headlineBasis`, the specific rows it rests on, so it
 * can be checked rather than believed. And `caveats` is never empty: two levels ran at two
 * different moments against sites that answer inconsistently, and a delta that does not
 * say so is overstating itself.
 */

import type {
  ConfidenceMove,
  DeltaSource,
  SeedAttribution,
  SelfAuditCheck,
  SelfAuditDelta,
  SelfAuditSnapshot,
  SnapshotAccount,
  SnapshotFinding,
  SnapshotSeed
} from '../../shared/selfaudit'
import { isSilent, seedField } from '../../shared/selfaudit'
import { fold } from './match'

function claimsOf(s: SelfAuditSnapshot): SnapshotFinding[] {
  return s.findings.filter((f) => !f.derived)
}

/**
 * Adapters that read a profile rather than only testing whether a handle is taken.
 *
 * This distinction decides whether a level above L1 can do anything at all. Sherlock
 * reports a site and a URL; there is no name, no bio and no location in what it returns,
 * so seeding a real name gives the matcher nothing to match against. Maigret, Blackbird
 * and the Reddit reader scrape the profile itself, and that text is where a seeded name
 * or city actually turns up.
 *
 * Getting this wrong in either direction produces a lie. Without it, a level that found no
 * attributions reads as "your name is not out there" when the truth is "nothing in this
 * run ever looked at a profile".
 */
const PROFILE_READERS = new Set(['maigret', 'blackbird', 'gallery-dl', 'reddit-profile', 'theharvester'])

/** Seed kinds that work by matching, not by making a tool runnable. L2 through L4. */
const ATTRIBUTION_FIELDS = new Set(['names', 'cities', 'schools', 'family'])

/**
 * The key two findings are compared on across runs and across levels.
 *
 * Not the finding id: that is content-addressed over the case as well, so the same claim
 * in two levels has two ids by construction.
 *
 * Durations are stripped, and that is now **only** a reader for history. A per-run
 * measurement inside an identity-bearing claim was a bug at the writing end — Sherlock
 * ended every claim with "Answered in 0.77 s", so a second run minted a fresh finding
 * instead of refreshing the old one and the claim count grew with every re-run. The
 * adapters no longer do it. This stays because `findings.jsonl` and the snapshots already
 * on disk still hold claims written the old way, and a diff that reported all eighty-nine
 * of those rows as removed and re-added would be wrong about precisely the number the
 * re-scan exists to get right.
 */
export function diffKey(f: SnapshotFinding): string {
  const claim = f.claim
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:ms|s|sec|secs|seconds)\b/gi, '')
    .replace(/\bAnswered in\s*\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return `${f.sourceKey} ${f.tool} ${claim}`
}

function bySourceKey(findings: readonly SnapshotFinding[]): Map<string, SnapshotFinding[]> {
  const out = new Map<string, SnapshotFinding[]>()
  for (const f of findings) {
    if (!f.sourceKey) continue
    const list = out.get(f.sourceKey)
    if (list) list.push(f)
    else out.set(f.sourceKey, [f])
  }
  return out
}

function seedFor(snapshot: SelfAuditSnapshot, entityId: string): SnapshotSeed | null {
  return snapshot.seeds.find((s) => s.entityId === entityId) ?? null
}

export function computeDelta(to: SelfAuditSnapshot, from: SelfAuditSnapshot | null): SelfAuditDelta {
  const toClaims = claimsOf(to)
  const fromClaims = from ? claimsOf(from) : []

  const toSources = bySourceKey(toClaims)
  const fromSources = bySourceKey(fromClaims)

  /* A site is only "newly findable" if the tool that found it was *able to speak* at the
     level below. Where it was refused or rate-limited there, the site was never asked, and
     calling what came back here "reach the seed unlocked" credits the seed with the lower
     run's bad luck. Those go in their own bucket, out of the headline count. */
  const mutedBelow = from ? silencedAdapters(from) : new Set<string>()
  const newReach: DeltaSource[] = []
  const incomparableReach: DeltaSource[] = []
  for (const [key, findings] of toSources) {
    if (fromSources.has(key)) continue
    const row: DeltaSource = {
      sourceKey: key,
      findings,
      viaSeed: seedFor(to, findings[0]?.entityId ?? '')
    }
    if (findings.some((f) => mutedBelow.has(f.tool))) incomparableReach.push(row)
    else newReach.push(row)
  }
  const byWeight = (a: DeltaSource, b: DeltaSource): number =>
    b.findings.length - a.findings.length || a.sourceKey.localeCompare(b.sourceKey)
  newReach.sort(byWeight)
  incomparableReach.sort(byWeight)

  const lostReach: DeltaSource[] = []
  for (const [key, findings] of fromSources) {
    if (toSources.has(key)) continue
    lostReach.push({ sourceKey: key, findings, viaSeed: from ? seedFor(from, findings[0]?.entityId ?? '') : null })
  }
  lostReach.sort((a, b) => b.findings.length - a.findings.length || a.sourceKey.localeCompare(b.sourceKey))

  const fromAccounts = new Map((from?.accounts ?? []).map((a) => [a.key, a]))
  const toAccounts = new Map(to.accounts.map((a) => [a.key, a]))
  const newAccounts = to.accounts.filter((a) => !fromAccounts.has(a.key))
  const goneAccounts = (from?.accounts ?? []).filter((a) => !toAccounts.has(a.key))

  // Confidence moves are matched on `diffKey`, not on the finding id: an id is
  // content-addressed over the case as well, so the same claim in two levels has two ids
  // by construction.
  const fromByClaim = new Map(fromClaims.map((f) => [diffKey(f), f]))
  const promoted: ConfidenceMove[] = []
  const demoted: ConfidenceMove[] = []
  const rank = ['refuted', 'unverified', 'corroborated', 'confirmed']
  for (const f of toClaims) {
    const prev = fromByClaim.get(diffKey(f))
    if (!prev || prev.confidence === f.confidence) continue
    const move: ConfidenceMove = {
      findingId: f.id,
      claim: f.claim,
      sourceKey: f.sourceKey,
      from: prev.confidence,
      to: f.confidence
    }
    if (rank.indexOf(f.confidence) > rank.indexOf(prev.confidence)) promoted.push(move)
    else demoted.push(move)
  }

  /* The candidate causes.
   *
   * `to.seeds \ from.seeds` is a diff of two *snapshots*, and a snapshot is a moment, not
   * an entitlement. Run L0, add two usernames to the vault, run L1, and those handles are
   * new to the diff even though L0 was entitled to hold them all along. Crediting L1 with
   * them answers "which single fact unlocked the biggest jump" with a fact that belongs
   * below — so a seed whose own entry level is at or under `from.level` is split out as
   * evidence that the lower snapshot is stale, and never named in the causal sentence. */
  const fromSeedIds = new Set((from?.seeds ?? []).map((s) => `${s.kind} ${s.value}`))
  const newToSnapshot = to.seeds.filter((s) => !fromSeedIds.has(`${s.kind} ${s.value}`))
  const staleSeeds = from ? newToSnapshot.filter((s) => s.level <= from.level) : []
  const addedSeeds = from ? newToSnapshot.filter((s) => s.level > from.level) : newToSnapshot
  const addedFields = new Set(addedSeeds.map((s) => s.field))

  const { unlocked: newlyRunnable, other: runnableForOtherReasons } = partitionNewlyRunnable(to, from)

  // Only attributions caused by the seeds this level added. An attribution that L1
  // already had is not L2's doing.
  const attributions = to.attributions.filter((a) => addedFields.has(a.field))

  const { headline, basis } = writeHeadline({ to, from, addedSeeds, attributions, newReach, newlyRunnable })

  return {
    from: from ? { id: from.id, level: from.level, caseId: from.caseId, at: from.at, counts: from.counts } : null,
    to: { id: to.id, level: to.level, caseId: to.caseId, at: to.at, counts: to.counts },
    addedSeeds,
    staleSeeds,
    newReach,
    incomparableReach,
    lostReach,
    newAccounts,
    goneAccounts,
    promoted,
    demoted,
    newlyRunnable,
    runnableForOtherReasons,
    attributions,
    headline,
    headlineBasis: basis,
    caveats: writeCaveats({ to, from, newReach, incomparableReach, lostReach, attributions, staleSeeds })
  }
}

/**
 * Which adapters could not speak at a level, keyed by adapter id.
 *
 * A tool that was refused, failed, was never installed or was dropped from the chain said
 * nothing there; so did one that only partly got through. Either way the sites behind it
 * were not asked, and a site that turns up a level higher is not a site the seed reached.
 */
function silencedAdapters(snapshot: SelfAuditSnapshot): Set<string> {
  const out = new Set<string>()
  for (const c of snapshot.checks) {
    if (isSilent(c.outcome) || c.outcome === 'partial') out.add(c.adapterId)
  }
  // A tool with a clean run somewhere at this level was able to speak, whatever else
  // happened to it: one refused seed out of three does not make the level blind.
  for (const c of snapshot.checks) {
    if (c.outcome === 'answered' || c.outcome === 'answered-none') out.delete(c.adapterId)
  }
  return out
}

/**
 * Split "ran here, did not run below" into the seed's doing and everything else.
 *
 * The old test was `c.jobId && !fromAdapters.has(c.adapterId)`, which is true of three
 * things that are not the seed: the operator deselected the tool below (which the level
 * panel invites, and which now leaves a `skipped` check rather than no trace at all), the
 * binary was installed between the two runs, and the registry changed. All three then fed
 * the delta's **headline** branch, which rendered *"adding email addresses made Maigret
 * runnable"* about a tool that accepts usernames and was simply switched off below.
 *
 * Unlocked means what the words say: **none** of the kinds the adapter accepts existed at
 * `from`, and at least one exists at `to`. That needs the adapter's `accepts`, which
 * snapshots now record; where a snapshot predates that field the weaker test is the
 * check's own `entityKind` — the tool ran here against a kind that is new — which is sound
 * in the same direction and merely less complete.
 */
function partitionNewlyRunnable(
  to: SelfAuditSnapshot,
  from: SelfAuditSnapshot | null
): { unlocked: SelfAuditCheck[]; other: SelfAuditCheck[] } {
  const ranAtFrom = new Set((from?.checks ?? []).filter((c) => c.jobId).map((c) => c.adapterId))
  const fromKinds = new Set((from?.seeds ?? []).map((s) => s.kind))
  const toKinds = new Set(to.seeds.map((s) => s.kind))

  const unlocked: SelfAuditCheck[] = []
  const other: SelfAuditCheck[] = []
  for (const c of to.checks) {
    if (!c.jobId || ranAtFrom.has(c.adapterId)) continue
    const accepts = c.adapterAccepts
    const bySeed = accepts
      ? accepts.some((k) => toKinds.has(k)) && !accepts.some((k) => fromKinds.has(k))
      : !!c.entityKind && toKinds.has(c.entityKind) && !fromKinds.has(c.entityKind)
    if (bySeed) unlocked.push(c)
    else other.push(c)
  }
  return { unlocked, other }
}

/* ------------------------------------------------------------------ *
 * The headline
 * ------------------------------------------------------------------ */

interface HeadlineInput {
  to: SelfAuditSnapshot
  from: SelfAuditSnapshot | null
  addedSeeds: SnapshotSeed[]
  attributions: SeedAttribution[]
  newReach: DeltaSource[]
  newlyRunnable: SelfAuditCheck[]
}

/**
 * A handle that appears on more than one platform, where at least one of those platforms
 * also carries a newly seeded fact.
 *
 * This is the "Steam username matching your Reddit username" shape, stated generally: the
 * reused handle is the edge, and the attributed platform is where the edge lands on a
 * person. Both halves have to be present — a reused handle alone connects two anonymous
 * accounts, which is interesting but not the finding.
 */
interface Bridge {
  handle: string
  platforms: string[]
  /** The platforms other than the attributed one, for naming a couple in the headline. */
  others: string[]
  attributed: SeedAttribution
  attributedPlatform: string
}

function findBridge(input: HeadlineInput): Bridge | null {
  const byHandle = new Map<string, Set<string>>()
  for (const a of input.to.accounts) {
    if (!a.handle || !a.platform) continue
    const key = fold(a.handle)
    const set = byHandle.get(key) ?? new Set<string>()
    set.add(a.platform)
    byHandle.set(key, set)
  }

  // Attributions from a seed that is *about a person* — a name, a city, a school, a
  // relative. An email or a username attribution is a link between accounts, not a link
  // to a person, and it belongs to the second detector rather than this one.
  const personal = input.attributions.filter((a) => ATTRIBUTION_FIELDS.has(a.field))

  let best: Bridge | null = null
  for (const attribution of personal) {
    // Only a claim match can name a platform. A raw match carries no `sourceKey` on
    // purpose — see `SeedAttribution` — and a bridge built on one would be asserting a
    // site said something it did not.
    const platform = attribution.sourceKey
    if (!platform) continue
    for (const [handleKey, platforms] of byHandle) {
      if (platforms.size < 2) continue
      if (![...platforms].some((p) => p === platform || platform.includes(p) || p.includes(platform))) continue
      const account = input.to.accounts.find((a) => fold(a.handle) === handleKey)
      const sorted = [...platforms].sort()
      const candidate: Bridge = {
        handle: account?.handle ?? handleKey,
        platforms: sorted,
        others: sorted.filter((p) => p !== platform),
        attributed: attribution,
        attributedPlatform: platform
      }
      if (!best || candidate.platforms.length > best.platforms.length) best = candidate
    }
  }
  return best
}

function writeHeadline(input: HeadlineInput): { headline: string; basis: string[] } {
  const { to, from, addedSeeds, attributions, newReach, newlyRunnable } = input

  /* L0 has nothing below it. Describing it as a change against "the level below" would be
     reporting a comparison that was never made, so it reads as what it is: the baseline
     every level above is measured against. */
  if (!from) {
    const answered = to.checks.filter((c) => c.outcome === 'answered' || c.outcome === 'partial')
    const silent = to.checks.filter((c) => isSilent(c.outcome))
    return {
      headline:
        `Baseline. ${describeSeeds(to.seeds)} alone put you on ${to.counts.sources} site${to.counts.sources === 1 ? '' : 's'}, ` +
        `from ${answered.length} tool${answered.length === 1 ? '' : 's'} that answered` +
        `${silent.length ? ` and ${silent.length} that could not` : ''}. Every level above is measured against this.`,
      basis: [
        ...newReach.slice(0, 3).map((r) => `${r.sourceKey} — ${r.findings[0]?.claim ?? ''}`),
        ...silent.slice(0, 2).map((c) => `${c.adapterTitle} — ${c.detail}`)
      ]
    }
  }

  const levelWord = `L${from.level} → L${to.level}`

  if (!addedSeeds.length) {
    return {
      headline: `Nothing was added between L${from.level} and L${to.level}: the profile has no values for the fields this level introduces, so the two runs started from the same place.`,
      basis: [`Both levels seeded ${to.seeds.length} entit${to.seeds.length === 1 ? 'y' : 'ies'}.`]
    }
  }

  const bridge = findBridge(input)
  if (bridge) {
    const field = seedField(bridge.attributed.field)
    // A relative's name is not the subject's, and "carries your family names" says it is.
    // The bridge is still worth reporting — a shared surname in a follower list is exactly
    // how an anonymous account gets tied to a household — but it has to say whose name it
    // found, because the inference it supports is one step longer than the others here.
    const carries =
      bridge.attributed.field === 'family'
        ? `carries a family name of yours — ${bridge.attributed.seedValue}, not your own name`
        : `carries your ${field.label.toLowerCase()}`
    return {
      headline:
        `The handle ${bridge.handle} is on ${bridge.platforms.length} sites — ${joinAnd(bridge.others.slice(0, 3))} among them — and the ` +
        `${bridge.attributedPlatform} one ${carries}. The handle is what connects those accounts to each other, ` +
        `and ${bridge.attributedPlatform} is where they stop being anonymous.`,
      basis: [
        `${bridge.handle} appears as the handle on ${bridge.platforms.length} platforms: ${bridge.platforms.join(', ')}.`,
        `"${bridge.attributed.seedValue}" (${field.label.toLowerCase()}, seeded at L${bridge.attributed.level}) appears in the ${bridge.attributedPlatform} result: ${bridge.attributed.excerpt}`,
        bridge.attributed.field === 'family'
          ? `Both halves are unverified, and this one has a third weakness: a family name is shared with people who are not you, so the account may be a relative's rather than yours.`
          : `Both halves are unverified. The handle match is what a tool reported; the ${field.label.toLowerCase()} match is a string match this app made.`
      ]
    }
  }

  if (attributions.length) {
    const byField = groupBy(attributions, (a) => a.field)
    const [topField, rows] = [...byField.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? ['names', []]
    const field = seedField(topField as SeedAttribution['field'])
    const sources = [...new Set(rows.map((r) => r.sourceKey).filter(Boolean))]
    const value = rows[0]?.seedValue ?? ''
    return {
      headline:
        `${levelWord} found nothing new. What it changed is ownership: your ${field.label.toLowerCase()} "${value}" appears in ${rows.length} result${rows.length === 1 ? '' : 's'} ` +
        `L${from.level} had already collected but could not attribute${sources.length ? ` — on ${joinAnd(sources.slice(0, 3))}` : ''}. ` +
        `That is the step from "an account with this handle" to "this person's account".`,
      basis: rows.slice(0, 4).map((r) => `${r.sourceKey || 'unknown source'} — ${r.excerpt}`)
    }
  }

  const answeredNew = newlyRunnable.filter((c) => c.outcome === 'answered' || c.outcome === 'partial')
  if (newReach.length && answeredNew.length) {
    const top = newReach[0]
    const seed = top?.viaSeed
    const tools = [...new Set(answeredNew.map((c) => c.adapterTitle))]
    return {
      headline:
        `Adding ${describeSeeds(addedSeeds)} made ${joinAnd(tools)} runnable, and ${tools.length === 1 ? 'it' : 'they'} reached ` +
        `${newReach.length === 1 ? 'one site' : `${newReach.length} sites`} L${from.level} could not: ` +
        `${joinAnd(newReach.slice(0, 3).map((r) => r.sourceKey))}${seed ? `, all of it hanging off ${seed.label}` : ''}.`,
      basis: newReach.slice(0, 4).map((r) => `${r.sourceKey} — ${r.findings[0]?.claim ?? ''}`)
    }
  }

  /* A tool became runnable and was refused. That outranks any drift in what the *old*
     tools returned, because it is the one thing the new seed actually caused — and
     reporting the drift instead would let a level that checked nothing read as a level
     that found nothing. This branch used to sit below the drift branch and produced
     exactly that lie on a real run. */
  const silenced = newlyRunnable.filter((c) => isSilent(c.outcome))
  if (silenced.length) {
    const tools = [...new Set(silenced.map((c) => c.adapterTitle))]
    return {
      headline:
        `Adding ${describeSeeds(addedSeeds)} made ${joinAnd(tools)} runnable, and ${tools.length === 1 ? 'it' : 'they'} could not get an answer. ` +
        `This level found nothing new because nothing was checked, not because there is nothing there.`,
      basis: silenced.slice(0, 4).map((c) => `${c.adapterTitle} — ${c.detail}`)
    }
  }

  /* An attribution-only level with no profile reader in the chain. "Matched nothing" here
     would be a lie by omission: nothing in the run ever read a profile, so there was no
     text for a name or a city to match against. */
  const attributionOnly = addedSeeds.every((s) => ATTRIBUTION_FIELDS.has(s.field))
  const readers = to.checks.filter((c) => c.jobId && PROFILE_READERS.has(c.adapterId))
  if (attributionOnly && readers.length === 0) {
    const ran = [...new Set(to.checks.filter((c) => c.jobId).map((c) => c.adapterTitle))]
    return {
      headline:
        `${levelWord} could not be tested. ${describeSeeds(addedSeeds)} works by matching against what a tool read off a profile, and nothing in this chain reads profiles — ` +
        `the username tools that ran report a site and a URL and nothing else. Add maigret or blackbird at this level and the question becomes answerable.`,
      basis: [
        `Tools that ran: ${ran.join(', ') || 'none'}.`,
        'None of them scrapes a display name, a bio or a location field, so the attribution matcher had nothing to read.'
      ]
    }
  }

  if (newReach.length) {
    return {
      headline:
        `${levelWord} reached ${newReach.length} new site${newReach.length === 1 ? '' : 's'} (${joinAnd(newReach.slice(0, 3).map((r) => r.sourceKey))}), ` +
        `but no tool became runnable that was not runnable before — so this is the same tools answering differently, not the seed opening a door.`,
      basis: newReach.slice(0, 4).map((r) => `${r.sourceKey} — ${r.findings[0]?.claim ?? ''}`)
    }
  }

  return {
    headline:
      `${levelWord} changed nothing measurable. ${describeSeeds(addedSeeds)} unlocked no tool this build carries and matched nothing in what was already found.`,
    basis: [
      `${to.counts.claims} claims about the subject, from ${to.counts.sources} distinct sources.`,
      `${to.counts.silentChecks} of ${to.checks.length} checks said nothing either way.`
    ]
  }
}

/* ------------------------------------------------------------------ *
 * Caveats — never empty
 * ------------------------------------------------------------------ */

function writeCaveats(input: {
  to: SelfAuditSnapshot
  from: SelfAuditSnapshot | null
  newReach: DeltaSource[]
  incomparableReach: DeltaSource[]
  lostReach: DeltaSource[]
  attributions: SeedAttribution[]
  staleSeeds: SnapshotSeed[]
}): string[] {
  const out: string[] = []
  const { to, from, incomparableReach, lostReach, attributions, staleSeeds } = input

  /* First, and blocking: the comparison itself is against a stale run. Everything below
     is measured against a level that ran before the operator finished typing, so it goes
     at the top rather than at the bottom of a list nobody reaches. */
  if (from && staleSeeds.length) {
    const fields = [...new Set(staleSeeds.map((s) => seedField(s.field).label.toLowerCase()))]
    out.push(
      `L${from.level} is out of date: it ran before ${plural(staleSeeds.length, 'value')} you have since added to ${joinAnd(fields)} — ` +
        `${joinAnd(staleSeeds.slice(0, 3).map((s) => s.label))}${staleSeeds.length > 3 ? ` and ${staleSeeds.length - 3} more` : ''}. ` +
        `${staleSeeds.length === 1 ? 'That value belongs' : 'Those values belong'} to L${from.level}, not to L${to.level}, so anything ${staleSeeds.length === 1 ? 'it' : 'they'} produced is credited to the wrong rung. ` +
        `Re-run L${from.level} before reading the sentence above.`
    )
  }

  if (from && incomparableReach.length) {
    const tools = [...new Set(incomparableReach.flatMap((r) => r.findings.map((f) => f.tool)))]
    out.push(
      `${plural(incomparableReach.length, 'source')} here ${incomparableReach.length === 1 ? 'is' : 'are'} not comparable with L${from.level} rather than new: ` +
        `${joinAnd(tools.slice(0, 3))} could not get an answer at L${from.level}, so ${joinAnd(incomparableReach.slice(0, 3).map((r) => r.sourceKey))} ` +
        `${incomparableReach.length === 1 ? 'was' : 'were'} never asked there. ${incomparableReach.length === 1 ? 'It is' : 'They are'} excluded from the count above.`
    )
  }

  if (from) {
    out.push(
      `The two levels ran ${gapWords(from.at, to.at)} (L${from.level} at ${from.at.slice(0, 16).replace('T', ' ')}, L${to.level} at ${to.at.slice(0, 16).replace('T', ' ')}). ` +
        'These sites answer inconsistently — Sherlock alone returned a different count on two runs minutes apart — so part of any difference here is the internet having a different moment, not the seed.'
    )
  }

  const silentTo = to.checks.filter((c) => isSilent(c.outcome))
  if (silentTo.length) {
    out.push(
      `${silentTo.length} of ${to.checks.length} checks at L${to.level} produced no answer at all — ` +
        `${joinAnd([...new Set(silentTo.map((c) => c.adapterTitle))].slice(0, 4))}. Anything they would have covered is unchecked, not clear.`
    )
  }

  if (from) {
    const silentFrom = from.checks.filter((c) => isSilent(c.outcome))
    if (silentFrom.length !== silentTo.length) {
      out.push(
        `The two levels were not equally well covered: ${silentFrom.length} silent checks at L${from.level} against ${silentTo.length} at L${to.level}. ` +
          'A level that was checked harder will look worse than one that was not.'
      )
    }
  }

  if (lostReach.length) {
    out.push(
      `${lostReach.length} source${lostReach.length === 1 ? '' : 's'} present at the lower level ${lostReach.length === 1 ? 'is' : 'are'} absent here. ` +
        'That is far more likely to be a rate limit than a removal — check the run notes before reading it as progress.'
    )
  }

  if (attributions.length) {
    out.push(
      'Attribution matches are string matches this app made, not claims a tool asserted. A common name or a city that is also an ordinary word will match strangers. Read the excerpt before believing the link.'
    )
  }

  out.push(
    'Every finding underneath this is unverified unless it says otherwise. Two independent sources make a claim corroborated; only you, with a note, can make one confirmed.'
  )
  return out
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

/** "four minutes apart", "3 days apart". The gap is the caveat; the stamps are the detail. */
function gapWords(a: string, b: string): string {
  const ms = Math.abs(Date.parse(b) - Date.parse(a))
  if (!Number.isFinite(ms)) return 'at different moments'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'within the same minute'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} apart`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} apart`
  return `${Math.round(hours / 24)} days apart`
}

/** "1 value", "3 values". The count is the point, so it is always written out. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function joinAnd(items: readonly string[]): string {
  if (!items.length) return 'nothing'
  if (items.length === 1) return items[0] as string
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function describeSeeds(seeds: readonly SnapshotSeed[]): string {
  if (!seeds.length) return 'nothing'
  const fields = [...new Set(seeds.map((s) => seedField(s.field).label.toLowerCase()))]
  const shown = seeds.slice(0, 2).map((s) => s.label)
  return `${joinAnd(fields)} (${shown.join(', ')}${seeds.length > shown.length ? `, +${seeds.length - shown.length} more` : ''})`
}

export type { SnapshotAccount }

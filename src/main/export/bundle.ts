/**
 * What the export says, assembled once, so that the HTML and the Markdown cannot drift
 * into two different accounts of the same case.
 *
 * ## The reader is the subject
 *
 * This document is handed to the person it is about — a friend who agreed to be looked
 * up. That decides almost everything below. It is organised by **what a thing means**
 * rather than by which tool produced it, because the reader has never heard of maigret. It
 * carries no jargon it does not immediately explain. And it is arranged so the single most
 * important distinction is legible without reading a word of methodology:
 *
 *   **this is definitely you** · **this is probably you** · **this might be anyone**
 *
 * If a reader closes the file believing forty handle collisions are all their accounts,
 * the document has done harm. That is the failure this file is shaped to prevent.
 *
 * ## Nothing is filtered out of existence
 *
 * Everything the case holds is in the bundle. Promotion — the operator deciding a
 * discovered thing belongs in the graph — changes **presentation** and never inclusion: a
 * promoted account is marked as vouched for and sorted first, and an unpromoted one is
 * still there. An export that showed only what the operator had already triaged would be a
 * filtered view presented as a complete one, and would also mean he could show his friend
 * nothing until he had reviewed the whole case.
 *
 * Rows that are almost certainly noise are still included, in their own section, each one
 * carrying **the rule that put it there**. A reader who can see the filter can disagree
 * with it. A reader who cannot is being asked to trust it.
 *
 * Material that fits no row — findings about an entity the operator has since removed,
 * claims from a tool this document has no section for — is counted and named in
 * `other` rather than dropped, because a headline backed by material the document never
 * shows is a headline the reader cannot check.
 *
 * ## The bands, and what puts a row in one
 *
 * | Band | Rule |
 * |---|---|
 * | `confirmed`    | **a human** opened it and wrote down that it is the subject's. Nothing else reaches this |
 * | `corroborated` | two sources with different site operators reported it. Machine agreement, and said so in those words |
 * | `probable`     | something beyond the handle agrees: a picture shared with another account, or a link the subject published pointing at it |
 * | `unverified`   | one tool said so and nothing has backed it up. **Most of these are wrong** |
 * | `noise`        | an explicit rule excluded it: the probe could not have meant anything, a human dismissed it, or a source contradicted it |
 *
 * These are the app's own confidence ladder with plain-language names. Nothing new is
 * computed and nothing is promoted by being exported.
 *
 * **`corroborated` and `confirmed` are separate bands here because they are separate
 * things in the app.** `shared/confidence.ts` lets only a human produce `confirmed`; two
 * hostnames agreeing tops out at `corroborated`. Collapsing them would hand the top rung
 * to the machine and print "checked by hand" over a pair of anti-bot redirects, which is
 * the exact false positive this whole application is built around.
 *
 * ## Independence is folded the conservative way
 *
 * Corroboration counts are computed with `engineSourceKey` / `independentSourcesOf` from
 * `engine/corroboration.ts` — the fold that goes to the **site operator** and **drops
 * `local:` and `file:` sources outright**. The looser `independenceKey` would count
 * `local:profile-enrich`'s note about an HTTP 403 as a corroborating witness beside a real
 * probe of the same site. A refusal is not a second opinion; it is this program describing
 * what happened to it.
 */

import { entityId } from '../../shared/ids'
import { isPublishableBasis } from '../../shared/types'
import type {
  Case,
  Confidence,
  Entity,
  EntityCandidate,
  Finding,
  MatcherQuality,
  RemovedEntity
} from '../../shared/types'
import type { AvatarGallery, GalleryImage } from '../../shared/ipc'
import type { CheckCoverage, CheckOutcome } from '../../shared/selfaudit'
import { isSilent } from '../../shared/selfaudit'
import {
  assessRelevance,
  emptyStatedFields,
  seedContextIsEmpty,
  statedFields,
  type RelevanceRow,
  type SeedContext,
  type StatedFields
} from '../../shared/relevance'
import { seedContextFrom } from '../../shared/ranking'
import type { CaseStore } from '../store/caseStore'
import type { ExtractedProfile } from '../adapters/support/profile'
import { siteOrigin } from '../adapters/support/sources'
import { independentSourcesOf, isDerivedSource } from '../engine/corroboration'
import { readCoverage, readRawEnvelope } from '../selfaudit/coverage'
import { groupAvatars, harvestAvatars, profilesFromHarvest } from './gallery'

export type Band = 'confirmed' | 'corroborated' | 'probable' | 'unverified' | 'noise'

export const BAND_ORDER: Record<Band, number> = {
  confirmed: 0,
  corroborated: 1,
  probable: 2,
  unverified: 3,
  noise: 4
}

/** The weaker of two bands. Used to clamp a derived band to the evidence under it. */
export function weakerBand(a: Band, b: Band): Band {
  return BAND_ORDER[a] >= BAND_ORDER[b] ? a : b
}

/** One account, with everything known about it and why it sits where it sits. */
export interface ExportAccount {
  key: string
  platform: string
  handle: string
  url: string | null
  band: Band
  confidence: Confidence
  /** True when the operator moved this into the case himself. Presentation only. */
  promoted: boolean
  /** True when the operator looked at it and said no. */
  dismissed: boolean
  /** False when nobody has decided about this row either way. */
  reviewed: boolean
  /**
   * Distinct **site operators** that reported it, `local:` and `file:` sources removed.
   * Two is the app's bar for corroboration.
   */
  independentSources: number
  /** Those source keys, for a row that wants to name them. */
  sources: string[]
  /** Derived sources that were present and deliberately not counted. */
  derivedSources: string[]
  tools: string[]
  /** How much the probe behind this could have meant, when the tool recorded it. */
  matcher: MatcherQuality | null
  /** The first thing on this row that disagrees with the seeds, when anything does. */
  contradiction: string | null
  profile: ExtractedProfile | null
  avatar: GalleryImage | null
  /** Accounts this one shares a picture with. Rows set aside as noise are never in here. */
  sharesPictureWith: string[]
  /** One sentence per reason, in the reader's language of evidence, not of tools. */
  why: string[]
  /** The claims that say this account is the subject's. Everything above is derived from these. */
  claims: string[]
  /**
   * What runs pointed at this account recorded — archive lookups, run notes, profile
   * fields read off whatever else the sweep touched.
   *
   * Shown so nothing is hidden, and **never** counted towards anything, because a
   * `Finding.entityId` names the entity the *run* was aimed at rather than the account the
   * claim is about: a sweep launched from a seeded account collects display names for fifty
   * other accounts under that entity's id. "The archive holds no captures of this URL" and
   * "some other site shows the name X" are neither of them a second site saying this
   * account is the subject's.
   */
  context: string[]
}

export type IdentityKind = 'name' | 'place' | 'work' | 'age' | 'contact' | 'link'

/** One thing the profiles say about the person, with everyone who said it. */
export interface IdentityItem {
  kind: IdentityKind
  value: string
  /** The sites that published it. More than one distinct site is real corroboration. */
  sources: string[]
  /** The account rows it was read off, so a value can be traced to what published it. */
  accounts: string[]
  band: Band
  /**
   * The band of the strongest account backing it.
   *
   * An identity line can never be worth more than the accounts it was read off: two
   * unverified handle collisions both printing "Alex" is one guess twice, not a fact.
   */
  backing: Band
  /** Plain language: what this is and how much it is worth. */
  note: string
}

/** A tool run that did not produce an answer, in the tool's own terms. */
export interface UncheckedItem {
  tool: string
  /** The value the run was pointed at, out of the capture's own envelope. */
  target: string
  outcome: CheckOutcome
  detail: string
  coverage: CheckCoverage | null
}

export interface AdviceItem {
  /** Imperative, plain, and something the subject can do this afternoon. */
  action: string
  /** Why it helps, concretely, naming what it disconnects. */
  because: string
  /** How many things it touches. The ordering key; never converted into a severity. */
  reach: number
  effort: 'minutes' | 'an evening' | 'weeks of waiting'
}

/**
 * Everything the case holds that no row and no line above accounts for.
 *
 * The headline counts and the tool list are computed over the whole case, and the account
 * table is not: the engine's provisional subjects make orphans by design, so a case that
 * ran to depth 2 has material that belongs to no account row. Counting it in the headline
 * and never showing it is a document backed by evidence the reader cannot see.
 */
export interface OtherMaterial {
  /** Findings backing no row in this document. */
  findings: number
  tools: { tool: string; claims: number }[]
  /** Independent source keys behind those findings. */
  sources: string[]
  /** Findings about something the operator has taken out of the case. */
  orphans: { kind: string; label: string; findings: number; why: string }[]
}

export interface ExportBundle {
  case: Case
  /** The consent/basis sentence, already assembled. */
  basisLine: string
  /**
   * False for every basis `isPublishableBasis` refuses.
   *
   * The export itself is deliberately ungated — handing the file to the person it is about
   * is the opposite of publishing it — but the document has to *say* which of the two it
   * is, and for a training or CTF case the "do not pass this on" sentence is simply false.
   */
  publishable: boolean
  subjectName: string
  preparedBy: string
  generatedAt: string
  seeds: { kind: string; label: string }[]
  counts: Record<Band, number> & { pictures: number; sources: number }
  accounts: ExportAccount[]
  /** Account key to band, so a picture can be captioned with the confidence of its row. */
  bandOf: Record<string, Band>
  identity: IdentityItem[]
  gallery: AvatarGallery
  /** Runs that were refused, failed, timed out, or were never re-read. A gap, not a result. */
  unchecked: UncheckedItem[]
  /** Runs that finished cleanly and found nothing. A result, and not the same thing. */
  answeredNothing: UncheckedItem[]
  /** Adapters that were never pointed at this case at all. */
  notAsked: { tool: string; wouldCover: string }[]
  advice: AdviceItem[]
  /** Every tool that produced anything, and how many claims it made. */
  toolsUsed: { tool: string; claims: number }[]
  other: OtherMaterial
}

/* ------------------------------------------------------------------ *
 * Basis
 * ------------------------------------------------------------------ */

/**
 * The declared basis, spelled out at the top of the document.
 *
 * Not a footnote and not a checkbox. A report about a person should say, in its first
 * paragraph, on what footing it was made — and `consent` is the only basis under which
 * handing somebody a dossier about themselves is an ordinary thing to do rather than a
 * strange one.
 *
 * `isPublishableBasis` is deliberately **not** used to gate the export. That rule governs
 * publishing — putting a case in front of an audience, which takes you out of the
 * household exemption and makes you a controller with notice duties. Giving the file to
 * the person it is about is the exact opposite of publishing it, and it is the one
 * disclosure that needs no lawful basis of its own.
 *
 * It *is* consulted for what the document says about itself: `bundle.publishable` carries
 * the answer, so the "not a document to pass on" sentence appears for `self` and `consent`
 * and stays off a CTF or training case, where it would simply be false.
 */
export function basisLine(c: Case, subjectName: string, lang: 'bg' | 'en'): string {
  const who = subjectName.trim() || (lang === 'bg' ? 'субекта' : 'the subject')
  const date = c.createdAt.slice(0, 10)
  if (lang === 'bg') {
    switch (c.basis) {
      case 'consent':
        return `Основание: съгласие. ${who} се съгласи да бъде проверен; случаят е открит на ${date}.`
      case 'self':
        return `Основание: собствена проверка. Това е одит на ${who} върху самия себе си, започнат на ${date}.`
      case 'ctf-fictional':
        return `Основание: измислен CTF сценарий. Нищо тук не е за истински човек. Случаят е открит на ${date}.`
      case 'public-entity':
        return `Основание: публична фигура или организация, проверена от публични източници. Случаят е открит на ${date}.`
      case 'training':
        return `Основание: тренировъчен случай. Случаят е открит на ${date}.`
    }
  }
  switch (c.basis) {
    case 'consent':
      return `Basis: consent. ${who} agreed to be looked up; this case was opened on ${date}.`
    case 'self':
      return `Basis: self-audit. This is ${who} looking themselves up, opened on ${date}.`
    case 'ctf-fictional':
      return `Basis: a fictional CTF scenario. Nothing here is about a real person. Opened on ${date}.`
    case 'public-entity':
      return `Basis: a public figure or organisation, looked up from public sources. Opened on ${date}.`
    case 'training':
      return `Basis: a training case. Opened on ${date}.`
  }
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

const CONFIDENCE_RANK: Confidence[] = ['refuted', 'unverified', 'corroborated', 'confirmed']

function strongest(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK.indexOf(a) >= CONFIDENCE_RANK.indexOf(b) ? a : b
}

function accountParts(value: string, attrs: Record<string, unknown>): { platform: string; handle: string } {
  const platform = typeof attrs['platform'] === 'string' ? attrs['platform'] : value.split('/')[0]
  const handle = typeof attrs['handle'] === 'string' ? attrs['handle'] : value.slice(value.indexOf('/') + 1)
  return { platform, handle }
}

/** Everything gathered about one account before any of it is turned into a band. */
interface AccountDraft {
  key: string
  platform: string
  handle: string
  url: string | null
  state: 'pending' | 'promoted' | 'dismissed' | 'seeded'
  /** Where this row came from, which decides what "nothing backs it up" means. */
  origin: 'candidate' | 'entity' | 'profile'
  /** When the operator decided about it, for the one case where two decisions disagree. */
  decidedAt: string | null
  /** True when the same value is also an entity in the graph. */
  inGraph: boolean
  /** Set when the graph entry is newer than a dismissal, so the dismissal was reversed. */
  revived: boolean
  /**
   * Claims that assert **this account is the subject's** — the candidate's own proposals.
   *
   * Everything that counts as corroboration is computed from this list and from nothing
   * else. The distinction is the whole of S2b and it is not academic: a real case in this
   * repository has a seeded `discord.com/<id>` whose entity collected wayback, pivot and
   * timezone findings, none of which says the account is anybody's — discord answered 404 —
   * and counting them made a row claiming **19 independent sites reported this**.
   */
  attributing: Finding[]
  /** Everything else the case recorded against this account. Shown, never counted. */
  context: Finding[]
  confidence: Confidence
  independent: string[]
  derived: string[]
  tools: string[]
  matcher: MatcherQuality | null
  weakOnly: boolean
  profile: ExtractedProfile | null
}

interface AccountsInput {
  caseId: string
  entities: readonly Entity[]
  candidates: readonly EntityCandidate[]
  findings: readonly Finding[]
  profiles: Map<string, ExtractedProfile>
  gallery: AvatarGallery
  seeds: SeedContext
}

/**
 * Everything the case knows about one account, folded into one row.
 *
 * Built from the candidate queue rather than from the findings, because a candidate is
 * already the app's answer to "these two proposals are about one account" — its id is
 * content-addressed exactly like an entity's, so two tools finding the same account
 * converge there and nothing here has to re-derive that. Accounts the operator typed in
 * himself have no candidate and are added on top.
 *
 * Two passes, and the split is load-bearing. A row is banded partly by whether it shares a
 * picture with another row — and a picture shared with a **dismissed** account is not
 * evidence of anything, so the set of rows eligible to corroborate has to be known before
 * any band is assigned. Doing it in one pass is how a row the operator threw away ends up
 * promoting a live one.
 */
function buildAccounts(input: AccountsInput): { rows: ExportAccount[]; usedFindingIds: Set<string> } {
  const byId = new Map<string, Finding>()
  for (const f of input.findings) byId.set(f.id, f)

  // Findings grouped by the entity they are about, so no loop below filters the whole list.
  const byEntity = new Map<string, Finding[]>()
  for (const f of input.findings) {
    const list = byEntity.get(f.entityId)
    if (list) list.push(f)
    else byEntity.set(f.entityId, [f])
  }

  const accountEntities = new Map<string, Entity>()
  for (const e of input.entities) {
    if (e.kind === 'account') accountEntities.set(e.value.toLowerCase(), e)
  }

  const pictureOf = new Map<string, GalleryImage>()
  for (const image of [
    ...input.gallery.groups.flatMap((g) => g.images),
    ...input.gallery.singles,
    ...input.gallery.defaults,
    ...input.gallery.unreadable
  ]) {
    if (!pictureOf.has(image.accountKey)) pictureOf.set(image.accountKey, image)
  }

  /* ---------------- pass one: gather ---------------- */

  const drafts: AccountDraft[] = []
  const seen = new Set<string>()

  const gather = (input2: {
    value: string
    attrs: Record<string, unknown>
    attributing: readonly Finding[]
    context: readonly Finding[]
    state: AccountDraft['state']
    origin: AccountDraft['origin']
    decidedAt: string | null
  }): void => {
    const key = input2.value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const { platform, handle } = accountParts(key, input2.attrs)

    // Everything — the band, the sources, the confidence — comes off the attributing
    // claims and off nothing else.
    //
    // The temptation is to let a `confirmed` context finding raise the row, since only a
    // human can mint one. It cannot be allowed to: a finding's `entityId` is the entity the
    // *run* was pointed at, not the account the claim is about, so a run against a seeded
    // account collects profile fields for every other account the sweep read. Confirming
    // one of those would confirm this row. `confirmed` here therefore means exactly what it
    // should — a human vouched for a claim that says *this account is the subject's*.
    let confidence: Confidence = 'unverified'
    const tools = new Set<string>()
    const rawSources: string[] = []
    let matcher: MatcherQuality | null = null
    let weakOnly = input2.attributing.length > 0
    for (const f of input2.attributing) {
      confidence = strongest(confidence, f.confidence)
      rawSources.push(f.source)
      tools.add(f.tool)
      if (f.matcher) {
        if (matcher === null || f.matcher.strength === 'strong') matcher = f.matcher
        if (f.matcher.strength !== 'weak') weakOnly = false
      } else weakOnly = false
    }

    const entity = accountEntities.get(key)
    const revived =
      input2.state === 'dismissed' &&
      entity !== undefined &&
      Date.parse(entity.createdAt) > Date.parse(input2.decidedAt ?? entity.createdAt)

    drafts.push({
      key,
      platform,
      handle,
      url: input.profiles.get(key)?.url ?? (typeof input2.attrs['url'] === 'string' ? input2.attrs['url'] : null),
      state: input2.state,
      origin: input2.origin,
      decidedAt: input2.decidedAt,
      inGraph: entity !== undefined,
      revived,
      attributing: [...input2.attributing],
      context: [...input2.context],
      confidence,
      // The conservative fold, and the only one this file uses. See the header.
      independent: independentSourcesOf(rawSources),
      derived: [...new Set(rawSources.filter(isDerivedSource).map((s) => s.trim().toLowerCase()))].sort(),
      tools: [...tools].sort(),
      matcher,
      weakOnly,
      profile: input.profiles.get(key) ?? null
    })
  }

  for (const candidate of input.candidates) {
    if (candidate.kind !== 'account') continue
    const attributing = candidate.proposals
      .map((p) => byId.get(p.findingId))
      .filter((f): f is Finding => f !== undefined)
    const proposed = new Set(attributing.map((f) => f.id))
    // A candidate id is content-addressed with the entity formula, so a finding an adapter
    // emitted *about this discovered account* is found by exact id, never by hostname.
    const context = (byEntity.get(candidate.id) ?? []).filter((f) => !proposed.has(f.id))
    gather({
      value: candidate.value,
      attrs: candidate.attrs as Record<string, unknown>,
      attributing,
      context,
      state: candidate.state,
      origin: 'candidate',
      decidedAt: candidate.decidedAt ?? null
    })
  }
  for (const entity of input.entities) {
    if (entity.kind !== 'account') continue
    gather({
      value: entity.value,
      attrs: entity.attrs as Record<string, unknown>,
      // Nothing proposed it: the operator typed it in. Every finding pointed at the entity
      // is context, and none of it asserts whose the account is.
      attributing: [],
      context: byEntity.get(entity.id) ?? [],
      state: 'seeded',
      origin: 'entity',
      decidedAt: null
    })
  }

  // Profiles read during enrichment for accounts that are in neither the graph nor the
  // review queue. This happens whenever a sweep's own capture carried profile metadata for
  // a site whose account was never proposed as a candidate — and dropping those would mean
  // the export silently held less than the case folder does, which is the one thing it is
  // not allowed to do.
  //
  // Their findings are looked up by the **account's own content-addressed entity id**, not
  // by hostname. Matching on the host attaches every `github.com` finding in the case to
  // this github row, so a claim the operator confirmed by hand about a completely different
  // account on the same platform would raise this one to `confirmed`.
  for (const [key, profile] of input.profiles) {
    if (seen.has(key)) continue
    gather({
      value: key,
      attrs: { platform: profile.platform, handle: profile.handle, url: profile.url },
      attributing: [],
      context: byEntity.get(entityId(input.caseId, 'account', key)) ?? [],
      state: 'pending',
      origin: 'profile',
      decidedAt: null
    })
  }

  /* ---------------- between the passes: who may corroborate ---------------- */

  const setAside = new Set<string>()
  for (const d of drafts) if (isSetAside(d)) setAside.add(d.key)

  const sharedWith = new Map<string, string[]>()
  for (const g of input.gallery.groups) {
    const live = g.accounts.filter((k) => !setAside.has(k))
    if (live.length < 2) continue
    for (const key of live) sharedWith.set(key, live.filter((k) => k !== key))
  }

  /* ---------------- pass two: band, and say why ---------------- */

  const scored = !seedContextIsEmpty(input.seeds)
  const rows: ExportAccount[] = []
  for (const d of drafts) {
    const shares = sharedWith.get(d.key) ?? []
    const linkedFrom = linkedFromAnother(d.key, input.profiles)
    const why: string[] = []

    let band: Band
    if (d.state === 'dismissed' && !d.revived) {
      band = 'noise'
      why.push('You looked at this one and decided it was not yours.')
      if (d.inGraph) {
        why.push(
          'It is also listed among the things typed into the case, from before that decision. The later decision is the one shown here.'
        )
      }
    } else if (d.confidence === 'refuted') {
      band = 'noise'
      why.push('Something contradicted this — it was marked as not yours.')
    } else if (d.weakOnly && d.confidence === 'unverified') {
      band = 'noise'
      why.push(
        d.matcher?.why ??
          'The check that found this could not actually tell whether the account exists — the request it made did not even mention the username.'
      )
    } else if (d.confidence === 'confirmed') {
      band = 'confirmed'
      why.push('Somebody opened this page and wrote down that it is yours.')
    } else if (d.confidence === 'corroborated' || d.independent.length >= 2) {
      band = 'corroborated'
      why.push(
        `${d.independent.length} different sites reported this independently — ${d.independent.join(', ')}. ` +
          'That is two machines agreeing, not a person opening the page and checking.'
      )
    } else if (shares.some((k) => platformOf(k) !== d.platform)) {
      band = 'probable'
      why.push(
        `The profile picture here is the same picture as on ${shares.join(', ')}. People do not usually share a picture by accident.`
      )
    } else if (shares.length > 0) {
      // Two accounts on one site serving one image is the shape of an undetected platform
      // default, and it is also just the site's own image pipeline. Disclosed, not promoted.
      band = 'unverified'
      why.push(
        `The profile picture here is the same picture as on ${shares.join(', ')} — but that is the same website twice, not two sites agreeing. One site can serve one image to any number of accounts, so this says much less than a match across two different sites would.`
      )
    } else if (d.profile !== null && d.profile.links.length > 0) {
      band = 'probable'
      why.push('This profile links out to your other accounts itself — you put those links there.')
    } else if (linkedFrom !== null) {
      band = 'probable'
      why.push(
        `Your profile on ${linkedFrom} links to this one. That connection was published by you, not guessed by a tool.`
      )
    } else if (d.origin === 'entity') {
      // Typed into the case by the operator and never proposed by anything. Not a handle
      // collision, and not something two sites agreed about either.
      band = 'probable'
      why.push(
        'This was put into the case by hand rather than found by a check, so it is here because somebody said so. Nothing in the case independently reports it.'
      )
    } else if (d.origin === 'profile') {
      band = 'unverified'
      why.push(
        'This came off a profile page that was read while looking at something else. Nothing in the case proposed it as yours.'
      )
    } else {
      band = 'unverified'
      why.push('One tool reported this and nothing has backed it up. A handle can simply belong to someone else.')
    }

    if (d.revived) {
      why.push('You dismissed this earlier and then added it to the case yourself; the later decision is the one that counts.')
    }

    // A derived source is this program describing its own run — a note that a site
    // answered 403, a histogram over captures already here. It is named where it might
    // otherwise look like a second witness, and it is never counted as one.
    if (d.derived.length > 0 && d.independent.length < 2 && band !== 'noise') {
      why.push(
        `A note this program wrote about its own run (${d.derived.join(', ')}) also mentions this. That is not a second website reporting it, so it is not counted.`
      )
    }

    const contradiction = scored ? contradictionOf(d, input.seeds) : null
    if (contradiction !== null && band !== 'noise') {
      why.unshift(contradiction)
      // A machine-derived band never outranks a contradiction; a human's does, because a
      // human looked. The row stays visible either way — this is a cap, not a deletion.
      if (d.confidence !== 'confirmed') band = weakerBand(band, 'unverified')
    }

    if (d.profile !== null && band !== 'noise') {
      if (d.profile.displayName !== null) why.push(`The page shows the name “${d.profile.displayName}”.`)
      if (d.profile.location !== null) {
        why.push(`The page shows the location “${d.profile.location}” — typed by whoever owns the account.`)
      }
    }

    const promoted = d.state === 'promoted' || d.state === 'seeded' || d.revived || d.inGraph
    if (promoted && !(d.state === 'dismissed' && !d.revived)) why.push('You added this to the case yourself.')

    const reviewed = d.state !== 'pending' || d.inGraph
    if (!reviewed && band !== 'noise') why.push('Nobody has reviewed this row yet.')

    rows.push({
      key: d.key,
      platform: d.platform,
      handle: d.handle,
      url: d.url,
      band,
      confidence: d.confidence,
      promoted,
      dismissed: d.state === 'dismissed' && !d.revived,
      reviewed,
      independentSources: d.independent.length,
      sources: d.independent,
      derivedSources: d.derived,
      tools: d.tools,
      matcher: d.matcher,
      contradiction,
      profile: d.profile,
      avatar: pictureOf.get(d.key) ?? null,
      sharesPictureWith: shares,
      why,
      claims: d.attributing.map((f) => f.claim),
      context: d.context.map((f) => f.claim)
    })
  }

  // Only the attributing claims count as "shown". The context list is printed in the
  // Markdown and not in the HTML, and the remainder is disclosed either way — over-stating
  // what a document left out is the safe direction to be wrong in.
  const usedFindingIds = new Set<string>()
  for (const d of drafts) for (const f of d.attributing) usedFindingIds.add(f.id)

  rows.sort(
    (a, b) =>
      BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
      Number(b.promoted) - Number(a.promoted) ||
      b.independentSources - a.independentSources ||
      a.platform.localeCompare(b.platform)
  )
  return { rows, usedFindingIds }
}

/** The platform half of an account key. */
function platformOf(key: string): string {
  const slash = key.indexOf('/')
  return slash < 0 ? key : key.slice(0, slash)
}

/** The three rules that set a row aside before any evidence is weighed. */
function isSetAside(d: AccountDraft): boolean {
  if (d.state === 'dismissed' && !d.revived) return true
  if (d.confidence === 'refuted') return true
  return d.weakOnly && d.confidence === 'unverified'
}

/**
 * Does this row state something that disagrees with the seeds?
 *
 * The same relevance model the review queue uses, applied to an export row. The queue
 * moves a `contradicted` candidate out of the triage bands entirely; the export cannot
 * hide a row, so it says so on the row and refuses to let a machine-derived band sit above
 * `unverified` while a contradiction stands.
 */
function contradictionOf(d: AccountDraft, seeds: SeedContext): string | null {
  // The attributing claims and this row's own profile, and nothing else. A context finding
  // belongs to whatever the run was pointed at, so scoring it here would let another
  // account's display name contradict this one.
  const claimText = d.attributing.map((f) => f.claim).join('\n')
  const stated: StatedFields = emptyStatedFields()
  const p = d.profile
  if (p?.displayName) stated.displayNames.push(p.displayName)
  if (p?.realName && !stated.displayNames.includes(p.realName)) stated.displayNames.push(p.realName)
  if (p?.location) stated.locations.push(p.location)
  const fromClaims = statedFields(claimText)
  for (const key of ['displayNames', 'locations', 'genders', 'countries', 'created'] as const) {
    for (const v of fromClaims[key]) if (!stated[key].includes(v)) stated[key].push(v)
  }
  for (const n of fromClaims.ages) if (!stated.ages.includes(n)) stated.ages.push(n)

  const row: RelevanceRow = {
    text: [d.key, p?.displayName, p?.realName, p?.location, p?.company, p?.bio, claimText]
      .filter(Boolean)
      .join('\n'),
    source: d.attributing[0]?.source ?? d.platform,
    platform: d.platform,
    handle: d.handle,
    anchored: d.state === 'seeded' || seeds.accounts.includes(d.key),
    stated
  }

  const assessment = assessRelevance(row, seeds)
  return assessment.band === 'contradicted' ? (assessment.why ?? 'This row disagrees with your seeds.') : null
}

/**
 * Which other enriched profile publishes a link that resolves to this account?
 *
 * Both halves are matched exactly, and both used to be loose enough to invent the
 * connection this document then calls its strongest: `hostname.endsWith(platform)` matches
 * `notgithub.com` against `github.com`, and `pathname.includes(handle)` matches the handle
 * `bob` against `/bobby` and `/jacobs`. The host is now folded to the site operator, and
 * the handle has to be a whole path segment.
 */
function linkedFromAnother(key: string, profiles: Map<string, ExtractedProfile>): string | null {
  const slash = key.indexOf('/')
  if (slash < 1) return null
  const platform = key.slice(0, slash)
  const handle = key.slice(slash + 1)
  if (!platform || !handle) return null
  for (const [otherKey, profile] of profiles) {
    if (otherKey === key) continue
    for (const link of profile.links) {
      if (linkPointsAt(link.url, platform, handle)) return otherKey
    }
  }
  return null
}

function linkPointsAt(url: string, platform: string, handle: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // `cleanUrl` already parsed this; anything that fails here is not a link to anything.
    return false
  }
  if (siteOrigin(u.href) !== platform) return false
  const wanted = handle.toLowerCase()
  return u.pathname
    .split('/')
    .filter(Boolean)
    .some((segment) => decodeSegment(segment).replace(/^@/, '') === wanted)
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase()
  } catch {
    return segment.toLowerCase()
  }
}

/* ------------------------------------------------------------------ *
 * What the profiles say about the person
 * ------------------------------------------------------------------ */

const IDENTITY_NOTE: Record<IdentityKind, string> = {
  name: 'A name printed on a profile page. It is whatever the account holder typed, and the same handle carries different names on different sites more often than people expect.',
  place: 'A location field somebody filled in themselves. It is not a measured position: it can be years out of date, a joke, or deliberately wrong.',
  work: 'An employer or school named on a profile. Self-declared, like everything else on a profile page.',
  age: 'A date the site recorded when the account was made. This is one of the few things on a profile the account holder cannot edit, which makes it more reliable than the rest of it — and it bounds when this identity started.',
  contact: 'A way of reaching you that is published on a public page and can be read by anyone, including automated collectors.',
  link: 'A link from one of your profiles to another. This is the strongest connection in the whole document, because you published it yourself.'
}

/**
 * Fold the profile fields into one line per distinct value.
 *
 * The rule that matters is the ceiling. An identity line is read **off** account rows, so
 * it cannot be worth more than the strongest of them: two `unverified` handle collisions
 * both printing `displayName: "Alex"` are one guess made twice, and printing that as a
 * confirmed fact — and then writing advice from it — is how a stranger's published email
 * ends up in a dossier handed to somebody else. Two distinct sites still corroborate; they
 * just cannot corroborate past the accounts underneath them.
 */
function buildIdentity(accounts: readonly ExportAccount[]): IdentityItem[] {
  const buckets = new Map<
    string,
    { kind: IdentityKind; value: string; sources: Set<string>; accounts: Set<string>; backing: Band }
  >()

  const record = (kind: IdentityKind, value: string | null, account: ExportAccount): void => {
    if (value === null || !value.trim()) return
    if (account.band === 'noise') return
    const id = `${kind}:${value.trim().toLowerCase()}`
    const found = buckets.get(id)
    if (found) {
      found.sources.add(account.platform)
      found.accounts.add(account.key)
      if (BAND_ORDER[account.band] < BAND_ORDER[found.backing]) found.backing = account.band
    } else {
      buckets.set(id, {
        kind,
        value: value.trim(),
        sources: new Set([account.platform]),
        accounts: new Set([account.key]),
        backing: account.band
      })
    }
  }

  for (const account of accounts) {
    const p = account.profile
    if (p === null) continue
    record('name', p.displayName, account)
    record('name', p.realName, account)
    record('place', p.location, account)
    record('work', p.company, account)
    record('age', p.joinedAt, account)
    record('contact', p.email, account)
    for (const link of p.links) record('link', link.url, account)
  }

  const out: IdentityItem[] = []
  for (const b of buckets.values()) {
    // Folded the conservative way here too, so two subdomains of one site operator cannot
    // read as two sites.
    const sources = independentSourcesOf([...b.sources])
    const two = sources.length >= 2
    let band: Band = two ? 'corroborated' : 'unverified'
    if (two && b.backing === 'confirmed') band = 'confirmed'
    band = weakerBand(band, b.backing)
    out.push({
      kind: b.kind,
      value: b.value,
      sources,
      accounts: [...b.accounts].sort(),
      band,
      backing: b.backing,
      note: IDENTITY_NOTE[b.kind]
    })
  }

  const kindOrder: IdentityKind[] = ['name', 'place', 'work', 'contact', 'link', 'age']
  return out.sort(
    (a, b) =>
      kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
      BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
      b.sources.length - a.sources.length ||
      a.value.localeCompare(b.value)
  )
}

/* ------------------------------------------------------------------ *
 * What could not be checked
 * ------------------------------------------------------------------ */

/**
 * One tool run, read back off its permanent capture.
 *
 * The unit is the **capture**, not the finding, and that is the whole point. A run that
 * failed, timed out, or was cancelled returns before `parse()` and therefore writes zero
 * findings — so enumerating runs through findings makes every unsuccessful run invisible,
 * and an invisible run is then reported to the subject under "what was never asked": a
 * heading that says in as many words that it is *not* a gap. holehe killed at its deadline
 * would be described to the person it is about as a check nobody thought to run.
 *
 * The captures are on disk regardless — the orchestrator persists them before parsing and
 * regardless of outcome — so the folder is the honest enumeration and this walks it.
 */
interface CaptureReading extends UncheckedItem {
  rawId: string
}

/** Derive the job's terminal state from what the capture itself records. */
function jobStateOf(text: string): { state: string; error: string | null; unreadable: boolean } {
  let outer: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'done', error: null, unreadable: true }
    }
    outer = parsed as Record<string, unknown>
  } catch {
    return { state: 'done', error: null, unreadable: true }
  }

  // A run that produced something parseable is written verbatim: the envelope itself, which
  // names its own adapter. Everything else is the orchestrator's wrapper, and the wrapper is
  // the one that carries the outcome.
  if (typeof outer['adapter'] === 'string') return { state: 'done', error: null, unreadable: false }

  const error = typeof outer['error'] === 'string' ? outer['error'] : null
  if (outer['ok'] === false) {
    if (outer['timedOut'] === true) return { state: 'timeout', error, unreadable: false }
    const marks = [error ?? '', typeof outer['stderr'] === 'string' ? outer['stderr'] : ''].join('\n')
    if (/\bcancell?ed\b/i.test(marks)) return { state: 'cancelled', error, unreadable: false }
    return { state: 'failed', error, unreadable: false }
  }
  return { state: 'done', error, unreadable: false }
}

function rawIdOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '')
}

function classifyCapture(
  fileName: string,
  text: string,
  claimsByRaw: ReadonlyMap<string, number>,
  toolByRaw: ReadonlyMap<string, string>
): CaptureReading | null {
  const rawId = rawIdOf(fileName)
  const env = readRawEnvelope(text)
  const tool = (env?.adapter ?? env?.adapterId ?? toolByRaw.get(rawId) ?? '').trim()
  if (!tool) return null
  const target = typeof env?.target === 'string' ? env.target : ''
  const { state, error, unreadable } = jobStateOf(text)

  if (unreadable) {
    return {
      rawId,
      tool,
      target,
      outcome: 'partial',
      detail:
        'Its output is on disk but could not be read back, so what it actually covered was not worked out. Treat it as unchecked rather than clear.',
      coverage: null
    }
  }

  const reading = readCoverage({
    adapterId: tool,
    rawText: text,
    jobState: state,
    jobError: error,
    claims: claimsByRaw.get(rawId) ?? 0
  })
  return { rawId, tool, target, outcome: reading.outcome, detail: reading.detail, coverage: reading.coverage }
}

/**
 * Checks nobody ran, and what each would have covered.
 *
 * Kept separate from the ones that ran and were refused, because they are separate facts:
 * "we asked and were told nothing" and "we never asked" fail differently and are fixed
 * differently. Which makes the membership rule the important part: a tool belongs here only
 * when **no capture of it exists in the case folder**. Deciding it from the tools that
 * produced findings files every failed run under a heading that reads "this is not a gap".
 */
const WOULD_COVER: Record<string, string> = {
  maigret: 'a sweep of a few thousand sites for the username, reading each profile it finds',
  sherlock: 'a fast plain sweep of several hundred sites for the username',
  blackbird: 'the widest site list of the three, and the only one that also takes an email address',
  holehe: 'which sites have an account registered to an email address, read out of their password-reset responses',
  theharvester: 'email addresses, hostnames and IPs published for a domain',
  subfinder: 'subdomains of a domain, from around thirty passive datasets',
  wayback: 'archived copies of pages, including ones that have since been deleted',
  'reddit-profile': 'a Reddit account’s posting hours, subreddits and vocabulary',
  'hibp-passwords': 'whether a password has appeared in a public breach corpus',
  'profile-enrich': 'the public profile behind each account: name, location, bio, picture and declared links',
  exiftool: 'the hidden metadata inside a photograph, including GPS coordinates',
  'gallery-dl': 'the files behind a gallery or profile URL, and the metadata the site attaches to them',
  'pattern-timezone': 'the time zone implied by when the accounts are active'
}

function buildNotAsked(attempted: ReadonlySet<string>, kinds: ReadonlySet<string>): { tool: string; wouldCover: string }[] {
  const relevant: [string, string[]][] = [
    ['maigret', ['username']],
    ['sherlock', ['username']],
    ['blackbird', ['username', 'email']],
    ['holehe', ['email']],
    ['theharvester', ['domain']],
    ['subfinder', ['domain']],
    ['wayback', ['domain', 'account', 'image']],
    ['profile-enrich', ['account', 'username']],
    ['exiftool', ['image']]
  ]
  const out: { tool: string; wouldCover: string }[] = []
  for (const [tool, accepts] of relevant) {
    if (attempted.has(tool)) continue
    if (!accepts.some((k) => kinds.has(k))) continue
    out.push({ tool, wouldCover: WOULD_COVER[tool] ?? 'a check this case never ran' })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * What this means for you
 * ------------------------------------------------------------------ */

/** Bands whose rows are solid enough to write an instruction from. */
function actionable(band: Band): boolean {
  return band === 'confirmed' || band === 'corroborated' || band === 'probable'
}

/**
 * Advice, ordered by how much it disconnects.
 *
 * Written to the subject and in the second person, which is a deliberate departure from
 * the operator-facing remediation in `selfaudit/report.ts`: that one is a checklist for
 * somebody who already knows what a recovery hub is. No severity scores, no colours, no
 * "CRITICAL". Reach is a count of the things an action touches and is shown as the fact it
 * is.
 *
 * It draws only on rows and lines that earned a band, and every value it names says which
 * account published it. An imperative written from an unverified row — *take this address
 * off your profiles* — is an instruction about an account that may belong to a stranger.
 */
function buildAdvice(
  accounts: readonly ExportAccount[],
  identity: readonly IdentityItem[],
  gallery: AvatarGallery,
  setAside: ReadonlySet<string>
): AdviceItem[] {
  const out: AdviceItem[] = []
  const real = accounts.filter((a) => actionable(a.band))

  const byHandle = new Map<string, Set<string>>()
  for (const a of real) {
    const set = byHandle.get(a.handle.toLowerCase())
    if (set) set.add(a.platform)
    else byHandle.set(a.handle.toLowerCase(), new Set([a.platform]))
  }
  for (const [handle, platforms] of byHandle) {
    if (platforms.size < 2) continue
    const list = [...platforms].sort()
    out.push({
      action: `Use a different username on the accounts you want kept apart. “${handle}” is the same on ${list.length} of them.`,
      because: `Anyone who finds one of these finds the rest by typing the same word into a free search tool. Right now ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''} are one search apart.`,
      reach: list.length,
      effort: 'an evening'
    })
  }

  for (const g of gallery.groups) {
    // A picture shared with an account you threw away is not a link between two of yours,
    // and a picture shared between two accounts on one site is that site serving one image
    // twice. Neither is the cross-site tie this advice is about, and saying it is would be
    // the strongest sentence in the document written from the weakest evidence in it.
    const live = g.accounts.filter((k) => !setAside.has(k))
    if (live.length < 2) continue
    if (new Set(live.map(platformOf)).size < 2) continue
    out.push({
      action: `Use a different picture on ${live.length} of your accounts — right now they share one.`,
      because: `${live.join(', ')} all show the same photograph. That is the single strongest way two accounts get tied together, and it works even when the usernames are completely different.`,
      reach: live.length,
      effort: 'minutes'
    })
  }

  const places = identity.filter((i) => i.kind === 'place' && actionable(i.backing))
  if (places.length > 0) {
    out.push({
      action: `Clear the location field on the profiles that carry one. ${places.map((p) => `“${p.value}” on ${p.accounts.join(', ')}`).join('; ')}.`,
      because:
        'A location field is a free gift to anyone deciding whether two accounts are the same person, and it is one of the few things on a profile that narrows you down to a city with no effort at all.',
      reach: places.reduce((n, p) => n + p.sources.length, 0),
      effort: 'minutes'
    })
  }

  const contacts = identity.filter((i) => i.kind === 'contact' && actionable(i.backing))
  if (contacts.length > 0) {
    out.push({
      action: `Take ${contacts.map((c) => `${c.value} off ${c.accounts.join(', ')}`).join('; ')}.`,
      because:
        'A published address is scraped by automated collectors within days, and it is also the first thing anyone tries when they want into an account: every "forgot my password" flow starts there.',
      reach: contacts.reduce((n, c) => n + c.sources.length, 0),
      effort: 'minutes'
    })
  }

  const oldest = identity
    .filter((i) => i.kind === 'age' && actionable(i.backing))
    .map((i) => ({ item: i, time: Date.parse(i.value) }))
    .filter((x) => Number.isFinite(x.time))
    .sort((a, b) => a.time - b.time)[0]
  if (oldest !== undefined) {
    out.push({
      action: 'Look at the oldest accounts first when you decide what to delete.',
      because: `The earliest one here dates to ${oldest.item.value.slice(0, 10)}. Accounts made years ago were usually made with fewer privacy settings, a name you no longer use, and a password you have reused since.`,
      reach: 1,
      effort: 'an evening'
    })
  }

  const unverified = accounts.filter((a) => a.band === 'unverified').length
  if (unverified > 0) {
    out.push({
      action: `Before you act on anything, open the ${unverified} entries marked “might be anyone” and check whether they are actually yours.`,
      because:
        'Automatic username checks are wrong a lot. A site that blocks robots often answers a check in a way that reads as “this account exists”, and short or common handles simply belong to other people. Deleting or reporting one of those does nothing for you and something to a stranger.',
      reach: unverified,
      effort: 'an evening'
    })
  }

  const effortRank: Record<AdviceItem['effort'], number> = { minutes: 0, 'an evening': 1, 'weeks of waiting': 2 }
  return out.sort((a, b) => b.reach - a.reach || effortRank[a.effort] - effortRank[b.effort])
}

/* ------------------------------------------------------------------ *
 * Everything else the case holds
 * ------------------------------------------------------------------ */

function buildOther(input: {
  findings: readonly Finding[]
  used: ReadonlySet<string>
  entities: readonly Entity[]
  removed: readonly RemovedEntity[]
}): OtherMaterial {
  const inGraph = new Set(input.entities.map((e) => e.id))
  const tombstone = new Map(input.removed.map((r) => [r.entityId, r]))

  const tools = new Map<string, number>()
  const sources = new Set<string>()
  const orphaned = new Map<string, number>()
  let count = 0

  for (const f of input.findings) {
    if (input.used.has(f.id)) continue
    count++
    if (!isDerivedSource(f.source)) {
      tools.set(f.tool, (tools.get(f.tool) ?? 0) + 1)
      for (const key of independentSourcesOf([f.source])) sources.add(key)
    }
    if (!inGraph.has(f.entityId)) orphaned.set(f.entityId, (orphaned.get(f.entityId) ?? 0) + 1)
  }

  const orphans: OtherMaterial['orphans'] = []
  for (const [id, findings] of orphaned) {
    const t = tombstone.get(id)
    orphans.push({
      kind: t?.kind ?? 'unknown',
      label: t?.label ?? t?.value ?? 'something no longer in the case',
      findings,
      why:
        t === undefined
          ? 'This was found while following something the case no longer holds. The record of what it was about was not kept.'
          : t.reason === 'renamed'
            ? 'This was about a value that has since been corrected. The observation is kept; the thing it was about was renamed.'
            : 'This was about something taken out of the case. Deleting the question does not unobserve the answer, so the finding is kept.'
    })
  }
  orphans.sort((a, b) => b.findings - a.findings || a.label.localeCompare(b.label))

  return {
    findings: count,
    tools: [...tools.entries()]
      .map(([tool, claims]) => ({ tool, claims }))
      .sort((a, b) => b.claims - a.claims || a.tool.localeCompare(b.tool)),
    sources: [...sources].sort(),
    orphans
  }
}

/* ------------------------------------------------------------------ *
 * The bundle
 * ------------------------------------------------------------------ */

export interface BundleInput {
  store: CaseStore
  caseId: string
  lang: 'bg' | 'en'
  subjectName?: string
  preparedBy?: string
  now?: () => string
}

export async function buildExportBundle(input: BundleInput): Promise<ExportBundle> {
  const caseDir = input.store.dir(input.caseId)
  const all = await input.store.readAll(input.caseId)
  const removed = await input.store.readRemovedEntities(input.caseId)
  const findings = all.findings

  // How many real claims each capture produced. A `local:` run note is the program talking
  // about itself, so a run that produced nothing but those found nothing, however many rows
  // that is. Computed before the walk so each capture is classified as it is read and no
  // capture text is held.
  const claimsByRaw = new Map<string, number>()
  const toolByRaw = new Map<string, string>()
  for (const f of findings) {
    const id = f.raw?.rawId
    if (!id) continue
    claimsByRaw.set(id, (claimsByRaw.get(id) ?? 0) + (isDerivedSource(f.source) ? 0 : 1))
    if (!toolByRaw.has(id)) toolByRaw.set(id, f.tool)
  }

  // One walk over `raw/`, feeding the gallery, the profiles and the coverage classifier.
  const readings: CaptureReading[] = []
  const harvest = await harvestAvatars(caseDir, {
    onCapture: (file, text) => {
      const reading = classifyCapture(file.name, text, claimsByRaw, toolByRaw)
      if (reading !== null) readings.push(reading)
    }
  })
  const gallery = groupAvatars(harvest)
  const profiles = profilesFromHarvest(harvest)

  const seeds = seedContextFrom(all.entities, null)
  const { rows: accounts, usedFindingIds } = buildAccounts({
    caseId: input.caseId,
    entities: all.entities,
    candidates: all.candidates,
    findings,
    profiles,
    gallery,
    seeds
  })

  const identity = buildIdentity(accounts)

  /* -------- runs: refused and failed, apart from clean negatives -------- */

  const unchecked: UncheckedItem[] = []
  const answeredNothing: UncheckedItem[] = []
  const seenReading = new Set<string>()
  for (const r of readings) {
    if (r.outcome === 'answered') continue
    const key = `${r.tool}|${r.target}|${r.outcome}|${r.detail}`
    if (seenReading.has(key)) continue
    seenReading.add(key)
    const item: UncheckedItem = {
      tool: r.tool,
      target: r.target,
      outcome: r.outcome,
      detail: r.detail,
      coverage: r.coverage
    }
    // The self-audit's rule, applied unchanged: a clean negative is a *result*. Filed under
    // a heading captioned "everything here is a gap, not a clean bill of health", it is
    // neither of those and it makes the real gaps harder to see.
    if (isSilent(r.outcome) || r.outcome === 'partial') unchecked.push(item)
    else answeredNothing.push(item)
  }
  for (const skipped of harvest.capturesSkipped) {
    unchecked.push({
      tool: toolByRaw.get(rawIdOf(skipped.name)) ?? 'a capture with no findings',
      target: '',
      outcome: 'partial',
      detail: `Its capture is ${Math.round(skipped.bytes / (1024 * 1024))} MB — too large to re-read here, so what it covered was not worked out. The file is on disk and can be read directly.`,
      coverage: null
    })
  }
  const unread = harvest.capturesTotal - harvest.capturesRead - harvest.capturesSkipped.length
  if (unread > 0) {
    unchecked.push({
      tool: `${unread} older runs`,
      target: '',
      outcome: 'skipped',
      detail: `This case holds ${harvest.capturesTotal} tool captures and only the newest ${harvest.capturesRead} were re-read for this document. The rest are on disk and unexamined here.`,
      coverage: null
    })
  }
  const order: CheckOutcome[] = ['no-answer', 'failed', 'unavailable', 'partial', 'skipped', 'answered-none', 'answered']
  const byOutcome = (a: UncheckedItem, b: UncheckedItem): number =>
    order.indexOf(a.outcome) - order.indexOf(b.outcome) || a.tool.localeCompare(b.tool)
  unchecked.sort(byOutcome)
  answeredNothing.sort(byOutcome)

  /* -------- headline counts, over what the document actually shows -------- */

  const shownSources = new Set<string>()
  for (const a of accounts) for (const key of a.sources) shownSources.add(key)

  const toolsUsed = new Map<string, number>()
  for (const f of findings) {
    if (isDerivedSource(f.source)) continue
    toolsUsed.set(f.tool, (toolsUsed.get(f.tool) ?? 0) + 1)
  }
  const kinds = new Set(all.entities.map((e) => e.kind as string))
  const attempted = new Set<string>([...toolsUsed.keys(), ...readings.map((r) => r.tool)])

  const counts: ExportBundle['counts'] = {
    confirmed: accounts.filter((a) => a.band === 'confirmed').length,
    corroborated: accounts.filter((a) => a.band === 'corroborated').length,
    probable: accounts.filter((a) => a.band === 'probable').length,
    unverified: accounts.filter((a) => a.band === 'unverified').length,
    noise: accounts.filter((a) => a.band === 'noise').length,
    pictures: gallery.groups.flatMap((g) => g.images).length + gallery.singles.length,
    // Only the sources standing behind a row this document prints. The rest are counted
    // and named in `other`, so nothing is hidden and nothing is claimed twice.
    sources: shownSources.size
  }

  const bandOf: Record<string, Band> = {}
  for (const a of accounts) bandOf[a.key] = a.band
  const setAside = new Set(accounts.filter((a) => a.band === 'noise').map((a) => a.key))

  const subjectName = (input.subjectName ?? '').trim()
  return {
    case: all.case,
    basisLine: basisLine(all.case, subjectName, input.lang),
    publishable: isPublishableBasis(all.case.basis),
    subjectName,
    preparedBy: (input.preparedBy ?? '').trim(),
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    seeds: all.entities.filter((e) => e.seed).map((e) => ({ kind: e.kind, label: e.label })),
    counts,
    accounts,
    bandOf,
    identity,
    gallery,
    unchecked,
    answeredNothing,
    notAsked: buildNotAsked(attempted, kinds),
    advice: buildAdvice(accounts, identity, gallery, setAside),
    toolsUsed: [...toolsUsed.entries()]
      .map(([tool, claims]) => ({ tool, claims }))
      .sort((a, b) => b.claims - a.claims || a.tool.localeCompare(b.tool)),
    other: buildOther({ findings, used: usedFindingIds, entities: all.entities, removed: removed.records })
  }
}

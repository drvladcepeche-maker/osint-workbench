/**
 * Ranking results against what the operator already knows.
 *
 * ## The gap this closes
 *
 * Seeds were used for **attribution** and nothing else: a seeded fact was matched against
 * text *after* the fact, to say which of the things already found could be tied to the
 * subject. They were never used to **order** what came back. So a sweep over a common
 * handle returned fifty strangers in the order the site list happened to be in, and the
 * operator had to read all fifty to find the two that were his. His words after the first
 * real run: *"It's really not using the stuff I gave it as filters."*
 *
 * ## Why this is contradiction scoring rather than match scoring
 *
 * The obvious build is "reward rows that match the seeds". That is half a scorer, and the
 * missing half is the half that does the work. Measured against a real consented run:
 *
 *  - Two profiles whose display names were unmistakably feminine, against a masculine
 *    seed. Under a match-only scorer those score **zero**, exactly like a profile with no
 *    display name at all.
 *  - Two accounts carrying a completely different Bulgarian personal name — different
 *    given name *and* different surname. Also zero, also identical to silence.
 *
 * A profile that states a different person's name is not *unmatched*. It is **positively
 * contradicted**, and it is the strongest evidence available on a row that a username
 * sweep cannot otherwise distinguish from a hit. Four of the six noise rows in that run
 * fall to this one signal.
 *
 * So every signal here is three-valued — `agrees`, `conflicts`, or it does not fire at
 * all — and **absent evidence is never treated as evidence**. A profile with no display
 * name is not suspicious; it is silent, and silent is the honest middle of the range.
 *
 * ## Three rules that outrank the arithmetic
 *
 * **1. Rank, never drop.** A contradicted row sorts to the bottom and its group can be
 * collapsed. Nothing is ever removed, and the collapsed group carries a count and the
 * reason it was collapsed, so the operator can see that four rows were set aside *for a
 * stated reason* rather than vanishing. Silent filtering is how a self-audit gives false
 * comfort, and the same failure applies to a case.
 *
 * **2. Every low row says why.** `signals[]` is the row's whole argument, in the operator's
 * own terms — "the location reads Brazil; you seeded Bulgaria", "the display name reads
 * feminine; you seeded masculine". This app's entire contract is showing the mechanism
 * rather than the verdict, and a score with no reasons attached is a verdict.
 *
 * **3. Relevance never touches `confidence`.** They are orthogonal axes and they stay in
 * separate columns. A perfectly relevant row can still be one anti-bot redirect answering
 * 200, and a `confirmed` finding about a stranger is still confirmed — it is confirmed
 * *about a stranger*. Folding one into the other would let a well-ranked guess promote
 * itself, which is the one thing the confidence ladder exists to forbid.
 *
 * ## What a location may and may not do
 *
 * A location conflict is **weak, by construction, and can never put a row in the
 * contradicted band on its own.** This is measured rather than cautious: the single best
 * hit of the operator's first real run was a Steam profile that was genuinely his, and its
 * location field named a city he has never lived in. Location fields are stale, ironic,
 * aspirational or deliberately poisoned, and poisoning them is a normal thing for a
 * privacy-aware person to do. A naive country filter would have deleted the best row in
 * the run.
 */

import { countryOfHost, countryOfPlace, countryOfPlatform, countryName, type CountryCode } from './geo'
import {
  cyrillicFormsOf,
  fold,
  hasCyrillic,
  inferGender,
  isKnownGivenName,
  looksLikeGivenName,
  matchName,
  surnameGender,
  type GenderBasis,
  type NameGender
} from './names'
import { CYRILLIC_COUNTRIES } from './geo'

/* ------------------------------------------------------------------ *
 * What the operator can tell the app about the subject
 * ------------------------------------------------------------------ */

/**
 * Age bands.
 *
 * Coarse on purpose. The operator is being asked for something he *knows* — "he's about
 * my age", "he's in his thirties" — not for a birthday he would have to look up, and a
 * band is also the only shape the evidence comes in: an account created in 2009 bounds an
 * age from below and says nothing else.
 */
export type AgeBand = 'under-18' | '18-24' | '25-34' | '35-49' | '50-plus'

export const AGE_BANDS: readonly AgeBand[] = ['under-18', '18-24', '25-34', '35-49', '50-plus'] as const

/** Inclusive bounds, in years. The open end of the last band is `Infinity`, honestly. */
export const AGE_BAND_RANGE: Record<AgeBand, { min: number; max: number }> = {
  'under-18': { min: 0, max: 17 },
  '18-24': { min: 18, max: 24 },
  '25-34': { min: 25, max: 34 },
  '35-49': { min: 35, max: 49 },
  '50-plus': { min: 50, max: Infinity }
}

export const AGE_BAND_LABEL: Record<AgeBand, string> = {
  'under-18': 'under 18',
  '18-24': '18 – 24',
  '25-34': '25 – 34',
  '35-49': '35 – 49',
  '50-plus': '50 or older'
}

/**
 * What the operator states about the subject, over and above the seed entities.
 *
 * All three are optional and all three are overrides. `gender: null` means "work it out
 * from the seeded name"; anything else means he simply knows, and knowledge beats a
 * heuristic every time. He asked for exactly this: *"From the name it should know it's a
 * male, or at least let me enter that. I could enter an age group."*
 */
export interface SubjectProfile {
  /** `null` — infer from the seeded names. Otherwise the operator's own statement. */
  gender: 'masculine' | 'feminine' | null
  ageBand: AgeBand | null
  /** ISO 3166-1 alpha-2. Empty means no country is seeded and the country signal is off. */
  countries: CountryCode[]
}

export function emptySubject(): SubjectProfile {
  return { gender: null, ageBand: null, countries: [] }
}

export function subjectIsEmpty(s: SubjectProfile | undefined | null): boolean {
  return !s || (s.gender === null && s.ageBand === null && s.countries.length === 0)
}

/**
 * Clean a subject profile arriving from the renderer, which is the app's one untrusted
 * caller. Anything unrecognised is dropped rather than corrected — a country code the app
 * cannot name would produce a conflict against every row and no way to see why.
 */
export function cleanSubject(input: unknown): SubjectProfile {
  const src = (input && typeof input === 'object' ? input : {}) as Partial<SubjectProfile>
  const gender = src.gender === 'masculine' || src.gender === 'feminine' ? src.gender : null
  const ageBand = AGE_BANDS.includes(src.ageBand as AgeBand) ? (src.ageBand as AgeBand) : null
  const countries: CountryCode[] = []
  if (Array.isArray(src.countries)) {
    for (const c of src.countries) {
      if (typeof c !== 'string') continue
      const code = c.trim().toUpperCase()
      if (/^[A-Z]{2}$/.test(code) && !countries.includes(code)) countries.push(code)
      if (countries.length >= 8) break
    }
  }
  return { gender, ageBand, countries }
}

/* ------------------------------------------------------------------ *
 * The subject, with the inference filled in
 * ------------------------------------------------------------------ */

export interface ResolvedSubject {
  gender: NameGender
  /** `operator` when he stated it; otherwise the rule `names.ts` used. */
  genderBasis: GenderBasis | 'operator'
  /** One phrase, shown next to the value so an inference never poses as a fact. */
  genderWhy: string
  ageBand: AgeBand | null
  countries: CountryCode[]
}

/**
 * Resolve the subject from the profile and the seeded names.
 *
 * The override wins outright and says so. Otherwise every seeded name is read and they
 * must agree: two seeded names that read differently produce `ambiguous`, not a coin
 * toss, because a household case seeded with a brother and a sister genuinely has no
 * single answer and guessing one would fire a gender conflict against half the rows.
 */
export function resolveSubject(
  profile: SubjectProfile | undefined | null,
  seededNames: readonly string[]
): ResolvedSubject {
  const p = profile ?? emptySubject()
  if (p.gender) {
    return {
      gender: p.gender,
      genderBasis: 'operator',
      genderWhy: 'you stated it',
      ageBand: p.ageBand,
      countries: p.countries
    }
  }
  let gender: NameGender = 'unknown'
  let basis: GenderBasis = 'none'
  let why = ''
  for (const name of seededNames) {
    const reading = inferGender(name)
    if (reading.gender === 'unknown') continue
    if (gender === 'unknown') {
      gender = reading.gender
      basis = reading.basis
      why = `inferred: ${reading.why}`
      continue
    }
    if (gender !== reading.gender) {
      gender = 'ambiguous'
      basis = reading.basis
      why = 'the seeded names do not read the same way, so nothing is assumed'
      break
    }
  }
  return { gender, genderBasis: basis, genderWhy: why, ageBand: p.ageBand, countries: p.countries }
}

/* ------------------------------------------------------------------ *
 * The seeds, in the shape the scorer needs
 * ------------------------------------------------------------------ */

export interface SeedContext {
  /** Seeded `person` values that are **the subject**, as typed. */
  names: string[]
  /**
   * Seeded `person` values marked `attrs.role: 'relative'` — somebody else's name.
   *
   * Kept out of `names` and out of the gender inference, because both treat a name as the
   * subject's. A relative's name is still a real signal, and a much weaker one: a shared
   * surname in a follower list is how an anonymous account gets tied to a household, but
   * it is not evidence that the account is *his*. Held separately so a reader can use it
   * at the weight it earns instead of at the subject's.
   */
  relatives: string[]
  /** Seeded `username` values, canonical. */
  handles: string[]
  /** Seeded `account` values — `platform/handle` the operator supplied himself. */
  accounts: string[]
  /** Seeded `location` and `organisation` values, as typed. */
  places: string[]
  /**
   * Seeded `email`, `domain`, `phone` and `ipaddr` values. High-entropy: finding one
   * written out in a result is close to the best evidence an unauthenticated lookup gets.
   */
  literals: string[]
  subject: ResolvedSubject
}

export function emptySeedContext(): SeedContext {
  return {
    names: [],
    relatives: [],
    handles: [],
    accounts: [],
    places: [],
    literals: [],
    subject: resolveSubject(null, [])
  }
}

/**
 * True when nothing has been seeded and the scorer therefore has nothing to say.
 *
 * `relatives` is deliberately not counted. A case that holds only somebody else's name has
 * nothing seeded *about the subject*, and scoring rows against a relative's name alone
 * would rank the household rather than the person.
 */
export function seedContextIsEmpty(c: SeedContext): boolean {
  return (
    c.names.length === 0 &&
    c.handles.length === 0 &&
    c.accounts.length === 0 &&
    c.places.length === 0 &&
    c.literals.length === 0 &&
    c.subject.gender === 'unknown' &&
    c.subject.ageBand === null &&
    c.subject.countries.length === 0
  )
}

/* ------------------------------------------------------------------ *
 * One row, normalised
 * ------------------------------------------------------------------ */

/**
 * The structured values a row states about its subject.
 *
 * Pulled out of claim text by `statedFields` below, or supplied directly by the caller
 * when it already has them — a `person` candidate's value *is* a display name, and going
 * through a regex to rediscover that would be silly.
 */
export interface StatedFields {
  displayNames: string[]
  locations: string[]
  /** The literal value of a site's own gender field, e.g. `male`. Not an inference. */
  genders: string[]
  countries: string[]
  /** Account creation dates or join years, as written. */
  created: string[]
  /** A stated age in years, when a row says one outright. */
  ages: number[]
}

export function emptyStatedFields(): StatedFields {
  return { displayNames: [], locations: [], genders: [], countries: [], created: [], ages: [] }
}

export interface RelevanceRow {
  /** Everything on the row a person would read: the claim, the label, the rationale. */
  text: string
  /** The finding's `source`, folded to a host by `support/sources.ts`. */
  source: string
  /** `platform/handle`'s platform half, when the row is about an account. */
  platform: string | null
  /** The handle the row is about, when it is about one. */
  handle: string | null
  /**
   * True when this row is about something the **operator supplied himself** — a seed
   * entity, or an account whose `platform/handle` he typed into the case.
   *
   * This is a different kind of fact from every other signal here and it is treated as
   * one. He gave the app a Steam profile directly and the enrichment read real data off
   * it; a row about that account is not a guess that happens to score well, it is the
   * anchor the rest of the case hangs from. Nothing demotes it, including a location that
   * disagrees — which is precisely what happened on that Steam profile.
   */
  anchored: boolean
  stated: StatedFields
}

/* ------------------------------------------------------------------ *
 * Signals
 * ------------------------------------------------------------------ */

export type RelevanceSignalId =
  | 'operator-supplied'
  | 'seed-literal'
  | 'name-match'
  | 'handle-exact'
  | 'place-match'
  | 'script-match'
  | 'gender-agrees'
  | 'age-agrees'
  | 'name-conflict'
  | 'name-shape-conflict'
  | 'gender-conflict'
  | 'age-conflict'
  | 'place-conflict'

export type SignalVerdict = 'agrees' | 'conflicts'

/**
 * How much a signal is allowed to decide.
 *
 * `anchor` is its own weight because "the operator typed this in himself" is not a strong
 * version of evidence, it is a different kind. And the band rule below turns on `strong`
 * alone: **only a strong conflict can put a row in the contradicted band.** That is what
 * makes "a location never sinks a row" a structural guarantee rather than a consequence of
 * whichever numbers happen to be in the table.
 */
export type SignalWeight = 'anchor' | 'strong' | 'moderate' | 'weak'

export interface RelevanceSignal {
  id: RelevanceSignalId
  verdict: SignalVerdict
  weight: SignalWeight
  /** Contribution to the score, signed. Kept per signal so the sum is auditable. */
  points: number
  /** One sentence in the operator's terms. This is what the row shows him. */
  detail: string
}

/**
 * Points per signal.
 *
 * An ordering with arithmetic attached, never a probability — the same disclaimer the
 * pivot scorer carries, for the same reason. Every term is shown, so the operator can
 * disagree with the total instead of having to trust it.
 *
 * The two strong negatives are deliberately larger than any single positive except the
 * anchor. A profile stating a different person's name outweighs the handle matching,
 * because the handle matching is the very thing that put the row in front of him.
 */
export const RELEVANCE_POINTS: Record<RelevanceSignalId, number> = {
  'operator-supplied': 55,
  'seed-literal': 40,
  'name-match': 34,
  'handle-exact': 12,
  'place-match': 10,
  'script-match': 4,
  'gender-agrees': 8,
  'age-agrees': 6,
  'name-conflict': -40,
  'name-shape-conflict': -16,
  'gender-conflict': -34,
  'age-conflict': -18,
  'place-conflict': -8
}

/**
 * Two or three words per signal, for the row itself.
 *
 * A findings row is 30px and the claim is what the operator came to read, so the reason
 * cannot be a sentence there — a sentence would either wrap the row or squeeze the claim
 * to nothing, and both are worse than a tag. The tag names the *kind* of disagreement; the
 * whole sentence is one hover away and is written out in full in the margin panel and in
 * the collapsed group's summary. Nothing is hidden, it is just not all on the row.
 */
export const RELEVANCE_SHORT: Record<RelevanceSignalId, string> = {
  'operator-supplied': 'you added this',
  'seed-literal': 'seeded value',
  'name-match': 'name matches',
  'handle-exact': 'exact handle',
  'place-match': 'place matches',
  'script-match': 'same script',
  'gender-agrees': 'gender agrees',
  'age-agrees': 'age fits',
  'name-conflict': 'different name',
  'name-shape-conflict': 'unrelated name?',
  'gender-conflict': 'gender differs',
  'age-conflict': 'age differs',
  'place-conflict': 'country differs'
}

export const RELEVANCE_WEIGHT: Record<RelevanceSignalId, SignalWeight> = {
  'operator-supplied': 'anchor',
  'seed-literal': 'strong',
  'name-match': 'strong',
  'handle-exact': 'moderate',
  'place-match': 'moderate',
  'script-match': 'weak',
  'gender-agrees': 'moderate',
  'age-agrees': 'weak',
  'name-conflict': 'strong',
  'name-shape-conflict': 'moderate',
  'gender-conflict': 'strong',
  'age-conflict': 'moderate',
  'place-conflict': 'weak'
}

/* ------------------------------------------------------------------ *
 * The assessment
 * ------------------------------------------------------------------ */

export type RelevanceBand = 'anchor' | 'supported' | 'silent' | 'questioned' | 'contradicted'

export const RELEVANCE_BANDS: readonly RelevanceBand[] = [
  'anchor',
  'supported',
  'silent',
  'questioned',
  'contradicted'
] as const

export const RELEVANCE_BAND_LABEL: Record<RelevanceBand, string> = {
  anchor: 'You supplied this',
  supported: 'Something matches your seeds',
  silent: 'Nothing either way',
  questioned: 'Something disagrees, but not decisively',
  contradicted: 'Contradicts your seeds'
}

export const RELEVANCE_BAND_MEANING: Record<RelevanceBand, string> = {
  anchor:
    'This row is about something you typed into the case yourself. It is the anchor the rest of the case hangs from, and nothing here demotes it — including a location field that disagrees with you, which is a normal thing for a real profile to carry.',
  supported:
    'At least one thing you seeded is present on this row: the name, an address, a place, or the gender the name reads as. Present, not proven — a shared city is a coincidence tens of thousands of people share.',
  silent:
    'Nothing on this row either matches or contradicts what you gave the app. This is the honest middle and it is where most of a username sweep correctly sits: a handle exists somewhere and the site said nothing else about who holds it.',
  questioned:
    'Something on this row disagrees with your seeds, and it is the kind of thing that is wrong often enough on real profiles to be worth noticing and not worth acting on: a location field, an account older than the age you gave, a name that merely looks like a name. It sorts below the silent rows and stays in the list. The best hit of a real run sat here — a profile that genuinely belonged to the subject, with a location field naming a city he has never lived in.',
  contradicted:
    'This row states something that disagrees with your seeds — a different personal name, or a gender the seeded name does not read as. That is evidence against, not merely missing evidence. Kept and shown, never deleted: the seed could be the thing that is wrong.'
}

/**
 * The neutral score of a row that says nothing either way.
 *
 * Mid-range rather than zero, so the two directions are legible on the same scale: a row
 * below this has something arguing against it and a row above has something arguing for
 * it. A scale where silence is zero would render "no evidence" and "evidence against" as
 * neighbours.
 */
export const RELEVANCE_BASE = 40

export interface RelevanceAssessment {
  /** 0..100. An ordering, not a probability. `RELEVANCE_BASE` is "nothing either way". */
  score: number
  band: RelevanceBand
  signals: RelevanceSignal[]
  /**
   * The first conflict's full sentence, for the hover and the margin. Null when nothing
   * conflicts.
   */
  why: string | null
  /** The same conflict in two or three words, for the row itself. Null when none. */
  whyShort: string | null
}

/** A row nothing has been seeded against. Scored as silence, and honestly labelled. */
export function unscored(): RelevanceAssessment {
  return { score: RELEVANCE_BASE, band: 'silent', signals: [], why: null, whyShort: null }
}

/* ------------------------------------------------------------------ *
 * Reading structured values out of a claim
 * ------------------------------------------------------------------ */

/**
 * Pull the fields a claim states about its subject out of the claim's text.
 *
 * These patterns are this application's **own** claim templates — `maigret.ts`'s
 * `ID_FIELDS` and `profile-enrich.ts`'s `PROFILE_FIELDS` both write
 * `… shows the display name "X" on this profile.` — so this is parsing text the repository
 * itself produced rather than guessing at arbitrary English. A test asserts the templates
 * and these patterns still agree, which is what keeps a reworded claim from silently
 * switching the strongest negative signal off.
 *
 * A claim that states nothing yields nothing, and that is the common case. Absence here
 * means the row is silent, never that it is suspect.
 */
export function statedFields(text: string): StatedFields {
  const out = emptyStatedFields()
  const push = (list: string[], v: string | undefined): void => {
    const s = (v ?? '').trim()
    if (s && s.length <= 120 && !list.includes(s)) list.push(s)
  }

  for (const m of text.matchAll(/\bdisplay name "([^"]{1,120})"/gi)) push(out.displayNames, m[1])
  for (const m of text.matchAll(/carries "([^"]{1,120})" in the profile's separate real-name field/gi))
    push(out.displayNames, m[1])
  for (const m of text.matchAll(/\bexposes "(?:full ?name|name|real ?name|display ?name)" for this account:\s*([^\n]{1,120})/gi))
    push(out.displayNames, m[1])

  for (const m of text.matchAll(/\blocation "([^"]{1,120})"/gi)) push(out.locations, m[1])
  for (const m of text.matchAll(/\bexposes "(?:location|city|place|country)" for this account:\s*([^\n]{1,120})/gi))
    push(out.locations, m[1])

  for (const m of text.matchAll(/\bgender "([^"]{1,40})"/gi)) push(out.genders, m[1])
  for (const m of text.matchAll(/\bcountry "([^"]{1,80})"/gi)) push(out.countries, m[1])

  for (const m of text.matchAll(/account was created (?:at|on)\s+([0-9][^\s.,;]*)/gi))
    push(out.created, m[1])
  for (const m of text.matchAll(/\bjoined\s+(?:in\s+)?((?:19|20)\d\d)/gi)) push(out.created, m[1])

  for (const m of text.matchAll(/\b(\d{1,2})\s*(?:years old|yo\b|y\/o\b)/gi)) {
    const n = Number(m[1])
    if (n >= 5 && n <= 110 && !out.ages.includes(n)) out.ages.push(n)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/**
 * Whole-value containment, folded and on Unicode boundaries.
 *
 * The same rule `selfaudit/match.ts` enforces for its literal path, restated here because
 * that module lives under `src/main` and this one has to run in the renderer. Four
 * characters is the floor there and here: under four, a match is noise.
 */
function containsWhole(haystackFolded: string, needle: string): boolean {
  const n = fold(needle.trim())
  if (n.length < 4) return false
  for (let from = 0; ; ) {
    const at = haystackFolded.indexOf(n, from)
    if (at < 0) return false
    const before = at > 0 ? haystackFolded[at - 1] : undefined
    const after = haystackFolded[at + n.length]
    const boundary = (c: string | undefined): boolean => c === undefined || !LETTER_OR_DIGIT.test(c)
    if (boundary(before) && boundary(after)) return true
    from = at + n.length
  }
}

/**
 * Does this string read as a person's name, and how confidently?
 *
 * `recognised` — at least one token is a given name the tables know, or a surname that
 * inflects. This is what licenses the **strong** negative, and it is why the signal fires
 * cleanly on Bulgarian material: a different Bulgarian name is recognisable as a name
 * with near-certainty, and every token of it is checkable.
 *
 * `shaped` — two or more capitalised alphabetic tokens and nothing recognisable in them.
 * `Marco Migozzi` lands here. It licenses only a **moderate** negative, because a display
 * name of that shape is also how band names, in-jokes and game handles are written.
 */
function readsAsName(value: string): 'recognised' | 'shaped' | 'no' {
  const tokens = value.trim().split(/[^\p{L}\p{N}'’-]+/u).filter((t) => t.length > 1)
  if (!tokens.length) return 'no'
  for (const t of tokens) {
    if (looksLikeGivenName(t)) return 'recognised'
    if (surnameGender(t).gender !== 'unknown') return 'recognised'
  }
  const capitalised = tokens.filter(
    (t) => /^\p{Lu}/u.test(t) && /^[\p{L}'’-]+$/u.test(t) && t.length >= 3
  )
  return capitalised.length >= 2 ? 'shaped' : 'no'
}

/** The gender a site's own gender field states. Never an inference. */
function statedGenderValue(v: string): NameGender {
  const s = fold(v.trim())
  if (['m', 'male', 'man', 'men', 'мъж', 'мъжки', 'муж'].includes(s)) return 'masculine'
  if (['f', 'female', 'woman', 'women', 'жена', 'женски'].includes(s)) return 'feminine'
  return 'unknown'
}

/** The year in a written creation date, or null. */
function yearOf(written: string): number | null {
  const m = /((?:19|20)\d\d)/.exec(written)
  if (!m) return null
  const y = Number(m[1])
  return y >= 1990 && y <= 2100 ? y : null
}

/**
 * The minimum age an account of this vintage implies for its holder.
 *
 * Every platform this app touches requires thirteen at sign-up, so an account opened in
 * 2009 belongs to somebody who is at least thirteen plus the years since. That is a bound,
 * not an estimate, and it is the only age evidence a public profile reliably carries.
 * It bounds from **below only**: an account opened last week says nothing about an upper
 * limit, so a recent join date never conflicts with anything.
 */
const MIN_SIGNUP_AGE = 13

export function minimumAgeFromJoinYear(joinYear: number, thisYear: number): number {
  return MIN_SIGNUP_AGE + Math.max(0, thisYear - joinYear)
}

/* ------------------------------------------------------------------ *
 * The scorer
 * ------------------------------------------------------------------ */

export interface ScoreOptions {
  /** Injected so the age rule is testable and deterministic. Defaults to the real year. */
  year?: number
}

/**
 * Score one row against the seeds.
 *
 * Pure, and deliberately cheap: a case with two thousand findings is re-scored on every
 * seed edit, and a scorer that had to be scheduled would end up cached, and a cache would
 * end up stale.
 */
export function assessRelevance(
  row: RelevanceRow,
  seeds: SeedContext,
  options: ScoreOptions = {}
): RelevanceAssessment {
  if (seedContextIsEmpty(seeds)) return unscored()

  const year = options.year ?? new Date().getUTCFullYear()
  const signals: RelevanceSignal[] = []
  const add = (id: RelevanceSignalId, verdict: SignalVerdict, detail: string): void => {
    signals.push({
      id,
      verdict,
      weight: RELEVANCE_WEIGHT[id],
      points: RELEVANCE_POINTS[id],
      detail
    })
  }

  const folded = fold(row.text)

  /* --- the anchor ------------------------------------------------------- */

  if (row.anchored) {
    add(
      'operator-supplied',
      'agrees',
      'You supplied this to the case yourself, so it is a starting point rather than a guess.'
    )
  }

  /* --- high-entropy literals -------------------------------------------- */

  for (const literal of seeds.literals) {
    if (!containsWhole(folded, literal)) continue
    add(
      'seed-literal',
      'agrees',
      `The row contains ${literal}, which you seeded. An address, a number or a domain is close to unique to one person.`
    )
    break
  }

  /* --- the name ---------------------------------------------------------- */

  const statedNames = row.stated.displayNames
  const seededHandles = new Set(seeds.handles.map((h) => fold(h)))
  let nameAgreed = false
  for (const seed of seeds.names) {
    // The whole row text, not just the display name: a real name printed anywhere on a
    // profile is worth the same as one printed in the name field.
    const hit = matchName(seed, row.text)
    if (!hit) continue
    // ...except when what matched *is* the handle the sweep was run on. `krisi` is a
    // transliterated short form of `Кристиян`, so on a case seeded with both it matches
    // every row a maigret sweep produced — the handle appears in every claim. Counting
    // that would be the scorer rewarding a row for the very reason the row is in front of
    // him, and it would rank all fifty strangers identically. It is not evidence; it is
    // the query.
    if (seededHandles.has(fold(hit.matched))) continue
    nameAgreed = true
    const weight: SignalWeight =
      hit.strength === 'strong' ? 'strong' : hit.strength === 'moderate' ? 'moderate' : 'weak'
    const points =
      hit.strength === 'strong'
        ? RELEVANCE_POINTS['name-match']
        : hit.strength === 'moderate'
          ? 18
          : 6
    // Scaled by the matcher's own strength rather than taken flat: an exact full name is
    // near-decisive and a bare diminutive collision is nearly nothing, and `names.ts`
    // already priced that difference. Flattening it here would throw the pricing away.
    signals.push({
      id: 'name-match',
      verdict: 'agrees',
      weight,
      points,
      detail: `The row carries your seeded name — ${hit.why}. Match strength: ${hit.strength}.`
    })
    break
  }

  if (!nameAgreed && statedNames.length > 0 && seeds.names.length > 0) {
    for (const stated of statedNames) {
      const reads = readsAsName(stated)
      if (reads === 'no') continue
      const matchesSomeSeed = seeds.names.some((seed) => matchName(seed, stated) !== null)
      if (matchesSomeSeed) continue
      if (reads === 'recognised') {
        add(
          'name-conflict',
          'conflicts',
          `The display name is "${stated}" — a different personal name from the one you seeded. That is evidence against this row, not missing evidence.`
        )
      } else {
        add(
          'name-shape-conflict',
          'conflicts',
          `The display name is "${stated}", which reads like somebody's name and is not a form of the name you seeded. It could also be a band, a joke or a handle, so this counts for less than a name the app recognises.`
        )
      }
      break
    }
  }

  /* --- the handle -------------------------------------------------------- */

  if (row.handle && seeds.handles.length > 0) {
    const h = fold(row.handle)
    if (seeds.handles.some((s) => fold(s) === h)) {
      add(
        'handle-exact',
        'agrees',
        `The handle is exactly one you seeded. A handle is why this row is in front of you, so on its own it argues very little.`
      )
    }
  }

  /* --- gender ------------------------------------------------------------ */

  const subjectGender = seeds.subject.gender
  if (subjectGender === 'masculine' || subjectGender === 'feminine') {
    const reading = rowGender(row)
    if (reading.gender === 'masculine' || reading.gender === 'feminine') {
      if (reading.gender === subjectGender) {
        // Capitalised like every other detail: these are rendered as a list of sentences
        // in the margin, and one of them starting lowercase reads as a fragment.
        add(
          'gender-agrees',
          'agrees',
          `${capitalise(reading.why)}, which agrees with the subject you described.`
        )
      } else {
        add(
          'gender-conflict',
          'conflicts',
          `${capitalise(reading.why)}, and the subject reads ${subjectGender} (${seeds.subject.genderWhy}).`
        )
      }
    }
  }

  /* --- place ------------------------------------------------------------- */

  const seededPlaceHit = seeds.places.find((p) => containsWhole(folded, p))
  if (seededPlaceHit) {
    add(
      'place-match',
      'agrees',
      `The row names ${seededPlaceHit}, which you seeded. Self-reported and shared by everyone else who lives there.`
    )
  }

  if (seeds.subject.countries.length > 0) {
    const found = rowCountries(row)
    if (found.length > 0) {
      const shared = found.filter((c) => seeds.subject.countries.includes(c.code))
      if (shared.length > 0) {
        add(
          'place-match',
          'agrees',
          `${capitalise(shared[0]!.why)}, which is a country you seeded.`
        )
      } else if (!seededPlaceHit) {
        const first = found[0]!
        add(
          'place-conflict',
          'conflicts',
          `${capitalise(first.why)}; you seeded ${seeds.subject.countries.map(countryName).join(' or ')}. A location field is stale, ironic or wrong often enough that this can never sink a row on its own.`
        )
      }
    } else if (hasCyrillic(row.text) && seeds.subject.countries.every((c) => CYRILLIC_COUNTRIES.includes(c))) {
      add(
        'script-match',
        'agrees',
        'The row is written in Cyrillic, as the region you seeded writes. That narrows the world to about a dozen countries and no further.'
      )
    }
  }

  /* --- age --------------------------------------------------------------- */

  const band = seeds.subject.ageBand
  if (band) {
    const range = AGE_BAND_RANGE[band]
    for (const stated of row.stated.ages) {
      if (stated >= range.min && stated <= range.max) {
        add('age-agrees', 'agrees', `The row states an age of ${stated}, inside the band you seeded.`)
      } else {
        add(
          'age-conflict',
          'conflicts',
          `The row states an age of ${stated}; you seeded ${AGE_BAND_LABEL[band]}.`
        )
      }
      break
    }
    if (!row.stated.ages.length) {
      for (const written of row.stated.created) {
        const y = yearOf(written)
        if (y === null) continue
        const minAge = minimumAgeFromJoinYear(y, year)
        if (minAge > range.max) {
          add(
            'age-conflict',
            'conflicts',
            `The account dates from ${y}. Every one of these platforms requires 13 at sign-up, so its holder is at least ${minAge} — and you seeded ${AGE_BAND_LABEL[band]}.`
          )
        } else if (minAge >= range.min) {
          add(
            'age-agrees',
            'agrees',
            `The account dates from ${y}, which puts its holder at ${minAge} or older — consistent with ${AGE_BAND_LABEL[band]}.`
          )
        }
        break
      }
    }
  }

  /* --- the total --------------------------------------------------------- */

  const sum = signals.reduce((n, s) => n + s.points, 0)
  const score = Math.max(0, Math.min(100, RELEVANCE_BASE + sum))
  const firstConflict = signals.find((s) => s.verdict === 'conflicts')

  return {
    score,
    band: bandOf(signals),
    signals,
    why: firstConflict?.detail ?? null,
    whyShort: firstConflict ? RELEVANCE_SHORT[firstConflict.id] : null
  }
}

/**
 * The band, decided by the *kinds* of signal present rather than by the score.
 *
 * This is where the two rules that outrank the arithmetic are actually enforced:
 *
 *  - An anchor is an anchor. Nothing demotes a row about something the operator typed in
 *    himself, whatever else fired.
 *  - Only a **strong** conflict produces `contradicted`. A location disagreeing is weak
 *    and a name of the right *shape* is moderate, so neither can put a row in the bottom
 *    group alone. They land it in `questioned` instead, which sorts below silence, states
 *    its reason, and is never collapsed away.
 */
export function bandOf(signals: readonly RelevanceSignal[]): RelevanceBand {
  if (signals.some((s) => s.weight === 'anchor')) return 'anchor'
  if (signals.some((s) => s.verdict === 'conflicts' && s.weight === 'strong')) return 'contradicted'
  const agreed = signals.filter((s) => s.verdict === 'agrees')
  if (agreed.some((s) => s.weight === 'strong' || s.weight === 'moderate')) return 'supported'
  // A row with a location that disagrees is not "nothing either way", and labelling it
  // that while showing it a negative number would be the interface arguing with itself.
  // It gets its own band, below silence and above contradiction, and the band's meaning
  // says out loud that nothing in it is decisive.
  if (signals.some((s) => s.verdict === 'conflicts')) return 'questioned'
  return 'silent'
}

/* ------------------------------------------------------------------ *
 * Two claims, against each other
 * ------------------------------------------------------------------ */

/**
 * Read one claim as if it were the seeds, so the scorer above can be pointed at another
 * claim instead of at the case.
 *
 * Only the fields that can produce a **strong** conflict are carried over: the personal
 * names a claim states, and a gender field it states outright. A stated age and a location
 * are deliberately left out — `RELEVANCE_WEIGHT` prices both below `strong`, so they cannot
 * reach the `contradicted` band, and reading them in here would imply they could.
 */
function claimAsSeeds(claim: string): SeedContext {
  const stated = statedFields(claim)
  let gender: 'masculine' | 'feminine' | null = null
  for (const g of stated.genders) {
    const v = statedGenderValue(g)
    if (v === 'masculine' || v === 'feminine') {
      gender = v
      break
    }
  }
  return {
    names: stated.displayNames,
    // A claim read as a seed set says nothing about whose relative anybody is.
    relatives: [],
    handles: [],
    accounts: [],
    places: [],
    literals: [],
    subject: resolveSubject({ gender, ageBand: null, countries: [] }, stated.displayNames)
  }
}

function contradictsOneWay(seedClaim: string, rowClaim: string, options: ScoreOptions): string | null {
  const seeds = claimAsSeeds(seedClaim)
  if (seedContextIsEmpty(seeds)) return null
  const assessment = assessRelevance(
    {
      text: rowClaim,
      source: '',
      platform: null,
      handle: null,
      anchored: false,
      stated: statedFields(rowClaim)
    },
    seeds,
    options
  )
  if (assessment.band !== 'contradicted') return null
  const strong = assessment.signals.find((s) => s.verdict === 'conflicts' && s.weight === 'strong')
  return strong?.detail ?? assessment.why ?? 'the two claims state different things about who this is'
}

/**
 * Do these two claims assert incompatible things about the same subject?
 *
 * Returns the sentence explaining the disagreement, or `null` when there is none. This is
 * the scorer above with one claim standing in for the seeds — not a second scorer — so
 * "contradicted" means here exactly what it means on a findings row: a different personal
 * name, or a gender the other side's name does not read as. Everything softer stays out,
 * because a location field disagreeing is normal on real profiles and must not be able to
 * block a promotion.
 *
 * Symmetric on purpose. Which claim is "the finding" and which is "the support" is an
 * accident of what the operator clicked, and a disagreement is a property of the pair.
 *
 * **Silence is not disagreement.** A claim that states nothing about who holds an account —
 * which is most of a username sweep — contradicts nothing, and two such claims corroborate
 * each other exactly as they did before.
 */
export function claimsContradict(a: string, b: string, options: ScoreOptions = {}): string | null {
  return contradictsOneWay(a, b, options) ?? contradictsOneWay(b, a, options)
}

/**
 * Sentence-case a reason, unless it opens with a literal.
 *
 * `rowCountries` builds its reasons from whatever named the country, and one of those is a
 * platform's own host — so the naive version wrote "Vk.com is used almost only in one
 * country". A hostname is a value, not a word, and capitalising it makes the app look like
 * it does not know the difference. A leading token holding a dot is left exactly as the
 * site spells it.
 */
function capitalise(s: string): string {
  const firstWord = s.split(/\s/, 1)[0] ?? ''
  if (firstWord.includes('.')) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * What gender a row reads as, and by what route.
 *
 * A site's own gender field wins outright — that is a value the account holder set, not an
 * inference off a string — and the display name is read only when there is no such field.
 */
function rowGender(row: RelevanceRow): { gender: NameGender; why: string } {
  for (const stated of row.stated.genders) {
    const g = statedGenderValue(stated)
    if (g === 'masculine' || g === 'feminine') {
      return { gender: g, why: `the site's own gender field says "${stated}"` }
    }
  }
  for (const name of row.stated.displayNames) {
    const reading = inferGender(name)
    if (reading.gender === 'masculine' || reading.gender === 'feminine') {
      return { gender: reading.gender, why: `the display name reads ${reading.gender} — ${reading.why}` }
    }
  }
  return { gender: 'unknown', why: '' }
}

/** Every country the row implies, with the route that implied it. Strongest first. */
function rowCountries(row: RelevanceRow): { code: CountryCode; why: string }[] {
  const out: { code: CountryCode; why: string }[] = []
  const seen = new Set<string>()
  const push = (code: CountryCode | null, why: string): void => {
    if (!code || seen.has(code)) return
    seen.add(code)
    out.push({ code, why })
  }
  for (const stated of row.stated.countries) {
    push(countryOfPlace(stated), `the profile's country field reads ${stated}`)
  }
  for (const stated of row.stated.locations) {
    push(countryOfPlace(stated), `the location field reads ${stated}`)
  }
  if (row.platform) push(countryOfPlatform(row.platform), `${row.platform} is used almost only in one country`)
  push(countryOfHost(row.source), `the site ${row.source} sits on a national domain`)
  return out
}

/* ------------------------------------------------------------------ *
 * Telling the operator when the technique itself is the problem
 * ------------------------------------------------------------------ */

/**
 * Ordinary English words that are also ordinary handles.
 *
 * Short and unglamorous on purpose: this list only has to be right about the handles
 * people actually pick, and every entry it misses is caught by the length rule or the
 * given-name rule below it.
 */
const COMMON_WORDS = new Set([
  'admin', 'test', 'user', 'guest', 'root', 'info', 'mail', 'news', 'shop', 'blog', 'home',
  'game', 'games', 'gamer', 'play', 'player', 'music', 'video', 'photo', 'art', 'dev',
  'code', 'data', 'link', 'love', 'life', 'cool', 'dark', 'red', 'blue', 'star', 'moon',
  'sun', 'fire', 'ice', 'king', 'queen', 'boss', 'pro', 'max', 'one', 'two', 'new', 'old',
  'big', 'small', 'fast', 'slow', 'good', 'bad', 'best', 'top', 'god', 'ninja', 'wolf',
  'bear', 'cat', 'dog', 'fox', 'bird', 'fish', 'tree', 'rock', 'sky', 'sea', 'rain', 'snow'
])

export type CommonalityReason =
  | 'short'
  | 'dictionary-word'
  | 'given-name'
  | 'contradicted-results'

export interface HandleAdvice {
  handle: string
  reasons: { id: CommonalityReason; detail: string }[]
  /** How many of the scored rows for this handle came back contradicted. */
  contradicted: number
  scored: number
}

/**
 * Whether a handle reads as somebody's name — formal or short form, in either script.
 *
 * Deliberately **looser** than `looksLikeGivenName`, which gates the strongest negative
 * signal and must not over-fire. This gates a paragraph of advice: over-firing costs the
 * operator one sentence he already knew, while missing costs him the explanation for why
 * his run came back useless. `krisi`, `chris`, `max` and `sasha` all belong here, and none
 * of them is a formal name in the tables.
 */
function handleReadsAsName(bare: string): boolean {
  if (isKnownGivenName(bare)) return true
  return cyrillicFormsOf(bare).some((form) => isKnownGivenName(form))
}

/** Under this, a handle is short enough that collisions are the norm rather than a fluke. */
export const SHORT_HANDLE_LENGTH = 7

/**
 * How much of a run has to come back contradicted before the *run* is the evidence.
 *
 * A quarter, and at least eight rows. Below that it is ordinary noise; above it, the
 * pattern is the finding — the handle is being used by several different people and no
 * amount of ranking turns that into an answer.
 */
const CONTRADICTED_SHARE = 0.25
const CONTRADICTED_FLOOR = 8

/**
 * Whether a handle is common enough that enumeration is the wrong technique on it, and
 * what the better move is.
 *
 * This exists because the operator's first real run produced almost nothing usable and the
 * honest explanation is **not** a bug in this build: username enumeration on a common
 * handle is low-yield as a property of the technique. Fifty people share the handle, the
 * probe cannot tell them apart, and no scorer can invent the distinguishing evidence that
 * was never fetched. Telling him that — beside the results, at the moment he is reading
 * them — is worth more than another point of precision, and leaving him to conclude the
 * tool is broken is the worst of the available outcomes.
 *
 * Returns null when nothing about the handle is remarkable. Silence is the default.
 */
export function handleAdvice(
  handle: string,
  rows: readonly RelevanceAssessment[]
): HandleAdvice | null {
  const h = handle.trim()
  if (!h) return null
  const reasons: HandleAdvice['reasons'] = []
  const bare = fold(h).replace(/[^\p{L}\p{N}]/gu, '')

  if (bare.length > 0 && bare.length < SHORT_HANDLE_LENGTH) {
    reasons.push({
      id: 'short',
      detail: `"${h}" is ${bare.length} characters. Short handles were taken early on every platform and are taken by different people on each of them.`
    })
  }
  if (COMMON_WORDS.has(bare)) {
    reasons.push({
      id: 'dictionary-word',
      detail: `"${h}" is an ordinary word, so a hit means somebody used that word, not that they are your subject.`
    })
  }
  if (handleReadsAsName(bare)) {
    reasons.push({
      id: 'given-name',
      detail: `"${h}" is a given name or a short form of one. Every platform has one of these for someone, and they are almost never the same person.`
    })
  }

  const contradicted = rows.filter((r) => r.band === 'contradicted').length
  const scored = rows.length
  if (
    scored >= CONTRADICTED_FLOOR &&
    contradicted / scored >= CONTRADICTED_SHARE
  ) {
    reasons.push({
      id: 'contradicted-results',
      detail: `${contradicted} of ${scored} results state a name or a gender that contradicts your seeds. Several different people are using this handle.`
    })
  }

  if (!reasons.length) return null
  return { handle: h, reasons, contradicted, scored }
}

/**
 * The move that actually works, when the handle does not.
 *
 * Deliberately concrete rather than encouraging. Starting from noise produces noise, and
 * the way out is not a better sweep — it is a different starting point: one identifier the
 * operator is already *certain* belongs to the subject, pivoted outward. A profile URL he
 * was sent. A Discord snowflake. An account the subject linked to himself.
 */
export const PIVOT_FROM_UNIQUE_ADVICE = [
  'Start from something you are already certain of rather than from a name several people share: a profile URL the subject gave you, a Discord user id, an account he has linked to from another one.',
  'Add it to the case as a seed, run the profile enrichment against it, and pivot outward from the links and names on that page. One certain account is worth more than fifty handle collisions.',
  'The sweep is not wasted — keep it. It is the list you check pivoted candidates against, rather than the list you read top to bottom.'
] as const

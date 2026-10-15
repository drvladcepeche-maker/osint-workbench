/**
 * Username pivoting — the vocabulary shared by the engine and the review queue.
 *
 * The question this answers is the one the operator asked out loud: *"if I run one of my
 * usernames and it finds an account which has a different username, can it search that and
 * see if it's related? It's probably gonna find many other names which aren't mine, but
 * perhaps it can somehow deduce whether it's mine."* That is username pivoting, and it is
 * the central technique in identity resolution: a profile is not only an account, it is a
 * page carrying pointers to other accounts — a handle in a bio, a link in a sidebar, a
 * display name that is itself a handle somewhere else.
 *
 * Two rules are baked into the shape of these types, not left to the code that fills them.
 *
 * **A pivot is a hypothesis, and it says so.** There is no boolean anywhere here. A
 * `PivotAssessment` carries a band, a score and the individual signals that produced it,
 * because the operator has to be able to disagree with the arithmetic. `handle-only` is a
 * real, common and correct outcome: `exampleuser` on Roblox is very likely a different person,
 * and the type has a way to say exactly that.
 *
 * **What could not be checked is recorded as loudly as what was.** `unevaluated` exists so
 * that "the avatar did not match" and "the avatar could not be fetched" never render the
 * same. A self-audit that shows a missing signal as an absent one gives false comfort,
 * which is worse than giving none — the same rule the check outcomes in `selfaudit.ts`
 * turn on.
 */

export type PivotSignalId =
  /** Two profiles link to each other. The subject asserted the connection themselves. */
  | 'reciprocal-link'
  /** One profile links to the other, and the other was not readable to check the reverse. */
  | 'outbound-link'
  /** Byte-identical avatar: the same file, not merely the same picture. */
  | 'avatar-bytes'
  /** Perceptually identical avatar across a re-encode or a resize. */
  | 'avatar-hash'
  /** A distinctive phrase shared by two bios. Not common words. */
  | 'bio-phrase'
  /** The same display name on both profiles. */
  | 'display-name'
  /** The profile carries a name the operator seeded as his own. */
  | 'seeded-name'
  /** The profile carries a city the operator seeded. */
  | 'seeded-city'
  /** The handle is a near-variant of one already known — `foo` and `foo_dev`. */
  | 'handle-shape'

export type PivotStrength = 'decisive' | 'strong' | 'moderate' | 'weak'

export interface PivotSignal {
  id: PivotSignalId
  strength: PivotStrength
  /** Contribution to the score. Kept per signal so the sum is auditable rather than magic. */
  points: number
  /** One sentence naming the actual evidence: the phrase, the URL, the Hamming distance. */
  detail: string
}

/**
 * A signal that was attempted and could not be decided.
 *
 * Nearly always the avatar: the picture could not be fetched, the site refused, the format
 * could not be decoded outside Electron, or both accounts are wearing the platform's
 * default. A default avatar matching a default avatar means nothing at all, and treating
 * it as a match would fire the strongest signal in the set on the weakest possible
 * evidence.
 */
export interface PivotGap {
  id: PivotSignalId
  why: string
}

export type PivotBand =
  /** A reciprocal link fired. The person said so themselves; nothing else beats it. */
  | 'asserted'
  | 'strong'
  | 'moderate'
  | 'weak'
  /** Nothing fired but the handle. This is the common case and it is not a failure. */
  | 'handle-only'

export interface PivotAssessment {
  /** `platform/handle` when the platform is known, otherwise the bare handle. */
  target: string
  /** The handle on its own, canonical (lowercase). */
  handle: string
  /** Site the account is on, folded to its operator, or `''` when only a handle is known. */
  platform: string
  /** `platform/handle` of the profile this was pivoted *from*. */
  from: string
  /** Site that carried the pointer — the `source` of the observation finding. */
  fromSource: string
  /** How the handle was found: a bio mention, a linked URL, a display name, a tool's own list. */
  via: string
  /** Username-to-username jumps away from a seed. 1 is "found on a seed's own profile". */
  hops: number
  /** 0..100, the sum of the signals' points, capped. */
  score: number
  band: PivotBand
  signals: PivotSignal[]
  unevaluated: PivotGap[]
  /** URL of the pivoted-to profile, when one was observed. */
  url: string | null
}

export const PIVOT_BAND_LABEL: Record<PivotBand, string> = {
  asserted: 'linked by the subject',
  strong: 'strong signals',
  moderate: 'some signals',
  weak: 'weak signals',
  'handle-only': 'the handle and nothing else'
}

export const PIVOT_SIGNAL_LABEL: Record<PivotSignalId, string> = {
  'reciprocal-link': 'reciprocal link',
  'outbound-link': 'outbound link',
  'avatar-bytes': 'identical avatar file',
  'avatar-hash': 'matching avatar',
  'bio-phrase': 'shared bio phrase',
  'display-name': 'same display name',
  'seeded-name': 'seeded real name',
  'seeded-city': 'seeded city',
  'handle-shape': 'similar handle'
}

/**
 * Points per signal.
 *
 * Ordered by how hard the signal is to produce by coincidence, which is not the same as
 * how easy it is to observe. A reciprocal link is nearly decisive because two site
 * operators would both have to be wrong at once *and* the subject would have had to write
 * the link. An avatar hash match is strong because a picture is a 64-bit fingerprint of
 * something a person chose. A display name is weak on its own: "Torvalds" appears on
 * SoundCloud, on Medium and on Instagram in this repository's own test fixture, attached
 * to at least three different people.
 *
 * The numbers are deliberately not a probability. They are an ordering with arithmetic
 * attached, and the UI shows every term so the operator can disagree with the total.
 */
export const PIVOT_POINTS: Record<PivotSignalId, number> = {
  'reciprocal-link': 60,
  'outbound-link': 32,
  'avatar-bytes': 45,
  'avatar-hash': 38,
  'bio-phrase': 24,
  'display-name': 14,
  'seeded-name': 20,
  'seeded-city': 8,
  'handle-shape': 5
}

export const PIVOT_STRENGTH: Record<PivotSignalId, PivotStrength> = {
  'reciprocal-link': 'decisive',
  'outbound-link': 'strong',
  'avatar-bytes': 'strong',
  'avatar-hash': 'strong',
  'bio-phrase': 'moderate',
  'display-name': 'moderate',
  'seeded-name': 'moderate',
  'seeded-city': 'weak',
  'handle-shape': 'weak'
}

/** Default hop cap. Depth 3 explodes combinatorially and floods the review queue. */
export const PIVOT_DEFAULT_MAX_HOPS = 2

export function pivotBand(score: number, signals: readonly PivotSignal[]): PivotBand {
  if (signals.some((s) => s.id === 'reciprocal-link')) return 'asserted'
  if (score >= 55) return 'strong'
  if (score >= 28) return 'moderate'
  if (score > 0) return 'weak'
  return 'handle-only'
}

/** The band's one-line meaning, shown beside every pivot in the review queue. */
export const PIVOT_BAND_MEANING: Record<PivotBand, string> = {
  asserted:
    'One of these two profiles links to the other. The subject published that connection; this is as close to decisive as an unauthenticated lookup gets, and it is still one claim from one source.',
  strong:
    'Several independent properties of the two profiles agree — a picture, a distinctive phrase, a name. Strong enough to be worth checking by hand, and not strong enough to promote without doing so.',
  moderate:
    'Something matched, but nothing that would be hard to match by coincidence. Look at both profiles before you believe it.',
  weak: 'Barely more than the handle. Most of these belong to other people.',
  'handle-only':
    'An account with this name exists and nothing else connects it to you. Handle collisions are ordinary: common words, short handles and old platforms all produce them constantly.'
}

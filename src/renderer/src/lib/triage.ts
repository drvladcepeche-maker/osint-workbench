import type { CandidateView } from '../../../shared/types'
import { PIVOT_BAND_MEANING, type PivotAssessment } from '../../../shared/pivot'

/**
 * Sorting the review queue, so the operator is not asked ninety identical questions.
 *
 * His words about the old queue: *"what does promote and dismiss mean? Can it do that
 * automatically at least to some degree?"* — and then, when told that promotion has to
 * stay human: *"maybe it doesn't auto promote, but it adds more weight. Like, this is
 * probably true. I don't wanna click promote on fucking everything."*
 *
 * Both halves of that are right, and they are asymmetric.
 *
 * **Dismissal is automated, promotion is not.** A candidate hidden as noise costs nothing
 * if it was wrong — it is hidden, never deleted, and one click brings the whole hidden
 * group back with its reasons attached. A candidate *promoted* wrongly becomes a real
 * entity, the next tool run is pointed at it, and every finding after that is about a
 * stranger while carrying the subject's name; because promotion is also what makes
 * something look established, the mistake gets more convincing the deeper it goes. So
 * nothing here promotes anything, including on a reciprocal link. What it does instead is
 * put the obvious cases in one group with one button on it.
 *
 * **Nothing is sorted silently.** Every band carries the reasons it was assigned, and a
 * hidden candidate says exactly which rule hid it. A triage that just reorders a list
 * teaches nothing, and the stated point of this whole application is understanding the
 * mechanism rather than trusting the output.
 */

export type TriageBand = 'almost-certain' | 'probable' | 'possible' | 'unlikely' | 'noise'

export const TRIAGE_BANDS: readonly TriageBand[] = [
  'almost-certain',
  'probable',
  'possible',
  'unlikely',
  'noise'
] as const

export const TRIAGE_LABEL: Record<TriageBand, string> = {
  'almost-certain': 'Almost certainly them',
  probable: 'Probably them',
  possible: 'Possible',
  unlikely: 'Probably not',
  noise: 'Hidden as noise'
}

export const TRIAGE_MEANING: Record<TriageBand, string> = {
  'almost-certain':
    'Either you have already confirmed the finding behind it, or the subject published a link between the two profiles themselves. This is the group worth promoting in one action.',
  probable:
    'Two independent sources agree, or several properties of the two profiles match. Worth a look before promoting, and quick to check.',
  possible: 'Something matched that would not be hard to match by coincidence. Read the evidence.',
  unlikely: 'Barely more than a name in common. Most of these belong to other people.',
  noise:
    'Hidden, not deleted. Every one of these rests on a probe that could not distinguish an account from a non-account, or on a handle collision with nothing behind it. Expand the group to see each one and the rule that hid it.'
}

export interface Triage {
  band: TriageBand
  /** 0..100. An ordering with arithmetic attached, never a probability. */
  score: number
  /** Why it landed here. Shown on the row, not in a doc panel. */
  reasons: string[]
  /** Set for the noise band: the exact rule that hid it. */
  hiddenBecause: string | null
  /** The pivot assessment, when this candidate came from a pivot. */
  pivot: PivotAssessment | null
}

/** Pivot bands map onto triage bands directly; the pivot scorer already did the work. */
const FROM_PIVOT: Record<PivotAssessment['band'], TriageBand> = {
  asserted: 'almost-certain',
  strong: 'probable',
  moderate: 'possible',
  weak: 'unlikely',
  'handle-only': 'noise'
}

export function triage(c: CandidateView): Triage {
  const pivot = readPivot(c)
  const reasons: string[] = []

  // A human already vouched for the evidence. Nothing outranks that, and it is the one
  // state that can never be hidden.
  if (c.bestConfidence === 'confirmed') {
    return {
      band: 'almost-certain',
      score: 100,
      reasons: ['You confirmed the finding that proposed this, with a written note.'],
      hiddenBecause: null,
      pivot
    }
  }

  if (pivot) {
    for (const s of pivot.signals) reasons.push(s.detail)
    if (!pivot.signals.length) reasons.push('Nothing fired beyond the handle itself.')
    const band = FROM_PIVOT[pivot.band]
    return {
      band,
      score: pivot.score,
      reasons,
      hiddenBecause:
        band === 'noise'
          ? 'A handle appearing on a profile, with no picture, phrase, name or link connecting it to you. Handle collisions are ordinary.'
          : null,
      pivot
    }
  }

  /* --- a plain account hit from a username sweep ------------------------- */

  const withMatcher = c.claims.filter((cl) => cl.matcher)
  const weakOnly = withMatcher.length > 0 && withMatcher.every((cl) => cl.matcher!.strength === 'weak')
  const anyStrong = withMatcher.some((cl) => cl.matcher!.strength === 'strong')

  if (c.bestConfidence === 'corroborated' || c.independentSources >= 2) {
    reasons.push(
      `${c.independentSources} independent sources reported this, so it is not one site's bug.`
    )
    if (anyStrong) reasons.push('At least one of them used a probe built to distinguish a real account.')
    return { band: 'probable', score: 60, reasons, hiddenBecause: null, pivot }
  }

  if (weakOnly) {
    const why = withMatcher[0]!.matcher!.why
    return {
      band: 'noise',
      score: 0,
      reasons: withMatcher.map((cl) => `${cl.source}: ${cl.matcher!.label}`),
      hiddenBecause: `Every probe behind this was structurally weak. ${why}`,
      pivot
    }
  }

  if (anyStrong) {
    reasons.push(
      'The probe behind this asks a per-user address and checks the answer, so a hit means an account with that name exists there.'
    )
    reasons.push('Whether it is yours is a separate question this tool has not answered.')
    return { band: 'possible', score: 35, reasons, hiddenBecause: null, pivot }
  }

  reasons.push('One source, and nothing yet says whether the probe behind it could tell an account from a page.')
  return { band: 'unlikely', score: 15, reasons, hiddenBecause: null, pivot }
}

function readPivot(c: CandidateView): PivotAssessment | null {
  const raw = c.attrs['pivot']
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<PivotAssessment>
  return typeof p.band === 'string' && Array.isArray(p.signals) ? (raw as PivotAssessment) : null
}

export interface TriagedGroup {
  band: TriageBand
  items: { candidate: CandidateView; triage: Triage }[]
}

/**
 * Group and order the queue: strongest first, noise last and collapsed.
 *
 * Within a band the order is by score and then by value, so the list does not reshuffle
 * under the pointer when a background run appends a proposal to something already on
 * screen.
 */
export function groupCandidates(candidates: readonly CandidateView[]): TriagedGroup[] {
  const byBand = new Map<TriageBand, TriagedGroup['items']>()
  for (const candidate of candidates) {
    const t = triage(candidate)
    const list = byBand.get(t.band) ?? []
    list.push({ candidate, triage: t })
    byBand.set(t.band, list)
  }
  return TRIAGE_BANDS.filter((b) => byBand.has(b)).map((band) => ({
    band,
    items: byBand
      .get(band)!
      .sort((a, b) => b.triage.score - a.triage.score || a.candidate.value.localeCompare(b.candidate.value))
  }))
}

/** The one-line meaning for a pivot band, for the detail panel. */
export function pivotMeaning(pivot: PivotAssessment): string {
  return PIVOT_BAND_MEANING[pivot.band]
}

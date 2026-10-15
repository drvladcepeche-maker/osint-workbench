import type { Confidence } from '../../../shared/types'
import { Icon, type IconName } from './Icon'

/**
 * The confidence ramp.
 *
 * `unverified -> corroborated -> confirmed`, with `refuted` off the ladder. It is
 * carried by **lightness and font-weight, never hue**: the four `--ink-*` tokens differ
 * in L, the four weights differ by design, and hue does nothing. That is what makes it
 * survive greyscale and every form of colour blindness — the same reason it also
 * survives a screenshot, a scaled-down window, and a bad monitor.
 *
 * Three carriers, all independent:
 *
 *   1. Lightness  — the ink token, set on the row and inherited.
 *   2. Weight     — 400 / 450 / 600 / 400, animated through the variable axis so a
 *                   promotion *develops* over 280ms instead of snapping.
 *   3. Shape+word — a glyph that is a print developing (empty, half, whole, struck) and
 *                   the level written out.
 *
 * Note on DESIGN.md: its ramp table gives `corroborated` "an amber marker". That is
 * overruled here by the same document's accent discipline — amber means a run is live
 * and nothing else, and a corroborated finding sitting on screen with no job running
 * would otherwise light the safelight. The glyph does the marking instead.
 */

interface Level {
  label: string
  icon: IconName
  /** Shown on hover and to assistive tech. This is the rule, not a description. */
  title: string
}

export const LEVELS: Record<Confidence, Level> = {
  unverified: {
    label: 'unverified',
    icon: 'latent',
    title:
      'One source said so. This is the default, and where most findings correctly stay. ' +
      'A single tool hit can never be anything else — username checkers in particular ' +
      'read anti-bot redirects as "account exists".'
  },
  corroborated: {
    label: 'corroborated',
    icon: 'developing',
    title:
      'At least two independent sources agree. Independence is keyed on the source, not ' +
      'the tool: two tools reading the same site counts once.'
  },
  confirmed: {
    label: 'confirmed',
    icon: 'developed',
    title:
      'A human looked and vouched for it, with a recorded note. No amount of tool ' +
      'agreement produces this.'
  },
  refuted: {
    label: 'refuted',
    icon: 'refuted',
    title: 'Actively disproved. Kept rather than deleted — knowing something is false is a result.'
  }
}

/** The glyph and the word, on the row's ink. Used in the confidence column. */
export function ConfidenceMark({ confidence }: { confidence: Confidence }): React.JSX.Element {
  const level = LEVELS[confidence]
  return (
    <span className="conf" title={level.title}>
      <Icon name={level.icon} className="conf__glyph" size={11} />
      <span className="conf__word">{level.label}</span>
    </span>
  )
}

/**
 * A count of findings at one level, for summary lines.
 * "3 corroborated, 44 unverified" — DESIGN.md's own example of what a headline is
 * allowed to say instead of "47 accounts exposed".
 */
export function ConfidenceCount({
  confidence,
  n
}: {
  confidence: Confidence
  n: number
}): React.JSX.Element {
  return (
    <span className="stat" data-confidence={confidence} title={LEVELS[confidence].title}>
      <span className="stat__n conf-ink">{n}</span>
      <span>{LEVELS[confidence].label}</span>
    </span>
  )
}

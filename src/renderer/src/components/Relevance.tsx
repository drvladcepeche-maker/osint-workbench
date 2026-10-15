import {
  RELEVANCE_BAND_LABEL,
  RELEVANCE_BAND_MEANING,
  type RelevanceAssessment,
  type RelevanceBand,
  type RelevanceSignal
} from '../../../shared/relevance'
import { Icon, type IconName } from './Icon'

/**
 * Relevance, on the row and in the margin.
 *
 * ## Why this is a separate column from confidence, and stays one
 *
 * They are orthogonal and the app would be lying if it merged them. `confidence` answers
 * *how many independent sources say this, and did a human look* — a property of the
 * evidence. Relevance answers *does this row have anything to do with the person I am
 * looking for* — a property of the subject. A `confirmed` finding about a stranger is
 * still confirmed; it is confirmed about a stranger. A perfectly relevant row can still
 * be one anti-bot redirect answering 200.
 *
 * So they get two columns, two vocabularies and two sets of glyphs. Nothing here ever
 * writes to a confidence, and nothing about a confidence changes a score.
 *
 * ## Shape, not colour
 *
 * The confidence ramp already owns lightness and font-weight in these rows — that is what
 * makes it survive greyscale and colour blindness — so relevance cannot use the same
 * channel without the two fighting. It uses **silhouette plus a word** instead: an anchor,
 * a tick, a dash, a triangle, an exclamation. Five shapes distinguishable at 11px, each
 * with its label beside it, and the score as a plain tabular number.
 */

const BAND_ICON: Record<RelevanceBand, IconName> = {
  anchor: 'anchor',
  supported: 'agrees',
  silent: 'silent',
  questioned: 'warning',
  contradicted: 'conflicts'
}

/** The compact cell: a glyph, the score, and the whole argument on hover. */
export function RelevanceMark({
  relevance,
  scored
}: {
  relevance: RelevanceAssessment
  /** False when nothing has been seeded, so the column has nothing to say yet. */
  scored: boolean
}): React.JSX.Element {
  if (!scored) {
    return (
      <span className="rel rel--off" title="Nothing is seeded in this case yet, so there is nothing to rank against. Add a name, a country or the subject's gender above.">
        <Icon name="silent" size={11} className="rel__glyph" />
        <span className="rel__score">—</span>
      </span>
    )
  }
  const title =
    `${RELEVANCE_BAND_LABEL[relevance.band]} · ${relevance.score}/100\n\n` +
    `${RELEVANCE_BAND_MEANING[relevance.band]}\n\n` +
    (relevance.signals.length
      ? relevance.signals.map((s) => `${s.verdict === 'conflicts' ? '−' : '+'} ${s.detail}`).join('\n\n')
      : 'Nothing on this row either matched or contradicted your seeds.')

  return (
    <span className="rel" data-band={relevance.band} title={title}>
      <Icon name={BAND_ICON[relevance.band]} size={11} className="rel__glyph" />
      <span className="rel__score">{relevance.score}</span>
    </span>
  )
}

/**
 * The one line a low row shows without being expanded.
 *
 * This is rule two of the three that outrank the arithmetic: *say why a row scored low*.
 * A score with no reason attached is a verdict, and this application's whole contract is
 * the mechanism rather than the verdict.
 *
 * Two or three words on the row, because a 30px row belongs to the claim and a sentence
 * there would either wrap it or squeeze the claim to nothing. The full sentence is on the
 * hover, itemised with its arithmetic in the margin, and written out again on the
 * collapsed group's header — so the tag is the shortest of four places it is said, not the
 * only one.
 */
export function RelevanceWhy({ relevance }: { relevance: RelevanceAssessment }): React.JSX.Element | null {
  if (!relevance.whyShort || !relevance.why) return null
  return (
    <span className="rel-why" title={relevance.why}>
      {relevance.whyShort}
    </span>
  )
}

/** Every signal, signed and itemised, for the context panel. The sum is auditable. */
export function RelevanceSignals({
  relevance
}: {
  relevance: RelevanceAssessment
}): React.JSX.Element {
  if (!relevance.signals.length) {
    return (
      <p className="hint">
        Nothing on this row either matched or contradicted your seeds. That is the honest
        middle of the range and where most of a username sweep correctly sits — a handle
        exists somewhere and the site said nothing else about who holds it.
      </p>
    )
  }
  return (
    <ul className="rel-list">
      {relevance.signals.map((s: RelevanceSignal, i) => (
        <li key={i} className="rel-list__item" data-verdict={s.verdict}>
          <span className="rel-list__points data">
            {s.points > 0 ? `+${s.points}` : s.points}
          </span>
          <span className="rel-list__detail">
            {s.detail}
            <span className="rel-list__weight" title="How much this signal is allowed to decide. Only a strong conflict can put a row in the contradicted group.">
              {s.weight}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The full margin block: band, score, the arithmetic, and the standing disclaimer.
 *
 * The disclaimer is not boilerplate. A number between 0 and 100 reads as a probability to
 * everybody who has ever seen one, and this is not a probability — it is an ordering with
 * arithmetic attached, exactly as the pivot scorer's is. Saying so next to the number is
 * cheaper than being misread.
 */
export function RelevanceDetail({
  relevance,
  scored
}: {
  relevance: RelevanceAssessment
  scored: boolean
}): React.JSX.Element {
  if (!scored) {
    return (
      <div className="detail">
        <p className="hint">
          Nothing is seeded in this case, so nothing can be ranked. Add what you already
          know — a real name, the subject&rsquo;s country, the gender the name reads as —
          and every row gets a score and a reason.
        </p>
      </div>
    )
  }
  return (
    <div className="detail">
      <div className="detail__row">
        <span className="detail__key">Relevance</span>
        <span className="detail__value">
          <RelevanceMark relevance={relevance} scored />
          <span className="dot-sep">·</span>
          <span>{RELEVANCE_BAND_LABEL[relevance.band]}</span>
        </span>
      </div>
      <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
        {RELEVANCE_BAND_MEANING[relevance.band]}
      </p>
      <RelevanceSignals relevance={relevance} />
      <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
        An ordering with arithmetic attached, never a probability. It is independent of
        confidence: this says whether the row is about your subject, confidence says how
        many independent sources stand behind the claim. Neither moves the other.
      </p>
    </div>
  )
}

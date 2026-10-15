import type { AdapterDoc } from '../../../shared/types'
import { Data } from './Data'

/**
 * The adapter `doc` block — what / how / why / better at / worse at / how it lies to you.
 *
 * This is not an about-box, and it is not a detail. The operator's stated reason for
 * building the app is understanding *mechanisms* rather than pressing buttons, so this
 * panel is a primary product feature: it is always on screen in the right margin, never
 * summoned into a modal, and never collapsed behind a disclosure the operator has to
 * remember exists.
 *
 * The registry refuses to start with an incomplete doc — `assertAdapterDoc()` throws on a
 * missing field, a placeholder, or anything under twelve characters — which is why this
 * component renders all six fields unconditionally with no null checks and no "not
 * documented" fallback. If an adapter is registered, its doc is real.
 *
 * Typeset as prose to be read: 14px on 1.6, a rule between fields, and a full beat of
 * space before "how it lies to you" — which is the field that matters most and the one
 * nobody wants to read.
 */

const FIELDS: { key: keyof AdapterDoc; label: string; hint?: string }[] = [
  { key: 'what', label: 'What it does' },
  { key: 'how', label: 'How it works', hint: 'the mechanism' },
  { key: 'why', label: 'Why that reveals anything' },
  { key: 'betterAt', label: 'Better at', hint: 'reach for it when' },
  { key: 'worseAt', label: 'Worse at', hint: 'blind spots' },
  { key: 'falsePositives', label: 'How it lies to you', hint: 'false positives' }
]

export function HowThisWorks({
  doc,
  toolId,
  version
}: {
  doc: AdapterDoc | undefined
  toolId: string
  version?: string
}): React.JSX.Element {
  if (!doc) {
    return (
      <div className="doc">
        <p className="prose">
          No adapter named <Data>{toolId}</Data> is registered, so its explanation is
          unavailable. The finding and its raw output are intact — this is a missing
          <em> description</em> of the tool, not missing data.
        </p>
      </div>
    )
  }

  return (
    <div className="doc">
      <div className="doc__tool">
        <span className="doc__tool-name">{toolId}</span>
        {version && <Data className="doc__hint">v{version}</Data>}
      </div>

      {FIELDS.map((f) => (
        <section className={`doc__field doc__field--${f.key}`} key={f.key}>
          <h3 className="doc__label">
            {f.label}
            {f.hint && <span className="doc__hint"> — {f.hint}</span>}
          </h3>
          <p className="doc__text">{doc[f.key]}</p>
        </section>
      ))}
    </div>
  )
}

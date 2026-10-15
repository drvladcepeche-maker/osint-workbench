import { useState } from 'react'
import { PIVOT_FROM_UNIQUE_ADVICE, type HandleAdvice } from '../../../shared/relevance'
import { Icon } from './Icon'

/**
 * When the technique is the problem, and not the build.
 *
 * The operator ran the app against a friend with a common Bulgarian given name and got
 * nothing usable. The honest explanation is **not** a bug: username enumeration on a
 * common handle is low-yield as a property of the technique. Fifty people share the
 * handle, an HTTP probe cannot tell them apart, and no amount of ranking invents the
 * distinguishing evidence that was never fetched. Ranking makes the fifty rows readable;
 * it does not make them informative.
 *
 * Leaving him to work that out for himself has one likely outcome — he concludes the tool
 * is broken — so this says it beside the results, at the moment he is reading them.
 *
 * ## It has to name the better move, or it is just an excuse
 *
 * A panel that explains why the results are poor and stops there is the app defending
 * itself. So the second half is the actual technique: **start from something you are
 * already certain of** and pivot outward — a profile URL he was sent, a Discord user id,
 * an account the subject linked to from another one. That is what identity resolution
 * actually looks like, and it is a thing this app can already do: seed the certain
 * account, enrich it, follow the links off the page it returns. Starting from noise
 * produces noise.
 *
 * Not a modal, not a banner, not fear framing. A panel in the flow, dismissible, and
 * silent unless something about the handle or the run has actually earned it.
 */
export function CommonHandleNotice({ advice }: { advice: HandleAdvice }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  const [open, setOpen] = useState(false)
  if (dismissed) return null

  return (
    <section className="panel notice-panel">
      <div className="panel__head">
        <span className="panel__title">
          <Icon name="info" size={12} /> This handle is a weak starting point
        </span>
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={() => setDismissed(true)}
          title="Dismiss for this visit"
          aria-label="Dismiss"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="panel__body">
        <ul className="reason-list">
          {advice.reasons.map((r) => (
            <li key={r.id}>{r.detail}</li>
          ))}
        </ul>
        <p className="prose">
          That is a property of username enumeration rather than a fault in the run. A probe
          asks a site whether a handle is taken; it cannot ask whose it is. Every row below
          is real — the ranking puts the plausible ones first and names what contradicts
          the rest — but a handle several people share cannot be made to yield one person.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span>What works instead</span>
        </button>
        {open && (
          <div className="prose-block">
            {PIVOT_FROM_UNIQUE_ADVICE.map((line, i) => (
              <p key={i} className="prose">
                {line}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

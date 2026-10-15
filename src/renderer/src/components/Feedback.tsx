import { Icon, type IconName } from './Icon'

/**
 * Notices, empty states and skeletons.
 *
 * The voice rule underneath all of them, from DESIGN.md: patient, exacting, unimpressed.
 * It states what was found and what it can't support. It never celebrates a result and
 * never dramatizes a risk. No "Something went wrong" — say what exited with what, and
 * what survived.
 */

export type NoticeState = 'danger' | 'warning' | 'success' | 'info'

const NOTICE: Record<NoticeState, { icon: IconName; label: string }> = {
  danger: { icon: 'danger', label: 'Failed' },
  warning: { icon: 'warning', label: 'Note' },
  success: { icon: 'success', label: 'Done' },
  info: { icon: 'info', label: 'Note' }
}

/**
 * Colour + icon + word, always all three. Hue alone would be doing the work on the one
 * axis red-green colour blindness compresses, and this palette is red-and-amber
 * dominant.
 */
export function Notice({
  state,
  label,
  children,
  onDismiss
}: {
  state: NoticeState
  label?: string
  children: React.ReactNode
  onDismiss?: () => void
}): React.JSX.Element {
  const preset = NOTICE[state]
  return (
    <div className={`notice notice--${state}`} role={state === 'danger' ? 'alert' : 'status'}>
      <Icon name={preset.icon} className="notice__icon" />
      <span className="notice__label">{label ?? preset.label}</span>
      <span className="notice__body">{children}</span>
      {onDismiss && (
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={onDismiss}
          aria-label="Dismiss this message"
        >
          <Icon name="close" />
        </button>
      )}
    </div>
  )
}

/**
 * An empty state that teaches.
 *
 * DESIGN.md: not "No findings." What this view does, what to feed it, and one concrete
 * example. An empty view is the moment the operator is most willing to read and the
 * cheapest place in the app to explain a mechanism, so all three parts are required
 * props rather than optional ones.
 */
export function EmptyState({
  title,
  body,
  example,
  exampleLabel = 'For example',
  actions
}: {
  title: string
  body: string[]
  example: React.ReactNode
  exampleLabel?: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="empty">
      <h2 className="empty__title">{title}</h2>
      {body.map((p) => (
        <p key={p} className="empty__body">
          {p}
        </p>
      ))}
      <div className="empty__example">
        <div className="empty__example-label">{exampleLabel}</div>
        <div className="empty__example-body">{example}</div>
      </div>
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  )
}

/**
 * Skeletons, not spinners, for content that is loading — a skeleton is honest about the
 * shape of what is coming, and a spinner is honest about nothing.
 *
 * The widths vary per row so the placeholder reads as a table of unequal claims rather
 * than a loading graphic.
 */
export function SkeletonRows({ rows = 8 }: { rows?: number }): React.JSX.Element {
  const widths = [58, 42, 71, 35, 64, 49, 77, 40, 55, 68]
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <div className="skeleton" style={{ width: 78 }} />
          <div className="skeleton" style={{ width: `${widths[i % widths.length]}%` }} />
        </div>
      ))}
    </div>
  )
}

/** The accessible half of a skeleton: a live region that says what is happening. */
export function Loading({ what }: { what: string }): React.JSX.Element {
  return (
    <>
      <span className="sr-only" role="status">
        Loading {what}.
      </span>
      <SkeletonRows />
    </>
  )
}

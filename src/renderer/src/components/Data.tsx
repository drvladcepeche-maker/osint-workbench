import { useCopy } from '../lib/hooks'
import { Icon } from './Icon'

/**
 * Literal values.
 *
 * DESIGN.md's monospace rule: mono is rationed to *data* — hashes, coordinates,
 * usernames, timestamps, domains, IPs, paths, raw tool output — and never to headings,
 * buttons, labels or body copy. Because it is rationed it means something: "this is a
 * literal value you could copy, and character-level detail matters."
 *
 * Enforcing that by convention would last about a week, so the ration is structural
 * instead: `.data` is the only class that applies `--font-mono`, and
 * `scripts/design-lint.mjs` fails on any other rule that reaches for it. Every
 * monospaced string in the app comes through here or through `<CopyValue>`.
 */
export function Data({
  children,
  title,
  className
}: {
  children: React.ReactNode
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <span className={className ? `data ${className}` : 'data'} title={title}>
      {children}
    </span>
  )
}

/**
 * A literal value you can copy, with real confirmation feedback.
 *
 * DESIGN.md asks for a copy affordance on every literal value and calls a silent success
 * a failure — so this says "Copied." in words, and says what went wrong when the
 * clipboard refuses. The whole value is the hit target rather than a 12px icon beside
 * it, because the thing the operator is aiming at is the value.
 */
export function CopyValue({
  value,
  label,
  title
}: {
  value: string
  /** What to show, when the display form differs from what should land on the clipboard. */
  label?: string
  title?: string
}): React.JSX.Element {
  const { state, copy } = useCopy()
  const shown = label ?? value

  return (
    <button
      type="button"
      className="copy data"
      data-copied={state === 'idle' ? undefined : state}
      onClick={() => copy(value)}
      title={title ?? `Copy ${value}`}
    >
      <span className="copy__value">{shown}</span>
      {state === 'idle' && <Icon name="copy" size={11} className="copy__mark" />}
      {state === 'true' && (
        <>
          <Icon name="check" size={11} className="copy__mark" />
          <span className="copy__said">Copied.</span>
        </>
      )}
      {state === 'error' && (
        <>
          <Icon name="danger" size={11} className="copy__mark" />
          <span className="copy__said">Clipboard refused.</span>
        </>
      )}
    </button>
  )
}

export function Tag({
  children,
  title,
  strong = false
}: {
  children: React.ReactNode
  title?: string
  strong?: boolean
}): React.JSX.Element {
  return (
    <span className={strong ? 'tag tag--seed' : 'tag'} title={title}>
      {children}
    </span>
  )
}

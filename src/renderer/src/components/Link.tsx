import { useCallback, useState } from 'react'
import {
  linkLabelFor,
  linkSpans,
  shortLinkLabel,
  sourceHref,
  trailingLink,
  type ClaimSpan
} from '../../../shared/links'
import { useCopy } from '../lib/hooks'
import { Icon } from './Icon'

/**
 * Links out of the app.
 *
 * The operator's report, verbatim: *"it would be really nice if the findings all contained
 * a hyperlink I can just click to go to the site they're referencing, because otherwise I
 * have to expand the box, copy the thing, and there's a full stop at the end which fucks
 * it up."* Three separate failures in one sentence, and all three are fixed here rather
 * than in one of them:
 *
 *  1. **Not clickable.** A finding whose entire value is "there is a page here" is not
 *     delivered until the page opens.
 *  2. **Behind an expand.** So the link is on the row, not only in the detail panel.
 *  3. **The full stop.** `shared/links.ts` gives sentence punctuation back to the
 *     sentence, so what is copied and what is opened is the address and nothing else.
 *
 * ## Everything opens in the real browser
 *
 * `window.osint.app.openExternal` hands the URL to `shell.openExternal`, and the main
 * process re-checks the scheme against the same `http`/`https` allowlist. Never an
 * Electron window: a case view renders URLs that came out of scraped, attacker-controllable
 * page content, and navigating this app's own window to one of those is a real hole rather
 * than a theoretical one. `main/index.ts` already denies every window-open request for the
 * same reason; this is the deliberate path.
 *
 * ## Why a button and not an anchor
 *
 * An `<a href>` in a `contextIsolation` renderer under a CSP that blocks remote loads is a
 * navigation the page is not allowed to perform — it would either do nothing or replace
 * the app. A button that calls across the bridge is the honest shape: the renderer names a
 * URL and the main process decides whether that is a thing to open.
 */

function useOpen(): {
  open: (href: string) => void
  failure: string | null
  clear: () => void
} {
  const [failure, setFailure] = useState<string | null>(null)
  const open = useCallback((href: string) => {
    setFailure(null)
    window.osint.app.openExternal(href).catch((err: Error) => setFailure(err.message))
  }, [])
  return { open, failure, clear: () => setFailure(null) }
}

/**
 * One clickable URL, in the monospace reserved for literal values.
 *
 * Both affordances are present because they answer different questions: *open it* and
 * *put it somewhere else*. The copy half reuses `useCopy`, so it says "Copied." in words
 * like every other literal in the app rather than succeeding silently.
 */
export function ExternalLink({
  href,
  label,
  title,
  showCopy = true
}: {
  href: string
  /** What to show, when it differs from the URL — a truncated form, a host. */
  label?: string
  title?: string
  showCopy?: boolean
}): React.JSX.Element {
  const { open, failure } = useOpen()
  const { state, copy } = useCopy()

  return (
    <span className="link-pair">
      <button
        type="button"
        className="link data"
        onClick={(e) => {
          e.stopPropagation()
          open(href)
        }}
        title={title ?? `Open ${href} in your browser`}
      >
        <span className="link__text">{label ?? href}</span>
        <Icon name="external" size={11} className="link__mark" />
      </button>
      {showCopy && (
        <button
          type="button"
          className="link-copy"
          data-copied={state === 'idle' ? undefined : state}
          onClick={(e) => {
            e.stopPropagation()
            void copy(href)
          }}
          title={`Copy ${href} — the address on its own, with no sentence punctuation`}
          aria-label={`Copy the link ${href}`}
        >
          {state === 'true' ? (
            <Icon name="check" size={11} />
          ) : state === 'error' ? (
            <Icon name="danger" size={11} />
          ) : (
            <Icon name="copy" size={11} />
          )}
        </button>
      )}
      {failure && <span className="link__failure">{failure}</span>}
    </span>
  )
}

/**
 * A claim, with every URL in it clickable and the prose left exactly as written.
 *
 * The spans concatenate back to the original string — asserted by a test — so this is a
 * rendering of the claim and never an edit of it. A URL whose scheme this app will not
 * open (`file:`, `javascript:`) stays visible as text: a `file:///home/user/...` path in a
 * scraped bio is itself a finding, and hiding it would be worse than not linking it.
 */
export function ClaimText({
  text,
  className,
  copyable = false
}: {
  text: string
  className?: string
  /**
   * Show a copy button beside each link.
   *
   * On a 30px findings row it is revealed by hover, focus or selection (see
   * `.claim-cell .link-copy` in ranking.css) rather than drawn on every row at all times —
   * a copy icon on every link in a fifty-row table is a column of icons, and the claim is
   * what the operator came to read. `visibility` rather than `opacity` does the hiding, so
   * a hidden button is out of the tab order entirely and the one on the selected row —
   * which is where keyboard focus already is — is always shown.
   */
  copyable?: boolean
}): React.JSX.Element {
  const spans = linkSpans(text)
  if (spans.every((s) => s.kind === 'text')) {
    return (
      <span className={className} title={text}>
        {text}
      </span>
    )
  }
  return (
    <span className={className} title={text}>
      {spans.map((span: ClaimSpan, i) =>
        span.kind === 'link' ? (
          <ExternalLink key={i} href={span.href} label={span.text} showCopy={copyable} />
        ) : (
          <span key={i}>{span.text}</span>
        )
      )}
    </span>
  )
}

/**
 * A claim on one line of a table, with the address it ends with pinned beside it.
 *
 * The claim column is three to five times narrower than the sentences it holds, so the
 * sentence is drawn with an ellipsis. Measured on the running app before this existed: a
 * 1039px claim in a 294px cell, which put every `Profile: https://…` off the end of the
 * row. The link existed, was clickable, and could not be reached — so the operator still
 * had to expand the row, which is the exact complaint the link work was meant to close.
 *
 * The two halves are treated differently because they *are* different. A sentence still
 * reads when it is abbreviated; an address does not exist unless it is whole. So the
 * sentence is the flex item that shrinks and the address is the one that does not, and the
 * address shows its host and path — the part that differs row to row — with the whole of
 * it on the title and on the clipboard.
 *
 * When a URL sits mid-sentence, `trailingLink` declines and this falls back to the plain
 * inline rendering rather than reordering what the parser wrote.
 */
export function RowClaim({
  text,
  source,
  className
}: {
  text: string
  /**
   * The finding's source host, so the pinned address can drop a host the row already
   * prints in its own column. See `linkLabelFor` — the claim column is the narrowest thing
   * on the row and saying `steamcommunity.com` twice on one line is what made it clip.
   */
  source?: string
  className?: string
}): React.JSX.Element {
  const trailing = trailingLink(text)
  if (!trailing) return <ClaimText text={text} className={className} copyable />
  const href = trailing.link.href
  return (
    <>
      <ClaimText text={trailing.prose} className={className} />
      <span className="claim-link">
        <ExternalLink
          href={href}
          label={source ? linkLabelFor(href, source) : shortLinkLabel(href)}
          title={`Open ${href} in your browser`}
        />
        {/* Given back exactly where it was written. The app does not drop a character from
            a claim to make it fit. */}
        {trailing.after && <span className="claim-link__after">{trailing.after}</span>}
      </span>
    </>
  )
}

/**
 * A finding's `source`, as a link when it is a place and as plain data when it is not.
 *
 * The title says what the link actually does, because a source has been folded to the
 * site's origin by `support/sources.ts` — `github.com`, never `github.com/torvalds`. It
 * opens the site, not the profile, and pretending otherwise would be the app inventing an
 * address no tool reported. `local:pattern-timezone` and `file:photo.jpg` are real source
 * identifiers and not places at all; they render as data.
 */
export function SourceLink({ source }: { source: string }): React.JSX.Element {
  const href = sourceHref(source)
  if (!href) {
    return (
      <span
        className="data"
        title={
          source.startsWith('local:')
            ? `${source} — derived locally from material already in this case. There is no page to open.`
            : source
        }
      >
        {source}
      </span>
    )
  }
  return (
    <ExternalLink
      href={href}
      label={source}
      showCopy={false}
      title={`Open ${href} — the site itself, not the profile this claim is about`}
    />
  )
}

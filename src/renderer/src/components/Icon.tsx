/**
 * Icons.
 *
 * Line glyphs on a 14px grid, drawn in `currentColor` so they inherit whatever ink the
 * thing around them is using — which is how the confidence glyphs stay on the ramp
 * without a single colour of their own.
 *
 * They exist for one accessibility reason and one only: hue is never the sole carrier of
 * meaning. The palette is red-and-amber dominant, which is exactly the axis red-green
 * colour blindness compresses, so every semantic state and every confidence level pairs
 * its colour with a distinct *shape* and a word. Take the colour away and nothing is
 * lost.
 *
 * The four confidence glyphs are a developing print: nothing, half, whole, discarded.
 */

export type IconName =
  | 'cases'
  | 'self-audit'
  | 'range'
  | 'scrub'
  | 'settings'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'copy'
  | 'check'
  | 'close'
  | 'danger'
  | 'warning'
  | 'success'
  | 'info'
  | 'latent'
  | 'developing'
  | 'developed'
  | 'refuted'
  | 'network'
  | 'key'
  | 'edit'
  | 'trash'
  | 'external'
  | 'anchor'
  | 'agrees'
  | 'conflicts'
  | 'silent'

const PATHS: Record<IconName, React.ReactNode> = {
  /* Stacked case folders. */
  cases: (
    <>
      <path d="M1.5 4.5h4l1 1.5h6v6.5h-11z" />
      <path d="M3.5 4.5v-2h4l1 1.5h4v2" />
    </>
  ),
  /* A subject with a ring drawn around them: the self-audit is you, seen from outside. */
  'self-audit': (
    <>
      <circle cx="7" cy="5.5" r="2.25" />
      <path d="M2.75 12.5a4.25 4.25 0 0 1 8.5 0" />
    </>
  ),
  /* Crosshair over a coordinate. */
  range: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M7 1v2.5M7 10.5V13M1 7h2.5M10.5 7H13" />
      <circle cx="7" cy="7" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  /* A file with its corner lifted: metadata is the part of a document you do not see
     until something turns it over. */
  scrub: (
    <>
      <path d="M3 1.75h5l3 3v7.5H3z" />
      <path d="M8 1.75V4.75h3" />
      <path d="M5 8.25h4M5 10.25h2.5" />
    </>
  ),
  /* Sliders, not a gear: these are settings you set, not machinery you wind. */
  settings: (
    <>
      <path d="M2 4.5h4M9 4.5h3M2 9.5h3M8 9.5h4" />
      <circle cx="7.5" cy="4.5" r="1.5" />
      <circle cx="6.5" cy="9.5" r="1.5" />
    </>
  ),

  'chevron-left': <path d="M8.75 3.5 5.25 7l3.5 3.5" />,
  'chevron-right': <path d="M5.25 3.5 8.75 7l-3.5 3.5" />,
  'chevron-down': <path d="M3.5 5.25 7 8.75l3.5-3.5" />,

  copy: (
    <>
      <rect x="5" y="5" width="7.5" height="7.5" rx="1" />
      <path d="M9.5 5V2.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1H5" />
    </>
  ),
  check: <path d="M2.5 7.5 5.5 10.5 11.5 4" />,
  close: <path d="M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5" />,

  /* Semantic. Three distinct silhouettes — triangle-with-bar, triangle-with-dot, tick,
     circle-with-bar — so the four are told apart with the colour removed. */
  danger: (
    <>
      <path d="M7 1.75 13 12.25H1z" />
      <path d="M7 5.5v3" />
      <circle cx="7" cy="10.4" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),
  warning: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 4v3.5" />
      <circle cx="7" cy="9.9" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),
  success: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M4.25 7.25 6.25 9.25 9.75 5" />
    </>
  ),
  info: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 6.5v4" />
      <circle cx="7" cy="4.2" r="0.55" fill="currentColor" stroke="none" />
    </>
  ),

  /* The confidence ramp, as a print developing. */
  latent: <circle cx="7" cy="7" r="4.25" />,
  developing: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M7 2.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" stroke="none" />
    </>
  ),
  developed: <circle cx="7" cy="7" r="4.25" fill="currentColor" />,
  refuted: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M4 10 10 4" />
    </>
  ),

  network: (
    <>
      <circle cx="7" cy="7" r="5.25" />
      <path d="M1.75 7h10.5M7 1.75c1.6 1.6 2.4 3.4 2.4 5.25S8.6 10.65 7 12.25c-1.6-1.6-2.4-3.4-2.4-5.25S5.4 3.35 7 1.75z" />
    </>
  ),
  key: (
    <>
      <circle cx="4.5" cy="7" r="2.5" />
      <path d="M7 7h5.5M10.5 7v2.25M12.5 7v1.75" />
    </>
  ),

  /* A nib over a rule: correcting what is written, not drawing something new. */
  /* An arrow leaving a frame. The universal "this opens somewhere else" and the one
     place in the app where that promise is made. */
  external: (
    <>
      <path d="M11 3H8.2M11 3v2.8M11 3 6.6 7.4" />
      <path d="M9.6 8.4v2.1a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1h2.1" />
    </>
  ),
  /* Relevance bands. Each is a distinct silhouette, never a colour alone: the
     confidence ramp already owns lightness in these rows, so these have to be readable
     as shapes. */
  anchor: (
    <>
      <path d="M7 3.2v7.6M4.2 5.4h5.6" />
      <path d="M3 8.6a4 4 0 0 0 8 0" />
    </>
  ),
  agrees: <path d="M3 7.5 5.6 10 11 4.2" />,
  conflicts: (
    <>
      <path d="M7 3.4v4.2" />
      <circle cx="7" cy="10.2" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  silent: <path d="M3.4 7h7.2" />,
  edit: (
    <>
      <path d="M9.25 2.25 11.75 4.75 5.5 11H3v-2.5z" />
      <path d="M2.25 12.75h9.5" />
    </>
  ),
  /* A bin with a lid. Deliberately not an X: an X closes things elsewhere in this app,
     and the one control that destroys something must not share a glyph with the one that
     dismisses a notice. */
  trash: (
    <>
      <path d="M2.75 3.75h8.5" />
      <path d="M5.5 3.75V2.5h3v1.25" />
      <path d="M3.75 3.75 4.4 12h5.2l.65-8.25" />
      <path d="M6 6.25v3.5M8 6.25v3.5" />
    </>
  )
}

export function Icon({
  name,
  size = 14,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

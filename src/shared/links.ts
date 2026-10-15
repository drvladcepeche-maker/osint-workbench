/**
 * URLs inside text the operator reads.
 *
 * ## Why this exists
 *
 * Every claim in this app is a sentence, and a lot of those sentences end in a URL —
 * `… exists on GitHub at https://github.com/torvalds.` The operator's report was that
 * getting to that page cost him three actions and then failed anyway: expand the row,
 * select the URL, copy it, and discover the sentence's full stop came along and broke the
 * address. That is not a rendering nicety. A finding whose whole value is "there is a page
 * here" is not delivered until the page opens.
 *
 * So this module answers exactly one question — *where in this string is a URL, and where
 * does it end?* — and it answers it in one place, shared by the renderer that draws the
 * link and by the test that asserts no adapter ever fuses punctuation onto one.
 *
 * ## Where a URL ends, and why that is the hard part
 *
 * There is no character that cannot legally appear in a URL, so "the URL ends at the first
 * `.`" is wrong and "the URL ends at the first space" is wrong in the other direction —
 * the latter is what leaves `https://github.com/torvalds.` on the clipboard. What actually
 * works is a two-stage rule, and both stages are needed:
 *
 *  1. **Take the whole run of non-space characters.** Anything else truncates a real URL:
 *     query strings hold `=`, `&`, `;` and `,`; the Wayback Machine embeds an entire second
 *     URL inside the path.
 *  2. **Give back the trailing characters that belong to the sentence rather than to the
 *     URL.** A `.` or `,` at the very end is punctuation, because no useful URL ends in
 *     one. A closing bracket is only punctuation when nothing in the URL opened it —
 *     which is what keeps Wikipedia's `…/Foo_(disambiguation)` intact while
 *     `(see https://example.com/x)` gives its bracket back to the prose.
 *
 * The stripped characters are never discarded: `linkSpans` hands them back as text, so
 * the rendered sentence still reads exactly as the parser wrote it. The link is a *span*
 * of the claim, not a replacement for it.
 *
 * ## The scheme allowlist is a security boundary, not tidiness
 *
 * Claim text is built from bytes a website chose to return. `linkHref` is therefore an
 * allowlist of `http` and `https` and nothing else — a `file:` URL in a scraped bio must
 * never become something the operator can click, and `javascript:` and `data:` must never
 * reach a shell at all. The main process refuses anything else a second time
 * (`CH.appOpenExternal`), because a check that exists only in the renderer is a check that
 * exists only until someone adds a second caller.
 *
 * `Finding.source` is deliberately *not* always a link. Derived claims use a
 * `local:<adapter>` source and exiftool uses `file:<name>`; both are real source
 * identifiers and neither is a place. `sourceHref` returns null for them rather than
 * inventing a URL, and it says so where it is used.
 */

/** Schemes an operator may be given a one-click path to. Everything else is refused. */
export const OPENABLE_SCHEMES: readonly string[] = ['http:', 'https:'] as const

/**
 * Characters that end a sentence rather than a URL.
 *
 * `.` `,` `;` `:` `!` `?` and the quote family, plus the ellipsis, because `truncate()` in
 * several adapters appends one. `/` is deliberately absent — a trailing slash is part of
 * the address and removing it changes which page some servers serve.
 */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '’', '”', '…', '·'])

/** Brackets whose closing half is punctuation only when the URL never opened one. */
const BRACKETS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' }

/**
 * A run of characters that could be a URL: a scheme, then anything that is not
 * whitespace, a quote, or an angle bracket.
 *
 * Bare `www.` and bare hostnames are not matched. A hostname written into a sentence is
 * usually the *source* of a claim rather than a page to open, and the app already renders
 * that separately; guessing a scheme for it would mean fabricating an address that no tool
 * reported. `sourceHref` does that on purpose and only for a value the app itself knows to
 * be a host.
 */
const URL_RUN = /\bhttps?:\/\/[^\s<>"'`]+/gi

/**
 * Strip the punctuation that belongs to the sentence off the end of a URL run.
 *
 * Repeats until nothing more comes off, so `(https://example.com/a).` loses the `.` and
 * then the `)`. A run that is nothing but punctuation comes back empty and is dropped by
 * the caller.
 */
export function trimUrlPunctuation(run: string): string {
  let end = run.length
  for (;;) {
    const ch = run[end - 1]
    if (ch === undefined) break
    if (TRAILING_PUNCTUATION.has(ch)) {
      end--
      continue
    }
    const opener = BRACKETS[ch]
    if (opener !== undefined) {
      const body = run.slice(0, end - 1)
      // Balanced: the URL opened this bracket itself, so it is part of the address.
      let depth = 0
      for (const c of body) {
        if (c === opener) depth++
        else if (c === ch) depth--
      }
      if (depth > 0) break
      end--
      continue
    }
    break
  }
  return run.slice(0, end)
}

/**
 * The URL to open for a string, or null when there is nothing safe to open.
 *
 * Parsing rather than pattern-matching: `new URL` is what the main process and Chromium
 * will do with the string, so anything this accepts and they read differently is a bug in
 * this function rather than a difference of opinion.
 */
export function linkHref(raw: string): string | null {
  const trimmed = trimUrlPunctuation(raw.trim())
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!OPENABLE_SCHEMES.includes(url.protocol)) return null
  // A URL with no host is `http:///x` and similar — parseable, and not a place.
  if (!url.hostname) return null
  return url.toString()
}

/** True when the whole string is one openable URL. */
export function isOpenableUrl(raw: string): boolean {
  return linkHref(raw) !== null
}

/**
 * A `Finding.source` as something to open, or null.
 *
 * Sources are folded to a bare host by `support/sources.ts`, so the site is reachable but
 * the *profile* is not — the host is `github.com`, never `github.com/torvalds`. Callers
 * must say that out loud rather than letting the operator believe a source link goes to
 * the page the claim is about. Namespaced sources (`local:…`, `file:…`) return null: they
 * identify where information came from and they are not addresses.
 */
export function sourceHref(source: string): string | null {
  const s = source.trim()
  if (!s || s.includes(':') || s.includes('/') || s.includes(' ')) {
    // `already://a/url` and `local:pattern-timezone` alike: if it carries a scheme or a
    // path it is either already a URL (handled by linkHref) or not a host at all.
    return linkHref(s)
  }
  // A host needs a dot and no characters a hostname cannot hold.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(s)) return null
  return linkHref(`https://${s}`)
}

/* ------------------------------------------------------------------ *
 * Splitting a sentence into text and links
 * ------------------------------------------------------------------ */

export interface LinkSpan {
  kind: 'link'
  /** What to draw. The URL as the text wrote it, minus sentence punctuation. */
  text: string
  /** What to open and what to copy. Normalised by `new URL`. */
  href: string
}

export interface TextSpan {
  kind: 'text'
  text: string
}

export type ClaimSpan = TextSpan | LinkSpan

/**
 * Split a claim into alternating prose and links.
 *
 * The concatenation of every span's `text` equals the input exactly, including the
 * punctuation given back to the prose. That is asserted by a test, because a renderer that
 * silently drops a character from a claim is a renderer that has edited the evidence.
 *
 * A run that parses to a scheme this app will not open stays prose. It is still visible —
 * a `file:///home/user/...` in a scraped bio is a finding in itself — it simply is not
 * clickable.
 */
export function linkSpans(text: string): ClaimSpan[] {
  const out: ClaimSpan[] = []
  let at = 0
  URL_RUN.lastIndex = 0
  for (let m: RegExpExecArray | null; (m = URL_RUN.exec(text)); ) {
    const run = m[0]
    const start = m.index
    const shown = trimUrlPunctuation(run)
    const href = shown ? linkHref(shown) : null
    if (!href) continue
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) })
    out.push({ kind: 'link', text: shown, href })
    at = start + shown.length
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

/** True when a string holds at least one openable URL. */
export function hasLink(text: string): boolean {
  return linkSpans(text).some((s) => s.kind === 'link')
}

/** The first openable URL in a string, or null. */
export function firstLink(text: string): string | null {
  for (const s of linkSpans(text)) if (s.kind === 'link') return s.href
  return null
}

/* ------------------------------------------------------------------ *
 * The address a claim ends with
 * ------------------------------------------------------------------ */

/**
 * A claim split at the URL it ends with.
 *
 * ## Why a table row needs this and the detail panel does not
 *
 * A findings row is one line, and a claim is three to five times wider than the column it
 * gets. So the claim is drawn with `text-overflow: ellipsis` — and an ellipsis eats the
 * end of the sentence, which is precisely where every adapter now puts its URL. Measured
 * on the running app: 1039px of claim into a 294px cell. The link was rendered, was
 * clickable, and was *off the end of the row*, so the operator's original complaint —
 * "otherwise I have to expand the box" — survived the fix that was supposed to remove it.
 *
 * Truncating the prose is right; truncating the address is not. They are different kinds
 * of content in the same cell: the prose is a sentence that reads fine abbreviated, and
 * the URL is the one thing on the row that is useless unless it is whole. So they become
 * two flex items — the sentence shrinks, the address does not.
 *
 * ## Only when the URL genuinely ends the claim
 *
 * Pinning an address that has prose after it would reorder the sentence the parser wrote,
 * and this app does not edit evidence to make it fit. So a link only qualifies when
 * nothing but sentence punctuation follows it, and that punctuation is handed back
 * (`after`) to be drawn against the link exactly where it was written. Anything else
 * returns null and the caller falls back to rendering the claim inline, which is still
 * correct — just still truncated.
 *
 * The three parts concatenate back to the input exactly, and a test asserts it.
 */
export interface TrailingLink {
  /** Everything before the address, verbatim. May hold links of its own. */
  prose: string
  link: LinkSpan
  /** What followed it — sentence punctuation only, and usually nothing at all. */
  after: string
}

/**
 * How much may follow the URL and still count as "the claim ends here".
 *
 * Three characters covers `.`, `).` and `…`. Anything longer is prose, and prose after an
 * address means the address is mid-sentence.
 */
const MAX_TRAILING_RESIDUE = 3

export function trailingLink(text: string): TrailingLink | null {
  const spans = linkSpans(text)
  let last = -1
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i]!.kind === 'link') {
      last = i
      break
    }
  }
  if (last < 0) return null
  const after = spans
    .slice(last + 1)
    .map((s) => s.text)
    .join('')
  // A letter or a digit after the URL is a sentence continuing, not punctuation closing.
  if (after.trim().length > MAX_TRAILING_RESIDUE || /[\p{L}\p{N}]/u.test(after)) return null
  return {
    prose: spans
      .slice(0, last)
      .map((s) => s.text)
      .join(''),
    link: spans[last] as LinkSpan,
    after
  }
}

/** Longest label a pinned address may draw before it is elided. */
export const MAX_LINK_LABEL = 38

/**
 * A URL shortened to the part that tells the operator which page it is.
 *
 * The scheme is noise — everything openable here is `http` or `https`, and the app says so
 * in the title — and `www.` is noise on top of that. What is left is host and path, which
 * is the part that differs between two rows and therefore the only part worth the width.
 *
 * When even that is too long the *middle* goes rather than the end, because the last path
 * segment is almost always the identifying one: a handle, a snapshot id, a file name.
 * Truncating from the right would leave every Wayback URL rendering as the same prefix.
 *
 * The full address is never lost — it is the title, and it is what the copy button puts on
 * the clipboard.
 */
export function shortLinkLabel(href: string, max: number = MAX_LINK_LABEL): string {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return href
  }
  const host = url.host.replace(/^www\./i, '')
  const tail = `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`
  const whole = `${host}${tail}`
  if (whole.length <= max) return whole
  // A host that alone fills the budget leaves nothing to be clever with.
  if (host.length + 4 >= max) return `${whole.slice(0, Math.max(1, max - 1))}…`
  const segments = tail.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  if (segments.length > 1) {
    const elided = `${host}/…/${last}`
    if (elided.length <= max) return elided
  }
  return `${host}/…${last.slice(-(max - host.length - 2))}`
}

/**
 * The label for an address drawn on a row that already names its source host.
 *
 * A findings row has a `Source` cell holding the site the claim came from, folded to its
 * origin — `steamcommunity.com`. Printing `steamcommunity.com/id/krisi_2007` beside it
 * says the host twice and spends the width that made the address unreachable in the first
 * place: the claim column is around 290px at 1440 with the margin open, and a repeated
 * host does not fit in it twice.
 *
 * So when the address is on the site the row already names, only the path is drawn. The
 * two cells read as one sentence — `steamcommunity.com` `/id/krisi_2007` — and the part
 * that differs between rows gets the room.
 *
 * When the hosts differ the whole thing is drawn, because that difference is itself
 * information: a media file served off a CDN, a Wayback snapshot of another site, a
 * declared link pointing somewhere else entirely. Those are the rows where the host is the
 * most interesting thing on the line, and eliding it would hide exactly the wrong one.
 *
 * `www.` is not a difference. Nothing else is normalised — a different subdomain is a
 * different place and is shown as one.
 */
export function linkLabelFor(href: string, source: string, max: number = MAX_LINK_LABEL): string {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return shortLinkLabel(href, max)
  }
  const bare = (h: string): string => h.trim().toLowerCase().replace(/^www\./, '')
  if (!source || bare(url.host) !== bare(source)) return shortLinkLabel(href, max)
  const path = `${url.pathname}${url.search}${url.hash}`
  if (path === '' || path === '/') return shortLinkLabel(href, max)
  if (path.length <= max) return path
  // Keep the tail: the identifying segment is at the end of a profile or snapshot path.
  return `…${path.slice(-(max - 1))}`
}

/**
 * Whether a string leaves punctuation fused to a URL.
 *
 * Used by the adapter test that walks every claim every parser produces against the
 * captured fixtures. The renderer trims anyway, so this is not what makes links work — it
 * is what keeps the *text* correct in an export, in the clipboard, and anywhere else the
 * claim is read outside this app's own table.
 */
export function fusedPunctuation(text: string): string[] {
  const bad: string[] = []
  URL_RUN.lastIndex = 0
  for (let m: RegExpExecArray | null; (m = URL_RUN.exec(text)); ) {
    const run = m[0]
    const shown = trimUrlPunctuation(run)
    if (shown !== run) bad.push(run)
  }
  return bad
}

/**
 * The search layer: asking a search engine a question and reading the answer.
 *
 * Two adapters use this — `websearch`, which turns a person into queries, and `dorks`,
 * which turns operators into queries. Neither knows how DuckDuckGo's HTML is shaped, and
 * neither knows what to do about a 429, because both of those things belong here.
 *
 * ## What was actually available, measured rather than assumed
 *
 * Every candidate was probed from this machine on 2026-09-03 with the app's own honest
 * User-Agent. The results were not what reputation predicts:
 *
 * | Backend | Result |
 * |---|---|
 * | `html.duckduckgo.com/html/` | **200, ~32 kB, 9–10 parseable results.** Works. |
 * | `lite.duckduckgo.com/lite/` | **200, ~23 kB, same results, smaller markup.** Works. |
 * | `wiby.me/json/` | **200, real JSON, no key, no blocking.** Works, tiny index. |
 * | SearXNG public instances | **2 of 80 answered `format=json`.** The other 78 returned `429 Too Many Requests` or a bot interstitial on the *first* request. |
 * | `www.mojeek.com/search` | 200 with a JavaScript captcha page. No usable results. |
 * | `api.qwant.com/v3/search/web` | 403. |
 * | `search.brave.com/search` | 429 on the first request. |
 * | `api.marginalia.nu` / `api2.marginalia-search.com` | Connection timeout / 404 on every documented path. |
 *
 * So the chain is DuckDuckGo first, DuckDuckGo's lite endpoint second, Wiby third, and a
 * SearXNG instance pool last and off by default. Brave's API is deliberately absent: its
 * remaining free tier requires a payment card on file, and this project takes no payment
 * details anywhere (DECISIONS.md #10).
 *
 * ## Rate limiting, as observed rather than as documented
 *
 * DuckDuckGo publishes no limit. What it does is answer `202` with a page saying
 * *"Please complete the following challenge to confirm this search was made by a human"*
 * — a CAPTCHA, served with a success-shaped status code. In testing it appeared once,
 * after two requests fired back to back at two different DuckDuckGo endpoints, and then
 * did not reappear across four bands of four queries at 0 ms, 1.5 s, 3 s and 5 s spacing.
 * That is not a rate limit with a threshold; it is a bursty heuristic. The defence is
 * therefore not a magic number but three habits: a real gap between queries, stopping the
 * moment a challenge appears, and — most importantly — **reporting the challenge as a
 * refusal rather than as an absence of results.** A blocked search that renders as "no
 * results" is the single most dangerous thing this file could do.
 *
 * ## Why the source is the engine, not the page
 *
 * A search result is not a fact about the page. It is the engine's opinion that the page
 * is relevant to the query, and nothing here fetches the page to check. So findings built
 * from these hits carry the **engine's** host in `Finding.source`, never the result's.
 * Setting the result's host would let a stale index entry for `github.com/x` silently
 * corroborate a live probe of `github.com/x` — manufacturing exactly the agreement that
 * `support/sources.ts` exists to prevent. Two different engines returning the same URL is
 * real corroboration and still works; an engine and a prober agreeing is not, and now
 * cannot happen by accident.
 */

import { httpGet, politeDelay, DEFAULT_USER_AGENT } from './net'
import { accountFromUrl } from './profiles'

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** One row of a results page, as the engine presented it. Nothing is fetched or verified. */
export interface SearchHit {
  /** Backend id that returned it. */
  backend: string
  /** 1-based position on the page. Rank is the engine's opinion, and is recorded as such. */
  rank: number
  url: string
  title: string
  snippet: string
  /** The URL as the engine displayed it, which is sometimes truncated with an ellipsis. */
  displayUrl: string
  /** Upstream engine name, where the backend is a metasearch that names its sources. */
  via: string | null
}

/**
 * Why a backend produced nothing.
 *
 * Split from "zero results" on purpose, and carried all the way into the findings. "The
 * engine refused to answer" and "the engine answered, and knows of no such page" are
 * completely different facts about the world, and only one of them says anything about
 * the subject.
 */
export type RefusalKind = 'challenge' | 'rate-limited' | 'blocked' | 'transport' | 'unreadable'

export interface BackendAttempt {
  backend: string
  /** The host that answered. Becomes `Finding.source` for anything read out of this attempt. */
  host: string
  url: string
  status: number
  /** `null` when the backend answered normally, whether or not it had results. */
  refusal: RefusalKind | null
  /** Human-readable, and shown verbatim in a finding when there was a refusal. */
  detail: string
  /** Key into `RunEnvelope.artifacts` holding the verbatim response body. */
  artifact: string | null
  durationMs: number
}

/** A backend is a URL builder plus a pure parser. The parser is what the tests exercise. */
export interface SearchBackend {
  id: string
  /** The operator that answers, folded the way `Finding.source` wants it. */
  host: string
  label: string
  /** Human-readable note about what this backend actually indexes. */
  about: string
  accept: string
  buildUrl(query: string, instance?: string): string
  /** Pure. Given a body and a status, either hits or a refusal. Never throws. */
  read(body: string, status: number): { hits: SearchHit[]; refusal: RefusalKind | null; detail: string }
}

/* ------------------------------------------------------------------ *
 * HTML helpers
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”'
}

/**
 * Decode the entity forms that actually appear in a results page.
 *
 * Numeric forms matter more here than in most HTML: DuckDuckGo escapes apostrophes as
 * `&#x27;` inside snippets, so a name like `O&#x27;Brien` would otherwise be searched for,
 * matched against and shown to the operator in a form nobody ever typed.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/** Tags out, entities decoded, whitespace collapsed. Search snippets are full of `<b>`. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Undo DuckDuckGo's click-tracking wrapper.
 *
 * Every result href is `//duckduckgo.com/l/?uddg=<percent-encoded target>&rut=<hmac>`.
 * Storing that instead of the target would mean every finding in the case file points at
 * DuckDuckGo, the URLs would not dedupe against anything another adapter found, and
 * `accountFromUrl` would see `duckduckgo.com` and propose nothing. Returns the input
 * unchanged when it is not a wrapper, so it is safe to call on everything.
 */
export function unwrapRedirect(href: string): string {
  const raw = (href ?? '').trim()
  if (!raw) return ''
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw
  let u: URL
  try {
    u = new URL(absolute)
  } catch {
    return raw
  }
  const target = u.searchParams.get('uddg')
  if (target) {
    try {
      return new URL(target).toString()
    } catch {
      return target
    }
  }
  return absolute
}

/** Every `<a …>…</a>` carrying the given class, with its href and inner HTML. */
function anchors(html: string, className: string): { href: string; inner: string }[] {
  // The class attribute is single-quoted on the lite endpoint and double-quoted on the
  // html one, and on the html endpoint it is not the first attribute. Both are matched
  // rather than picking one and quietly returning zero results on the other.
  const re = new RegExp(
    `<a\\b[^>]*?\\bclass\\s*=\\s*["']${className}["'][^>]*>([\\s\\S]*?)<\\/a>`,
    'gi'
  )
  const out: { href: string; inner: string }[] = []
  for (const m of html.matchAll(re)) {
    const tag = m[0] ?? ''
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    out.push({ href: decodeEntities(href), inner: m[1] ?? '' })
  }
  return out
}

/**
 * Elements of one tag name carrying the given class, with their inner HTML.
 *
 * Deliberately only used on leaf elements — a `<td>` or a `<span>` whose content is text.
 * A non-greedy match to the first closing tag is wrong the moment the element nests one
 * of its own kind inside it, which is why the result *rows* are split by index below
 * instead of matched this way.
 */
function blocks(html: string, tag: string, className: string): string[] {
  const re = new RegExp(
    `<${tag}\\b[^>]*?\\bclass\\s*=\\s*["']${className}["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
    'gi'
  )
  return [...html.matchAll(re)].map((m) => m[1] ?? '')
}

/**
 * Cut a results page into one string per result.
 *
 * Rows are found by the index of their opening tag and sliced to the next one, rather
 * than by matching a balanced element. DuckDuckGo's result row contains four levels of
 * nested `<div>`, so any regex that stops at the first `</div>` cuts the row in half and
 * loses the snippet — which is the failure mode that makes a parser look like it works
 * while quietly returning titles with no context attached.
 */
function splitRows(html: string, opener: RegExp): string[] {
  const starts: number[] = []
  for (const m of html.matchAll(opener)) {
    if (typeof m.index === 'number') starts.push(m.index)
  }
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length))
}

/* ------------------------------------------------------------------ *
 * Refusal detection
 * ------------------------------------------------------------------ */

const CHALLENGE_MARKERS =
  /complete the following challenge|confirm this search was made by a human|Making sure you.{0,5}re not a bot|Just a moment|cf-browser-verification|challenges\.cloudflare|JavaScript is required to complete this challenge|unusual traffic/i

/**
 * Decide whether a response is a refusal, before any attempt is made to read results out
 * of it.
 *
 * The `202` case is the one worth knowing about: DuckDuckGo serves its CAPTCHA with a
 * 2xx status, so a parser that trusts `res.ok` reads a challenge page, finds no result
 * rows in it, and reports "no results" for a search that never happened.
 */
export function refusalOf(status: number, body: string): { refusal: RefusalKind | null; detail: string } {
  if (status === 429) {
    return { refusal: 'rate-limited', detail: `answered HTTP 429 Too Many Requests` }
  }
  if (status === 403 || status === 401) {
    return { refusal: 'blocked', detail: `answered HTTP ${status}, refusing this client outright` }
  }
  if (CHALLENGE_MARKERS.test(body)) {
    return {
      refusal: 'challenge',
      detail: `answered HTTP ${status} with an anti-bot challenge page instead of results`
    }
  }
  if (status === 202) {
    return { refusal: 'challenge', detail: 'answered HTTP 202 with a non-results page' }
  }
  if (status < 200 || status >= 300) {
    return { refusal: 'blocked', detail: `answered HTTP ${status}` }
  }
  return { refusal: null, detail: '' }
}

/* ------------------------------------------------------------------ *
 * The backends
 * ------------------------------------------------------------------ */

/** Hosts whose "results" are the engine talking about itself. Never a hit. */
const SELF_HOSTS = /(^|\.)(duckduckgo\.com|wiby\.me)$/i

function usableHit(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    return !SELF_HOSTS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * `html.duckduckgo.com/html/` — the no-JavaScript results page.
 *
 * Not an API and never advertised as one; it is the page DuckDuckGo serves to a browser
 * with scripting off, which is why it is stable enough to parse and why it can be taken
 * away without notice. One page, nine or ten organic results, no key, no cookie.
 */
const ddgHtml: SearchBackend = {
  id: 'ddg-html',
  host: 'duckduckgo.com',
  label: 'DuckDuckGo (no-JavaScript results page)',
  about:
    'DuckDuckGo’s own crawl blended with a Bing-derived index, served as plain HTML to a client with scripting disabled.',
  accept: 'text/html,application/xhtml+xml;q=0.9',
  buildUrl(query) {
    // `kl=wt-wt` is "no region": without it the results are localised to whatever the
    // exit IP looks like, which silently changes the answer between two machines.
    return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`
  },
  read(body, status) {
    const r = refusalOf(status, body)
    if (r.refusal) return { hits: [], refusal: r.refusal, detail: r.detail }
    const rows = splitRows(body, /<div\b[^>]*\bclass\s*=\s*["']result[ "']/gi)
    const hits: SearchHit[] = []
    for (const row of rows) {
      // A sponsored row carries `result--ad`. An advert is not an observation about the
      // subject, and paying to appear for a name is the opposite of evidence.
      if (/result--ad|result--sponsored/i.test(row)) continue
      const link = anchors(row, 'result__a')[0]
      if (!link) continue
      const url = unwrapRedirect(link.href)
      if (!usableHit(url)) continue
      hits.push({
        backend: 'ddg-html',
        rank: hits.length + 1,
        url,
        title: textOf(link.inner),
        snippet: textOf(anchors(row, 'result__snippet')[0]?.inner ?? ''),
        displayUrl: textOf(anchors(row, 'result__url')[0]?.inner ?? ''),
        via: null
      })
    }
    const empty = /\bno-results\b|No results\./i.test(body)
    return {
      hits: dedupe(hits),
      refusal: hits.length === 0 && !empty ? 'unreadable' : null,
      detail:
        hits.length === 0 && !empty
          ? 'answered normally but no result rows could be read out of the page, which usually means the markup changed'
          : ''
    }
  }
}

/**
 * `lite.duckduckgo.com/lite/` — the same index, rendered as a table.
 *
 * Kept as a second backend rather than a second URL for the same one because its markup
 * is completely different: results are `<tr>` rows with `class='result-link'`, snippets
 * live in a following row, and the whole page is a third smaller. When DuckDuckGo changes
 * the html endpoint's classes, this one usually still parses.
 */
const ddgLite: SearchBackend = {
  id: 'ddg-lite',
  host: 'duckduckgo.com',
  label: 'DuckDuckGo (lite table view)',
  about: 'The same DuckDuckGo index as the html endpoint, rendered as a plain table for very old browsers.',
  accept: 'text/html',
  buildUrl(query) {
    return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=wt-wt`
  },
  read(body, status) {
    const r = refusalOf(status, body)
    if (r.refusal) return { hits: [], refusal: r.refusal, detail: r.detail }
    const links = anchors(body, 'result-link')
    const snippets = blocks(body, 'td', 'result-snippet')
    const displays = blocks(body, 'span', 'link-text')
    const hits: SearchHit[] = []
    for (let i = 0; i < links.length; i++) {
      const url = unwrapRedirect(links[i]?.href ?? '')
      if (!usableHit(url)) continue
      hits.push({
        backend: 'ddg-lite',
        rank: hits.length + 1,
        url,
        title: textOf(links[i]?.inner ?? ''),
        // Positional: the lite page emits exactly one snippet row per result row, in
        // order. It is checked against the link count rather than assumed, so a page with
        // an extra promotional row degrades to an empty snippet instead of a shifted one.
        snippet: snippets.length === links.length ? textOf(snippets[i] ?? '') : '',
        displayUrl: displays.length === links.length ? textOf(displays[i] ?? '') : '',
        via: null
      })
    }
    const empty = /No results\.|no results found/i.test(body)
    return {
      hits: dedupe(hits),
      refusal: hits.length === 0 && !empty ? 'unreadable' : null,
      detail: hits.length === 0 && !empty ? 'answered normally but contained no readable result rows' : ''
    }
  }
}

/**
 * `wiby.me` — a hand-curated index of small, mostly hand-written pages.
 *
 * Included because it is the only backend on this list with a documented, genuinely
 * keyless JSON endpoint and no bot detection at all, and because its index is *disjoint*
 * from everyone else's: personal homepages, club pages, university department listings
 * and old forums, which is precisely the kind of page that carries a real name next to a
 * town. It will return nothing at all for most queries, and that is expected.
 */
const wiby: SearchBackend = {
  id: 'wiby',
  host: 'wiby.me',
  label: 'Wiby (curated small-web index)',
  about: 'A small, human-curated index of personal and hobbyist pages, with a documented keyless JSON endpoint.',
  accept: 'application/json',
  buildUrl(query) {
    return `https://wiby.me/json/?q=${encodeURIComponent(query)}`
  },
  read(body, status) {
    const r = refusalOf(status, body)
    if (r.refusal) return { hits: [], refusal: r.refusal, detail: r.detail }
    let rows: unknown
    try {
      rows = JSON.parse(body)
    } catch {
      // An empty result set is served as an empty body rather than `[]`.
      if (!body.trim()) return { hits: [], refusal: null, detail: '' }
      return { hits: [], refusal: 'unreadable', detail: 'answered with a body that is not JSON' }
    }
    if (!Array.isArray(rows)) return { hits: [], refusal: null, detail: '' }
    const hits: SearchHit[] = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const rec = row as Record<string, unknown>
      const url = typeof rec['URL'] === 'string' ? rec['URL'] : ''
      if (!usableHit(url)) continue
      hits.push({
        backend: 'wiby',
        rank: hits.length + 1,
        url,
        title: decodeEntities(String(rec['Title'] ?? '')).trim(),
        snippet: decodeEntities(String(rec['Snippet'] ?? '')).replace(/\s+/g, ' ').trim(),
        displayUrl: '',
        via: null
      })
    }
    return { hits: dedupe(hits), refusal: null, detail: '' }
  }
}

/**
 * A SearXNG instance — a metasearch front end that forwards the query to Google, Bing,
 * Brave and others under its own IP and returns their results merged.
 *
 * Valuable when it works, because it reaches indexes nothing else here can. It mostly
 * does not work: `format=json` is **off by default** in SearXNG's own configuration, and
 * the shipped `limiter` answers an unknown client `429` on its very first request. Of the
 * 80 public instances listed by searx.space on 2026-09-03, exactly two answered a JSON
 * search. So this is off unless the operator turns it on, and the two that answered are
 * seeded as the default pool with no promise that they still will.
 *
 * The honest fix is a self-hosted instance, where `search.formats` is the operator's to
 * set. `instances` is a config option for exactly that.
 */
const searxng: SearchBackend = {
  id: 'searxng',
  host: 'searxng',
  label: 'SearXNG (metasearch instance)',
  about: 'A self-hostable metasearch front end that queries Google, Bing and others on your behalf and merges the results.',
  accept: 'application/json',
  buildUrl(query, instance) {
    const base = (instance ?? '').replace(/\/+$/, '')
    return `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`
  },
  read(body, status) {
    const r = refusalOf(status, body)
    if (r.refusal) return { hits: [], refusal: r.refusal, detail: r.detail }
    let doc: unknown
    try {
      doc = JSON.parse(body)
    } catch {
      // The nastiest failure mode this file has to handle: `200 OK` with an anti-bot
      // interstitial in the body. Status and content-type both look healthy.
      return {
        hits: [],
        refusal: 'unreadable',
        detail: 'answered HTTP 200 with HTML instead of JSON, which is how a SearXNG instance says the JSON format is disabled or the limiter caught us'
      }
    }
    const results = (doc as { results?: unknown })?.results
    if (!Array.isArray(results)) return { hits: [], refusal: null, detail: '' }
    const hits: SearchHit[] = []
    for (const row of results) {
      if (!row || typeof row !== 'object') continue
      const rec = row as Record<string, unknown>
      const url = typeof rec['url'] === 'string' ? rec['url'] : ''
      if (!usableHit(url)) continue
      const engines = Array.isArray(rec['engines'])
        ? (rec['engines'] as unknown[]).filter((e): e is string => typeof e === 'string')
        : typeof rec['engine'] === 'string'
          ? [rec['engine']]
          : []
      hits.push({
        backend: 'searxng',
        rank: hits.length + 1,
        url,
        title: String(rec['title'] ?? '').trim(),
        snippet: String(rec['content'] ?? '').replace(/\s+/g, ' ').trim(),
        displayUrl: '',
        via: engines.length ? engines.join(', ') : null
      })
    }
    return { hits: dedupe(hits), refusal: null, detail: '' }
  }
}

export const SEARCH_BACKENDS: readonly SearchBackend[] = [ddgHtml, ddgLite, wiby, searxng]

export function backendById(id: string): SearchBackend | null {
  return SEARCH_BACKENDS.find((b) => b.id === id) ?? null
}

/**
 * Order tried when the operator does not name one.
 *
 * DuckDuckGo first because it answers immediately and has the broadest index here, its
 * lite endpoint second because it is different markup over the same index, and Wiby last
 * because it will almost always answer and will almost rarely have anything — the right
 * shape for a floor.
 *
 * **SearXNG is deliberately not in it**, despite being the only backend here that reaches
 * Google and Bing. See `DEFAULT_SEARX_INSTANCES`.
 */
export const DEFAULT_BACKEND_CHAIN = ['ddg-html', 'ddg-lite', 'wiby'] as const

/**
 * The public SearXNG instances that answered a JSON search when this was written — and
 * the reason none of them is trusted by default.
 *
 * Two of the eighty listed by searx.space answered at all on 2026-09-03. Of those two,
 * `search.mectov.my.id` was intermittent, and `sx.xo.st` — the one that answered
 * reliably, forwarding to Bing — turned out to be **searching only the first word of the
 * query**. `"John Smith" Chicago` returned Bible passages about John the Apostle;
 * `"Linus Torvalds" Helsinki` returned Linus Tech Tips; `site:github.com torvalds`
 * ignored the scope entirely. Every response was a confident, well-formed, plausible page
 * of results for a question nobody asked.
 *
 * That is a worse failure than a refusal, and it is why this backend is opt-in: a 429
 * announces itself, and a silently rewritten query does not. `complianceOf` below exists
 * because of this instance and now guards every backend.
 *
 * The honest way to use SearXNG is to run one. On your own instance `search.formats` is
 * yours to set, there is no limiter deciding you are a robot, and the engines it forwards
 * to are ones you chose. Set `options.instances` and add `searxng` to `options.backends`.
 */
export const DEFAULT_SEARX_INSTANCES = ['https://sx.xo.st', 'https://search.mectov.my.id'] as const

/* ------------------------------------------------------------------ *
 * Did the engine answer the question that was asked?
 * ------------------------------------------------------------------ */

export interface Compliance {
  /** `false` when the query used no operator worth checking. */
  checked: boolean
  /** Hits that satisfy at least one operator in the query. */
  matched: number
  total: number
  /** The engine answered, and appears to have answered something else. */
  ignored: boolean
  /** Which operators were checked, for the claim that reports this. */
  operators: string[]
}

/** Quoted phrases in a query, unquoted. `"a b" c "d"` -> `['a b', 'd']`. */
export function quotedPhrases(query: string): string[] {
  return [...(query ?? '').matchAll(/"([^"]{2,})"/g)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
}

/** `site:` scopes in a query, excluding the negated ones. */
export function siteScopes(query: string): string[] {
  return [...(query ?? '').matchAll(/(^|[\s(])site:([^\s)]+)/gi)].map((m) => (m[2] ?? '').toLowerCase()).filter(Boolean)
}

/**
 * Check the results against the operators the query actually used.
 *
 * A search engine that does not support an operator **drops it silently and answers a
 * broader question**, which is the single most dangerous behaviour in this whole file:
 * the response is a normal 200 with normal-looking results, and nothing about it says the
 * query was rewritten. A refusal is loud and safe; this is quiet and wrong.
 *
 * So the operators that can be verified from the results are verified. A quoted phrase
 * must appear somewhere in a hit's title, snippet or URL; a `site:` scope must be
 * satisfied by the hit's hostname. If *not one* hit satisfies *any* checked operator, the
 * response is marked `ignored` — not a refusal, because an answer did arrive, but an
 * answer to a different question, and the callers stop proposing entities from it.
 *
 * The test is deliberately weak in one direction: a single matching hit clears the whole
 * response. Snippets are truncated, phrases get hyphenated across a line break, and a
 * legitimate result can carry the phrase only in the body — so a strict ratio would
 * condemn honest engines. What it is looking for is the case where the answer has nothing
 * to do with the question at all, and that case is unambiguous.
 */
export function complianceOf(query: string, hits: readonly SearchHit[]): Compliance {
  const written = quotedPhrases(query)
  const phrases = written.map((p) => p.toLowerCase())
  const scopes = siteScopes(query)
  // Described as the operator wrote them — these strings go into a finding a person reads,
  // and `the quoted phrase "john smith"` is not what was typed.
  const operators = [
    ...written.map((p) => `the quoted phrase "${p}"`),
    ...scopes.map((s) => `the scope site:${s}`)
  ]
  if (operators.length === 0 || hits.length === 0) {
    return { checked: false, matched: 0, total: hits.length, ignored: false, operators }
  }

  let matched = 0
  for (const hit of hits) {
    const haystack = `${hit.title} ${hit.snippet} ${hit.url} ${hit.displayUrl}`.toLowerCase()
    const phraseOk = phrases.some((p) => haystack.includes(p))
    let scopeOk = false
    if (scopes.length) {
      const host = (() => {
        try {
          return new URL(hit.url).hostname.toLowerCase()
        } catch {
          return ''
        }
      })()
      scopeOk = scopes.some((s) => host === s || host.endsWith(`.${s}`))
    }
    if (phraseOk || scopeOk) matched++
  }

  return { checked: true, matched, total: hits.length, ignored: matched === 0, operators }
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const h of hits) {
    const key = h.url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...h, rank: out.length + 1 })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Executing one query across the chain
 * ------------------------------------------------------------------ */

export interface SearchRequest {
  query: string
  /** Backend ids, in order. The first that returns hits wins. */
  chain: readonly string[]
  /** SearXNG instances to try, in order, when `searxng` is in the chain. */
  instances: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
  userAgent?: string
  /** Politeness gap applied *before* each request after the first. */
  gapMs: number
  /** Retries after a 429, honouring `Retry-After` when the server sends one. */
  maxRetries: number
  /** Called with each response body so the caller can put it in the envelope verbatim. */
  keep(backendId: string, body: string): string
}

export interface SearchOutcome {
  query: string
  hits: SearchHit[]
  attempts: BackendAttempt[]
  /** Backend that produced `hits`, or `null` when every one of them failed. */
  servedBy: string | null
}

/**
 * Hosts that have already refused this client, and why.
 *
 * Keyed on the **host**, not the backend id, and that distinction was learned from a live
 * run: `ddg-html` and `ddg-lite` are two endpoints of one operator, so when DuckDuckGo
 * served its challenge the chain dutifully failed over to the second DuckDuckGo endpoint
 * and collected an identical challenge. Striking off the host retires both at once and
 * saves a request that could only ever have been refused — the same reasoning
 * `support/sources.ts` uses to fold two hostnames onto one operator, applied to
 * politeness instead of to corroboration.
 */
export type BackendHealth = Map<string, string>

/**
 * Ask the chain, in order, until something answers with results.
 *
 * Three rules, and all three are about not making the situation worse:
 *
 *  - **A refusal poisons the backend for the rest of the run.** Once DuckDuckGo has shown
 *    a challenge, every further request is both futile and rude, so the backend is struck
 *    off in `health` and the chain moves on. The struck-off reason still appears in every
 *    subsequent attempt record, so the operator sees why it stopped being tried.
 *  - **A 429 is waited out, not retried immediately.** `Retry-After` is honoured when
 *    present; otherwise the wait doubles. Cancellation wakes it up instantly.
 *  - **Zero results is a success.** The chain stops at the first backend that answered
 *    *normally*, whether it had ten hits or none, because moving on after a legitimate
 *    "nothing found" would turn one honest answer into three redundant requests.
 */
export async function executeSearch(req: SearchRequest, health: BackendHealth): Promise<SearchOutcome> {
  const attempts: BackendAttempt[] = []
  let servedBy: string | null = null
  let hits: SearchHit[] = []
  let first = true

  for (const backendId of req.chain) {
    if (req.signal?.aborted) break
    const backend = backendById(backendId)
    if (!backend) continue

    const targets = backendId === 'searxng' ? [...req.instances] : [undefined]
    for (const instance of targets) {
      if (req.signal?.aborted) break
      const url = backend.buildUrl(req.query, instance)
      const host = instance ? hostname(instance) : backend.host

      const struck = health.get(host)
      if (struck) {
        attempts.push({
          backend: backendId,
          host,
          url: '',
          status: 0,
          refusal: 'blocked',
          detail: `not tried: ${struck}`,
          artifact: null,
          durationMs: 0
        })
        continue
      }

      let attemptsLeft = req.maxRetries
      for (;;) {
        if (!first) await politeDelay(req.gapMs, req.signal)
        first = false

        const res = await httpGet({
          url,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          userAgent: req.userAgent ?? DEFAULT_USER_AGENT,
          accept: backend.accept,
          maxBytes: 4 * 1024 * 1024
        })

        if (res.error !== null) {
          attempts.push({
            backend: backendId,
            host,
            url,
            status: res.status,
            refusal: 'transport',
            detail: res.error,
            artifact: null,
            durationMs: res.durationMs
          })
          break
        }

        const read = backend.read(res.body, res.status)
        const artifact = req.keep(instance ? `${backendId}@${host}` : backendId, res.body)
        attempts.push({
          backend: backendId,
          host,
          url,
          status: res.status,
          refusal: read.refusal,
          detail: read.refusal ? `${backend.label} ${read.detail}` : '',
          artifact,
          durationMs: res.durationMs
        })

        if (read.refusal === 'rate-limited' && attemptsLeft > 0) {
          attemptsLeft--
          const after = Number(res.headers['retry-after'])
          const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : req.gapMs * 3
          await politeDelay(wait, req.signal)
          continue
        }

        if (read.refusal) {
          // `unreadable` means the markup moved, which is not the backend's fault and not
          // something a second query will fix either — strike it off the same way.
          health.set(host, `${backend.label} ${read.detail}`)
          break
        }

        servedBy = backendId
        hits = read.hits
        break
      }

      if (servedBy) break
    }
    if (servedBy) break
  }

  return { query: req.query, hits, attempts, servedBy }
}

/**
 * `accountFromUrl`, tightened for a search result.
 *
 * `support/profiles.ts` reads a URL that a *human chose to publish as their profile* — a
 * link in a bio, a `rel="me"`, a declared homepage. In that setting a path like
 * `/people/<something>` is a profile with near-certainty, so treating `people`, `user` and
 * `profile` as handle prefixes is right.
 *
 * A search index is the opposite setting. It contains every page on a site, and a
 * reference site with a `/people/` directory of static articles produces
 * `computerhope.com/linus_torvalds.htm` as a perfectly well-formed "account" — which is
 * how the review queue fills up with articles wearing profiles' clothes. The extra rule
 * here is narrow on purpose: a handle that ends in a web file extension is a file name,
 * and a file name is not a person.
 */
export function accountFromSearchHit(url: string): { platform: string; handle: string } | null {
  const account = accountFromUrl(url)
  if (!account) return null
  if (/\.(html?|php|aspx?|jsp|cgi|shtml|xml|json|txt|pdf)$/i.test(account.handle)) return null
  return account
}

function hostname(base: string): string {
  try {
    return new URL(base).hostname
  } catch {
    return base.replace(/^https?:\/\//i, '').split('/')[0] ?? base
  }
}

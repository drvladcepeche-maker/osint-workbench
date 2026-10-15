/**
 * Query construction: turning what the case knows into strings a search engine can answer.
 *
 * Two callers, two different jobs, one file because they share every primitive:
 *
 *  - **`websearch`** needs *identity combinations* — a name is useless alone and becomes
 *    a real query the moment a town, a school or a handle is welded to it.
 *  - **`dorks`** needs *operator-scoped* queries — `site:`, `filetype:`, `inurl:`,
 *    `intitle:` — which narrow a search to a shape of page rather than a subject.
 *
 * ## Why a bare name is not a query
 *
 * This is the correction the whole search path exists to make. Seeding a person's name
 * into a case used to contribute nothing to what got *queried*: every adapter took a
 * username, an email, a domain or a file, so the name could only ever be matched against
 * text something else had already fetched. For a human being that is backwards. A name is
 * a *join key*, not a search term — `"Иван Петров"` matches tens of thousands of people
 * and the first page will be data-broker aggregators. `"Иван Петров" "Варна"` matches
 * approximately one neighbourhood. The combination is the technique; the name is only the
 * half of it that a human happens to already know.
 *
 * So `personQueries` refuses to build a query out of a name alone unless there is nothing
 * to combine it with, and when it does, it says in the query's own `why` that this one is
 * expected to be noise.
 *
 * ## What the operators actually do
 *
 * Every template carries an `explains` line, and it is not decoration — it is the reason
 * this feature exists in a learning instrument rather than a search box. Support varies
 * by engine and is stated where it matters: `site:`, `filetype:`/`ext:`, `intitle:`,
 * `inurl:` and quoted phrases work on Google, Bing and DuckDuckGo; `OR` grouping is
 * reliable on Google and Bing and flaky on DuckDuckGo, so grouped dorks are built for the
 * open-in-a-browser path and split into one-per-site for the run-it path.
 */

import type { EntityKind } from '../../../shared/types'

/* ------------------------------------------------------------------ *
 * What the case knows
 * ------------------------------------------------------------------ */

/**
 * The case's own seeds, flattened into the handful of lists a query builder can use.
 *
 * Assembled by the adapter from `entities.json`, which is why it is a plain data shape
 * with no entity types in it: `parse()` must be able to rebuild the same queries from the
 * raw capture years later, and it will not have a case folder to read.
 */
export interface DorkContext {
  /** Full names, as a human would write them. */
  names: string[]
  /** Handles, without any platform. */
  handles: string[]
  emails: string[]
  domains: string[]
  /** Towns, cities, regions. */
  places: string[]
  /** Schools, employers, clubs. */
  organisations: string[]
  phones: string[]
  /** The value the run was actually pointed at, for templates that want just the subject. */
  subject: string
  subjectKind: EntityKind
}

export function emptyContext(subject: string, subjectKind: EntityKind): DorkContext {
  return {
    names: [],
    handles: [],
    emails: [],
    domains: [],
    places: [],
    organisations: [],
    phones: [],
    subject,
    subjectKind
  }
}

/* ------------------------------------------------------------------ *
 * Quoting
 * ------------------------------------------------------------------ */

/**
 * Wrap a phrase in quotes so the engine matches the words adjacently and in order.
 *
 * Without this, `Linus Torvalds` is a request for pages containing both words anywhere,
 * which for a two-word name is a completely different and much larger result set. Inner
 * quotes are stripped rather than escaped — no major engine supports escaping inside a
 * phrase, and a stray quote silently truncates the query on all of them.
 */
export function phrase(s: string): string {
  const clean = (s ?? '').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  // A single word with no punctuation gains nothing from quoting and loses stemming.
  return /\s|[.'-]/.test(clean) ? `"${clean}"` : clean
}

/** Join the non-empty parts of a query with spaces. */
function q(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join(' ').trim()
}

/* ------------------------------------------------------------------ *
 * Person queries — the primary technique
 * ------------------------------------------------------------------ */

export interface BuiltQuery {
  /** Stable within one run, used to key the artifact holding the response. */
  id: string
  query: string
  /** One line for the operator: what this combination is doing and why. */
  why: string
  /** `true` when the query is expected to be mostly noise and is run for completeness. */
  weak: boolean
}

const MAX_PER_AXIS = 2

/**
 * The queries worth spending a run on for a person, strongest combination first.
 *
 * Ordering is the whole value here, because the run has a budget and the budget is spent
 * top-down. A name welded to a place beats a name welded to an employer (people move
 * jobs more often than towns), which beats a name next to a handle (a handle is
 * distinctive but the pairing is rarely written down anywhere), which beats the bare
 * name (a lottery).
 */
export function personQueries(ctx: DorkContext): BuiltQuery[] {
  const names = ctx.names.length ? ctx.names : ctx.subjectKind === 'person' ? [ctx.subject] : []
  const out: BuiltQuery[] = []
  const push = (id: string, query: string, why: string, weak = false): void => {
    if (!query.trim()) return
    if (out.some((o) => o.query === query)) return
    out.push({ id, query, why, weak })
  }

  for (const name of names.slice(0, MAX_PER_AXIS)) {
    const quoted = phrase(name)
    if (!quoted) continue

    for (const place of ctx.places.slice(0, MAX_PER_AXIS)) {
      push(
        `name-place-${out.length}`,
        q(quoted, phrase(place)),
        `The name welded to a place. This is the strongest combination available for a person, because a town narrows a common name to roughly one neighbourhood and people change town far less often than they change anything else.`
      )
    }

    for (const org of ctx.organisations.slice(0, MAX_PER_AXIS)) {
      push(
        `name-org-${out.length}`,
        q(quoted, phrase(org)),
        `The name welded to a school, employer or club. Institutions publish lists — staff pages, team rosters, alumni notices, conference programmes — and those lists are indexed and rarely taken down.`
      )
    }

    for (const handle of ctx.handles.slice(0, MAX_PER_AXIS)) {
      push(
        `name-handle-${out.length}`,
        q(quoted, phrase(handle)),
        `The name beside a handle. A page carrying both is the single most useful thing this search can find, because it is the join between a real identity and an online one — and it is usually written by the subject themselves in a bio or a signature.`
      )
    }

    for (const email of ctx.emails.slice(0, 1)) {
      push(
        `name-email-${out.length}`,
        q(quoted, phrase(email)),
        `The name beside the address. Rare, and worth trying precisely because the pages that carry both tend to be documents nobody meant to publish — membership lists, minutes, mailing-list archives.`
      )
    }

    if (out.length === 0) {
      push(
        `name-alone-${out.length}`,
        quoted,
        `The name on its own. Included because there is nothing in the case to combine it with, and flagged as weak because a bare common name mostly returns people-search aggregators that will confidently show you a stranger.`,
        true
      )
    }
  }

  // A handle is distinctive in a way a name is not, so it earns its own query even when
  // the run was pointed at a person.
  for (const handle of ctx.handles.slice(0, MAX_PER_AXIS)) {
    push(
      `handle-${out.length}`,
      phrase(handle),
      `The handle as a quoted phrase. Unlike a username sweep, which asks a fixed list of sites whether the handle exists there, this asks the whole index where the string has ever been written down — forum posts, commit messages, credits, comment sections.`,
      handle.length <= 5
    )
  }

  return out
}

/** The queries worth running when the subject is a handle, an address or a domain. */
export function subjectQueries(ctx: DorkContext): BuiltQuery[] {
  const out: BuiltQuery[] = []
  const push = (id: string, query: string, why: string, weak = false): void => {
    if (query.trim() && !out.some((o) => o.query === query)) out.push({ id, query, why, weak })
  }
  const subject = ctx.subject.trim()
  if (!subject) return out

  if (ctx.subjectKind === 'username') {
    push(
      'handle-exact',
      phrase(subject),
      `The handle as a quoted phrase, asked of the whole index rather than of a site list. This finds the places a handle was *mentioned* — a forum thread, a changelog, a credit — which a username sweep structurally cannot see.`,
      subject.length <= 5
    )
    for (const place of ctx.places.slice(0, 1)) {
      push(
        'handle-place',
        q(phrase(subject), phrase(place)),
        `The handle beside a known place. Useful for a short or dictionary-word handle, where the bare query is drowned; the place is what makes the hit about this person rather than the word.`
      )
    }
    for (const name of ctx.names.slice(0, 1)) {
      push(
        'handle-name',
        q(phrase(subject), phrase(name)),
        `The handle beside the real name. A page carrying both is the join between the two identities, and it is the finding that makes everything else in the case connect.`
      )
    }
  }

  if (ctx.subjectKind === 'email') {
    push(
      'email-exact',
      phrase(subject),
      `The address as a quoted phrase. Addresses get published by accident constantly — in committed source, in PDF metadata, in mailing-list archives, in conference programmes — and unlike a name an address is unambiguous.`
    )
    const local = subject.split('@')[0] ?? ''
    if (local && local.length > 4) {
      push(
        'email-local',
        phrase(local),
        `Just the part before the @. People reuse the local part as a handle far more often than they realise, so this often finds accounts the address itself never touched.`,
        true
      )
    }
  }

  if (ctx.subjectKind === 'domain') {
    push(
      'domain-mentions',
      phrase(subject),
      `The domain as a quoted phrase, which finds who *links to it and writes about it* rather than what is on it. Directory listings, press mentions and forum recommendations all name a site without the site knowing.`
    )
    push(
      'domain-site',
      `site:${subject}`,
      `Everything the engine has indexed under this host. This is an inventory of what is publicly reachable, which is frequently larger than what the site's own navigation admits to.`
    )
  }

  if (ctx.subjectKind === 'account') {
    const handle = subject.includes('/') ? subject.slice(subject.indexOf('/') + 1) : subject
    push(
      'account-handle',
      phrase(handle),
      `The account's handle as a phrase. The profile page is already known; what this looks for is everywhere *else* the handle appears, which is where the cross-platform links live.`,
      handle.length <= 5
    )
  }

  if (ctx.subjectKind === 'organisation' || ctx.subjectKind === 'person') {
    push('subject-exact', phrase(subject), `The subject as a quoted phrase, matched adjacently rather than as loose words.`, true)
  }

  return out
}

/* ------------------------------------------------------------------ *
 * The dork library
 * ------------------------------------------------------------------ */

/**
 * One prepared search, with the mechanism it exploits written down.
 *
 * `mode` is the honest part. Some of these are worth running and parsing; some are worth
 * *looking at* — an image search, a directory listing, a results page whose value is the
 * shape of it rather than the ten URLs a parser would extract. A dork marked `open` is
 * never run automatically, and the finding it produces says so.
 */
export interface DorkTemplate {
  id: string
  title: string
  /** Which subjects it makes sense for. */
  appliesTo: EntityKind[]
  /** `run` = execute and parse. `open` = hand the operator the URL. `both` = do both. */
  mode: 'run' | 'open' | 'both'
  /** The one-line mechanism. Rendered next to every generated query. */
  explains: string
  /** Returns one or more queries, or nothing when the context lacks what it needs. */
  build(ctx: DorkContext): string[]
}

/**
 * Terms that identify the subject, whatever kind it is, **the run's own subject first**.
 *
 * The ordering is not cosmetic and it was got wrong first time: with names ahead of
 * everything, pointing the adapter at the handle `torvalds` in a case that also held the
 * person "Linus Torvalds" built every dork around the name. The operator asked about the
 * handle. Whatever the run was aimed at leads, and the rest of the case follows it.
 */
function subjectTerms(ctx: DorkContext): string[] {
  const self = ctx.subjectKind === 'account' && ctx.subject.includes('/')
    ? ctx.subject.slice(ctx.subject.indexOf('/') + 1)
    : ctx.subject
  const terms = [
    phrase(self),
    ...ctx.names.map(phrase),
    ...ctx.handles.map(phrase),
    ...ctx.emails.map(phrase)
  ].filter(Boolean)
  return [...new Set(terms)].slice(0, 2)
}

/** Sites worth scoping a handle or a name to, one dork each on the run-it path. */
const SOCIAL_SITES = [
  'facebook.com',
  'instagram.com',
  'x.com',
  'tiktok.com',
  'linkedin.com',
  'youtube.com',
  'reddit.com',
  'vk.com'
] as const

const PASTE_SITES = ['pastebin.com', 'ghostbin.com', 'justpaste.it', 'controlc.com', 'rentry.co'] as const

const DOCUMENT_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'] as const

export const DORKS: readonly DorkTemplate[] = [
  {
    id: 'social-scoped',
    title: 'The subject, scoped to one social platform at a time',
    appliesTo: ['person', 'username', 'email', 'account', 'organisation'],
    mode: 'both',
    explains:
      '`site:` restricts the whole query to one host, so the engine ranks within that platform instead of against the entire web. This finds a profile the platform\'s own search hides and — more usefully — finds *other people\'s* posts that name the subject, which no profile lookup can see.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return SOCIAL_SITES.map((s) => `site:${s} ${terms[0]}`)
    }
  },
  {
    id: 'social-grouped',
    title: 'The subject across every social platform in one query',
    appliesTo: ['person', 'username', 'email', 'account', 'organisation'],
    mode: 'open',
    explains:
      'The same `site:` restriction, OR-ed into one query so one results page compares the platforms side by side. Reliable on Google and Bing; DuckDuckGo handles long OR chains badly, which is why this one is for opening rather than parsing.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return [`${terms[0]} (${SOCIAL_SITES.map((s) => `site:${s}`).join(' OR ')})`]
    }
  },
  {
    id: 'documents',
    title: 'The subject inside published documents',
    appliesTo: ['person', 'username', 'email', 'organisation', 'domain'],
    mode: 'both',
    explains:
      '`filetype:` matches the format rather than the page, which reaches the files nobody thinks of as web pages. Rosters, minutes, grant lists, timetables and CVs get uploaded as PDFs and spreadsheets and then forgotten, and they carry full names, addresses and phone numbers in a way a web page never would.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return DOCUMENT_TYPES.slice(0, 4).map((t) => `${terms[0]} filetype:${t}`)
    }
  },
  {
    id: 'cv',
    title: 'A CV or résumé naming the subject',
    appliesTo: ['person', 'email', 'username'],
    mode: 'both',
    explains:
      'A CV is the single densest public document about a person — full name, phone, address, employment history, school, and often a photograph, all on two pages. This pairs the name with the words a CV file is titled with, in English and in Bulgarian, and restricts to document formats.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return [`${terms[0]} (CV OR resume OR résumé OR автобиография) filetype:pdf`]
    }
  },
  {
    id: 'pastes',
    title: 'The subject on paste sites',
    appliesTo: ['person', 'username', 'email', 'domain'],
    mode: 'both',
    explains:
      'Paste sites are where copied lists end up — leaked credential dumps, scraped member lists, config files pasted for help and never deleted. They are indexed like any other page, and a hit here is usually somebody else publishing data about the subject rather than the subject publishing it.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return PASTE_SITES.map((s) => `site:${s} ${terms[0]}`)
    }
  },
  {
    id: 'forum-membership',
    title: 'Forum profiles and member lists carrying the handle',
    appliesTo: ['username', 'account', 'person'],
    mode: 'both',
    explains:
      '`inurl:` matches the address rather than the page text, and forum software puts the identifier in predictable URL shapes — `memberlist`, `viewtopic`, `profile`, `u=`. Pairing that with the handle finds the small independent forums that no username sweep has on its site list.',
    build(ctx) {
      const handles = ctx.handles.length ? ctx.handles : ctx.subjectKind === 'username' ? [ctx.subject] : []
      if (!handles.length) return []
      const h = phrase(handles[0] ?? '')
      return [`${h} (inurl:memberlist OR inurl:viewtopic OR inurl:profile OR inurl:forum)`]
    }
  },
  {
    id: 'open-directories',
    title: 'Open directory listings mentioning the subject',
    appliesTo: ['person', 'username', 'organisation', 'domain'],
    mode: 'open',
    explains:
      '`intitle:"index of"` matches the page title a web server generates when a directory has no index file and directory listing was left on. What turns up is a raw file tree — backups, photo dumps, exports — that was never meant to be browsable, and is worth looking at rather than parsing.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return [`intitle:"index of" ${terms[0]}`]
    }
  },
  {
    id: 'domain-inventory',
    title: 'Everything indexed under the domain, minus the front door',
    appliesTo: ['domain'],
    mode: 'both',
    explains:
      'A `site:` query with `-site:www.…` subtracted removes the pages the site advertises and leaves the ones it does not: staging hosts, forgotten subdomains, admin panels, uploaded files. The minus operator is a set subtraction on the result set, not a text exclusion.',
    build(ctx) {
      const d = ctx.domains[0] ?? (ctx.subjectKind === 'domain' ? ctx.subject : '')
      if (!d) return []
      return [`site:${d} -site:www.${d}`]
    }
  },
  {
    id: 'domain-documents',
    title: 'Files published on the domain',
    appliesTo: ['domain', 'organisation'],
    mode: 'both',
    explains:
      'Scoping `filetype:` to one host inventories what an organisation has published as files rather than as pages. This is where staff lists, price lists, internal-looking templates and documents with author metadata still in them live.',
    build(ctx) {
      const d = ctx.domains[0] ?? (ctx.subjectKind === 'domain' ? ctx.subject : '')
      if (!d) return []
      return DOCUMENT_TYPES.slice(0, 4).map((t) => `site:${d} filetype:${t}`)
    }
  },
  {
    id: 'domain-logins',
    title: 'Login and administration pages on the domain',
    appliesTo: ['domain'],
    mode: 'open',
    explains:
      'Matching `inurl:` against the paths that authentication lives behind maps a site\'s attack surface without touching the site: every hit is a page the search engine already crawled. Looking is passive; this adapter never requests any of them.',
    build(ctx) {
      const d = ctx.domains[0] ?? (ctx.subjectKind === 'domain' ? ctx.subject : '')
      if (!d) return []
      return [`site:${d} (inurl:login OR inurl:admin OR inurl:signin OR inurl:wp-admin OR inurl:dashboard)`]
    }
  },
  {
    id: 'domain-addresses',
    title: 'Email addresses at the domain, written on any page',
    appliesTo: ['domain', 'organisation'],
    mode: 'both',
    explains:
      '`intext:` forces the term into the body rather than the title or the URL, so `intext:"@example.com"` finds pages that print an address at that domain — anywhere on the web, not just on the domain itself. Conference programmes and press releases leak far more addresses than a company\'s own contact page.',
    build(ctx) {
      const d = ctx.domains[0] ?? (ctx.subjectKind === 'domain' ? ctx.subject : '')
      if (!d) return []
      return [`intext:"@${d}" -site:${d}`]
    }
  },
  {
    id: 'code-mentions',
    title: 'The subject inside published source code',
    appliesTo: ['email', 'username', 'person', 'domain'],
    mode: 'both',
    explains:
      'Commit metadata carries a real name and an address on every single commit, and code-hosting pages are indexed. Scoping to the code hosts finds the author line the subject never thought of as public — which is how an anonymous handle gets tied to a work address.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return [`(site:github.com OR site:gitlab.com OR site:bitbucket.org) ${terms[0]}`]
    }
  },
  {
    id: 'phone',
    title: 'The phone number in the formats people actually type it',
    appliesTo: ['person', 'phone', 'organisation', 'domain'],
    mode: 'both',
    explains:
      'A phone number is written a dozen ways and a quoted search matches exactly one of them, so this expands the number into its common spacings and prefixes. A number is close to unique, which makes a single hit worth more than a page of name matches.',
    build(ctx) {
      const p = ctx.phones[0] ?? (ctx.subjectKind === 'phone' ? ctx.subject : '')
      const digits = p.replace(/\D/g, '')
      if (digits.length < 8) return []
      const tail = digits.slice(-9)
      const forms = new Set<string>([digits, tail, `0${tail}`, `+${digits}`])
      return [[...forms].map((f) => `"${f}"`).join(' OR ')]
    }
  },
  {
    id: 'images',
    title: 'Pages that carry a picture and the subject\'s name',
    appliesTo: ['person', 'username', 'organisation'],
    mode: 'open',
    explains:
      'The image tab of a normal search ranks by the text around the picture, so a name query there returns photographs captioned with that name. Worth opening rather than parsing, because judging whether two faces are the same person is the one thing here a parser cannot do.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return [terms[0] ?? '']
    }
  },
  {
    id: 'archived-mentions',
    title: 'The subject as the archives hold it',
    appliesTo: ['person', 'username', 'email', 'domain'],
    mode: 'open',
    explains:
      'Restricting to the archive hosts finds pages that were captured and then changed or deleted at the source. A search engine drops a deleted page from its index eventually; the archive keeps the copy, and the archive copy is what is indexed here.',
    build(ctx) {
      const terms = subjectTerms(ctx)
      if (!terms.length) return []
      return [`(site:web.archive.org OR site:archive.ph) ${terms[0]}`]
    }
  }
]

export function dorkById(id: string): DorkTemplate | null {
  return DORKS.find((d) => d.id === id) ?? null
}

/* ------------------------------------------------------------------ *
 * Building the library for one subject
 * ------------------------------------------------------------------ */

export interface BuiltDork {
  templateId: string
  title: string
  explains: string
  query: string
  mode: DorkTemplate['mode']
  /** Where to open it in a browser. */
  openUrl: string
  /** Stable per run; keys the artifact holding the response when it is run. */
  id: string
}

/** Engines whose results page can be opened with a plain query string. */
export const OPEN_ENGINES = {
  google: (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  duckduckgo: (query: string) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  bing: (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  'google-images': (query: string) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`
} as const

export type OpenEngine = keyof typeof OPEN_ENGINES

export function openUrl(engine: OpenEngine, query: string): string {
  return OPEN_ENGINES[engine](query)
}

/**
 * Every dork that applies to this subject, expanded against what the case knows.
 *
 * `only` narrows to named template ids. A template that cannot build anything from the
 * context — a phone dork with no phone — contributes nothing rather than an empty query,
 * so the operator never sees a dork that would search for the string `undefined`.
 */
export function buildDorks(ctx: DorkContext, engine: OpenEngine, only?: readonly string[]): BuiltDork[] {
  const wanted = only && only.length ? new Set(only) : null
  const out: BuiltDork[] = []
  for (const t of DORKS) {
    if (wanted && !wanted.has(t.id)) continue
    if (!t.appliesTo.includes(ctx.subjectKind)) continue
    let built: string[]
    try {
      built = t.build(ctx)
    } catch {
      // A template that throws is a bug in this file, not a reason to lose the other
      // fourteen. It is skipped silently here and caught by the tests.
      continue
    }
    for (const query of built) {
      if (!query.trim()) continue
      // The image dork's whole point is the image tab, so it opens there.
      const target: OpenEngine = t.id === 'images' ? 'google-images' : engine
      out.push({
        templateId: t.id,
        title: t.title,
        explains: t.explains,
        query,
        mode: t.mode,
        openUrl: openUrl(target, query),
        id: `${t.id}-${out.length}`
      })
    }
  }
  return out
}

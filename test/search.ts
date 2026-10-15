/**
 * The search path: backend parsers, query construction, and the two things that make a
 * search adapter dangerous rather than merely unreliable.
 *
 * Every fixture in here is a **real capture**, taken from this machine on 2026-09-03
 * against deliberately neutral targets — `torvalds`, `example.com`, `github.com/torvalds`
 * and the deliberately common name "John Smith". No personal data, and nothing synthetic:
 * a parser tested against markup somebody imagined is a parser tested against nothing.
 *
 * Two of the fixtures are here because they caught a real bug and must keep catching it:
 *
 *  - `websearch-ddg-html-challenge.html` is DuckDuckGo's CAPTCHA, served — as it really is
 *    — with **HTTP 202**. A parser that trusts a 2xx reads this page, finds no result rows
 *    and reports "no results" for a search that never happened. That is the single worst
 *    failure this adapter could have, because it turns a block into an absence.
 *  - `websearch-searxng-firstword-only.json` is a live response from the one public
 *    SearXNG instance that answered a JSON query: ten well-formed results for
 *    `"John Smith" Chicago`, every one of them about John the Apostle. The instance
 *    searches only the first word and says nothing about it. A refusal is loud; this is
 *    quiet, and only checking the results against the query catches it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  backendById,
  complianceOf,
  accountFromSearchHit,
  quotedPhrases,
  siteScopes,
  unwrapRedirect,
  decodeEntities,
  refusalOf,
  DEFAULT_BACKEND_CHAIN,
  SEARCH_BACKENDS,
  type SearchHit
} from '../src/main/adapters/support/search'
import { parseTimeMap } from '../src/main/adapters/archive-today'
import {
  buildDorks,
  DORKS,
  emptyContext,
  personQueries,
  phrase,
  subjectQueries,
  type DorkContext
} from '../src/main/adapters/support/dorks'

export interface SearchTest {
  name: string
  fn: () => void | Promise<void>
}

export const searchTests: SearchTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  searchTests.push({ name, fn })
}

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'adapters')
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

function read(backendId: string, file: string, status = 200): ReturnType<NonNullable<ReturnType<typeof backendById>>['read']> {
  const backend = backendById(backendId)
  assert.ok(backend, `no backend "${backendId}"`)
  return backend.read(fixture(file), status)
}

/* ------------------------------------------------------------------ *
 * 1. Backend parsers against real results pages
 * ------------------------------------------------------------------ */

test('ddg-html: real results page yields URLs, titles and snippets, with the tracker unwrapped', () => {
  const r = read('ddg-html', 'websearch-ddg-html-torvalds.html')
  assert.equal(r.refusal, null)
  assert.ok(r.hits.length >= 8, `expected a full page of results, got ${r.hits.length}`)

  const first = r.hits[0]!
  assert.equal(first.rank, 1)
  assert.equal(first.url, 'https://github.com/torvalds')
  assert.ok(first.title.includes('Torvalds'), first.title)
  assert.ok(first.snippet.length > 20, 'the snippet is empty, which is the nested-div bug')
  assert.equal(first.displayUrl, 'github.com/torvalds')

  // Not one stored URL may still be pointing at the click tracker.
  for (const h of r.hits) {
    assert.ok(/^https?:\/\//.test(h.url), h.url)
    assert.ok(!h.url.includes('duckduckgo.com/l/'), `unwrapping missed ${h.url}`)
    assert.ok(!h.url.includes('uddg='), `unwrapping missed ${h.url}`)
  }
  // Ranks are dense and ordered; a gap means a row was silently dropped mid-page.
  assert.deepEqual(r.hits.map((h) => h.rank), r.hits.map((_, i) => i + 1))
})

test('ddg-lite: the table view finds the same results as the html page', () => {
  const html = read('ddg-html', 'websearch-ddg-html-torvalds.html')
  const lite = read('ddg-lite', 'websearch-ddg-lite-torvalds.html')
  assert.equal(lite.refusal, null)
  assert.ok(lite.hits.length >= 8, `expected results, got ${lite.hits.length}`)
  assert.equal(lite.hits[0]!.url, html.hits[0]!.url)
  assert.ok(lite.hits[0]!.snippet.length > 20, 'the lite snippet row was not matched to its link')
  // Snippets are read positionally on this endpoint, so a shift would show up as the
  // wrong text against the right URL.
  assert.ok(lite.hits[0]!.snippet.startsWith(html.hits[0]!.snippet.slice(0, 30)))
})

test('ddg: zero results is an answer, and is not confused with a refusal', () => {
  const r = read('ddg-html', 'websearch-ddg-html-noresults.html')
  assert.equal(r.hits.length, 0)
  assert.equal(r.refusal, null, 'an honest "no results" page must not be reported as a refusal')
})

test('ddg: the CAPTCHA page is a refusal even though it arrives as HTTP 202', () => {
  const r = read('ddg-html', 'websearch-ddg-html-challenge.html', 202)
  assert.equal(r.hits.length, 0)
  assert.equal(r.refusal, 'challenge')
  assert.ok(/challenge/i.test(r.detail), r.detail)

  // And the same page must not read as a refusal-free empty page at any status.
  const at200 = read('ddg-html', 'websearch-ddg-html-challenge.html', 200)
  assert.equal(at200.refusal, 'challenge', 'the body must be enough on its own')
})

test('wiby: keyless JSON parses, and self-referential hosts are dropped', () => {
  const r = read('wiby', 'websearch-wiby-torvalds.json')
  assert.equal(r.refusal, null)
  assert.ok(r.hits.length >= 5, `expected results, got ${r.hits.length}`)
  assert.ok(r.hits.every((h) => /^https?:\/\//.test(h.url)))
  assert.ok(r.hits.every((h) => !h.url.includes('wiby.me')))
  assert.ok(r.hits[0]!.title.length > 0)
})

test('refusalOf: a 429, a 403 and a Cloudflare interstitial are all distinguished', () => {
  assert.equal(refusalOf(429, '').refusal, 'rate-limited')
  assert.equal(refusalOf(403, '').refusal, 'blocked')
  assert.equal(refusalOf(200, '<title>Just a moment...</title>').refusal, 'challenge')
  assert.equal(refusalOf(200, '<html>ordinary page</html>').refusal, null)
  assert.equal(refusalOf(500, '').refusal, 'blocked')
})

test('unwrapRedirect and decodeEntities survive the shapes a results page actually uses', () => {
  assert.equal(
    unwrapRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Ftorvalds&rut=abc'),
    'https://github.com/torvalds'
  )
  // Not a wrapper: returned untouched rather than mangled.
  assert.equal(unwrapRedirect('https://example.com/a?b=c'), 'https://example.com/a?b=c')
  assert.equal(unwrapRedirect(''), '')
  assert.equal(decodeEntities('O&#x27;Brien &amp; Sons &lt;x&gt;'), "O'Brien & Sons <x>")
})

/* ------------------------------------------------------------------ *
 * 2. The silently-rewritten query
 * ------------------------------------------------------------------ */

test('compliance: a real response that ignored the quoted phrase is caught', () => {
  const r = read('searxng', 'websearch-searxng-firstword-only.json')
  // It answered perfectly well. That is the whole problem.
  assert.equal(r.refusal, null)
  assert.ok(r.hits.length >= 5, `expected the instance to have answered, got ${r.hits.length}`)

  const c = complianceOf('"John Smith" Chicago', r.hits)
  assert.equal(c.checked, true)
  assert.equal(c.matched, 0)
  assert.equal(c.ignored, true, 'ten results about John the Apostle passed as an answer about John Smith')
  assert.ok(c.operators.some((o) => o.includes('John Smith')), c.operators.join('; '))
})

test('compliance: an engine that honoured the phrase is not accused of ignoring it', () => {
  const r = read('ddg-html', 'websearch-ddg-html-torvalds.html')
  const c = complianceOf('"torvalds"', r.hits)
  assert.equal(c.ignored, false)
  assert.ok(c.matched > 0)
})

test('compliance: a query with no operators is not checked at all', () => {
  const hits: SearchHit[] = [
    { backend: 'x', rank: 1, url: 'https://example.com/', title: 'a', snippet: 'b', displayUrl: '', via: null }
  ]
  const c = complianceOf('plain words', hits)
  assert.equal(c.checked, false)
  assert.equal(c.ignored, false, 'a query that asserted nothing cannot have been ignored')
})

test('compliance: a site: scope is verified against the result hostnames', () => {
  const hit = (url: string): SearchHit => ({
    backend: 'x', rank: 1, url, title: '', snippet: '', displayUrl: '', via: null
  })
  assert.equal(complianceOf('site:github.com torvalds', [hit('https://github.com/torvalds')]).ignored, false)
  assert.equal(complianceOf('site:github.com torvalds', [hit('https://gist.github.com/x')]).ignored, false)
  assert.equal(complianceOf('site:github.com torvalds', [hit('https://en.wikipedia.org/x')]).ignored, true)
})

test('quotedPhrases and siteScopes read the operators out of a query', () => {
  assert.deepEqual(quotedPhrases('"John Smith" Chicago "IL"'), ['John Smith', 'IL'])
  assert.deepEqual(quotedPhrases('no quotes here'), [])
  assert.deepEqual(siteScopes('site:a.com x (site:b.org)'), ['a.com', 'b.org'])
})

/* ------------------------------------------------------------------ *
 * 3. Turning a search result into a candidate
 * ------------------------------------------------------------------ */

test('a search hit that is really an article does not become an account', () => {
  // The generic `/people/<x>` rule is right for a link somebody published as their
  // profile and wrong for a search index, which contains every static page on a site.
  assert.equal(accountFromSearchHit('https://www.computerhope.com/people/linus_torvalds.htm'), null)
  assert.equal(accountFromSearchHit('https://example.org/user/report.php'), null)
  // Real profiles still resolve.
  const gh = accountFromSearchHit('https://github.com/torvalds')
  assert.deepEqual(gh, { platform: 'github.com', handle: 'torvalds' })
})

/* ------------------------------------------------------------------ *
 * 4. Query construction — the actual correction this work exists to make
 * ------------------------------------------------------------------ */

function personContext(): DorkContext {
  const ctx = emptyContext('linus torvalds', 'person')
  ctx.names = ['Linus Torvalds']
  ctx.places = ['Helsinki']
  ctx.organisations = ['University of Helsinki']
  ctx.handles = ['torvalds']
  return ctx
}

test('a person is searched as name-plus-place first, because that is the technique', () => {
  const qs = personQueries(personContext())
  assert.ok(qs.length >= 3, `expected several combinations, got ${qs.length}`)
  assert.equal(qs[0]!.query, '"Linus Torvalds" Helsinki')
  assert.ok(qs.some((q) => q.query === '"Linus Torvalds" "University of Helsinki"'))
  assert.ok(qs.some((q) => q.query === '"Linus Torvalds" torvalds'))
  // Every query explains itself: the panel beside the result renders this.
  for (const q of qs) assert.ok(q.why.length > 60, `${q.id} has no explanation`)
  // The name is quoted, or it is a request for two words in any order.
  for (const q of qs) assert.ok(!/^Linus Torvalds/.test(q.query), q.query)
})

test('a person with nothing to combine gets one query, and it is flagged weak', () => {
  const ctx = emptyContext('linus torvalds', 'person')
  ctx.names = ['Linus Torvalds']
  const qs = personQueries(ctx)
  assert.equal(qs.length, 1)
  assert.equal(qs[0]!.query, '"Linus Torvalds"')
  assert.equal(qs[0]!.weak, true, 'a bare common name must not be presented as a good query')
})

test('a person with no name at all produces nothing rather than an empty query', () => {
  assert.deepEqual(personQueries(emptyContext('', 'person')), [])
})

test('phrase() quotes what needs quoting and leaves single words alone', () => {
  assert.equal(phrase('Linus Torvalds'), '"Linus Torvalds"')
  assert.equal(phrase('torvalds'), 'torvalds')
  assert.equal(phrase('a@b.com'), '"a@b.com"')
  // An inner quote would truncate the query on every engine, so it is removed.
  assert.equal(phrase('say "hi" now'), '"say hi now"')
  assert.equal(phrase('   '), '')
})

test('a handle, an address and a domain each get queries suited to what they are', () => {
  const h = subjectQueries({ ...emptyContext('torvalds', 'username'), places: ['Helsinki'] })
  assert.ok(h.some((q) => q.query === 'torvalds'))
  assert.ok(h.some((q) => q.query === 'torvalds Helsinki'))

  const e = subjectQueries(emptyContext('someone@example.com', 'email'))
  assert.ok(e.some((q) => q.query === '"someone@example.com"'))
  assert.ok(e.some((q) => q.query.includes('someone')), 'the local part is worth its own query')

  const d = subjectQueries(emptyContext('example.com', 'domain'))
  assert.ok(d.some((q) => q.query === 'site:example.com'))
  assert.ok(d.some((q) => q.query === '"example.com"'))
})

/* ------------------------------------------------------------------ *
 * 5. The dork library
 * ------------------------------------------------------------------ */

test('every dork template explains the mechanism it exploits', () => {
  const seen = new Set<string>()
  for (const d of DORKS) {
    assert.ok(/^[a-z][a-z0-9-]*$/.test(d.id), `bad dork id ${d.id}`)
    assert.ok(!seen.has(d.id), `duplicate dork id ${d.id}`)
    seen.add(d.id)
    assert.ok(d.appliesTo.length > 0, `${d.id} applies to nothing`)
    assert.ok(d.explains.length >= 120, `${d.id}.explains is ${d.explains.length} chars; name the mechanism, do not label it`)
    assert.ok(/[.!?]/.test(d.explains), `${d.id}.explains is not a sentence`)
    assert.ok(d.title.length > 10, `${d.id} has no title`)
  }
})

test('no dork template throws or emits an empty query on an empty context', () => {
  for (const kind of ['person', 'username', 'email', 'domain', 'account', 'organisation', 'phone'] as const) {
    const built = buildDorks(emptyContext('', kind), 'google')
    for (const b of built) {
      assert.ok(b.query.trim().length > 0, `${b.templateId} built an empty query`)
      assert.ok(!/undefined|null|""\s*$/.test(b.query), `${b.templateId} built ${b.query}`)
    }
  }
})

test('dorks are built around the subject the run was pointed at, not around the case', () => {
  // Pointing at the handle in a case that also holds the person must search the handle.
  const ctx = { ...personContext(), subject: 'torvalds', subjectKind: 'username' as const }
  const built = buildDorks(ctx, 'google')
  const social = built.filter((b) => b.templateId === 'social-scoped')
  assert.ok(social.length > 0)
  for (const b of social) assert.ok(b.query.includes('torvalds'), b.query)
  assert.ok(!social.some((b) => b.query.includes('"Linus Torvalds"')), 'the case overrode the subject')
})

test('every built dork carries an openable URL that round-trips its query', () => {
  const built = buildDorks(personContext(), 'google')
  assert.ok(built.length >= 8, `expected a real library, got ${built.length}`)
  for (const b of built) {
    assert.ok(b.openUrl.startsWith('https://'), b.openUrl)
    const q = new URL(b.openUrl).searchParams.get('q')
    assert.equal(q, b.query, `${b.templateId} URL does not carry its own query`)
  }
  // The image dork opens the image tab, since the judgement it needs is visual.
  const images = built.find((b) => b.templateId === 'images')
  if (images) assert.ok(images.openUrl.includes('tbm=isch'), images.openUrl)
})

test('narrowing to named templates returns only those', () => {
  const built = buildDorks(personContext(), 'google', ['pastes'])
  assert.ok(built.length > 0)
  assert.ok(built.every((b) => b.templateId === 'pastes'))
})

/* ------------------------------------------------------------------ *
 * 6. archive.today's TimeMap
 * ------------------------------------------------------------------ */

test('archive.today: a real TimeMap yields one memento per capture, with timestamps', () => {
  const mementos = parseTimeMap(fixture('archive-today-timemap-torvalds.txt'))
  assert.ok(mementos.length >= 10, `expected the captures of github.com/torvalds, got ${mementos.length}`)
  for (const m of mementos) {
    assert.ok(/^\d{14}$/.test(m.timestamp), `bad timestamp ${m.timestamp}`)
    assert.ok(m.url.startsWith('http'), m.url)
    assert.ok(m.rel.includes('memento'))
  }
  // `original`, `timegate` and `self` are not captures and must not be counted as any.
  assert.ok(!mementos.some((m) => m.rel === 'original' || m.rel === 'timegate' || m.rel === 'self'))
  // The `first memento` is also emitted as a plain `memento`; one capture, one entry.
  assert.equal(new Set(mementos.map((m) => m.timestamp)).size, mementos.length)
  const sorted = [...mementos].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  assert.equal(sorted[0]!.timestamp.slice(0, 4), '2012')
})

test('archive.today: the absent-URL response yields no mementos and does not throw', () => {
  assert.deepEqual(parseTimeMap(fixture('archive-today-timemap-absent.txt')), [])
  assert.deepEqual(parseTimeMap(''), [])
  assert.deepEqual(parseTimeMap('total nonsense <<<>>>'), [])
})

test('archive.today: a URL containing a comma does not split an entry in half', () => {
  // The obvious implementation splits the document on `,` and loses exactly these.
  const body =
    '<https://example.com/a,b>; rel="original",\n' +
    '<http://archive.md/20200101120000/https://example.com/a,b>; rel="memento"; datetime="Wed, 01 Jan 2020 12:00:00 GMT",\n' +
    '<http://archive.md/20210202130000/https://example.com/a,b>; rel="last memento"; datetime="Tue, 02 Feb 2021 13:00:00 GMT"'
  const mementos = parseTimeMap(body)
  assert.equal(mementos.length, 2)
  assert.equal(mementos[0]!.timestamp, '20200101120000')
  assert.ok(mementos[0]!.url.endsWith('/a,b'))
})

test('archive.today: a timestamp only in the datetime header is still read', () => {
  const body = '<http://archive.md/nonstandard/https://example.com/>; rel="memento"; datetime="Wed, 01 Jan 2020 12:00:00 GMT"'
  assert.equal(parseTimeMap(body)[0]?.timestamp, '20200101120000')
})

/* ------------------------------------------------------------------ *
 * 7. The chain itself
 * ------------------------------------------------------------------ */

test('the default chain names only real backends, and excludes the one that lies', () => {
  for (const id of DEFAULT_BACKEND_CHAIN) {
    assert.ok(backendById(id), `default chain names unknown backend ${id}`)
  }
  assert.ok(
    !DEFAULT_BACKEND_CHAIN.includes('searxng' as never),
    'searxng answers confidently with results for a different query; it must stay opt-in'
  )
  assert.equal(DEFAULT_BACKEND_CHAIN[0], 'ddg-html')
})

test('every backend describes itself and builds an encoded URL', () => {
  for (const b of SEARCH_BACKENDS) {
    assert.ok(b.about.length > 40, `${b.id} does not say what it indexes`)
    assert.ok(b.host.length > 0)
    const url = b.buildUrl('"a b" site:c.com', 'https://searx.example')
    assert.ok(url.includes('%22a%20b%22') || url.includes('%22a+b%22'), `${b.id} did not encode the query: ${url}`)
  }
})

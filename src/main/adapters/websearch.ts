/**
 * `websearch` — the missing primary technique.
 *
 * Every other adapter in this app takes a username, an email address, a domain or a file.
 * Not one of them takes a *person*. That is why seeding a real name into a case used to
 * change nothing about what got queried: the name could only ever be matched against text
 * some other adapter had already fetched, so it sat in the graph looking like an input
 * while being, in fact, inert.
 *
 * For a human being the order is the other way round from how this toolbelt had it. A web
 * search over `"name" + town`, `"name" + school`, `"name" + handle` is the primary
 * technique and a username sweep is the supporting one — because the sweep can only ever
 * ask a fixed list of sites a yes/no question, while a search asks the whole index an open
 * one and comes back with the page that happens to carry both halves of an identity.
 *
 * ## What it actually does
 *
 * Reads the case's own entity list, welds the subject to every other seed in it, and asks
 * a search engine each combination. There is no cleverness in the querying and there does
 * not need to be: the value is entirely in the combination, and the combination is
 * something the app knows and the operator would otherwise have to retype by hand fifteen
 * times.
 *
 * ## Which engine, and why not a better one
 *
 * Free and keyless was a hard constraint (DECISIONS.md #10), so every candidate was probed
 * from this machine rather than trusted. DuckDuckGo's no-JavaScript endpoint answered; its
 * lite endpoint answered; Wiby answered. Mojeek served a JavaScript captcha, Qwant
 * answered 403, Brave answered 429 on the first request and now requires a payment card
 * even on its free plan, Marginalia's public API timed out on every documented host, and
 * 78 of the 80 public SearXNG instances refused a JSON query outright — while the one
 * that answered reliably turned out to be searching only the first word of every query
 * and returning a confident page of results for a question nobody asked. The chain
 * reflects exactly that and nothing else. See `support/search.ts` for the measurements.
 *
 * ## What a result is worth
 *
 * A search hit is a **search engine's opinion that a page is relevant to a string**. It is
 * not a statement that the page is about the subject, and this adapter never fetches the
 * page to find out. Two consequences are wired into the code rather than left to the
 * reader:
 *
 *  - `Finding.source` is the **engine's** host, never the result's. Recording `github.com`
 *    for a hit about `github.com/x` would let a stale index entry corroborate a live probe
 *    of the same profile, manufacturing exactly the agreement `support/sources.ts` exists
 *    to prevent.
 *  - Everything it produces is a **lead**. `unverified` is enforced by the contract; the
 *    proposals it makes say in their own rationale that nobody has looked at the page yet.
 */

import type { Entity, Finding } from '../../shared/types'
import {
  makeFinding,
  type Adapter,
  type AdapterContext,
  type AdapterInput,
  type EntityProposal,
  type RawResult
} from './types'
import { beginEnvelope, finishEnvelope, group, parseJsonSafe, readEnvelope } from './support/envelope'
import { localSource, siteOrigin } from './support/sources'
import { DEFAULT_USER_AGENT } from './support/net'
import { mergedOptions, optionList, optionNumber, optionString } from './support/toolkit'
import { readCaseFacts, type CaseFacts } from './support/casefacts'
import { personQueries, subjectQueries, type BuiltQuery, type DorkContext } from './support/dorks'
import {
  backendById,
  executeSearch,
  DEFAULT_BACKEND_CHAIN,
  DEFAULT_SEARX_INSTANCES,
  accountFromSearchHit,
  complianceOf,
  type BackendAttempt,
  type BackendHealth,
  type SearchHit
} from './support/search'

const ID = 'websearch'
const VERSION = '1.0.0'

/**
 * The manifest written into `stdout`.
 *
 * Collection metadata, not interpretation: which query was asked, of whom, what came back
 * and where the bytes are. `parse()` re-reads the stored response bodies through the same
 * backend parsers `run()` would have used, so a parser fix next month applies to a capture
 * made today with nothing re-queried.
 */
interface Manifest {
  kind: 'websearch-run'
  subject: string
  subjectKind: string
  facts: DorkContext
  provenance: CaseFacts['provenance']
  entitiesRead: number
  chain: string[]
  gapMs: number
  queries: {
    id: string
    query: string
    why: string
    weak: boolean
    servedBy: string | null
    attempts: BackendAttempt[]
  }[]
}

/**
 * Hosts that sell "background checks" by re-selling scraped public records.
 *
 * They rank first for almost every `"name" + city` query, they are the reason a bare-name
 * search feels productive and is not, and DECISIONS.md rules them out of the toolbelt
 * explicitly. They are never proposed as entities and they get a finding of their own
 * saying what they are, because a beginner reading a results page cannot tell them apart
 * from a real source.
 */
const AGGREGATOR_HOSTS =
  /^(whitepages|spokeo|411|truthfinder|beenverified|intelius|peoplefinders|instantcheckmate|radaris|mylife|fastpeoplesearch|thatsthem|nuwber|clustrmaps|usphonebook|searchpeoplefree|zabasearch|checkpeople|peekyou|socialcatfish|smartbackgroundchecks)\.(com|net|org|us)$/i

/** Big platforms that would be proposed as a `domain` for every subject and mean nothing. */
const NOT_A_LEAD_DOMAIN =
  /^(google|youtube|facebook|instagram|x|twitter|tiktok|linkedin|reddit|wikipedia|wikimedia|amazon|apple|microsoft|github|gitlab|medium|pinterest|quora|yelp|tripadvisor|imdb|bing|yahoo|vk|ok)\.(com|org|ru|co\.uk|net)$/i

export const websearchAdapter: Adapter = {
  id: ID,
  title: 'Web search (a name, welded to what else the case knows)',
  version: VERSION,

  accepts: ['person', 'username', 'email', 'domain'],
  produces: ['account', 'domain'],

  requiresKey: false,
  requiresNetwork: true,

  // One at a time, and slowly. Two concurrent runs would be two clients hammering one free
  // endpoint from one address, which is how a keyless source stops being keyless.
  concurrency: 1,
  minIntervalMs: 8_000,
  defaultTimeoutMs: 180_000,

  doc: {
    what: 'Asks a search engine what the open web says about a person, by welding their name to every other thing the case already knows — a town, a school, an employer, a handle — and running each combination as its own query.',

    how: 'It reads the case\'s own `entities.json`, sorts what is there into names, places, organisations, handles, addresses and domains, and builds one query per combination, strongest first: name plus place, then name plus organisation, then name plus handle, then the handle on its own. Each query is sent as a plain HTTPS GET to DuckDuckGo\'s no-JavaScript results page, whose HTML is parsed for the result rows — title, click-through URL, snippet and displayed URL, with the click tracker unwrapped so the stored URL is the real destination. If DuckDuckGo answers with its anti-bot challenge — which it serves with a 202, not an error — the whole host is struck off for the rest of the run and the chain falls through to DuckDuckGo\'s lite endpoint and then to Wiby\'s keyless JSON. Every response body is stored verbatim in the capture, so the parser re-derives the results from the bytes rather than from anything the run decided at the time, and every set of results is checked against the operators the query used before any of it is treated as a lead.',

    why: 'A name is not a search term, it is a join key, and that is precisely why the app was blind without this. Username enumeration asks a fixed list of sites a closed question — does this handle exist here — and can therefore only find what is on the list. A search asks the whole index an open one, and the pages that matter for identifying a person are almost never profile pages: they are a club roster, a school prize list, a local newspaper\'s photo caption, a conference programme, a forum signature where somebody wrote both their handle and their real name. Combining the name with a town or a school is what turns a query matching tens of thousands of people into one matching a neighbourhood, and no other adapter here can perform that join at all.',

    betterAt: 'Reaching pages nobody would think to look for, and finding the join between a real identity and an online one. It is the only thing in this toolbelt that can act on a name at all, the only one whose reach is the whole indexed web rather than a site list, and the only one that finds a subject in text other people wrote about them rather than in a profile they created themselves. It also costs nothing, needs no key, and works on the first try for a subject with an uncommon surname.',

    worseAt: 'Common names, non-Latin scripts, and anything recent or private. A search index is months stale in places, has never seen most of a social platform\'s content, and reflects an algorithm tuned to give a shopper a shop. Its ranking is personalised and regionalised — the region is pinned off here, but the index still is not neutral — so the same query genuinely returns different answers from different places. It cannot see inside a login, and platforms that block crawlers are represented by whatever leaked out years ago. The free endpoints it depends on are also its weakest joint: they are results pages meant for a browser, not APIs, and they can change shape or refuse without notice.',

    falsePositives: 'It lies most convincingly through people-search aggregators. A `"name" + city` query typically returns Whitepages, Spokeo and 411 in the first three positions, each presenting a confident page of addresses and relatives for somebody who may share nothing with the subject but a name — this adapter flags those hosts by name rather than letting them pass as sources. Beyond that, the engine ranks by relevance to a string, so a page mentioning a different person with the same name is a perfect match by the only criterion applied, and a high rank means popularity rather than accuracy. Snippets are assembled from fragments and routinely juxtapose a name and a place that sit in unrelated parts of the page. The quietest lie of all is an engine that drops the quotes: one fallback tested during development answered `"John Smith" Chicago` with a page of Bible passages about John the Apostle, at a normal status code, with no indication that it had searched for a single word — so every response is checked against the operators the query used, and a set of results in which nothing matches the quoted phrase is reported and then kept out of the leads. Nothing here fetches the page to check, so every hit is a lead about a URL, not a fact about a human, and a challenge page served with a success status is treated as a refusal rather than as an empty result — a blocked search must never render as "nothing was found".'
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const env = beginEnvelope({
      adapterId: ID,
      adapterVersion: VERSION,
      input,
      target: input.entity.label || input.entity.value,
      startedAt
    })

    const facts = await readCaseFacts(ctx.caseDir, input.entity as Entity)
    const explicit = optionList(options, 'queries', [])
    const built = explicit.length
      ? explicit.map((query, i) => ({
          id: `given-${i}`,
          query,
          why: 'Supplied for this run rather than derived from the case.',
          weak: false
        }))
      : queriesFor(facts.context)

    const maxQueries = optionNumber(options, 'maxQueries', 6, { min: 1, max: 20 })
    const queries = built.slice(0, maxQueries)

    if (queries.length === 0) {
      env.notes.push(
        `Nothing searchable could be built from a ${input.entity.kind} entity plus ${facts.entitiesRead} case entities.`
      )
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error:
          input.entity.kind === 'person'
            ? 'A person entity with no place, organisation, handle or address to combine it with produces only a bare-name query. Seed a town or a school first — that combination is the technique.'
            : `No query could be derived from this ${input.entity.kind} entity.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    const chain = optionList(options, 'backends', [...DEFAULT_BACKEND_CHAIN]).filter((b) => backendById(b) !== null)
    const instances = optionList(options, 'instances', [...DEFAULT_SEARX_INSTANCES])
    const gapMs = optionNumber(options, 'requestGapMs', 6_000, { min: 500, max: 60_000 })
    const perQuery = optionNumber(options, 'maxResultsPerQuery', 10, { min: 1, max: 50 })

    const manifest: Manifest = {
      kind: 'websearch-run',
      subject: input.entity.label || input.entity.value,
      subjectKind: input.entity.kind,
      facts: facts.context,
      provenance: facts.provenance,
      entitiesRead: facts.entitiesRead,
      chain,
      gapMs,
      queries: []
    }

    const health: BackendHealth = new Map()
    let done = 0
    for (const bq of queries) {
      if (ctx.signal.aborted) break
      ctx.progress({
        pct: Math.round((done / queries.length) * 90),
        note: `searching for ${bq.query}`,
        done,
        total: queries.length,
        current: bq.query
      })

      const outcome = await executeSearch(
        {
          query: bq.query,
          chain,
          instances,
          timeoutMs: Math.min(ctx.timeoutMs, 45_000),
          signal: ctx.signal,
          userAgent: optionString(options, 'userAgent', DEFAULT_USER_AGENT),
          gapMs,
          maxRetries: optionNumber(options, 'maxRetries', 1, { min: 0, max: 3 }),
          keep: (backendId, body) => {
            const name = `${bq.id}--${backendId.replace(/[^a-z0-9@.-]/gi, '_')}.txt`
            env.artifacts[name] = body
            return name
          }
        },
        health
      )

      manifest.queries.push({
        id: bq.id,
        query: bq.query,
        why: bq.why,
        weak: bq.weak,
        servedBy: outcome.servedBy,
        attempts: outcome.attempts
      })
      done++
      ctx.progress({
        pct: Math.round((done / queries.length) * 90),
        done,
        total: queries.length,
        hits: outcome.hits.length
      })
    }

    env.stdout = JSON.stringify(manifest)
    env.command = { file: 'GET', args: manifest.queries.flatMap((q) => q.attempts.map((a) => a.url)).filter(Boolean) }
    env.notes.push(`Read ${facts.entitiesRead} case entities to build ${queries.length} queries.`)
    env.notes.push(`Backend chain: ${chain.join(' → ')}. Politeness gap ${gapMs} ms. Top ${perQuery} results kept per query.`)
    for (const [backend, why] of health) env.notes.push(`Backend ${backend} was struck off mid-run: ${why}`)

    const served = manifest.queries.filter((q) => q.servedBy !== null).length
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: served > 0,
      error:
        served > 0
          ? null
          : `Every backend refused: ${[...health.values()].join('; ') || 'no backend answered'}. This says nothing about the subject.`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/* ------------------------------------------------------------------ *
 * Interpretation
 * ------------------------------------------------------------------ */

/** One URL, and everything the run learned about how it was reached. */
interface Reached {
  url: string
  title: string
  snippet: string
  bestRank: number
  /** Distinct queries that surfaced it. Two is much stronger than one. */
  queries: string[]
  /** Distinct engine hosts that returned it. This is the corroboration axis. */
  hosts: Set<string>
}

const MAX_RESULT_FINDINGS = 40
const MAX_PROPOSALS = 25

function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }
  const manifest = parseJsonSafe<Manifest>(env.stdout)
  if (!manifest || manifest.kind !== 'websearch-run' || !Array.isArray(manifest.queries)) {
    return { findings: [], proposals: [] }
  }

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  const reached = new Map<string, Reached>()
  const aggregators = new Set<string>()
  let queriesServed = 0

  for (const q of manifest.queries) {
    const attempts = Array.isArray(q.attempts) ? q.attempts : []

    // A refusal is a fact about the engine and is recorded as one. It is emphatically not
    // an empty result set, and the claim says so in words rather than leaving it implied.
    for (const a of attempts) {
      if (!a.refusal || !a.detail) continue
      if (a.detail.startsWith('not tried:')) continue
      findings.push(
        makeFinding(raw, {
          source: siteOrigin(a.host) || a.host,
          claim: `${a.detail} when asked ${JSON.stringify(q.query)}. That is a refusal aimed at this client, not an answer about the subject: nothing was learned from ${a.host} for this query, and it must not be read as "nothing was found".`
        })
      )
    }

    const served = attempts.find((a) => a.backend === q.servedBy && a.refusal === null && a.artifact)
    if (!served || !q.servedBy) continue
    const backend = backendById(q.servedBy)
    const body = env.artifacts[served.artifact ?? '']
    if (!backend || typeof body !== 'string') continue

    const read = backend.read(body, served.status)
    if (read.refusal) continue
    queriesServed++
    const host = siteOrigin(served.host) || served.host

    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim:
          `The query ${JSON.stringify(q.query)} was put to ${served.host} and came back with ${group(read.hits.length)} result${read.hits.length === 1 ? '' : 's'}. ` +
          `${q.why}${q.weak ? ' This query was run knowing it is weak, so treat its results as the least reliable in the run.' : ''}`
      })
    )

    // An engine that quietly dropped the operators answered a different, broader question
    // and its results are about something else. They are reported, because the capture is
    // the record, but they are kept out of the pool that becomes leads.
    const compliance = complianceOf(q.query, read.hits)
    if (compliance.ignored) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `${served.host} answered ${JSON.stringify(q.query)} with ${group(read.hits.length)} results and not one of them satisfies ${compliance.operators.join(' or ')}. ` +
            `That is an engine dropping the operators and answering a broader question without saying so — the response looks completely normal and is about something else. These results are recorded but are not treated as leads about the subject.`
        })
      )
      continue
    }

    for (const hit of read.hits) {
      recordHit(reached, hit, q.query, host)
      const h = hostOfUrl(hit.url)
      if (h && AGGREGATOR_HOSTS.test(h)) aggregators.add(h)
    }
  }

  if (manifest.queries.length && queriesServed === 0) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: `All ${group(manifest.queries.length)} queries in this run were refused by every backend in the chain (${manifest.chain.join(', ')}). The case learned nothing about the subject from this run — this is a fact about the search engines, not about the person.`
      })
    )
    return { findings, proposals }
  }

  // Ranked by corroboration first, then by how well the engine ranked it. A URL that two
  // different combinations both surfaced is worth more than one that scored top for one.
  const ranked = [...reached.values()].sort(
    (a, b) => b.queries.length - a.queries.length || b.hosts.size - a.hosts.size || a.bestRank - b.bestRank
  )

  for (const r of ranked.slice(0, MAX_RESULT_FINDINGS)) {
    const host = hostOfUrl(r.url)
    const isAggregator = host !== '' && AGGREGATOR_HOSTS.test(host)
    const engines = [...r.hosts]
    const across =
      r.queries.length > 1
        ? ` It was returned for ${group(r.queries.length)} different queries in this run (${r.queries.map((s) => JSON.stringify(s)).join(', ')}), which is the strongest signal a search alone can give.`
        : ''
    const warning = isAggregator
      ? ' This host is a people-search aggregator: it re-sells scraped public records and will present a confident page for almost any name, so a hit here is evidence that the name is common, not that this record is the subject.'
      : ''

    const finding = makeFinding(raw, {
      // The engine is the source. The page has not been fetched by anything in this app.
      source: engines[0] ?? localSource(ID),
      claim:
        `${engines.join(' and ')} ranked ${r.url} at position ${r.bestRank} for ${JSON.stringify(r.queries[0] ?? '')}` +
        `${r.title ? `, titled ${JSON.stringify(truncate(r.title, 140))}` : ''}.` +
        `${r.snippet ? ` The snippet reads ${JSON.stringify(truncate(r.snippet, 220))}.` : ''}` +
        `${across}${warning} Nothing in this run fetched that page; this is the engine's opinion of relevance to a string.`
    })
    findings.push(finding)

    if (proposals.length < MAX_PROPOSALS && !isAggregator) {
      const account = accountFromSearchHit(r.url)
      if (account) {
        propose(proposals, {
          fromFindingId: finding.id,
          kind: 'account',
          value: `${account.platform}/${account.handle}`,
          label: r.title ? truncate(r.title, 80) : `${account.platform}/${account.handle}`,
          attrs: { platform: account.platform, handle: account.handle, url: r.url },
          rationale: `A search for ${JSON.stringify(r.queries[0] ?? '')} returned this profile URL at position ${r.bestRank}. A search engine matched a string against a page; nobody has opened the profile or checked that it belongs to the subject, and a page can rank for a name it merely mentions.`
        })
      } else if (
        r.queries.length > 1 &&
        host &&
        // Folded to the operator before the check, so `en.wikipedia.org` is recognised as
        // Wikipedia rather than sailing past a list that only names `wikipedia.org`.
        !NOT_A_LEAD_DOMAIN.test(siteOrigin(host) || host) &&
        !host.endsWith('.gov')
      ) {
        propose(proposals, {
          fromFindingId: finding.id,
          kind: 'domain',
          value: host.replace(/^www\./, ''),
          rationale: `This host came back for ${group(r.queries.length)} different queries about the subject, which is why it is worth a look rather than a single hit would be. It is still only an engine's ranking: the host may simply be a large site that mentions the terms.`
        })
      }
    }
  }

  if (ranked.length > MAX_RESULT_FINDINGS) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: `${group(ranked.length - MAX_RESULT_FINDINGS)} further distinct URLs were returned and are not findings; every response body is stored verbatim in the raw capture and can be re-parsed without re-querying anything.`
      })
    )
  }

  if (aggregators.size) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim:
          `${group(aggregators.size)} people-search aggregator${aggregators.size === 1 ? '' : 's'} appeared in these results (${[...aggregators].join(', ')}). ` +
          `They buy and re-sell scraped public records, they rank near the top for almost every name-plus-city query, and they will show a plausible page of addresses and relatives for a person who shares nothing with the subject but a name. They are never proposed as entities here and are not treated as sources.`
      })
    )
  }

  findings.push(
    makeFinding(raw, {
      source: localSource(ID),
      claim:
        `Search results are an engine's ranking of pages against a string, not statements about a person. Rank reflects popularity and link structure; a page can be the top result for a name it mentions once about somebody else. ` +
        `The index is also months stale in places and cannot see inside a login, so absence from these results is not evidence of absence from the web.`
    })
  )

  const usedFacts = describeFacts(manifest)
  if (usedFacts) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: `The queries in this run were built by combining the subject with what the case already held: ${usedFacts}. Adding another seed — a town, a school, an employer — changes what gets asked, which is the whole reason a name seed is worth anything.`
      })
    )
  }

  return { findings, proposals }
}

/**
 * Add a proposal unless the same entity has already been named this run.
 *
 * Three result URLs on one university host, or two profile URLs that fold to one account,
 * are one candidate with one piece of evidence — not three rows in the review queue. The
 * *first* mention keeps the slot deliberately: the results are already sorted with the
 * best-corroborated URL first, so the proposal that survives cites the strongest finding.
 */
function propose(into: EntityProposal[], p: EntityProposal): void {
  if (into.some((existing) => existing.kind === p.kind && existing.value === p.value)) return
  into.push(p)
}

function recordHit(map: Map<string, Reached>, hit: SearchHit, query: string, host: string): void {
  const key = hit.url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
  const existing = map.get(key)
  if (existing) {
    existing.bestRank = Math.min(existing.bestRank, hit.rank)
    if (!existing.queries.includes(query)) existing.queries.push(query)
    existing.hosts.add(host)
    if (!existing.snippet && hit.snippet) existing.snippet = hit.snippet
    return
  }
  map.set(key, {
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
    bestRank: hit.rank,
    queries: [query],
    hosts: new Set([host])
  })
}

/** The queries this subject earns, given what the case knows about it. */
function queriesFor(ctx: DorkContext): BuiltQuery[] {
  const out = ctx.subjectKind === 'person' ? personQueries(ctx) : subjectQueries(ctx)
  if (out.length) return out
  // A non-person subject with an empty case still deserves its own name as a query.
  return ctx.subjectKind === 'person' ? [] : subjectQueries({ ...ctx, names: [], handles: [] })
}

function describeFacts(m: Manifest): string {
  const f = m.facts ?? {}
  const parts: string[] = []
  const say = (label: string, xs: unknown): void => {
    if (Array.isArray(xs) && xs.length) parts.push(`${label} ${xs.slice(0, 3).map((x) => JSON.stringify(String(x))).join(', ')}`)
  }
  say('the name', f.names)
  say('the place', f.places)
  say('the organisation', f.organisations)
  say('the handle', f.handles)
  say('the address', f.emails)
  return parts.join('; ')
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function truncate(s: string, max: number): string {
  const t = (s ?? '').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

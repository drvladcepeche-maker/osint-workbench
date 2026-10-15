/**
 * `dorks` — search operators, prepared and explained.
 *
 * A "dork" is a search query built out of the operators an engine exposes but almost
 * nobody uses: `site:` to scope to one host, `filetype:` to match a format rather than a
 * page, `inurl:` and `intitle:` to match the address or the title instead of the body,
 * quotes to force adjacency, `-` to subtract a set. The technique is old, entirely public,
 * and touches nothing: every hit is a page the search engine already crawled and indexed,
 * so looking at the results of a dork is passive in a way that visiting the pages is not.
 *
 * ## Why this is a separate adapter from `websearch`
 *
 * They ask different questions. `websearch` asks *who is this person* by welding a name to
 * a town and a school. `dorks` asks *what shape of page exists* — the PDF nobody meant to
 * publish, the open directory listing, the paste site copy, the forum member list, the
 * login page. One is about a subject, the other is about an exposure, and the queries look
 * nothing alike. They share every primitive in `support/dorks.ts` and the whole engine
 * chain in `support/search.ts`; only the query construction differs.
 *
 * ## Run it, or hand over the URL
 *
 * Some of these are worth executing and parsing. Some are worth *looking at*: an image
 * search, where judging whether two faces are the same person is exactly the thing a
 * parser cannot do, or an open-directory listing, where the value is the shape of the file
 * tree rather than ten extracted URLs. Every prepared dork therefore declares which it is,
 * and the ones marked for opening produce a finding carrying the query, the explanation
 * and a ready URL — sourced `local:dorks`, because a query that has not been run is not
 * evidence of anything and must never be able to corroborate something that has.
 *
 * The operator library and its explanations live in `support/dorks.ts`, which is pure, so
 * `parse()` can rebuild every explanation from the capture without a case folder.
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
import { readCaseFacts } from './support/casefacts'
import { buildDorks, dorkById, OPEN_ENGINES, type BuiltDork, type OpenEngine } from './support/dorks'
import {
  backendById,
  executeSearch,
  DEFAULT_BACKEND_CHAIN,
  DEFAULT_SEARX_INSTANCES,
  accountFromSearchHit,
  complianceOf,
  type BackendAttempt,
  type BackendHealth
} from './support/search'

const ID = 'dorks'
const VERSION = '1.0.0'

interface Manifest {
  kind: 'dorks-run'
  subject: string
  subjectKind: string
  engine: OpenEngine
  mode: Mode
  built: BuiltDork[]
  ran: {
    id: string
    templateId: string
    query: string
    servedBy: string | null
    attempts: BackendAttempt[]
  }[]
}

type Mode = 'open' | 'run' | 'both'

const MAX_RESULTS_PER_DORK = 8

export const dorksAdapter: Adapter = {
  id: ID,
  title: 'Dork builder (search operators, prepared and explained)',
  version: VERSION,

  accepts: ['person', 'username', 'email', 'domain', 'account', 'organisation', 'phone'],
  produces: ['account', 'domain'],

  requiresKey: false,
  // True for the default mode, which runs a few of them. `mode: "open"` makes no request
  // at all and is the right setting for an air-gapped or deliberately quiet session.
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 8_000,
  defaultTimeoutMs: 180_000,

  doc: {
    what: 'Builds a library of prepared search queries out of the operators a search engine exposes — scoping to a site, to a file format, to a URL shape — runs a few of the most useful ones, and hands over the rest as URLs to open, each with the mechanism it exploits written next to it.',

    how: 'It assembles what the case knows about the subject — names, handles, addresses, domains, places, organisations, phone numbers — and expands each template in the library against it. `site:` restricts the result set to one host, so the engine ranks within a platform instead of against the whole web; `filetype:` matches the stored format, reaching PDFs and spreadsheets that are not web pages at all; `inurl:` and `intitle:` match the address and the title rather than the body, which is how forum software and directory listings are identified by their predictable URL shapes; a quoted phrase forces adjacency, turning a two-word name from an any-order word match into a real name match; and a leading minus subtracts a whole set, which is what makes `site:example.com -site:www.example.com` an inventory of the pages a site does not advertise. Templates marked for running are sent through the same engine chain the web search uses and their result rows parsed; templates marked for opening are emitted as a query plus a ready URL and nothing is requested.',

    why: 'A plain search is a request for whatever an engine thinks is most popular for some words, and popularity is the opposite of what an investigation wants. Operators change the question from "what is relevant" to "what exists of this shape", and the pages that answer the second question are the ones nobody optimised, linked to, or remembered publishing: a membership spreadsheet uploaded to a club website in 2019, a CV in a university directory, a configuration file pasted to a paste site for help, a directory listing left browsable because a server had no index file. None of that is reachable by typing a name into a search box, all of it is already in a public index, and reading an index is passive — the target server sees nothing, because the crawler already visited on somebody else\'s behalf.',

    betterAt: 'Finding documents and exposures rather than people, and doing it without touching the target at all. It is the cheapest way to inventory what an organisation has published as files, the fastest way to see which social platforms carry a handle, and the only technique here that reaches inside formats — a name inside a PDF is invisible to every other adapter in this toolbelt. As a teaching surface it is also the best in the app, because each query states the mechanism it exploits and the operator can watch a single operator change the result set.',

    worseAt: 'Operator support, which is inconsistent and shrinking. `filetype:` and `inurl:` are honoured properly by Google and partially by others; long `OR` chains are reliable on Google and Bing and unreliable on DuckDuckGo, which is why grouped queries here are built for opening rather than parsing. Engines silently drop operators they do not support instead of erroring, so a dork can quietly degrade into a plain word search and return a confident page of irrelevant results. Coverage is also whatever the crawler reached: a file behind a login, a robots exclusion or a link nobody ever made is not in the index, so a clean dork result is not an assurance that nothing is exposed.',

    falsePositives: 'The most dangerous failure is the silent one: an engine that ignores an operator answers the wrong question and gives no sign of it, so a `filetype:xlsx` search that quietly became a keyword search returns pages that are not spreadsheets and a reader who trusts the query believes they are. Scoping to a site with `site:` also matches subdomains and, on some engines, hosts that merely contain the string, so a scoped result is not guaranteed to be on the host that was asked for. Indexed does not mean current — a dork frequently finds a document that was removed years ago and survives only as a cached listing, which reads as a live exposure. And a dork built around a name inherits every problem a name has: the roster PDF ranks identically whether or not its Ivan Petrov is the right one, and a paste-site hit for a common handle is usually somebody else entirely.'
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

    const engine = engineOption(optionString(options, 'engine', 'google'))
    const mode = modeOption(optionString(options, 'mode', 'both'))
    const facts = await readCaseFacts(ctx.caseDir, input.entity as Entity)
    const only = optionList(options, 'dorks', [])
    const built = buildDorks(facts.context, engine, only)

    const manifest: Manifest = {
      kind: 'dorks-run',
      subject: input.entity.label || input.entity.value,
      subjectKind: input.entity.kind,
      engine,
      mode,
      built,
      ran: []
    }

    if (built.length === 0) {
      env.stdout = JSON.stringify(manifest)
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: `No dork in the library applies to a ${input.entity.kind} entity with nothing else in the case to build on.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    if (mode !== 'open') {
      const runnable = built.filter((d) => d.mode === 'run' || d.mode === 'both')
      const maxRun = optionNumber(options, 'maxRun', 4, { min: 0, max: 20 })
      const chain = optionList(options, 'backends', [...DEFAULT_BACKEND_CHAIN]).filter((b) => backendById(b) !== null)
      const instances = optionList(options, 'instances', [...DEFAULT_SEARX_INSTANCES])
      const gapMs = optionNumber(options, 'requestGapMs', 6_000, { min: 500, max: 60_000 })
      const health: BackendHealth = new Map()
      const selected = runnable.slice(0, maxRun)

      let done = 0
      for (const dork of selected) {
        if (ctx.signal.aborted) break
        ctx.progress({
          pct: Math.round((done / selected.length) * 90),
          note: `running ${dork.templateId}`,
          done,
          total: selected.length,
          current: dork.query
        })
        const outcome = await executeSearch(
          {
            query: dork.query,
            chain,
            instances,
            timeoutMs: Math.min(ctx.timeoutMs, 45_000),
            signal: ctx.signal,
            userAgent: optionString(options, 'userAgent', DEFAULT_USER_AGENT),
            gapMs,
            maxRetries: optionNumber(options, 'maxRetries', 1, { min: 0, max: 3 }),
            keep: (backendId, body) => {
              const name = `${dork.id}--${backendId.replace(/[^a-z0-9@.-]/gi, '_')}.txt`
              env.artifacts[name] = body
              return name
            }
          },
          health
        )
        manifest.ran.push({
          id: dork.id,
          templateId: dork.templateId,
          query: dork.query,
          servedBy: outcome.servedBy,
          attempts: outcome.attempts
        })
        done++
      }
      for (const [backend, why] of health) env.notes.push(`Backend ${backend} was struck off mid-run: ${why}`)
    }

    env.stdout = JSON.stringify(manifest)
    env.command =
      manifest.ran.length > 0
        ? { file: 'GET', args: manifest.ran.flatMap((r) => r.attempts.map((a) => a.url)).filter(Boolean) }
        : null
    env.notes.push(
      `Built ${built.length} dorks from ${facts.entitiesRead} case entities for a ${input.entity.kind} subject; mode=${mode}, open-in=${engine}, ran ${manifest.ran.length}.`
    )

    // A library with nothing run is still a complete, useful result — that is the whole
    // point of the open mode — so `ok` is about having built something, not about traffic.
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: true,
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

function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }
  const manifest = parseJsonSafe<Manifest>(env.stdout)
  if (!manifest || manifest.kind !== 'dorks-run' || !Array.isArray(manifest.built)) {
    return { findings: [], proposals: [] }
  }

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  const ranIds = new Set(manifest.ran.map((r) => r.id))

  /* --- 1. every prepared dork, whether or not it was run ------------------ */

  for (const dork of manifest.built) {
    const wasRun = ranIds.has(dork.id)
    const explains = dorkById(dork.templateId)?.explains ?? dork.explains
    findings.push(
      makeFinding(raw, {
        // Nothing was observed to produce this. A prepared query is a suggestion, and
        // `local:` is what stops a suggestion from ever counting towards corroboration.
        source: localSource(ID),
        claim:
          `${dork.title}: ${dork.query} — ${explains} ` +
          `${wasRun ? 'It was run in this session and its results are separate findings.' : `It was not run; open it at ${dork.openUrl} to look at the results yourself.`}`
      })
    )
  }

  /* --- 2. what running them actually returned ---------------------------- */

  for (const r of manifest.ran) {
    const attempts = Array.isArray(r.attempts) ? r.attempts : []
    for (const a of attempts) {
      if (!a.refusal || !a.detail || a.detail.startsWith('not tried:')) continue
      findings.push(
        makeFinding(raw, {
          source: siteOrigin(a.host) || a.host,
          claim: `${a.detail} when asked the dork ${JSON.stringify(r.query)}. The engine refused this client; it did not report that nothing matches. An exposure check that was blocked has found nothing and proved nothing.`
        })
      )
    }

    const served = attempts.find((a) => a.backend === r.servedBy && a.refusal === null && a.artifact)
    if (!served || !r.servedBy) continue
    const backend = backendById(r.servedBy)
    const body = env.artifacts[served.artifact ?? '']
    if (!backend || typeof body !== 'string') continue
    const read = backend.read(body, served.status)
    if (read.refusal) continue

    const host = siteOrigin(served.host) || served.host

    // The failure this whole adapter is most exposed to: an engine that does not support
    // `site:` or `filetype:` drops it and answers the plain word search instead, with a
    // normal status and a normal-looking page. Checking the results against the operators
    // is the only way to notice, and a dork whose operators were ignored has found nothing.
    const compliance = complianceOf(r.query, read.hits)
    if (compliance.ignored) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `${served.host} answered the dork ${JSON.stringify(r.query)} with ${group(read.hits.length)} results, none of which satisfies ${compliance.operators.join(' or ')}. ` +
            `The engine dropped the operators and answered the plain word search instead — silently, with a normal status code. Nothing was learned about exposure of that shape, and these results are not treated as leads.`
        })
      )
      continue
    }

    if (read.hits.length === 0) {
      findings.push(
        makeFinding(raw, {
          source: host,
          claim: `${served.host} returned no results for the dork ${JSON.stringify(r.query)}. That is the engine's index answering, not the web: a file behind a login, a robots exclusion or a page nobody ever linked to is not in any index, so this is not an assurance that nothing of that shape exists.`
        })
      )
      continue
    }

    for (const hit of read.hits.slice(0, MAX_RESULTS_PER_DORK)) {
      const finding = makeFinding(raw, {
        source: host,
        claim:
          `The dork ${JSON.stringify(r.query)} returned ${hit.url} at position ${hit.rank}` +
          `${hit.title ? `, titled ${JSON.stringify(truncate(hit.title, 140))}` : ''}.` +
          `${hit.snippet ? ` The snippet reads ${JSON.stringify(truncate(hit.snippet, 200))}.` : ''}` +
          ` Nothing here fetched that URL — it is an index entry, and an engine that silently ignored an operator would answer this way too.`
      })
      findings.push(finding)

      if (proposals.length >= 20) continue
      const account = accountFromSearchHit(hit.url)
      if (account && !proposals.some((x) => x.kind === 'account' && x.value === `${account.platform}/${account.handle}`)) {
        proposals.push({
          fromFindingId: finding.id,
          kind: 'account',
          value: `${account.platform}/${account.handle}`,
          label: hit.title ? truncate(hit.title, 80) : `${account.platform}/${account.handle}`,
          attrs: { platform: account.platform, handle: account.handle, url: hit.url },
          rationale: `A site-scoped search returned this profile URL for ${JSON.stringify(r.query)}. The scope proves the page is on that platform; it proves nothing about whose page it is, and a page that merely mentions the term ranks the same as one that belongs to the subject.`
        })
      }
    }
  }

  /* --- 3. what the operator should know about the whole technique --------- */

  const openable = manifest.built.filter((d) => !ranIds.has(d.id)).length
  findings.push(
    makeFinding(raw, {
      source: localSource(ID),
      claim:
        `${group(manifest.built.length)} dork${manifest.built.length === 1 ? '' : 's'} were prepared for this subject and ${group(manifest.ran.length)} ${manifest.ran.length === 1 ? 'was' : 'were'} run; ${group(openable)} are queries to open at ${OPEN_ENGINES[manifest.engine]('…').split('?')[0]} rather than parse. ` +
        `An engine that does not support an operator drops it silently and answers a different, broader question, so a dork that comes back with ordinary-looking results may not have been the search that was asked for.`
    })
  )

  return { findings, proposals }
}

function engineOption(v: string): OpenEngine {
  return v in OPEN_ENGINES ? (v as OpenEngine) : 'google'
}

function modeOption(v: string): Mode {
  return v === 'open' || v === 'run' || v === 'both' ? v : 'both'
}

function truncate(s: string, max: number): string {
  const t = (s ?? '').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

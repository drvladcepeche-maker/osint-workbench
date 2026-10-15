/**
 * `wayback` — the Internet Archive's CDX index.
 *
 * No tool to install, no key, no rot risk, and the only adapter here that can show you
 * something that no longer exists. It is also one of the oldest and most stable public
 * APIs on the internet, which is why it is native rather than a wrapper around somebody's
 * Python package.
 *
 * The CDX server answers with a JSON array of arrays whose **first row is the field
 * names**, not data — a shape that catches people who assume a list of objects.
 */

import type { Finding } from '../../shared/types'
import {
  makeFinding,
  type Adapter,
  type AdapterContext,
  type AdapterInput,
  type EntityProposal,
  type RawResult
} from './types'
import {
  beginEnvelope,
  finishEnvelope,
  group,
  parseJsonSafe,
  readEnvelope,
  type RunEnvelope
} from './support/envelope'
import { hostOf, localSource } from './support/sources'
import { httpGet, DEFAULT_USER_AGENT } from './support/net'
import { mergedOptions, optionNumber, optionString } from './support/toolkit'

const ID = 'wayback'
const VERSION = '1.0.0'
const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx'
const SOURCE = 'web.archive.org'

/** The fields requested, in order. The CDX server returns them as positional arrays. */
const FIELDS = ['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'] as const

interface Capture {
  timestamp: string
  original: string
  mimetype: string
  statuscode: string
  digest: string
  length: string
}

export const waybackAdapter: Adapter = {
  id: ID,
  title: 'Wayback Machine (URL/domain → archived history)',
  version: VERSION,

  accepts: ['domain', 'account', 'image'],
  produces: ['domain'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 2,
  minIntervalMs: 3_000,
  defaultTimeoutMs: 120_000,

  doc: {
    what: 'Lists every snapshot the Internet Archive holds for a URL or a whole domain, when each was taken, what it returned, and which of them differ from each other.',

    how: 'It queries the CDX server, which is the index behind the Wayback Machine rather than the Wayback Machine itself. Every capture the Archive has ever made is one line in that index: the crawl timestamp, the original URL, the MIME type, the HTTP status the server gave at the time, the length, and a content digest. Asking the index instead of fetching pages means one request answers "how many times, over what period, and did the content change" for a whole domain. The digest is the useful part — it is a hash of the captured body, so a run of captures sharing a digest is a page that sat unchanged, and a new digest is the moment somebody edited it. `collapse` folds the index server-side: `collapse=digest` gives you only the versions that differ, `collapse=urlkey` gives you one row per distinct URL. Retrieving an actual snapshot afterwards is a separate fetch of `https://web.archive.org/web/<timestamp>/<url>`, which this adapter reports but does not perform.',

    why: 'Deletion on the web is local. When somebody takes a page down, edits a bio, removes a phone number from a contact page or quietly retires a staging server, the version that existed before is still in an archive that they do not control and usually do not think about. The Archive crawls from its own list, from Common Crawl, from Alexa\'s old feeds and from anyone who clicks "Save Page Now", so a page can be captured without ever being submitted deliberately. For an investigation this is the difference between what a subject presents now and what they presented before they decided to stop; for a self-audit it is the uncomfortable discovery that the thing you deleted in 2019 is still one URL away.',

    betterAt: 'History, and being certain about it. Nothing else in this toolbelt can show a previous state of anything. It is free, keyless, unmetered for reasonable use, has been stable for over a decade, and returns an index rather than pages, so one request covers thousands of captures. It is also the natural companion to every other adapter here: subfinder gives you a hostname that no longer resolves, and the Archive tells you what was on it in 2021.',

    worseAt: 'Anything that was never crawled. Coverage is heavily skewed towards pages that were linked from somewhere popular; a small personal site may have three captures in ten years, and a page behind a login, a paywall or a `robots.txt` exclusion may have none. Social media is patchy and often captured as an unusable JavaScript shell. The Archive also honours retroactive exclusion requests, so a domain\'s current owner can suppress captures made by a previous owner — the absence of history is therefore not evidence that nothing was published. And it indexes URLs, not people: it cannot be searched by name.',

    falsePositives: 'The dates mean the crawl, not the content. A capture stamped 2023 can be showing a page that was written in 2011 and never touched since, and a burst of captures usually means the Archive got interested rather than that the page changed — the digest is what distinguishes those, and this adapter reports it for exactly that reason. The archived HTTP status is the status at crawl time, so a 200 in the index says nothing about whether the URL works today. Snapshots also frequently mix eras: a page captured in 2018 may pull images or scripts captured in 2015 or 2021, so a rendered snapshot is a reconstruction, not a photograph. Finally, `matchType=domain` matches on the URL key, and unrelated hosts whose names merely contain the target string can appear in a broad query.'
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const target = resolveTarget(input)
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })

    if (!target) {
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: `No URL or hostname could be derived from this ${input.entity.kind} entity.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    // A domain entity wants an inventory (one row per URL); a specific URL wants a
    // timeline of the versions that actually differ.
    const defaultMatch = input.entity.kind === 'domain' ? 'domain' : 'exact'
    const matchType = optionString(options, 'matchType', defaultMatch)
    const collapse = optionString(options, 'collapse', matchType === 'exact' ? 'digest' : 'urlkey')
    const limit = optionNumber(options, 'limit', 500, { min: 1, max: 20_000 })

    const params = new URLSearchParams({
      url: target,
      output: 'json',
      fl: FIELDS.join(','),
      matchType,
      collapse,
      limit: String(limit)
    })
    const from = optionString(options, 'from', '')
    const to = optionString(options, 'to', '')
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    if (optionString(options, 'filter', '')) params.append('filter', optionString(options, 'filter', ''))

    const url = `${CDX_ENDPOINT}?${params.toString()}`
    env.command = { file: 'GET', args: [url] }
    ctx.progress({ pct: 20, note: `querying the CDX index for ${target}` })

    const res = await httpGet({
      url,
      timeoutMs: Math.min(ctx.timeoutMs, 120_000),
      signal: ctx.signal,
      userAgent: optionString(options, 'userAgent', DEFAULT_USER_AGENT),
      maxBytes: 16 * 1024 * 1024
    })

    env.stdout = res.body
    env.exitCode = res.status
    env.notes.push(`matchType=${matchType}, collapse=${collapse}, limit=${limit}`)
    if (res.truncated) env.notes.push('The CDX response hit the size cap and was truncated.')
    for (const [k, v] of Object.entries(res.headers)) env.notes.push(`header ${k}: ${v}`)
    if (res.error) env.stderr = res.error

    // An empty body is a legitimate answer here: it is what the CDX server returns when
    // it holds nothing for the URL. That is a finding, not a failure.
    const ok = res.error === null && res.status >= 200 && res.status < 300
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok,
      error: res.error ?? `The Internet Archive answered HTTP ${res.status} ${res.statusText}.`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * Hostnames the Archive holds captures for that are not the host the run was pointed at.
   *
   * This is the one adapter that can name something which no longer exists: a subdomain
   * that answered for eighteen months in 2014, was retired, and is in nobody's DNS today
   * is still in the index. That is precisely what makes it worth a candidate — and
   * precisely why a candidate is all it can be. An index row proves a crawler once got a
   * response, not that the host resolves now, and `matchType=domain` matches on the URL
   * key, so a broad query can return a host whose name merely contains the target string.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the CDX index, producing the findings and the proposals together, so a
 * proposal cites the id of the finding standing beside it rather than a rebuilt copy of
 * that finding's claim — which is what the id is derived from, and which would drift.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  if (!env.stdout.trim()) {
    return {
      findings: [
        makeFinding(raw, {
          source: SOURCE,
          claim: `The Internet Archive holds no captures matching ${env.target}. Absence here means it was never crawled or has been excluded, not that nothing was ever published.`
        })
      ],
      proposals: []
    }
  }

  const rows = parseJsonSafe<unknown[][]>(env.stdout)
  if (!Array.isArray(rows)) {
    return {
      findings: [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `The CDX response for ${env.target} could not be read as JSON, so no captures were extracted. The response is preserved in the raw capture and can be re-parsed.`
        })
      ],
      proposals: []
    }
  }
  if (rows.length <= 1) {
    return {
      findings: [
        makeFinding(raw, {
          source: SOURCE,
          claim: `The Internet Archive holds no captures matching ${env.target}. Absence here means it was never crawled or has been excluded, not that nothing was ever published.`
        })
      ],
      proposals: []
    }
  }

  // Row 0 is the field-name header, so the index positions are read from it rather than
  // assumed — the CDX server honours `fl` but the order has moved before.
  const header = (rows[0] ?? []).map((h) => String(h))
  const index = (name: string): number => header.indexOf(name)
  const captures: Capture[] = []
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row)) continue
    const at = (name: string): string => {
      const i = index(name)
      const v = i >= 0 ? row[i] : ''
      return v === undefined || v === null ? '' : String(v)
    }
    const timestamp = at('timestamp')
    if (!/^\d{14}$/.test(timestamp)) continue
    captures.push({
      timestamp,
      original: at('original'),
      mimetype: at('mimetype'),
      statuscode: at('statuscode'),
      digest: at('digest'),
      length: at('length')
    })
  }

  if (!captures.length) {
    return {
      findings: [
        makeFinding(raw, {
          source: SOURCE,
          claim: `The Internet Archive returned ${group(rows.length - 1)} index rows for ${env.target}, none of which carried a readable capture timestamp.`
        })
      ],
      proposals: []
    }
  }

  captures.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const first = captures[0] as Capture
  const last = captures[captures.length - 1] as Capture
  const urls = new Map<string, { count: number; first: string; last: string; statuses: Set<string> }>()
  const digests = new Set<string>()
  for (const c of captures) {
    digests.add(c.digest)
    const entry = urls.get(c.original)
    if (entry) {
      entry.count++
      entry.last = c.timestamp
      entry.statuses.add(c.statuscode)
    } else {
      urls.set(c.original, { count: 1, first: c.timestamp, last: c.timestamp, statuses: new Set([c.statuscode]) })
    }
  }

  const overview = makeFinding(raw, {
    source: SOURCE,
    claim:
      `The Internet Archive holds ${group(captures.length)} indexed capture${captures.length === 1 ? '' : 's'} matching ${env.target}, ` +
      `covering ${group(urls.size)} distinct URL${urls.size === 1 ? '' : 's'}, from ${isoOf(first.timestamp)} to ${isoOf(last.timestamp)}. ` +
      `${group(digests.size)} distinct content digest${digests.size === 1 ? '' : 's'} appear, so the captured content changed ${digests.size <= 1 ? 'not at all' : `${group(digests.size - 1)} time${digests.size === 2 ? '' : 's'}`} across that window.`
  })
  const earliest = makeFinding(raw, {
    source: SOURCE,
    claim: `The earliest archived capture matching ${env.target} is ${isoOf(first.timestamp)} of ${first.original} (HTTP ${first.statuscode || '?'}, ${first.mimetype || 'unknown type'}). It is retrievable at ${snapshotUrl(first)}`
  })
  const findings: Finding[] = [overview, earliest]
  const proposals: EntityProposal[] = []
  // The host the run was aimed at, folded the way the domain entity itself is: `www.` is
  // not a different site, so re-proposing it would put a duplicate of the case's own
  // subject in the review queue.
  const subject = registrable(env.target)
  // A rationale is one line in a review row, and the target can be a whole profile URL.
  const aimedAt = env.target.length > 120 ? `${env.target.slice(0, 119)}…` : env.target
  const proposedHosts = new Set<string>()
  const proposeHost = (url: string, from: Finding, why: string): void => {
    const host = hostOf(url)
    if (!host || !host.includes('.')) return
    // An IP literal is an `ipaddr`, which this adapter does not declare and must not mint.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return
    const value = registrable(host)
    if (!value || value === subject || proposedHosts.has(value)) return
    proposedHosts.add(value)
    proposals.push({
      fromFindingId: from.id,
      kind: 'domain',
      value,
      rationale: `${why} The index proves a crawler once got a response from this host, not that it resolves today — and a domain-wide CDX query matches on the URL key, so a host whose name merely contains the target can appear here.`
    })
  }
  proposeHost(
    first.original,
    earliest,
    `The Internet Archive's earliest capture matching ${aimedAt} was of a URL on this host.`
  )

  if (last.timestamp !== first.timestamp) {
    const latest = makeFinding(raw, {
      source: SOURCE,
      claim: `The most recent archived capture matching ${env.target} is ${isoOf(last.timestamp)} of ${last.original} (HTTP ${last.statuscode || '?'}). It is retrievable at ${snapshotUrl(last)}`
    })
    findings.push(latest)
    proposeHost(
      last.original,
      latest,
      `The Internet Archive's most recent capture matching ${aimedAt} was of a URL on this host.`
    )
  }

  const ranked = [...urls.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
  for (const [url, info] of ranked.slice(0, MAX_URLS)) {
    const statuses = [...info.statuses].filter(Boolean).sort().join('/')
    const archived = makeFinding(raw, {
      source: SOURCE,
      claim:
        `${url} was archived ${group(info.count)} time${info.count === 1 ? '' : 's'} between ${isoOf(info.first)} and ${isoOf(info.last)}` +
        `${statuses ? ` (archived HTTP ${statuses})` : ''}. The stored copy is readable at https://web.archive.org/web/${info.last}/${url} regardless of whether the live URL still works.`
    })
    findings.push(archived)
    proposeHost(
      url,
      archived,
      `A host other than ${aimedAt}, seen in captures the Archive holds between ${isoOf(info.first).slice(0, 10)} and ${isoOf(info.last).slice(0, 10)}.`
    )
  }
  if (ranked.length > MAX_URLS) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: `${group(ranked.length - MAX_URLS)} further archived URLs matching ${env.target} were not turned into findings; all of them are in the raw capture.`
      })
    )
  }

  findings.push(coverageCaveat(raw, env, captures.length))
  return { findings, proposals }
}

/**
 * A hostname reduced to the form a `domain` entity would be stored under: no scheme, no
 * port, no trailing dot, no `www.`. Matching `normaliseEntityValue`'s domain rule here is
 * what lets a proposal be compared against the run's own subject before it is made.
 */
function registrable(urlOrHost: string): string {
  const host = hostOf(urlOrHost)
  return host.replace(/^www\./, '').replace(/\.+$/, '')
}

/** How many distinct archived URLs become findings. The rest stay in the raw capture. */
const MAX_URLS = 60

function coverageCaveat(raw: RawResult, env: RunEnvelope, count: number): Finding {
  const limited = /limit=(\d+)/.exec(env.command?.args?.[0] ?? '')
  const cap = limited ? Number(limited[1]) : null
  const truncated =
    cap !== null && count >= cap
      ? ` The result hit the requested limit of ${group(cap)} rows, so the real history is longer than this — raise \`limit\` or narrow the window with \`from\`/\`to\`.`
      : ''
  return makeFinding(raw, {
    source: localSource(ID),
    claim:
      `Wayback capture dates are crawl dates, not publication dates: a page captured in 2023 may have been written years earlier and never touched since, ` +
      `and the archived HTTP status describes the crawl, not what the URL does today.${truncated}`
  })
}

/** CDX timestamps are `YYYYMMDDhhmmss` in UTC. */
function isoOf(timestamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp)
  if (!m) return timestamp
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}Z`
}

function snapshotUrl(c: Capture): string {
  return `https://web.archive.org/web/${c.timestamp}/${c.original}`
}

function resolveTarget(input: AdapterInput): string {
  const fromOptions = typeof input.options['url'] === 'string' ? (input.options['url'] as string).trim() : ''
  if (fromOptions) return fromOptions
  const entity = input.entity
  if (entity.kind === 'domain') return entity.value
  if (entity.kind === 'image') {
    const attrs = entity.attrs as { sourceUrl?: string }
    return attrs.sourceUrl?.trim() || (/^[a-z][a-z0-9+.-]*:\/\//i.test(entity.value) ? entity.value : '')
  }
  const attrs = entity.attrs as { url?: string; platform?: string; handle?: string }
  if (attrs.url?.trim()) return attrs.url.trim()
  if (attrs.platform && attrs.handle) return `${attrs.platform}/${attrs.handle}`
  return ''
}

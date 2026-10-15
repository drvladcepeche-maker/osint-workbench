/**
 * `archive-today` — the other archive, and the one that holds what the Internet Archive
 * does not.
 *
 * Wayback crawls; archive.today saves on demand. That single difference decides what each
 * one contains. Wayback's coverage follows link popularity and its crawler is politely
 * turned away by most social platforms, so a Twitter thread or an Instagram profile is
 * usually captured as an unusable JavaScript shell or not at all. archive.today renders
 * the page in a real browser at the moment somebody clicks Save, flattens it to static
 * HTML and a screenshot, and keeps it — which is why the captures that exist of deleted
 * posts, edited profiles and taken-down articles overwhelmingly live there.
 *
 * ## Whether this needed a browser: it did not, and that was the surprise
 *
 * archive.today has no official API and a reputation for being unreachable by anything
 * that is not Chrome. The reputation is half right. Probing every mirror from this machine
 * on 2026-09-03:
 *
 *  - The **Memento TimeMap** at `https://<mirror>/timemap/<url>` answered `200` with
 *    `application/link-format` — a standards-based, machine-readable list of every capture
 *    it holds, with a timestamp on each. No key, no cookie, no Cloudflare challenge.
 *  - A missing URL answered `404` with the plain text *"TimeMap does not exists. The
 *    archive has no Mementos for the requested URI"*, which is a clean, unambiguous
 *    absence rather than a soft 404 that has to be guessed at.
 *  - Individual snapshots at `https://<mirror>/<timestamp>/<url>` also answered `200` with
 *    the full captured page.
 *
 * And the part that inverts the expectation: **the honest User-Agent worked and a Chrome
 * one did not.** Every mirror answered `200` to `osint-workbench/0.1 …` and `429 Too Many
 * Requests` to a copied Chrome string, on the same connection, seconds apart. Impersonating
 * a browser here actively makes things worse, which is a pleasant confirmation of the
 * policy in `support/net.ts` rather than an exception to it.
 *
 * So no browser automation is needed for the index or for reading a capture, and none is
 * used. The one thing that genuinely does need a browser is **submitting a new capture** —
 * that is a form POST behind a challenge — and this adapter deliberately does not do it.
 * Reading an archive is observation; adding to it is publication, and publishing a page
 * about a subject is not a thing a research tool should do on its own initiative.
 *
 * ## The mirrors
 *
 * `archive.today`, `.ph`, `.is`, `.li`, `.vn`, `.fo` and `.md` are one service behind
 * several domains — all seven returned byte-identical responses in testing. They are
 * failed over between anyway, because the operator's DNS, a resolver or a network filter
 * will eventually take one of them out, and losing an adapter to a single domain would be
 * a silly way to lose it.
 */

import type { Finding } from '../../shared/types'
import { makeFinding, type Adapter, type AdapterContext, type AdapterInput, type RawResult } from './types'
import { beginEnvelope, finishEnvelope, group, parseJsonSafe, readEnvelope } from './support/envelope'
import { localSource } from './support/sources'
import { httpGet, politeDelay, DEFAULT_USER_AGENT } from './support/net'
import { mergedOptions, optionList, optionNumber, optionString } from './support/toolkit'

const ID = 'archive-today'
const VERSION = '1.0.0'

/**
 * `Finding.source` for everything read here.
 *
 * One string for all seven mirrors on purpose: they are one archive, and letting
 * `archive.ph` and `archive.md` count as two sources would fabricate corroboration out of
 * a DNS choice this adapter made by itself.
 */
const SOURCE = 'archive.today'

const MIRRORS = ['archive.ph', 'archive.today', 'archive.is', 'archive.li', 'archive.vn', 'archive.fo', 'archive.md'] as const

/** The manifest `parse()` reads. Collection metadata only. */
interface Manifest {
  kind: 'archive-today-run'
  target: string
  attempts: { mirror: string; url: string; status: number; bytes: number; note: string; artifact: string | null }[]
  servedBy: string | null
}

export const archiveTodayAdapter: Adapter = {
  id: ID,
  title: 'archive.today (on-demand captures Wayback does not have)',
  version: VERSION,

  accepts: ['domain', 'account', 'image'],
  // It indexes captures of the URL it was asked about and nothing else — every memento is
  // a copy of that same address. There is no new entity in here to name, and declaring one
  // it cannot deliver would be a lie in the UI.
  produces: [],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 5_000,
  defaultTimeoutMs: 90_000,

  doc: {
    what: 'Lists every snapshot archive.today holds of a URL, when each was taken, and hands back the address of each stored copy — the archive that captures social media and deleted posts that the Internet Archive mostly misses.',

    how: 'It asks for the Memento TimeMap at `https://archive.ph/timemap/<url>`, an IETF-standard index (RFC 7089) that no scraping is required to read: the response is `application/link-format`, one line per capture, each line an angle-bracketed URL followed by `rel="memento"` and an RFC 1123 `datetime`. The capture timestamp is taken from the memento URL\'s own `/YYYYMMDDhhmmss/` path segment rather than the header date, because the path segment is what addresses the stored copy. A URL the archive has never seen answers `404` with a one-line plain-text explanation, which is why absence here is unambiguous rather than inferred. If a mirror fails the same request is repeated against the next of the seven domains the service answers on. No browser is involved and no capture is submitted: this reads the archive, it never adds to it.',

    why: 'The two big archives hold different things because they acquire pages differently. The Internet Archive crawls, following links and its own lists, and is refused by most social platforms — so its copy of a profile is often an empty JavaScript shell. archive.today only stores what a human deliberately clicked Save on, rendered in a real browser and flattened to static HTML, which means its holdings are biased towards exactly the pages somebody expected to disappear: a post before it was deleted, a bio before it was edited, an article before it was retracted, a profile before it was locked. That bias is what makes it worth a second query. It is also the reason a page can be absent from Wayback and present here, and checking only one of them is the most common way an investigation concludes that something was never public.',

    betterAt: 'Social media, deleted content and anything somebody wanted preserved before it vanished. Its captures are rendered rather than crawled, so a page that needs JavaScript to show anything is stored as it actually looked, complete with a screenshot. Because a capture is a deliberate human act, a URL having captures at all is itself informative — somebody thought it was worth keeping — and the timing of those captures often marks the moment a page became controversial.',

    worseAt: 'Breadth and history. It holds only pages a person chose to save, so an ordinary site with nobody watching it has nothing here while Wayback may have a decade of crawls. There is no way to search it by content, no domain-wide query, and no equivalent of the CDX index\'s content digest, so this cannot tell you whether a page changed between two captures without fetching both. It also offers no way to enumerate what it holds about a person — only about a URL you already have.',

    falsePositives: 'The dates in a TimeMap are not reliably the dates of the content. archive.today derives some entries from what the captured page claimed about itself, and the index for a much-saved URL contains entries stamped decades in the past and years in the future — a real TimeMap examined during development ran from 1994 to 2035 for a page that has existed since 1995. Treat anything outside a plausible window as a date the archive was told rather than one it observed; this adapter flags them rather than quietly averaging them in. Beyond that, a capture proves what one machine received at one moment, not what a visitor saw: pages are captured mid-load, with cookie banners covering the content, in the wrong language, or already showing an error. And the archive is not neutral about what it stores — anti-bot pages, paywalls and login walls are saved with as much conviction as real content, so a snapshot can look like a page and be a refusal.'
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
        error: `No URL could be derived from this ${input.entity.kind} entity. archive.today indexes URLs, not names.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    const mirrors = optionList(options, 'mirrors', [...MIRRORS])
    const gapMs = optionNumber(options, 'requestGapMs', 2_000, { min: 250, max: 30_000 })
    const manifest: Manifest = { kind: 'archive-today-run', target, attempts: [], servedBy: null }

    let first = true
    for (const mirror of mirrors) {
      if (ctx.signal.aborted) break
      if (!first) await politeDelay(gapMs, ctx.signal)
      first = false

      const url = `https://${mirror}/timemap/${target}`
      ctx.progress({ pct: 30, note: `asking ${mirror} for its capture index`, current: mirror })
      const res = await httpGet({
        url,
        timeoutMs: Math.min(ctx.timeoutMs, 45_000),
        signal: ctx.signal,
        userAgent: optionString(options, 'userAgent', DEFAULT_USER_AGENT),
        accept: 'application/link-format, text/plain;q=0.8',
        maxBytes: 8 * 1024 * 1024
      })

      if (res.error !== null) {
        manifest.attempts.push({ mirror, url, status: 0, bytes: 0, note: res.error, artifact: null })
        continue
      }

      const artifact = `${mirror}.timemap.txt`
      env.artifacts[artifact] = res.body
      manifest.attempts.push({
        mirror,
        url,
        status: res.status,
        bytes: res.bytes,
        note: Object.entries(res.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; '),
        artifact
      })

      // A 404 is a real answer — the archive saying it holds nothing — and stops the
      // failover just as firmly as a 200 does. Trying six more mirrors for the same
      // definitive "no" would be pure noise on somebody else's server.
      if (res.status === 200 || res.status === 404) {
        manifest.servedBy = mirror
        break
      }
    }

    env.stdout = JSON.stringify(manifest)
    env.command = { file: 'GET', args: manifest.attempts.map((a) => a.url) }
    env.notes.push(`Tried ${manifest.attempts.length} of ${mirrors.length} mirrors; ${manifest.servedBy ?? 'none'} answered.`)

    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: manifest.servedBy !== null,
      error:
        manifest.servedBy !== null
          ? null
          : `No archive.today mirror answered. Attempts: ${manifest.attempts.map((a) => `${a.mirror} ${a.status || a.note}`).join('; ')}`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    const env = readEnvelope(raw)
    if (!env) return []
    const manifest = parseJsonSafe<Manifest>(env.stdout)
    if (!manifest || manifest.kind !== 'archive-today-run') return []

    const served = manifest.attempts.find((a) => a.mirror === manifest.servedBy)
    if (!served) {
      return [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `No archive.today mirror answered for ${manifest.target || 'this target'}, so this run learned nothing. That is a fact about reachability from this machine, not about whether the archive holds captures.`
        })
      ]
    }

    const body = env.artifacts[served.artifact ?? ''] ?? ''

    if (served.status === 404 || /TimeMap does not exist/i.test(body)) {
      return [
        makeFinding(raw, {
          source: SOURCE,
          claim: `archive.today holds no captures of ${manifest.target}. Its holdings are only what somebody deliberately clicked Save on, so absence means nobody archived this URL here — it says nothing about whether the page existed, and the Internet Archive may still have crawled it.`
        })
      ]
    }

    const mementos = parseTimeMap(body)
    if (mementos.length === 0) {
      return [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `${served.mirror} answered HTTP ${served.status} for ${manifest.target} with ${group(served.bytes)} bytes that contained no readable memento links. The response is preserved in the raw capture and can be re-parsed once the reader is fixed, with nothing re-fetched.`
        })
      ]
    }

    mementos.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const plausible = mementos.filter((m) => isPlausible(m.timestamp, raw.finishedAt))
    const odd = mementos.length - plausible.length
    const span = plausible.length ? plausible : mementos
    const first = span[0]!
    const last = span[span.length - 1]!
    const years = new Map<string, number>()
    for (const m of span) years.set(m.timestamp.slice(0, 4), (years.get(m.timestamp.slice(0, 4)) ?? 0) + 1)

    const findings: Finding[] = [
      makeFinding(raw, {
        source: SOURCE,
        claim:
          `archive.today holds ${group(mementos.length)} capture${mementos.length === 1 ? '' : 's'} of ${manifest.target}, ` +
          `the earliest ${isoOf(first.timestamp)} and the most recent ${isoOf(last.timestamp)}. ` +
          `Each one exists because a person chose to save that page at that moment, which makes the timing itself informative in a way a crawler's schedule is not.`
      }),
      makeFinding(raw, {
        source: SOURCE,
        claim: `The earliest archive.today capture of ${manifest.target} is ${isoOf(first.timestamp)}, stored at ${first.url}. It is a rendered copy of the page as it was then, readable whether or not the live URL still works.`
      })
    ]

    if (last.timestamp !== first.timestamp) {
      findings.push(
        makeFinding(raw, {
          source: SOURCE,
          claim: `The most recent archive.today capture of ${manifest.target} is ${isoOf(last.timestamp)}, stored at ${last.url}. Comparing it against the earliest capture is how you see what the page stopped saying.`
        })
      )
    }

    if (years.size > 1) {
      const distribution = [...years.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([y, n]) => `${y}: ${n}`)
        .join(', ')
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: `Captures of ${manifest.target} by year — ${distribution}. A cluster of saves in one period usually marks the moment the page became worth preserving to somebody, which is often the moment it became contentious or was about to be deleted.`
        })
      )
    }

    if (odd > 0) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: `${group(odd)} of the ${group(mementos.length)} index entries carry a timestamp outside a plausible window — before 1995 or in the future — and were left out of the span above. Those dates come from what the captured page claimed about itself rather than from when the archive stored it, so they are not evidence of anything about the subject.`
        })
      )
    }

    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: `archive.today and the Internet Archive hold different things and neither is a substitute for the other: one saves what a person clicked, the other saves what a crawler reached. Running ${'`wayback`'} on the same target is the other half of this question, and a URL missing from both is the only kind of absence worth calling absence.`
      })
    )

    return findings
  }
}

/* ------------------------------------------------------------------ *
 * The TimeMap reader
 * ------------------------------------------------------------------ */

export interface Memento {
  url: string
  timestamp: string
  /** `memento`, `first memento`, `last memento`, `original`, `timegate`, `self`. */
  rel: string
}

/**
 * Read an `application/link-format` TimeMap.
 *
 * Entries are separated by commas, and so are the parameters within an entry, and URLs are
 * perfectly free to contain commas of their own — which is why this walks
 * angle-bracket-delimited targets and takes everything up to the next `<` as that entry's
 * parameters, rather than splitting the document on `,`. Splitting on the comma is the
 * obvious implementation and it silently drops every capture of a URL with a comma in the
 * query string.
 *
 * Pure and total: anything unreadable yields fewer entries, never an exception.
 */
export function parseTimeMap(body: string): Memento[] {
  const out: Memento[] = []
  if (typeof body !== 'string' || !body.trim()) return out
  for (const m of body.matchAll(/<([^>]+)>([^<]*)/g)) {
    const url = (m[1] ?? '').trim()
    const params = m[2] ?? ''
    const rel = (/\brel\s*=\s*"([^"]*)"/i.exec(params)?.[1] ?? '').trim().toLowerCase()
    if (!rel.includes('memento')) continue
    // The path segment addresses the stored copy and is what the archive itself uses; the
    // `datetime` header is only consulted when the URL is not in the expected shape.
    const fromUrl = /\/(\d{14})\//.exec(url)?.[1] ?? ''
    const timestamp = fromUrl || fromHttpDate(/\bdatetime\s*=\s*"([^"]*)"/i.exec(params)?.[1] ?? '')
    if (!/^\d{14}$/.test(timestamp)) continue
    out.push({ url, timestamp, rel })
  }
  // One capture appears twice when it is both `first memento` and `memento`.
  const seen = new Set<string>()
  return out.filter((m) => (seen.has(m.timestamp) ? false : (seen.add(m.timestamp), true)))
}

/** `Sat, 31 Dec 1994 15:00:00 GMT` -> `19941231150000`. */
function fromHttpDate(s: string): string {
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

/**
 * Whether a capture timestamp can be believed as a capture date.
 *
 * archive.today's index carries entries stamped 1994 and 2035 for a page that has existed
 * since 1995 — dates it took from the captured content rather than from its own clock. The
 * window is deliberately generous at the bottom (the web predates the archive) and hard at
 * the top (nothing can be captured after now).
 */
function isPlausible(timestamp: string, runFinishedAt: string): boolean {
  const year = Number(timestamp.slice(0, 4))
  if (!Number.isFinite(year) || year < 1995) return false
  const now = Date.parse(runFinishedAt)
  const nowYear = Number.isFinite(now) ? new Date(now).getUTCFullYear() : 9999
  return year <= nowYear
}

function isoOf(timestamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp)
  if (!m) return timestamp
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}Z`
}

/** The URL to ask the archive about, from whatever kind of entity the run was pointed at. */
function resolveTarget(input: AdapterInput): string {
  const fromOptions = typeof input.options['url'] === 'string' ? (input.options['url'] as string).trim() : ''
  if (fromOptions) return fromOptions

  const entity = input.entity
  if (entity.kind === 'domain') return `https://${entity.value}`
  if (entity.kind === 'image') {
    const attrs = entity.attrs as { sourceUrl?: string }
    const source = attrs.sourceUrl?.trim() ?? ''
    if (source) return source
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(entity.value) ? entity.value : ''
  }
  const attrs = entity.attrs as { url?: string; platform?: string; handle?: string }
  if (attrs.url?.trim()) return attrs.url.trim()
  if (attrs.platform && attrs.handle) return `https://${attrs.platform}/${attrs.handle}`
  return ''
}

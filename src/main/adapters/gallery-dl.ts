/**
 * `gallery-dl` — resolve a gallery, profile or media URL into the individual files behind
 * it, together with every metadata field the site's own API attaches to them.
 *
 * Run in simulate mode (`-s`) with JSON dump (`-j`), it downloads nothing: it performs
 * exactly the extraction step and prints what it *would* fetch. That is the useful half
 * for an investigation, and it is the only Python tool in the Phase 0 set that prints
 * proper JSON to stdout instead of writing a file with a name it chose itself.
 *
 * Output is an array of `[type, ...payload]` tuples. Type 2 is a directory with its
 * metadata, type 3 is a downloadable URL with its metadata, type 6 is a queued sub-URL.
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
  recordSpawn,
  stderrSummary,
  type RunEnvelope
} from './support/envelope'
import { hostOf, localSource, siteOrigin } from './support/sources'
import {
  checkBinary,
  mergedOptions,
  optionNumber,
  optionString,
  osintEnv,
  resolveBinary
} from './support/toolkit'

const ID = 'gallery-dl'
const VERSION = '1.0.0'
const BIN_CANDIDATES = ['venv/Scripts/gallery-dl.exe', 'venv/bin/gallery-dl'] as const

/** Metadata keys worth a finding of their own, with how to phrase each. */
const META_FIELDS: { key: string; describe: (v: string, host: string) => string }[] = [
  { key: 'username', describe: (v, h) => `${h} attributes this media to the account "${v}".` },
  { key: 'user', describe: (v, h) => `${h} attributes this media to the user "${v}".` },
  { key: 'author', describe: (v, h) => `${h} names "${v}" as the author of this media.` },
  { key: 'uploader', describe: (v, h) => `${h} names "${v}" as the uploader of this media.` },
  { key: 'nickname', describe: (v, h) => `${h} shows the display name "${v}" for this account.` },
  { key: 'date', describe: (v, h) => `${h} timestamps this media ${v}.` },
  { key: 'title', describe: (v, h) => `${h} titles this item "${truncate(v, 200)}".` },
  { key: 'description', describe: (v, h) => `${h} carries the description "${truncate(v, 300)}" on this item.` },
  { key: 'tags', describe: (v, h) => `${h} tags this item: ${truncate(v, 300)}.` },
  { key: 'location', describe: (v, h) => `${h} attaches the location "${v}" to this item.` },
  { key: 'gps', describe: (v, h) => `${h} attaches the coordinates ${v} to this item.` }
]

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export const galleryDlAdapter: Adapter = {
  id: ID,
  title: 'gallery-dl (URL → media list + site metadata)',
  version: VERSION,

  accepts: ['image', 'account'],
  produces: ['image', 'account', 'username', 'location'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 2,
  minIntervalMs: 2_000,
  defaultTimeoutMs: 120_000,

  doc: {
    what: 'Turns one gallery, profile or media URL into the list of individual files behind it, with every metadata field the hosting site attaches to each one — and in this app it never downloads anything.',

    how: 'It carries a per-site extractor: a URL pattern that says "this is a Reddit user page" or "this is an Imgur album", and code that knows how to walk that particular site\'s pagination and how to read its responses. Most extractors call the site\'s own JSON API — the same endpoint the site\'s own front end calls to render the page — because that returns structured data instead of HTML that has to be scraped. The extractor emits a stream of messages: a directory with its metadata, then one message per file with its URL and its own metadata dict. Passing `--simulate` stops it at exactly that point, so the whole pipeline runs and produces the full listing without a single media byte being fetched, and `--dump-json` prints the stream as JSON.',

    why: 'The metadata a site attaches to a piece of media is usually richer than anything on the visible page. An API response for a single post routinely carries the uploader\'s internal numeric id, the account creation date, the exact upload timestamp to the second, the original filename as it existed on the uploader\'s device, the caption before it was edited, and sometimes coordinates. That numeric id in particular is what survives a rename: an account that changes its handle keeps its id, so a media listing captured today still identifies the same account after the handle changes. It is also the practical bridge to the exiftool adapter — download one file and its embedded metadata becomes readable too.',

    betterAt: 'Enumerating what a profile actually holds, and doing it without touching the media. It supports several hundred sites with maintained extractors, it prints proper JSON to stdout so nothing has to be globbed off disk, it is fast, and in simulate mode it is close to weightless for the target — one API listing rather than hundreds of file downloads. When you need the original file rather than a re-encoded copy, it is also the only thing here that will get it.',

    worseAt: 'Anything behind a login. Instagram, most of Twitter/X, and any private or age-gated content need cookies or credentials, and this app does not hold either — for those sites it returns an authentication error rather than a partial result. It also has no search capability at all: it resolves a URL you already have and cannot find that URL for you. Extractors break when a site changes its API, and a broken extractor usually fails loudly rather than silently, which is at least the better direction.',

    falsePositives: 'The metadata is what the site chooses to serve, so it inherits the site\'s own inaccuracies and the uploader\'s. Timestamps are the usual problem: some sites report upload time, some report capture time, some report the time the post was last edited, and they are variously in UTC, in the site\'s local zone, or in the viewer\'s — comparing timestamps across two sites without checking which is which produces confident nonsense. Display names and locations are free text the uploader typed and are frequently jokes. Reposted media carries the reposter\'s metadata, not the original creator\'s, so an attribution here is "who uploaded this copy", never "who made this". And simulate mode reports the URLs the extractor resolved, which for expiring CDN links may already be dead by the time you open them.'
  },

  check(ctx) {
    return checkBinary(
      ctx.config,
      ctx.toolkitRoot,
      ID,
      BIN_CANDIDATES,
      'Install it into the toolkit venv: <toolkitRoot>\\venv\\Scripts\\pip.exe install gallery-dl'
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const url = resolveUrl(input)
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target: url, startedAt })

    if (!url) {
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: `No URL could be derived from this ${input.entity.kind} entity. gallery-dl resolves a URL; give the entity a sourceUrl (image) or url (account) attribute.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN_CANDIDATES)
    const args: string[] = [
      // --simulate: run the whole extraction and download nothing. The pair below is what
      // makes this adapter safe to point at someone's profile.
      '-s',
      '-j',
      '--no-colors',
      '--retries',
      String(optionNumber(options, 'retries', 1, { min: 0, max: 5 }))
    ]
    const range = optionString(options, 'range', '1-100')
    if (range) args.push('--range', range)
    const cookies = optionString(options, 'cookiesFile', '')
    if (cookies) args.push('--cookies', cookies)
    args.push(url)

    ctx.progress({ pct: 15, note: `resolving ${hostOf(url) || url}` })

    const res = await ctx.spawn(bin.file, {
      args,
      env: osintEnv(ctx.toolkitRoot),
      timeoutMs: ctx.timeoutMs
    })
    recordSpawn(env, { file: bin.file, args }, res)

    const looksJson = res.stdout.trim().startsWith('[')
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: looksJson,
      error: res.spawnError
        ? `gallery-dl did not run: ${res.spawnError}`
        : `gallery-dl exited ${res.exitCode} without JSON output. ${stderrSummary(env) || 'The URL may be unsupported or require authentication.'}`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * The uploader, their handle and the files themselves, as candidates.
   *
   * What this adapter learns is what the site's own API says about a listing, so a
   * proposal here is only ever "the site attributes this to that account". Reposted media
   * carries the reposter's metadata, which makes an attribution "who uploaded this copy"
   * rather than "who made this" — the rationales say so, because that distinction is the
   * one a reviewer will otherwise skip past.
   *
   * The media proposals are capped well below the number of findings. A profile listing
   * resolves hundreds of files and a review queue with four hundred rows in it is a review
   * queue nobody reads; the rest stay in the raw capture, where they can be re-derived.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/** How many resolved media URLs become findings; the rest stay in the raw capture. */
const MAX_MEDIA = 50

/**
 * How many of those become *candidates*. Deliberately half the finding cap: a finding is
 * a row in a report the operator can scroll past, a candidate is a question he has to
 * answer one at a time.
 */
const MAX_MEDIA_PROPOSALS = 25

/** Metadata keys that carry a login handle rather than a display name. */
const HANDLE_KEYS = new Set(['username', 'user', 'uploader'])

/** What a handle can look like before it is worth putting a URL together from it. */
const HANDLE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * One walk of the message stream, producing the findings and the proposals together, so a
 * proposal can cite the id of the finding built beside it rather than a second copy of a
 * claim string that would drift the moment one of the two was edited.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const messages = parseJsonSafe<unknown[]>(env.stdout)
  if (!Array.isArray(messages)) {
    return {
      findings: [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `gallery-dl produced output for ${env.target} that was not a JSON array, so nothing was extracted. ${stderrSummary(env)}`.trim()
        })
      ],
      proposals: []
    }
  }

  const host = siteOrigin(env.target) || 'unknown host'
  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  const mediaUrls: string[] = []
  const seenMeta = new Set<string>()
  const seenProposal = new Set<string>()
  let queued = 0

  for (const message of messages) {
    if (!Array.isArray(message) || !message.length) continue
    const type = message[0]

    if (type === 3 || type === 6) {
      const url = typeof message[1] === 'string' ? message[1] : ''
      const meta = asRecord(message[2])
      if (type === 6) queued++
      else if (url) mediaUrls.push(url)
      collectMetadata(raw, meta, host, seenMeta, findings, { env, proposals, seenProposal })
      continue
    }
    if (type === 2) {
      collectMetadata(raw, asRecord(message[1]), host, seenMeta, findings, { env, proposals, seenProposal })
    }
  }

  let mediaProposed = 0
  for (const url of mediaUrls.slice(0, MAX_MEDIA)) {
    const file = makeFinding(raw, {
      // The **site**, not the CDN the site serves its bytes from. `pbs.twimg.com` and
      // `twitter.com` are one operator answering about one profile, and sourcing the media
      // at the content host made a site and its own CDN read as two independent sources —
      // the one bypass of the fold that manufactured agreement rather than splitting it.
      // The CDN host is in the claim, where it is information rather than a key.
      source: host,
      claim: `${host} serves a media file for ${env.target} at ${truncate(url, 400)}`
    })
    findings.push(file)
    // The file the run was pointed at is already the image entity in the graph; resolving
    // a direct media URL returns it unchanged, and proposing it back would ask the
    // operator to approve something he typed in himself.
    if (mediaProposed >= MAX_MEDIA_PROPOSALS || url === env.target.trim()) continue
    mediaProposed++
    const capped =
      mediaUrls.length > MAX_MEDIA_PROPOSALS
        ? ` One of the first ${MAX_MEDIA_PROPOSALS} of ${group(mediaUrls.length)} resolved URLs; the remainder stay in the raw capture rather than in the review queue.`
        : ''
    proposals.push({
      fromFindingId: file.id,
      kind: 'image',
      value: url,
      attrs: { sourceUrl: url, listing: env.target },
      rationale: `${host} listed this file under ${truncate(env.target, 120)}.${capped} Resolved in simulate mode and never downloaded, so an expiring CDN link may already be dead.`
    })
  }

  const omitted = mediaUrls.length > MAX_MEDIA ? ` ${group(mediaUrls.length - MAX_MEDIA)} further media URLs are in the raw capture only.` : ''
  findings.push(
    makeFinding(raw, {
      source: localSource(ID),
      claim:
        `gallery-dl resolved ${env.target} into ${group(mediaUrls.length)} media file${mediaUrls.length === 1 ? '' : 's'}` +
        `${queued ? ` and ${group(queued)} queued sub-listing${queued === 1 ? '' : 's'}` : ''} in ${(env.durationMs / 1000).toFixed(1)} s, without downloading anything.${omitted}`
    })
  )
  return { findings, proposals }
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}
}

/** What `collectMetadata` needs in order to name entities as well as state facts. */
interface ProposalSink {
  env: RunEnvelope
  proposals: EntityProposal[]
  /** `kind|value`, so the same handle seen on fifty files is one candidate, not fifty. */
  seenProposal: Set<string>
}

function collectMetadata(
  raw: RawResult,
  meta: Record<string, unknown>,
  host: string,
  seen: Set<string>,
  out: Finding[],
  sink: ProposalSink
): void {
  for (const field of META_FIELDS) {
    const value = flatten(meta[field.key])
    if (!value) continue
    const key = `${field.key}=${value}`
    if (seen.has(key)) continue
    seen.add(key)
    const finding = makeFinding(raw, { source: host, claim: field.describe(value, host) })
    out.push(finding)
    proposeFromMetadata(field.key, value, host, finding, sink)
  }
}

/**
 * Turn one metadata field into candidates, or into nothing.
 *
 * Three fields out of eleven name a thing. A title, a description, a tag list and a
 * timestamp describe a post; a `nickname` is a display name the uploader typed and this
 * adapter cannot propose people, so it stays a finding. What is left is the handle — the
 * account and the username are proposed as two separate entities because they are two
 * separate things: `reddit.com/x` is one profile, `x` is a string to go looking for
 * everywhere else — and whatever the site attached as a place.
 */
function proposeFromMetadata(
  key: string,
  value: string,
  host: string,
  from: Finding,
  sink: ProposalSink
): void {
  const { env, proposals, seenProposal } = sink
  const add = (p: EntityProposal): void => {
    const dedupe = `${p.kind}|${p.value.toLowerCase()}`
    if (seenProposal.has(dedupe)) return
    seenProposal.add(dedupe)
    proposals.push(p)
  }

  if (HANDLE_KEYS.has(key)) {
    // A numeric id makes a URL that goes nowhere, and a display name with spaces in it is
    // not a handle. Both are already findings; neither is worth a candidate.
    if (!HANDLE_SHAPE.test(value) || !/[A-Za-z]/.test(value)) return
    // `platform/handle` off the same folded origin `Finding.source` uses, so a gallery-dl
    // proposal and a maigret proposal about the same site converge on one candidate
    // carrying two proposals rather than two candidates that look like two accounts.
    // Without an origin there is no account to name — only the handle survives.
    const platform = siteOrigin(env.target)
    if (platform && !isSubjectHandle(env, value)) {
      add({
        fromFindingId: from.id,
        kind: 'account',
        value: `${platform}/${value}`,
        label: `${value} on ${platform}`,
        attrs: { platform, handle: value },
        rationale: `${host}'s own API attributes this listing to that account. It says who uploaded this copy, which is not the same as who made it — reposted media carries the reposter's name.`
      })
    }
    add({
      fromFindingId: from.id,
      kind: 'username',
      value,
      rationale: `The bare handle behind the ${host} account, worth searching elsewhere. Handle reuse across services is a hypothesis to test, never an identification on its own.`
    })
    return
  }

  if (key === 'gps') {
    const coords = coordinatePair(value)
    if (!coords) return
    add({
      fromFindingId: from.id,
      kind: 'location',
      value: coords,
      rationale: `${host} attaches this coordinate to the item. It comes from the uploading device or from a place the uploader picked in the app, so it is the post's claim about where it was, not an observation.`
    })
    return
  }

  if (key === 'location') {
    const place = value.trim()
    if (place.length < 2 || place.length > 120) return
    add({
      fromFindingId: from.id,
      kind: 'location',
      value: place,
      rationale: `A place name the uploader attached, not a coordinate: far weaker than a GPS pair, free text on most sites, and by this adapter's own account frequently a joke.`
    })
  }
}

/**
 * True when this handle is the account the run was already pointed at.
 *
 * Pointing gallery-dl at a profile URL and having it answer with that same profile is the
 * expected case, not a discovery, and the operator should not be asked to approve an
 * entity he typed in himself.
 */
function isSubjectHandle(env: RunEnvelope, handle: string): boolean {
  if (env.entityKind !== 'account') return false
  const last = env.target.split(/[?#]/)[0]?.split('/').filter(Boolean).pop() ?? ''
  return last.toLowerCase() === handle.toLowerCase()
}

/** `lat,lon` when the value is a coordinate pair, `''` otherwise. Never guessed at. */
function coordinatePair(value: string): string {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value)
  if (!m) return ''
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return ''
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return ''
  if (lat === 0 && lon === 0) return ''
  // Unrounded: `normaliseEntityValue` rounds a pair to 6dp, which is what makes two
  // adapters reporting the same point converge on one candidate.
  return `${lat},${lon}`
}

/** Metadata values are strings, numbers, arrays of strings, or nested objects. */
function flatten(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (Array.isArray(v)) {
    const parts = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String)
    return parts.slice(0, 30).join(', ')
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const name = o['name'] ?? o['username'] ?? o['nick'] ?? o['id']
    return typeof name === 'string' || typeof name === 'number' ? String(name) : ''
  }
  return ''
}

function resolveUrl(input: AdapterInput): string {
  const entity = input.entity
  const fromOptions = typeof input.options['url'] === 'string' ? (input.options['url'] as string).trim() : ''
  if (fromOptions) return fromOptions

  if (entity.kind === 'image') {
    const attrs = entity.attrs as { sourceUrl?: string; path?: string }
    if (attrs.sourceUrl?.trim()) return attrs.sourceUrl.trim()
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entity.value)) return entity.value
    return ''
  }
  const attrs = entity.attrs as { url?: string; platform?: string; handle?: string }
  if (attrs.url?.trim()) return attrs.url.trim()
  if (attrs.platform && attrs.handle) return `https://${attrs.platform}/${attrs.handle}`
  return ''
}

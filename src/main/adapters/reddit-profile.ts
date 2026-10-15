/**
 * `reddit-profile` — a behavioural read of one Reddit account, built on Reddit's own
 * public JSON, with no third-party service in the middle.
 *
 * Reddit will serve almost any page as JSON if you append `.json` to the path. No key, no
 * OAuth, no scraping. That is why this is a native adapter rather than a wrapper around
 * somebody's "Reddit OSINT" site: those sites are a rate-limited middleman in front of an
 * endpoint we can call ourselves, and they go dark without warning.
 *
 * **Verified 2026-08-30: that access is no longer reliable.** From this machine, every
 * keyless `.json` endpoint — `www.reddit.com`, `api.reddit.com`, a user profile, a
 * subreddit listing — answered HTTP 403 with Reddit's "blocked by network security"
 * interstitial, and `old.reddit.com` answered a blanket 404. It is a block aimed at
 * unauthenticated clients, not at this user agent: a browser user agent was refused
 * identically. The adapter is kept as written because the mechanism and the analysis are
 * correct and the block is a property of one network at one moment, but it reports a 403
 * as a refusal aimed at the client and refuses to say anything about the account. Do not
 * read an empty result here as an empty account.
 *
 * All analysis is deterministic and local — histograms, counting, tokenising. There is no
 * model anywhere in this file, per DECISIONS.md.
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
  readEnvelope
} from './support/envelope'
import { localSource, siteOrigin } from './support/sources'
import { httpGet, politeDelay } from './support/net'
import { mergedOptions, optionNumber, optionString, subjectValue } from './support/toolkit'
import { analyseActivity, formatHourRange, formatOffset, renderHistogram, toDate } from './support/activity'

const ID = 'reddit-profile'
const VERSION = '1.0.0'
const SOURCE = 'reddit.com'
const BASE = 'https://www.reddit.com'

/**
 * Reddit asks for a descriptive User-Agent and enforces it — a generic or browser-faking
 * one gets a 429 quickly. Saying honestly what this is gets far better behaviour than
 * pretending to be Chrome.
 */
const REDDIT_USER_AGENT = `windows:osint-workbench:0.1.0 (local research instrument, single operator)`

interface RedditThing<T> {
  kind?: string
  data?: T
}
interface Listing<T> {
  kind?: string
  data?: { after?: string | null; children?: RedditThing<T>[] }
}
interface AboutData {
  name?: string
  id?: string
  created_utc?: number
  total_karma?: number
  link_karma?: number
  comment_karma?: number
  is_employee?: boolean
  is_mod?: boolean
  is_gold?: boolean
  verified?: boolean
  has_verified_email?: boolean
  icon_img?: string
  subreddit?: { title?: string; public_description?: string; over_18?: boolean; subscribers?: number }
}
interface ItemData {
  created_utc?: number
  subreddit?: string
  title?: string
  selftext?: string
  body?: string
  permalink?: string
  score?: number
  link_title?: string
  domain?: string
  over_18?: boolean
}

export const redditProfileAdapter: Adapter = {
  id: ID,
  title: 'Reddit profile (behavioural read of one account)',
  version: VERSION,

  accepts: ['username', 'account'],
  produces: ['account', 'location'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 5_000,
  defaultTimeoutMs: 180_000,

  doc: {
    what: 'Reads one Reddit account\'s public profile and its recent posts and comments, then derives an hour-of-day activity histogram and an inferred time zone, a breakdown of which subreddits it uses, and the words it uses most.',

    how: 'Reddit serves JSON for almost any page if you append `.json` to the path, unauthenticated: `/user/<name>/about.json` for the profile, `/user/<name>/submitted.json` and `/comments.json` for the history, both paginated with an `after` cursor. Each item carries `created_utc`, a Unix timestamp in UTC. The analysis is arithmetic on those timestamps: bin every one by its UTC hour, smooth the 24 buckets over a three-hour circular window, find the six-hour stretch with the least activity, and assume its middle is roughly the middle of a night\'s sleep — which converts the position of the gap into a UTC offset. Subreddit distribution and word frequency are plain counting over the same items, with stopwords removed. No model is involved in any step.',

    why: 'People post when they are awake, and Reddit publishes exactly when that was. Nobody chooses their sleep schedule to be unremarkable, so the hole in the histogram is one of the most reliable involuntary signals a public account emits — and unlike a stated location it cannot be edited, because it is a property of thousands of small actions rather than one field. Subreddit distribution adds the geography the timezone cannot: a city subreddit, a national one, a university one, a subreddit for a specific employer. The word frequencies are the cheap end of stylometry, and the same counting exposes topic obsessions and the professional vocabulary of someone\'s actual job. None of these are secrets — every one is a thing the account holder published — but nobody reads their own five hundred comments as a dataset, which is exactly why this is uncomfortable to run on yourself.',

    betterAt: 'Being permanent and honest. It has no dependency that can rot, no API key that can be revoked and no third-party service that can disappear, and its inputs are the platform\'s own canonical data rather than a scrape of rendered HTML. Reddit is unusually good material for this: post history is public by default, indefinitely retained, and attached to a persistent pseudonym that people carry for years across topics they would never connect deliberately. As a self-audit exercise it is the most direct demonstration in the app of how much a pseudonymous account gives away without ever naming anything.',

    worseAt: 'Getting past Reddit\'s front door at all, as of August 2026. Reddit now gates its keyless JSON: from an ordinary connection every one of these endpoints can answer HTTP 403 with a "blocked by network security" page, and the block is aimed at unauthenticated clients rather than at any particular user agent — a browser user agent is refused identically, and `old.reddit.com` answers a blanket 404. When that happens the adapter says so and concludes nothing. Beyond the block: the unauthenticated listings reach only the most recent ~1000 items per kind, so a long-lived account\'s early years are out of reach; an account with fewer than about thirty timestamps produces a histogram that is noise, and no offset is stated in that case; deleted and removed content is invisible; and none of this transfers to platforms that do not publish timestamps.',

    falsePositives: 'The timezone estimate is the part most likely to be wrong and most likely to be believed. It is worth roughly ±2 hours — a band of countries, not a city — and it silently assumes one person, in one place, sleeping at conventional hours. It breaks completely for shift workers, insomniacs, students in exam season, people who travel, accounts shared by several people, anything posted through a scheduler, and any bot. A VPN does not affect it at all, which surprises people, because the signal is behavioural rather than a network property. Subreddit membership is equally soft: people follow city subreddits for places they left, or have never been. And the whole read assumes the account belongs to the subject in the first place — this adapter is pointed at a handle, and a handle matching your subject\'s on another site is a hypothesis, not an identification.'
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const handle = resolveHandle(input)
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target: handle, startedAt })

    if (!handle) {
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: `No Reddit handle could be derived from this ${input.entity.kind} entity.`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    const userAgent = optionString(options, 'userAgent', REDDIT_USER_AGENT)
    const maxPages = optionNumber(options, 'maxPages', 3, { min: 1, max: 10 })
    const perPage = optionNumber(options, 'perPage', 100, { min: 1, max: 100 })
    const gapMs = optionNumber(options, 'requestGapMs', 1_200, { min: 300, max: 10_000 })
    const requestTimeout = Math.min(ctx.timeoutMs, 30_000)
    env.command = { file: 'GET', args: [`${BASE}/user/${handle}/{about,submitted,comments}.json`] }

    // Status codes are recorded as a structured artifact rather than scraped back out of
    // the log lines. `parse()` has to distinguish "no such account" (404) from "refused"
    // (403) from "never answered", and reading that out of prose would be a parser bug
    // waiting to happen.
    const statuses: Record<string, number> = {}
    let anyResponse = false

    const fetchInto = async (name: string, url: string): Promise<number> => {
      const res = await httpGet({ url, timeoutMs: requestTimeout, signal: ctx.signal, userAgent })
      if (res.error) {
        statuses[name] = 0
        env.notes.push(`${name}: ${res.error}`)
        env.stderr += `${name}: ${res.error}\n`
        return 0
      }
      anyResponse = true
      statuses[name] = res.status
      env.notes.push(`${name}: HTTP ${res.status} ${res.statusText || ''} (${group(res.bytes)} bytes)`.trim())
      const remaining = res.headers['x-ratelimit-remaining']
      if (remaining !== undefined) env.notes.push(`${name}: x-ratelimit-remaining ${remaining}`)
      if (res.status !== 200) {
        env.stderr += `${name}: HTTP ${res.status}\n`
        // A non-200 body is the block page or the error document. It is kept, truncated,
        // so the raw capture shows what was actually served instead of an empty file.
        env.artifacts[`${name}.error.html`] = res.body.slice(0, 8192)
        return res.status
      }
      env.artifacts[name] = res.body
      return 200
    }

    ctx.progress({ pct: 10, note: 'reading profile' })
    const aboutStatus = await fetchInto('about.json', `${BASE}/user/${encodeURIComponent(handle)}/about.json?raw_json=1`)

    // Anything other than 200 on the profile ends the run: 404 is "no such account", 403
    // is a refusal (a suspended account, or — since Reddit began gating its keyless JSON —
    // an outright block of unauthenticated clients). All of them are answers about the
    // world worth recording, and none of them leaves anything else worth fetching.
    if (aboutStatus !== 200) {
      env.artifacts['_http.json'] = JSON.stringify(statuses, null, 2)
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: anyResponse,
        error: `Reddit never answered for u/${handle}. ${env.stderr.trim()}`,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    for (const kind of ['submitted', 'comments'] as const) {
      let after: string | null = null
      for (let page = 1; page <= maxPages; page++) {
        if (ctx.signal.aborted) break
        const cursor: string = after ? `&after=${encodeURIComponent(after)}` : ''
        const url = `${BASE}/user/${encodeURIComponent(handle)}/${kind}.json?limit=${perPage}&raw_json=1${cursor}`
        ctx.progress({ pct: kind === 'submitted' ? 25 + page * 8 : 55 + page * 8, note: `${kind} page ${page}` })
        const name = `${kind}-${page}.json`
        const status = await fetchInto(name, url)
        if (status !== 200) break
        const listing = parseJsonSafe<Listing<ItemData>>(env.artifacts[name] ?? null)
        after = listing?.data?.after ?? null
        const got = listing?.data?.children?.length ?? 0
        if (!after || got === 0) break
        // The politeness gap is what keeps this a profile read rather than a scrape.
        await politeDelay(gapMs, ctx.signal)
      }
    }

    env.artifacts['_http.json'] = JSON.stringify(statuses, null, 2)
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: anyResponse,
      error: `Reddit never answered for u/${handle}. ${env.stderr.trim()}`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * The account, and — only when the histogram earned it — a timezone.
   *
   * A block proposes nothing. That is the whole point of the 403 branch: this adapter's
   * own doc says a refusal aimed at the client must never be rendered as absence, and a
   * candidate queue that filled up during a run where Reddit said nothing would be exactly
   * that mistake in a form the operator would later mistake for evidence. 404, 429 and an
   * unreadable profile behave the same way.
   *
   * The timezone candidate is the uncomfortable one, and it is deliberately shaped so a
   * reviewer cannot miss what it is: an arithmetic reading of a posting-hour histogram,
   * not a place anybody observed the account to be in.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the captured documents, producing the findings and the proposals together.
 *
 * A proposal has to carry the id of the finding that implies it, and that id is derived
 * from the finding's claim string — so the two are built side by side here rather than in
 * two passes that would each hold their own copy of the claim and drift apart.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }
  const findings: Finding[] = []
  const proposals: EntityProposal[] = []

  // --- account state ---
  const statuses = parseJsonSafe<Record<string, number>>(env.artifacts['_http.json'] ?? null) ?? {}
  const aboutStatus = statuses['about.json'] ?? 0
  const about = parseJsonSafe<RedditThing<AboutData>>(env.artifacts['about.json'] ?? null)?.data
  if (!about) {
    // Every branch below returns findings and no proposals. Reddit refusing to answer,
    // rate-limiting, or 404-ing an unauthenticated client are facts about the run; none
    // of them names an entity, and inventing one from a block page is the exact failure
    // this adapter's doc warns about.
    if (aboutStatus === 404) {
      return {
        findings: [
          makeFinding(raw, {
            source: SOURCE,
            claim: `Reddit has no public account named u/${env.target} (HTTP 404). The name is either unused, deleted, or spelled differently — or Reddit is returning a blanket 404 to unauthenticated clients, which it has done, so check a handle you know exists before concluding anything.`
          })
        ],
        proposals: []
      }
    }
    if (aboutStatus === 403) {
      return {
        findings: [
          makeFinding(raw, {
            source: localSource(ID),
            claim:
              `Reddit answered HTTP 403 for u/${env.target} and served its "blocked by network security" interstitial instead of JSON. ` +
              'That is a refusal aimed at this client, not a statement about the account: since Reddit began gating its keyless .json endpoints, an unauthenticated request from an ordinary connection is frequently refused outright. ' +
              'Nothing can be concluded about the account from this run.'
          })
        ],
        proposals: []
      }
    }
    if (aboutStatus === 429) {
      return {
        findings: [
          makeFinding(raw, {
            source: localSource(ID),
            claim: `Reddit rate-limited this run (HTTP 429) before returning a profile for u/${env.target}. Nothing can be concluded about the account; wait and repeat.`
          })
        ],
        proposals: []
      }
    }
    return {
      findings: [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `No readable profile document was captured for u/${env.target}${aboutStatus ? ` (HTTP ${aboutStatus})` : ''}; nothing could be derived. ${env.stderr.trim()}`.trim()
        })
      ],
      proposals: []
    }
  }

  const created = toDate(about.created_utc)
  const identity = makeFinding(raw, {
    source: SOURCE,
    claim:
      `Reddit account u/${about.name ?? env.target} exists${about.id ? ` with the permanent internal id t2_${about.id}` : ''}` +
      `${created ? `, created ${created.toISOString().slice(0, 10)}` : ''}` +
      `${typeof about.total_karma === 'number' ? `, carrying ${group(about.total_karma)} total karma (${group(about.link_karma ?? 0)} post, ${group(about.comment_karma ?? 0)} comment)` : ''}. ` +
      'The internal id survives a username change, so it identifies the account after the handle stops matching.'
  })
  findings.push(identity)

  // Unlike a username sweep, this is Reddit confirming its own account from its own
  // profile endpoint — no status-code guessing, no anti-bot page mistaken for a hit. The
  // value is `platform/handle` off the same folded origin `Finding.source` carries, so a
  // maigret or sherlock hit on reddit.com lands on this same candidate instead of a
  // second one that would look like a second account.
  const handle = (about.name ?? env.target).trim()
  if (handle && env.entityKind !== 'account') {
    proposals.push({
      fromFindingId: identity.id,
      kind: 'account',
      value: `${siteOrigin(BASE) || SOURCE}/${handle}`,
      label: `u/${handle}`,
      attrs: {
        platform: siteOrigin(BASE) || SOURCE,
        handle,
        url: `${BASE}/user/${handle}/`,
        ...(about.id ? { redditId: `t2_${about.id}` } : {})
      },
      rationale: `Reddit's own profile endpoint served this account, so it exists — but this run was pointed at a handle, and a handle matching your subject's elsewhere is a hypothesis, not an identification.`
    })
  }

  const flags = [
    about.is_employee ? 'a Reddit employee account' : '',
    about.is_mod ? 'a moderator of at least one subreddit' : '',
    about.is_gold ? 'a paid (premium) account' : '',
    about.has_verified_email ? 'attached to a verified email address' : ''
  ].filter(Boolean)
  if (flags.length) {
    findings.push(
      makeFinding(raw, { source: SOURCE, claim: `Reddit marks u/${about.name ?? env.target} as ${flags.join(', ')}.` })
    )
  }
  const bio = (about.subreddit?.public_description ?? '').trim()
  if (bio) {
    findings.push(
      makeFinding(raw, { source: SOURCE, claim: `The profile text on u/${about.name ?? env.target} reads: "${bio.slice(0, 400)}"` })
    )
  }

  // --- history ---
  const items: ItemData[] = []
  for (const [name, body] of Object.entries(env.artifacts)) {
    if (!/^(submitted|comments)-\d+\.json$/.test(name)) continue
    const listing = parseJsonSafe<Listing<ItemData>>(body)
    for (const child of listing?.data?.children ?? []) {
      if (child?.data) items.push(child.data)
    }
  }
  if (!items.length) {
    findings.push(
      makeFinding(raw, {
        source: SOURCE,
        claim: `No public posts or comments were readable for u/${env.target}. Reddit shows nothing for an account whose content is all deleted or removed, so this is not evidence that the account is unused.`
      })
    )
    return { findings, proposals }
  }

  const dates = items.map((i) => toDate(i.created_utc)).filter((d): d is Date => d !== null)
  const analysis = analyseActivity(dates)

  findings.push(
    makeFinding(raw, {
      source: SOURCE,
      claim:
        `u/${env.target} published ${group(items.length)} readable items between ${(analysis.earliest ?? '').slice(0, 10)} and ${(analysis.latest ?? '').slice(0, 10)}. ` +
        `Activity by UTC hour: ${renderHistogram(analysis.hourHistogram)}.`
    })
  )
  const timezone = makeFinding(raw, {
    source: localSource(ID),
    claim: analysis.usable
      ? `The quietest six hours of u/${env.target}'s activity are ${formatHourRange(analysis.quietWindowStartUtc)}. Reading that gap as a night's sleep puts the account's local clock at about ${formatOffset(analysis.offsetHours)}, from ${group(analysis.samples)} timestamps. ${analysis.quality} This is a behavioural estimate worth roughly ±2 hours — a band of countries, not a city — and it assumes one person in one place keeping conventional hours.`
      : `No time zone is claimed for u/${env.target}. ${analysis.quality}`
  })
  findings.push(timezone)
  // Only when the histogram had a hole in it worth reading. `usable` is false whenever
  // the account posts around the clock, and no candidate is offered in that case — a
  // number with a shrug attached is worse than nothing once it is in a review queue.
  if (analysis.usable) {
    proposals.push({
      fromFindingId: timezone.id,
      kind: 'location',
      // Arithmetic over timestamps already in the capture. Nothing observed this, nothing
      // was fetched for it, and it must never read as a field the site printed.
      mechanism: 'correlation',
      value: formatOffset(analysis.offsetHours),
      label: `${formatOffset(analysis.offsetHours)} (inferred from posting hours)`,
      attrs: {
        inferred: true,
        method: 'posting-hour histogram',
        offsetHours: analysis.offsetHours,
        samples: analysis.samples,
        quietWindowStartUtc: analysis.quietWindowStartUtc
      },
      rationale: `An inference, not an observation: arithmetic on ${group(analysis.samples)} posting timestamps, reading the quiet stretch as sleep. Nobody saw this account anywhere. Worth ±2 hours at best, and it breaks entirely for shift workers, travellers, schedulers and shared accounts.`
    })
  }
  if (analysis.samples >= MIN_WEEKDAY_SAMPLES) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: `${(analysis.weekendShare * 100).toFixed(0)}% of u/${env.target}'s activity falls at the weekend (UTC), against 29% for an evenly spread week. Weekday-heavy posting is consistent with an account used from a desk during working hours.`
      })
    )
  }

  // --- subreddits ---
  const subs = new Map<string, number>()
  for (const item of items) {
    const s = (item.subreddit ?? '').trim()
    if (s) subs.set(s, (subs.get(s) ?? 0) + 1)
  }
  const rankedSubs = [...subs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  for (const [sub, count] of rankedSubs.slice(0, MAX_SUBREDDITS)) {
    findings.push(
      makeFinding(raw, {
        source: SOURCE,
        claim: `u/${env.target} posted ${group(count)} of ${group(items.length)} captured items in r/${sub} — https://www.reddit.com/r/${sub}/`
      })
    )
  }
  if (rankedSubs.length) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim:
          `u/${env.target}'s captured activity spans ${group(rankedSubs.length)} subreddit${rankedSubs.length === 1 ? '' : 's'}, led by ${rankedSubs
            .slice(0, 8)
            .map(([s, n]) => `r/${s} (${n})`)
            .join(', ')}. Place-named and institution-named subreddits are the geographic signal here, and they are soft: people follow cities they have left and universities they never attended.`
      })
    )
  }

  // --- vocabulary ---
  const words = topWords(items, MAX_WORDS)
  if (words.length) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim:
          `The most frequent non-stopword terms in u/${env.target}'s captured text are ${words.map(([w, n]) => `${w} (${n})`).join(', ')}. ` +
          'This is plain frequency counting over the captured items, not a model, and it reflects what was captured rather than what the account is about.'
      })
    )
  }

  return { findings, proposals }
}

const MAX_SUBREDDITS = 25
const MAX_WORDS = 20
const MIN_WEEKDAY_SAMPLES = 20

/** Small, deliberately boring English stoplist. Keeps the counting honest and local. */
const STOPWORDS = new Set(
  [
    'that', 'have', 'this', 'with', 'they', 'from', 'will', 'would', 'there', 'their',
    'what', 'about', 'which', 'when', 'make', 'like', 'just', 'know', 'take', 'people',
    'into', 'year', 'your', 'good', 'some', 'could', 'them', 'than', 'then', 'look',
    'only', 'come', 'over', 'think', 'also', 'back', 'after', 'been', 'were', 'because',
    'these', 'give', 'most', 'said', 'very', 'much', 'many', 'more', 'down', 'under',
    'again', 'still', 'even', 'want', 'here', 'does', 'doing', 'should', 'really',
    'thing', 'things', 'something', 'anything', 'nothing', 'everyone', 'someone',
    'https', 'http', 'www', 'com', 'edit', 'deleted', 'removed', 'reddit', 'subreddit',
    'gt', 'amp', 'lt', 'nbsp'
  ]
)

function topWords(items: readonly ItemData[], limit: number): [string, number][] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const text = `${item.title ?? ''} ${item.selftext ?? ''} ${item.body ?? ''}`.toLowerCase()
    for (const token of text.match(/[a-z][a-z'-]{3,}/g) ?? []) {
      const w = token.replace(/^['-]+|['-]+$/g, '')
      if (w.length < 4 || STOPWORDS.has(w)) continue
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
}

function resolveHandle(input: AdapterInput): string {
  const fromOptions = typeof input.options['handle'] === 'string' ? (input.options['handle'] as string).trim() : ''
  if (fromOptions) return fromOptions.replace(/^\/?(u|user)\//i, '').replace(/^@/, '')
  if (input.entity.kind === 'account') {
    const attrs = input.entity.attrs as { platform?: string; handle?: string }
    if (attrs.platform && /reddit\.com$/i.test(attrs.platform) && attrs.handle) return attrs.handle
    return ''
  }
  return subjectValue(input.entity).replace(/^@/, '')
}

/**
 * `profile-enrich` — the account, and then the person behind it.
 *
 * ## The problem it exists for
 *
 * A username sweep answers "is this handle taken here". That is much less than it looks
 * like. Forty rows saying a handle exists on forty sites tells you nothing about who holds
 * any of them — this repository's own maigret capture has `torvalds` resolving to *Linus
 * Torvalds* on GitHub, *Patricia Torvalds* on Medium, *Patrick Torvalds* on Facebook and
 * *Marco Migozzi* on Instagram and Pinterest. Four different people, one handle.
 *
 * The discriminating information is on the profile page: a name, a self-declared city, a
 * bio, a picture, a join date, and the links the person put in their own sidebar. This
 * adapter goes and reads that.
 *
 * ## How it works — the actual mechanism
 *
 * Two routes, and the first one costs no packets at all:
 *
 *  1. **Re-reading captures the case already holds.** Maigret runs a per-site extractor
 *     after every hit and stores the result in `status.ids` — `fullname`, `location`,
 *     `image`, `created_at`, `follower_count`, `company`. That is already in
 *     `cases/<id>/raw/`. `run()` transcribes those blocks into the envelope verbatim and
 *     `parse()` reads them back into structured profiles.
 *  2. **One unauthenticated GET of the public profile.** For sites with a documented
 *     keyless endpoint — GitHub's user API, Steam's `?xml=1` profile, Bluesky's public
 *     AppView, Keybase's lookup with its proof list — the endpoint is requested directly.
 *     For anything else, the profile URL itself is fetched once and read for Open Graph
 *     tags and `rel="me"` links, which is what a browser would show a logged-out visitor.
 *
 * Then, for each avatar found, the picture is fetched and perceptually hashed
 * (`support/image.ts`), and the bytes are kept in the capture so the export can inline
 * them and work offline.
 *
 * ## What this is not
 *
 * **It does not find anybody's city.** It reads a text box the account holder filled in.
 * A `location` saying "Sofia" is a claim its owner typed and may be stale, ironic,
 * aspirational or a deliberate lie — poisoning that field is a well-known and entirely
 * rational thing to do. Every value it extracts lands as `unverified`, like everything
 * else in this app, and the doc's `falsePositives` says so in as many words.
 *
 * **Nothing is logged in.** No cookies, no tokens, no session. Scraping an authenticated
 * view is a terms-of-service breach and a ban risk, and it would also answer the wrong
 * question: a self-audit asks what a stranger sees.
 *
 * **Nothing is inferred.** No geocoding, no "this bio mentions a city", no guessing which
 * heading on a page is a name. A regex that decides a bio names a place is a fabrication
 * engine whose output is indistinguishable, in the export, from something a site actually
 * said.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import type { EntityKind, Finding } from '../../shared/types'
import {
  makeFinding,
  type Adapter,
  type AdapterContext,
  type AdapterInput,
  type EntityProposal,
  type RawResult
} from './types'
import type { ProvenanceMechanism } from '../../shared/engine'
import {
  beginEnvelope,
  finishEnvelope,
  group,
  parseJsonSafe,
  readEnvelope
} from './support/envelope'
import { checkImageUrl, hammingHex, hashImage, sniffImageFormat, type ImageHash } from './support/image'
import { httpGet, httpGetBinary, politeDelay, DEFAULT_USER_AGENT } from './support/net'
import {
  cleanUrl,
  endpointFor,
  fromHtml,
  fromMaigretIds,
  isDefaultAvatar,
  isEmptyProfile,
  mergeProfiles,
  PROFILE_PROVIDER_HOSTS,
  type ExtractedProfile,
  type ProfileLink
} from './support/profile'
import { localSource, siteOrigin } from './support/sources'
import { findFiles, mergedOptions, optionBoolean, optionNumber, optionString, readTextIfExists } from './support/toolkit'

const ID = 'profile-enrich'
const VERSION = '1.0.0'

/** Artifact keys inside the envelope. Underscored so a tool's own filename cannot collide. */
const HARVEST = '_harvest.json'
const FETCHES = '_fetches.json'
const AVATARS = '_avatars.json'

/**
 * Perceptual-hash distance at which two avatars are called the same picture.
 *
 * Six bits of sixty-four. Both hashes must agree independently, which is the point of
 * computing two: dHash survives re-compression and fails on a mirror flip, pHash survives
 * cropping and gamma and is duller on flat images. Requiring both keeps the false-match
 * rate low on the one signal the operator is most likely to act on.
 */
const AVATAR_MATCH_DISTANCE = 6

/* ------------------------------------------------------------------ *
 * The transcript `run()` writes and `parse()` reads
 * ------------------------------------------------------------------ */

/** One account this run was pointed at. */
interface Target {
  /** `platform/handle`, the canonical account form. */
  key: string
  platform: string
  handle: string
  url: string | null
  /** Where the app already knew about this account. */
  from: 'entity' | 'candidate' | 'seed'
}

/** A maigret `ids` block, copied out of a capture without being interpreted. */
interface HarvestEntry {
  site: string
  url: string | null
  username: string
  ids: Record<string, unknown>
  /** The raw file it was copied from, relative to the case folder. */
  capture: string
}

interface Harvest {
  entries: HarvestEntry[]
  capturesRead: number
  capturesSkipped: string[]
}

/** One profile request, and where its body was filed. */
interface FetchRecord {
  key: string
  platform: string
  handle: string
  /** The URL actually requested. */
  url: string
  /** `github-api`, `html`, … */
  providerId: string
  /** One line for the claim: what endpoint this is. */
  what: string
  status: number
  mediaType: string
  bytes: number
  error: string | null
  /** Artifact key holding the response body verbatim, or null when nothing was received. */
  bodyKey: string | null
  /** Page URL the profile lives at, for the `html` route. */
  pageUrl: string
}

/** One avatar, fetched and hashed. */
interface AvatarRecord {
  key: string
  platform: string
  handle: string
  url: string
  /** True when the URL is the platform's stock picture rather than this account's. */
  isDefault: boolean
  status: number
  mediaType: string
  bytes: number
  sha256: string | null
  hash: ImageHash | null
  /** Populated whenever `hash` is null. `blocked:…`, `http:404`, `undecodable:webp`. */
  reason: string | null
  /**
   * The picture itself, base64, when it was small enough to keep.
   *
   * Kept in the capture rather than fetched again at export time for two reasons: the
   * export has to work offline and inline every image as a data URI, and a URL that
   * answered today is very often a signed CDN link that expires — this repository's own
   * maigret sample has TikTok and Instagram avatar URLs carrying `x-expires` and `oe`
   * parameters. A picture nobody kept is a picture that is gone.
   */
  base64: string | null
}

/* ------------------------------------------------------------------ *
 * run()
 * ------------------------------------------------------------------ */

/** Accounts the case already knows about, read out of its own files. */
async function knownAccounts(caseDir: string): Promise<{ targets: Target[]; notes: string[] }> {
  const notes: string[] = []
  const targets: Target[] = []
  const seen = new Set<string>()

  const push = (value: unknown, attrs: unknown, from: Target['from']): void => {
    if (typeof value !== 'string' || !value.includes('/')) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    const a = (attrs ?? {}) as Record<string, unknown>
    const platform = typeof a['platform'] === 'string' ? a['platform'] : key.split('/')[0]
    const handle = typeof a['handle'] === 'string' ? a['handle'] : key.slice(key.indexOf('/') + 1)
    if (!platform || !handle) return
    seen.add(key)
    targets.push({
      key,
      platform: siteOrigin(platform) || platform,
      handle,
      url: cleanUrl(a['url']),
      from
    })
  }

  const entitiesText = await readTextIfExists(path.join(caseDir, 'entities.json'))
  const entities = parseJsonSafe<{ kind?: string; value?: string; attrs?: unknown }[]>(entitiesText)
  if (Array.isArray(entities)) {
    for (const e of entities) if (e?.kind === 'account') push(e.value, e.attrs, 'entity')
  } else if (entitiesText !== null) {
    notes.push('entities.json could not be read as JSON; no promoted accounts were taken from it.')
  }

  // The review queue counts. An account nobody has promoted yet is exactly the thing the
  // operator most wants a profile for — that is what he would use to decide.
  const candidatesText = await readTextIfExists(path.join(caseDir, 'candidates.jsonl'))
  if (candidatesText !== null) {
    for (const line of candidatesText.split(/\r?\n/)) {
      if (!line.trim()) continue
      const c = parseJsonSafe<{ kind?: string; value?: string; attrs?: unknown; state?: string }>(line)
      if (c?.kind === 'account' && c.state !== 'dismissed') push(c.value, c.attrs, 'candidate')
    }
  }

  return { targets, notes }
}

/** Every maigret `ids` block in the case's raw captures, copied verbatim. */
async function harvest(caseDir: string, maxCaptures: number): Promise<Harvest> {
  const out: Harvest = { entries: [], capturesRead: 0, capturesSkipped: [] }
  const rawDir = path.join(caseDir, 'raw')
  const files = await findFiles(rawDir, (name) => name.toLowerCase().endsWith('.json'), 1)

  for (const file of files.slice(0, maxCaptures)) {
    const text = await readTextIfExists(file.path)
    if (text === null) {
      out.capturesSkipped.push(`${file.name}: unreadable`)
      continue
    }
    const env = parseJsonSafe<{ adapter?: string; artifacts?: Record<string, string> }>(text)
    if (!env || typeof env.adapter !== 'string') {
      out.capturesSkipped.push(`${file.name}: not a run envelope`)
      continue
    }
    out.capturesRead++
    for (const [name, body] of Object.entries(env.artifacts ?? {})) {
      if (!/^report_.*_simple\.json$/i.test(name)) continue
      const report = parseJsonSafe<Record<string, unknown>>(body)
      if (!report) continue
      for (const [site, value] of Object.entries(report)) {
        if (!value || typeof value !== 'object') continue
        const entry = value as {
          username?: unknown
          url_user?: unknown
          status?: { status?: unknown; ids?: unknown; url?: unknown; site_name?: unknown }
        }
        const ids = entry.status?.ids
        if (!ids || typeof ids !== 'object' || Array.isArray(ids)) continue
        if (Object.keys(ids as object).length === 0) continue
        out.entries.push({
          site: typeof entry.status?.site_name === 'string' ? entry.status.site_name : site,
          url: cleanUrl(entry.status?.url ?? entry.url_user),
          username: typeof entry.username === 'string' ? entry.username : '',
          ids: ids as Record<string, unknown>,
          capture: `raw/${file.name}`
        })
      }
    }
  }
  return out
}

/** Folded handle comparison. Site handles differ in case and in separators constantly. */
function foldHandle(h: string): string {
  return (h ?? '').trim().toLowerCase().replace(/^@/, '')
}

export const profileEnrichAdapter: Adapter = {
  id: ID,
  title: 'Profile enrichment (public profile pages)',
  version: VERSION,

  accepts: ['account', 'username'],
  produces: ['person', 'location', 'organisation', 'image', 'account', 'username', 'email', 'domain'],

  requiresKey: false,
  requiresNetwork: true,

  // One profile at a time and a real gap between runs. This makes requests to sites that
  // owe nobody anything; the politeness is the price of the endpoint staying keyless.
  concurrency: 1,
  minIntervalMs: 2_000,
  defaultTimeoutMs: 120_000,

  doc: {
    what: "Reads the public profile behind an account — display name, self-declared location, bio, avatar, join date, follower counts and the outbound links the profile itself declares.",
    how: "Two routes. First it re-reads captures already in the case folder: maigret stores a per-site `status.ids` block after each hit (fullname, location, image, created_at, company, follower counts) and this transcribes those verbatim. Second, for one account at a time, it makes a single unauthenticated GET — the site's own public endpoint where a documented keyless one exists (api.github.com/users/<h>, Steam's ?xml=1 profile, Bluesky's public AppView, Keybase's lookup with its proof list, GitLab, Gitea, DEV, Mastodon), otherwise the profile URL itself, read for Open Graph tags and rel=\"me\" links. Each avatar it finds is then downloaded, perceptually hashed with dHash and pHash, and kept in the capture as bytes.",
    why: "A username sweep only establishes that a handle is taken. The page behind it is where the discriminating information is: this repository's own maigret capture resolves the handle `torvalds` to four different people across five sites. A profile carries a name, a city the person typed, a picture and — most valuable of all — links the account holder wrote themselves, which is the only assertion of \"these accounts are both mine\" that comes from the subject rather than from a guess.",
    betterAt: "Turning a list of handles into something you can judge. It is the only adapter that answers \"who is this\" rather than \"does this exist\", the only one that produces a picture you can look at, and the only one that recovers a subject-declared link between two platforms.",
    worseAt: "Anything the site does not publish to a logged-out visitor. Instagram, Facebook, TikTok and X show almost nothing without a session, and it will never log in. It also only knows a documented endpoint for a handful of sites; everywhere else it reads Open Graph tags, which give a name, a description and a picture and nothing structured. It discovers no accounts on its own — it enriches the ones a sweep already found.",
    falsePositives: "Everything it returns is text the account holder typed about themselves, and it cannot tell a true statement from a false one. A location field saying \"Sofia\" is a claim, not a fact: it may be years out of date, a joke, a band name, or deliberately false — poisoning that field is a normal thing for a privacy-aware person to do. A display name is not an identity: the same handle carries four different names across the sample capture in this repository. An Open Graph title on an unknown site is the page's title, which on a badly built profile page is the site's own name. And the account being enriched may not be the subject's at all — if the sweep that found it was wrong, everything read off it is a stranger's data with the subject's name on the file."
  },

  check(): string | null {
    return null
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const maxProfiles = Math.max(1, Math.min(50, optionNumber(options, 'maxProfiles', 10, { min: 1, max: 50 })))
    const maxCaptures = Math.max(1, Math.min(500, optionNumber(options, 'maxCaptures', 60, { min: 1, max: 500 })))
    const requestGapMs = Math.max(0, optionNumber(options, 'requestGapMs', 1_200, { min: 0, max: 60_000 }))
    const fetchAvatars = optionBoolean(options, 'fetchAvatars', true)
    const readUnknownSites = optionBoolean(options, 'readUnknownSites', true)
    const maxAvatarBytes = Math.max(1_024, optionNumber(options, 'maxAvatarBytes', 262_144, { min: 1_024, max: 4_194_304 }))
    const avatarBudgetBytes = Math.max(
      maxAvatarBytes,
      optionNumber(options, 'avatarBudgetBytes', 3_000_000, { min: 1_024, max: 33_554_432 })
    )
    const userAgent = optionString(options, 'userAgent', DEFAULT_USER_AGENT)
    const explicitUrl = cleanUrl(optionString(options, 'url', ''))

    const entity = input.entity
    const env = beginEnvelope({
      adapterId: ID,
      adapterVersion: VERSION,
      input,
      target: entity.label || entity.value,
      startedAt: ctx.now()
    })

    /* ---- 1. Who to look at ---- */

    const inCase = await knownAccounts(ctx.caseDir)
    env.notes.push(...inCase.notes)

    let targets: Target[] = []
    if (entity.kind === 'account') {
      const attrs = (entity.attrs ?? {}) as Record<string, unknown>
      const platformRaw = typeof attrs['platform'] === 'string' ? attrs['platform'] : entity.value.split('/')[0]
      const handle = typeof attrs['handle'] === 'string' ? attrs['handle'] : entity.value.slice(entity.value.indexOf('/') + 1)
      targets = [
        {
          key: entity.value,
          platform: siteOrigin(platformRaw) || platformRaw,
          handle,
          url: explicitUrl ?? cleanUrl(attrs['url']),
          from: 'seed'
        }
      ]
    } else {
      // A username. Every account the case already holds under that handle — which is
      // exactly the set a sweep just produced, and the set the review queue is showing.
      const wanted = foldHandle(entity.value)
      const matching = inCase.targets.filter((t) => foldHandle(t.handle) === wanted)
      // A known endpoint first: those return structured fields, an Open Graph read returns
      // three. Then the ones the operator has already promoted, then the rest.
      matching.sort((a, b) => {
        const documented =
          Number(endpointFor(b.platform, b.handle) !== null) - Number(endpointFor(a.platform, a.handle) !== null)
        if (documented !== 0) return documented
        const promoted = Number(b.from === 'entity') - Number(a.from === 'entity')
        if (promoted !== 0) return promoted
        return a.platform.localeCompare(b.platform)
      })
      targets = matching.slice(0, maxProfiles)
      if (matching.length > targets.length) {
        env.notes.push(
          `${matching.length} accounts in this case carry the handle "${entity.label}"; the first ${targets.length} were read. Raise maxProfiles to read more.`
        )
      }
      if (matching.length === 0) {
        env.notes.push(
          `No account for "${entity.label}" is in this case yet. Run a username sweep first — this adapter enriches accounts, it does not discover them.`
        )
      }
    }

    /* ---- 2. What the case already knows, transcribed ---- */

    const harvested = await harvest(ctx.caseDir, maxCaptures)
    env.artifacts[HARVEST] = JSON.stringify(harvested)
    env.notes.push(
      `Transcribed ${harvested.entries.length} profile-metadata blocks from ${harvested.capturesRead} raw captures already in this case.`
    )

    /* ---- 3. One request per profile ---- */

    const fetches: FetchRecord[] = []
    const avatarUrls = new Map<string, { platform: string; handle: string; url: string }>()

    const noteAvatar = (t: { key: string; platform: string; handle: string }, url: string | null): void => {
      if (url === null) return
      const id = `${t.key} ${url}`
      if (!avatarUrls.has(id)) avatarUrls.set(id, { platform: t.platform, handle: t.handle, url })
    }

    // Avatars maigret already saw, for accounts this run is not fetching. The picture is
    // the answer to "can I find an image of this person", and dropping it because the
    // profile endpoint is unknown would throw away the best part of the capture.
    for (const entry of harvested.entries) {
      const platform = entry.url === null ? '' : siteOrigin(entry.url)
      if (!platform) continue
      const ids = entry.ids as Record<string, unknown>
      const image = cleanUrl(ids['image'] ?? ids['avatar'])
      if (image === null) continue
      if (entity.kind === 'username' && foldHandle(entry.username) !== foldHandle(entity.value)) continue
      noteAvatar({ key: `${platform}/${foldHandle(entry.username)}`, platform, handle: entry.username }, image)
    }

    let index = 0
    for (const target of targets) {
      if (ctx.signal.aborted) break
      index++
      ctx.progress({ done: index - 1, total: targets.length, current: target.platform, note: 'reading profile' })

      const documented = endpointFor(target.platform, target.handle)
      const pageUrl = target.url ?? (target.platform ? `https://${target.platform}/${target.handle}` : '')
      const requestUrl = documented?.url ?? (readUnknownSites ? pageUrl : '')
      if (!requestUrl) {
        env.notes.push(`${target.platform}: no public endpoint is known and unknown-site reading is off; not requested.`)
        continue
      }

      const res = await httpGet({
        url: requestUrl,
        timeoutMs: Math.min(ctx.timeoutMs, 20_000),
        signal: ctx.signal,
        userAgent,
        maxBytes: 1_500_000,
        accept: documented?.provider.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
      })

      const bodyKey = res.body ? `profile-${index}-${target.platform.replace(/[^a-z0-9.]+/gi, '_')}` : null
      if (bodyKey !== null) env.artifacts[bodyKey] = res.body

      fetches.push({
        key: target.key,
        platform: target.platform,
        handle: target.handle,
        url: requestUrl,
        providerId: documented?.provider.id ?? 'html',
        what: documented?.provider.what ?? 'the profile page as served to a logged-out visitor',
        status: res.status,
        mediaType: res.headers['content-type'] ?? '',
        bytes: res.bytes,
        error: res.error,
        bodyKey,
        pageUrl
      })

      ctx.progress({ done: index, total: targets.length, current: target.platform, hits: fetches.filter((f) => f.status === 200).length })
      if (index < targets.length) await politeDelay(requestGapMs, ctx.signal)
    }
    env.artifacts[FETCHES] = JSON.stringify(fetches)

    /* ---- 4. Avatars, fetched and hashed ---- */

    // The bodies just fetched name avatars the harvest did not. Read here rather than in
    // `parse()` because the picture has to be downloaded, and `parse()` may not.
    for (const record of fetches) {
      const body = record.bodyKey === null ? null : env.artifacts[record.bodyKey]
      if (!body) continue
      const provider = endpointFor(record.platform, record.handle)?.provider
      const fields =
        provider && provider.id === record.providerId
          ? provider.extract(body, record.handle)
          : fromHtml(record.platform, record.handle, body, record.pageUrl)
      noteAvatar(record, cleanUrl(fields?.avatarUrl ?? null))
    }

    const avatars: AvatarRecord[] = []
    if (fetchAvatars) {
      let spent = 0
      let n = 0
      for (const { platform, handle, url } of avatarUrls.values()) {
        if (ctx.signal.aborted) break
        n++
        const key = `${platform}/${foldHandle(handle)}`
        ctx.progress({ note: `avatar ${n} of ${avatarUrls.size}`, current: platform })

        const record: AvatarRecord = {
          key,
          platform,
          handle,
          url,
          isDefault: isDefaultAvatar(url),
          status: 0,
          mediaType: '',
          bytes: 0,
          sha256: null,
          hash: null,
          reason: null,
          base64: null
        }

        // The URL gate runs before the socket: these strings arrive inside third-party
        // JSON, so a crafted profile must not be able to aim this at the loopback
        // interface or a link-local metadata endpoint.
        const blocked = checkImageUrl(url)
        if (blocked !== null) {
          record.reason = `blocked:${blocked}`
          avatars.push(record)
          continue
        }

        const res = await httpGetBinary({
          url,
          timeoutMs: Math.min(ctx.timeoutMs, 15_000),
          signal: ctx.signal,
          maxBytes: maxAvatarBytes,
          userAgent,
          accept: 'image/*'
        })
        record.status = res.status
        record.bytes = res.bytes
        const declared = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        const sniffed = sniffImageFormat(res.body)
        record.mediaType = declared || (sniffed === 'unknown' ? 'application/octet-stream' : `image/${sniffed}`)
        if (res.body.byteLength > 0) record.sha256 = createHash('sha256').update(res.body).digest('hex')

        if (res.error !== null) record.reason = `transport:${res.error.split(':')[0]}`
        else if (!res.ok) record.reason = `http:${res.status}`
        else if (res.body.byteLength === 0) record.reason = 'empty'
        else if (res.truncated) record.reason = 'too-large'
        else {
          // A hash is for *grouping*; its absence is not a reason to throw the picture
          // away. JPEG needs Chromium's decoder and therefore does not hash outside
          // Electron, and an export with no faces in it because the test harness has no
          // JPEG decoder would be a strange thing to ship.
          record.hash = hashImage(res.body)
          if (record.hash === null) record.reason = `undecodable:${sniffed}`
        }

        // Bytes are kept whenever what came back is actually an image and there is room in
        // the budget, hashed or not. The export inlines these as data URIs so the document
        // works offline — and so it survives the signed, expiring CDN URLs that Instagram,
        // TikTok and Steam all serve avatars from.
        const looksLikeImage = sniffed !== 'unknown' || record.mediaType.startsWith('image/')
        if (
          res.ok &&
          !res.truncated &&
          looksLikeImage &&
          res.body.byteLength > 0 &&
          res.body.byteLength <= maxAvatarBytes &&
          spent + res.body.byteLength <= avatarBudgetBytes
        ) {
          record.base64 = res.body.toString('base64')
          spent += res.body.byteLength
        }

        avatars.push(record)
        await politeDelay(requestGapMs, ctx.signal)
      }
      if (spent >= avatarBudgetBytes) {
        env.notes.push(
          `The per-run avatar byte budget (${group(avatarBudgetBytes)} bytes) was reached; later pictures were hashed but their bytes were not kept.`
        )
      }
    } else {
      env.notes.push('Avatar fetching was turned off for this run; avatar URLs were recorded but no picture was downloaded.')
    }
    env.artifacts[AVATARS] = JSON.stringify(avatars)

    const anything = fetches.length > 0 || harvested.entries.length > 0 || avatars.length > 0
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: anything,
      error: anything
        ? null
        : 'Nothing to enrich: no account for this seed is in the case yet, and no earlier capture carried profile metadata.',
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
 * parse() / propose() — one walk
 * ------------------------------------------------------------------ */

interface Interpreted {
  findings: Finding[]
  proposals: EntityProposal[]
}

/** A field worth its own separately checkable claim. */
interface ProfileFieldSpec {
  read: (p: ExtractedProfile) => string | null
  describe: (v: string, p: ExtractedProfile) => string
  proposes?: (v: string, p: ExtractedProfile) => { kind: EntityKind; value: string; rationale: string } | null
}

/**
 * The extracted fields, in the order a person reads them.
 *
 * One finding per field rather than one blob, because they are separately checkable and
 * separately wrong: "GitHub shows the name Linus Torvalds" and "GitHub shows the location
 * Portland, OR" can be corroborated, contradicted or refuted independently of each other,
 * and a single merged claim could never be promoted for one half and refuted for the
 * other.
 *
 * Every `describe` names the site as the speaker — "GitHub's public profile says" — rather
 * than asserting the fact directly. That is not politeness. The sentence is what the
 * export prints, and "he lives in Portland" and "GitHub says he lives in Portland" are
 * different claims with very different evidence behind them.
 */
const PROFILE_FIELDS: ProfileFieldSpec[] = [
  {
    read: (p) => p.displayName,
    describe: (v, p) => `${p.platform} shows the display name "${v}" on this profile.`,
    proposes: (v, p) =>
      /\s/.test(v) && v.length <= 80
        ? { kind: 'person', value: v, rationale: `${p.platform} prints this as the profile's display name. A name a site shows, not a verified identity.` }
        : null
  },
  {
    read: (p) => p.realName,
    describe: (v, p) => `${p.platform} carries "${v}" in the profile's separate real-name field.`,
    proposes: (v, p) => ({
      kind: 'person',
      value: v,
      rationale: `${p.platform} has a distinct real-name field and this is what the account holder put in it.`
    })
  },
  {
    read: (p) => p.location,
    describe: (v, p) =>
      `${p.platform} shows the location "${v}" on this profile — a value the account holder typed, not a measured position.`,
    proposes: (v, p) => ({
      kind: 'location',
      value: v,
      rationale: `${p.platform}'s location field, self-declared. A lead to check, never a coordinate and never a confirmed residence.`
    })
  },
  {
    read: (p) => p.company,
    describe: (v, p) => `${p.platform} shows the employer or organisation "${v}" on this profile.`,
    proposes: (v, p) => ({
      kind: 'organisation',
      value: v,
      rationale: `${p.platform} prints this as the profile's employer or organisation.`
    })
  },
  {
    read: (p) => p.bio,
    describe: (v, p) => `${p.platform} shows the profile text "${v}".`
  },
  {
    read: (p) => p.joinedAt,
    describe: (v, p) =>
      `${p.platform} reports this account was created at ${v}. That bounds when the identity started, which is one of the few dates on a profile the account holder cannot edit.`
  },
  {
    read: (p) => p.email,
    describe: (v, p) => `${p.platform} publishes the address ${v} on this profile.`,
    proposes: (v, p) => ({ kind: 'email', value: v, rationale: `${p.platform} shows this address on the public profile page.` })
  },
  {
    read: (p) => (p.followers === null ? null : String(p.followers)),
    describe: (v, p) =>
      `${p.platform} reports ${group(Number(v))} followers${p.following === null ? '' : ` and ${group(p.following)} following`} for this account.`
  },
  {
    read: (p) => p.avatarUrl,
    describe: (v, p) => `${p.platform} serves this account's profile picture from ${v}`,
    proposes: (v, p) =>
      isDefaultAvatar(v)
        ? null
        : {
            kind: 'image',
            value: v,
            rationale: `${p.platform} serves this as the profile picture. Reverse-image work and the avatar gallery both start here.`
          }
  }
]

/**
 * Path segments that introduce a handle rather than being one.
 *
 * `reddit.com/user/foo` and `linkedin.com/in/foo` are profiles; the first segment is
 * furniture. Kept small and literal — a guess here mints an account that does not exist.
 */
const PROFILE_PATH_PREFIXES = new Set([
  'user',
  'users',
  'u',
  'profile',
  'profiles',
  'in',
  'people',
  'member',
  'members',
  'id',
  'channel',
  'c'
])

/** Query keys these same sites carry a handle in: `news.ycombinator.com/user?id=mofle`. */
const HANDLE_QUERY_KEYS = ['id', 'user', 'username', 'u', 'name']

/**
 * Sites where a bare first path segment is a person rather than a page.
 *
 * The inversion matters. On `github.com`, `/foo` is an account; on somebody's own domain,
 * `/apps` is a page about their software. Without this list the second one becomes an
 * "account named apps" in the review queue, which is the kind of confident nonsense the
 * candidate queue exists to keep out of the graph — it was in the first live run of this
 * adapter, which is why the list is here.
 */
const HANDLE_ROOT_PLATFORMS = new Set([
  ...PROFILE_PROVIDER_HOSTS,
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'youtube.com',
  'twitch.tv',
  'medium.com',
  'soundcloud.com',
  'pinterest.com',
  'flickr.com',
  'deviantart.com',
  'behance.net',
  'dribbble.com',
  'patreon.com',
  'ko-fi.com',
  'buymeacoffee.com',
  'about.me',
  'last.fm',
  'vk.com',
  't.me',
  'telegram.me',
  'tumblr.com',
  'wordpress.com',
  'itch.io',
  'hackerone.com',
  'stackoverflow.com',
  'goodreads.com',
  'letterboxd.com'
])

/** Single-segment paths that are pages on every site that has them. */
const GENERIC_SEGMENTS = new Set([
  'about',
  'apps',
  'blog',
  'contact',
  'docs',
  'download',
  'downloads',
  'feed',
  'home',
  'index',
  'legal',
  'news',
  'press',
  'privacy',
  'projects',
  'rss',
  'shop',
  'sponsors',
  'store',
  'support',
  'team',
  'terms',
  'work'
])

/**
 * `https://github.com/torvalds` -> `{ platform: 'github.com', handle: 'torvalds' }`.
 *
 * Returns null far more often than it returns a value, and deliberately so: this feeds the
 * review queue, and a queue full of `sindresorhus.com/apps` is a queue nobody reads.
 */
function accountFromUrl(url: string): { platform: string; handle: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const platform = siteOrigin(parsed.hostname)
  if (!platform) return null
  const segments = parsed.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  if (segments.length === 0 || segments.length > 2) return null

  let handle: string | null = null
  const first = segments[0].replace(/^@/, '').toLowerCase()

  if (segments.length === 2) {
    // `reddit.com/user/foo`. Anything else with two segments is a page, not a profile.
    if (PROFILE_PATH_PREFIXES.has(first)) handle = segments[1].replace(/^@/, '')
  } else if (PROFILE_PATH_PREFIXES.has(first)) {
    // `news.ycombinator.com/user?id=mofle` — the handle is in the query, and it is often a
    // *different* handle from the one being enriched, which is exactly the pivot worth
    // having.
    for (const key of HANDLE_QUERY_KEYS) {
      const v = parsed.searchParams.get(key)
      if (v !== null && v.trim()) {
        handle = v.trim().replace(/^@/, '')
        break
      }
    }
  } else if (!GENERIC_SEGMENTS.has(first) && HANDLE_ROOT_PLATFORMS.has(platform)) {
    handle = segments[0].replace(/^@/, '')
  }

  if (handle === null) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(handle)) return null
  if (/\.(html?|php|aspx?|json|xml|rss|atom)$/i.test(handle)) return null
  return { platform, handle }
}

const LINK_RELATION: Record<ProfileLink['rel'], string> = {
  website: 'in the profile’s website field',
  'rel-me': 'as a rel="me" identity link',
  verified: 'as a link the platform says it verified',
  bio: 'inside the profile text'
}

/**
 * Which link relations are an **ownership declaration**, and which are only a mention.
 *
 * The distinction decides whether the engine may follow the link on one source, so it is
 * worth being exact about. `rel="me"` is the IndieWeb identity-claim convention and means
 * precisely "this other profile is also me". `verified` is that plus the platform having
 * checked the far end links back. `website` is the platform's own field for *your* site —
 * the account holder typed it into a box whose label says it is theirs.
 *
 * `bio` is none of those. It is a URL that happened to appear in free text, and free text
 * links to news articles, to friends, to a band, to a repository somebody likes. Treating
 * a mention as a declaration was the hole: it let anything a subject *wrote about* be
 * followed as though they had claimed to own it. A bio link is a field printed on a
 * profile, which is exactly what `profile-field` means, and nothing more.
 */
const DECLARES_OWNERSHIP: Record<ProfileLink['rel'], boolean> = {
  website: true,
  'rel-me': true,
  verified: true,
  bio: false
}

const linkMechanism = (rel: ProfileLink['rel']): ProvenanceMechanism =>
  DECLARES_OWNERSHIP[rel] ? 'declared-link' : 'profile-field'

function interpret(raw: RawResult): Interpreted {
  const findings: Finding[] = []
  const proposals: EntityProposal[] = []

  const env = readEnvelope(raw)
  if (env === null) {
    return {
      findings: [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `The ${ID} capture could not be read as a run envelope, so nothing was interpreted. The bytes are still on disk at ${raw.raw.path} and can be re-parsed once this is fixed.`
        })
      ],
      proposals: []
    }
  }

  const harvested = parseJsonSafe<Harvest>(env.artifacts[HARVEST]) ?? { entries: [], capturesRead: 0, capturesSkipped: [] }
  const fetches = parseJsonSafe<FetchRecord[]>(env.artifacts[FETCHES]) ?? []
  const avatars = parseJsonSafe<AvatarRecord[]>(env.artifacts[AVATARS]) ?? []

  /* ---- Build one profile per account, best reading first ---- */

  const readings = new Map<string, ExtractedProfile[]>()
  const add = (key: string, profile: ExtractedProfile | null, first: boolean): void => {
    if (profile === null || isEmptyProfile(profile)) return
    const list = readings.get(key)
    if (!list) readings.set(key, [profile])
    else if (first) list.unshift(profile)
    else list.push(profile)
  }

  for (const record of fetches) {
    if (record.error !== null) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: `Reading ${record.platform}'s profile for "${record.handle}" failed before an answer arrived: ${record.error}. Nothing follows about the account from this — it is a failure to look, not a look that found nothing.`
        })
      )
      continue
    }
    if (record.status !== 200) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: `${record.platform} answered HTTP ${record.status}. ${
            record.status === 404
              ? 'That is the site saying there is no such profile at this address.'
              : 'That is a refusal aimed at an unauthenticated client, not a statement about the account.'
          } The address asked was ${record.url}`
        })
      )
      continue
    }
    const body = record.bodyKey === null ? '' : (env.artifacts[record.bodyKey] ?? '')
    if (!body) continue

    const provider = endpointFor(record.platform, record.handle)?.provider
    if (provider && provider.id === record.providerId) {
      const fields = provider.extract(body, record.handle)
      if (fields === null) {
        findings.push(
          makeFinding(raw, {
            source: localSource(ID),
            claim: `${record.platform} answered 200 but the body was not the shape ${record.providerId} expects, so no fields were read. The response is kept in this capture and can be re-parsed.`
          })
        )
        continue
      }
      const base = { platform: record.platform, handle: record.handle, via: record.providerId }
      add(record.key, { ...emptyLike(base), ...fields, ...base, links: fields.links ?? [] }, true)
    } else {
      add(record.key, fromHtml(record.platform, record.handle, body, record.pageUrl), true)
    }
  }

  for (const entry of harvested.entries) {
    const platform = entry.url === null ? '' : siteOrigin(entry.url)
    if (!platform) continue
    const key = `${platform}/${entry.username.toLowerCase()}`
    add(key, fromMaigretIds(platform, entry.username, entry.site, entry.ids, entry.url), false)
  }

  /* ---- One finding per field ---- */

  let enriched = 0
  const byKey = new Map<string, ExtractedProfile>()
  for (const [key, list] of readings) {
    const profile = mergeProfiles(list)
    if (profile === null) continue
    byKey.set(key, profile)
    enriched++

    for (const field of PROFILE_FIELDS) {
      const value = field.read(profile)
      if (value === null) continue
      const finding = makeFinding(raw, { source: profile.platform, claim: field.describe(value, profile) })
      findings.push(finding)
      const proposed = field.proposes?.(value, profile)
      if (proposed) {
        proposals.push({
          fromFindingId: finding.id,
          kind: proposed.kind,
          value: proposed.value,
          rationale: proposed.rationale
        })
      }
    }

    /* Links. The strongest thing on the page — when the subject actually claimed them. */
    for (const link of profile.links) {
      const declared = DECLARES_OWNERSHIP[link.rel]
      const mechanism = linkMechanism(link.rel)
      const finding = makeFinding(raw, {
        source: profile.platform,
        claim: declared
          ? `${profile.platform}'s profile for "${profile.handle}" links out to ${link.url} ${LINK_RELATION[link.rel]}. The account holder put that link there, so it is their own assertion that the two are connected.`
          : `${profile.platform}'s profile for "${profile.handle}" mentions ${link.url} ${LINK_RELATION[link.rel]}. A URL inside bio text is something the account holder wrote *about*; it is not a claim that the far end is theirs, and people link to articles, friends and projects they merely like.`
      })
      findings.push(finding)

      const account = accountFromUrl(link.url)
      if (account !== null && account.platform !== profile.platform) {
        proposals.push({
          fromFindingId: finding.id,
          kind: 'account',
          mechanism,
          value: `${account.platform}/${account.handle}`,
          rationale: declared
            ? `Linked from the ${profile.platform} profile ${LINK_RELATION[link.rel]}. A link the subject published as their own, not a handle guess.`
            : `Mentioned ${LINK_RELATION[link.rel]} on the ${profile.platform} profile. A URL in free text names something the account holder wrote about, which is weaker than a handle guess is strong — it says nothing about ownership.`
        })
        if (account.handle.toLowerCase() !== profile.handle.toLowerCase()) {
          proposals.push({
            fromFindingId: finding.id,
            kind: 'username',
            // A handle lifted out of a URL is a string, however the URL got onto the page.
            // The declaration, when there is one, is about the account at the far end, not
            // about every site where that word happens to be taken.
            mechanism: 'profile-field',
            value: account.handle,
            rationale: `A second handle, read out of a URL on the ${profile.platform} profile. The link may be the subject's own; the bare handle on other sites is a hypothesis to sweep, never an identification.`
          })
        }
      } else if (account === null) {
        try {
          const host = new URL(link.url).hostname
          if (host.includes('.')) {
            proposals.push({
              fromFindingId: finding.id,
              kind: 'domain',
              mechanism,
              value: host,
              rationale: declared
                ? `A site the ${profile.platform} profile declares as the account holder's own. Personal domains are where subdomain and certificate work starts.`
                : `A host mentioned in the ${profile.platform} profile's bio text. Somebody linked to it; nobody said it was theirs.`
            })
          }
        } catch {
          /* cleanUrl already guaranteed this parses; nothing to do if it somehow does not */
        }
      }
    }
  }

  /* ---- Avatars ---- */

  const usable = avatars.filter((a) => a.hash !== null && !a.isDefault)
  for (const avatar of avatars) {
    if (avatar.hash !== null) {
      findings.push(
        makeFinding(raw, {
          source: avatar.platform,
          claim:
            `The picture ${avatar.platform} serves for "${avatar.handle}" is ${group(avatar.bytes)} bytes of ${avatar.mediaType || 'an image'}, ` +
            `sha256 ${avatar.sha256 ?? 'unknown'}, perceptual hashes dhash ${avatar.hash.dhash} / phash ${avatar.hash.phash}.` +
            (avatar.isDefault
              ? ' This is the platform’s stock picture, identical for every account there, so it identifies the platform and nobody else.'
              : '')
        })
      )
    } else {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: `The picture at ${avatar.url} could not be turned into a comparable hash (${avatar.reason ?? 'no reason recorded'}). It is unchecked, not absent — no conclusion about the account follows from it.`
        })
      )
    }
  }

  // Two accounts wearing the same picture. Derived analysis, so it carries a `local:`
  // source and can never count as one of the two independent sources corroboration needs:
  // the comparison is this app's arithmetic, not a second site's testimony.
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]
      const b = usable[j]
      if (a.key === b.key) continue
      const identical = a.sha256 !== null && a.sha256 === b.sha256
      const dh = hammingHex(a.hash?.dhash ?? '', b.hash?.dhash ?? '')
      const ph = hammingHex(a.hash?.phash ?? '', b.hash?.phash ?? '')
      const near = dh >= 0 && ph >= 0 && dh <= AVATAR_MATCH_DISTANCE && ph <= AVATAR_MATCH_DISTANCE
      if (!identical && !near) continue
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: identical
            ? `${a.platform}/${a.handle} and ${b.platform}/${b.handle} serve byte-identical profile pictures (sha256 ${a.sha256}). The same file was uploaded to both.`
            : `${a.platform}/${a.handle} and ${b.platform}/${b.handle} serve the same picture through different encodings (dhash differs by ${dh} bits, phash by ${ph} of 64). Two sites re-compressing one photograph looks exactly like this.`
        })
      )
    }
  }

  /* ---- The run's own account of itself ---- */

  findings.push(
    makeFinding(raw, {
      source: localSource(ID),
      claim:
        `${ID} read ${group(fetches.length)} profile${fetches.length === 1 ? '' : 's'} directly and re-used ` +
        `${group(harvested.entries.length)} metadata block${harvested.entries.length === 1 ? '' : 's'} from ${group(harvested.capturesRead)} capture${harvested.capturesRead === 1 ? '' : 's'} already in this case; ` +
        `${group(enriched)} account${enriched === 1 ? '' : 's'} came out with something on them. ` +
        `${group(avatars.length)} picture${avatars.length === 1 ? '' : 's'} were fetched, ${group(usable.length)} of them hashable and not a platform default. ` +
        `Every field above is text the account holder published about themselves; none of it has been checked against anything.`
    })
  )

  return { findings, proposals }
}

/** A blank profile with the right shape, for spreading a provider's partial fields over. */
function emptyLike(base: { platform: string; handle: string; via: string }): ExtractedProfile {
  return {
    platform: base.platform,
    handle: base.handle,
    url: null,
    displayName: null,
    realName: null,
    location: null,
    bio: null,
    avatarUrl: null,
    joinedAt: null,
    followers: null,
    following: null,
    company: null,
    email: null,
    links: [],
    via: base.via
  }
}

/* ------------------------------------------------------------------ *
 * Re-derivation, for the gallery and the export
 * ------------------------------------------------------------------ */

export const PROFILE_ENRICH_ID = ID
export const PROFILE_ENRICH_ARTIFACTS = { HARVEST, FETCHES, AVATARS }
export type { AvatarRecord, FetchRecord, Harvest, HarvestEntry }

/**
 * Everything one `profile-enrich` capture holds, re-derived from the envelope.
 *
 * Exported so the avatar gallery and the export can read a capture without importing the
 * adapter's internals or re-running anything. Same purity rule as `parse()`: a string in,
 * values out, and `null` for anything unreadable.
 */
export function readCapture(envelopeJson: string | null): {
  profiles: ExtractedProfile[]
  avatars: AvatarRecord[]
} | null {
  const outer = parseJsonSafe<{ adapter?: string; artifacts?: Record<string, string>; stdout?: string }>(envelopeJson)
  if (!outer) return null
  const env =
    typeof outer.adapter === 'string'
      ? outer
      : parseJsonSafe<{ adapter?: string; artifacts?: Record<string, string> }>(outer.stdout ?? null)
  if (!env || env.adapter !== ID) return null
  const artifacts = env.artifacts ?? {}

  const harvested = parseJsonSafe<Harvest>(artifacts[HARVEST]) ?? { entries: [], capturesRead: 0, capturesSkipped: [] }
  const fetches = parseJsonSafe<FetchRecord[]>(artifacts[FETCHES]) ?? []
  const avatars = parseJsonSafe<AvatarRecord[]>(artifacts[AVATARS]) ?? []

  const readings = new Map<string, ExtractedProfile[]>()
  for (const record of fetches) {
    if (record.status !== 200 || record.bodyKey === null) continue
    const body = artifacts[record.bodyKey]
    if (!body) continue
    const provider = endpointFor(record.platform, record.handle)?.provider
    const profile =
      provider && provider.id === record.providerId
        ? (() => {
            const fields = provider.extract(body, record.handle)
            if (fields === null) return null
            const base = { platform: record.platform, handle: record.handle, via: record.providerId }
            return { ...emptyLike(base), ...fields, ...base, links: fields.links ?? [] }
          })()
        : fromHtml(record.platform, record.handle, body, record.pageUrl)
    if (profile !== null && !isEmptyProfile(profile)) {
      const list = readings.get(record.key)
      if (list) list.unshift(profile)
      else readings.set(record.key, [profile])
    }
  }
  for (const entry of harvested.entries) {
    const platform = entry.url === null ? '' : siteOrigin(entry.url)
    if (!platform) continue
    const profile = fromMaigretIds(platform, entry.username, entry.site, entry.ids, entry.url)
    if (isEmptyProfile(profile)) continue
    const key = `${platform}/${entry.username.toLowerCase()}`
    const list = readings.get(key)
    if (list) list.push(profile)
    else readings.set(key, [profile])
  }

  const profiles: ExtractedProfile[] = []
  for (const list of readings.values()) {
    const merged = mergeProfiles(list)
    if (merged !== null) profiles.push(merged)
  }
  return { profiles, avatars }
}

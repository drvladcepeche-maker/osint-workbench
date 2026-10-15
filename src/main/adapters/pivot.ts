/**
 * `pivot` — the second handle.
 *
 * Every other adapter in this app answers "what exists for the thing you gave me". This
 * one answers the question the operator actually asked: *"if I run one of my usernames and
 * it finds an account which has a different username, can it search that and see if it's
 * related? It's probably gonna find many other names which aren't mine, but perhaps it can
 * somehow deduce whether it's mine."*
 *
 * That is username pivoting, and it is the technique the whole discipline of identity
 * resolution is built on. A profile is not just an account; it is a page carrying pointers
 * — a handle in a bio, a link in a sidebar, a display name that is itself a handle
 * somewhere else. Following one is trivial. Deciding whether what you land on is the same
 * person is the entire problem, and it is where a tool either teaches you something true
 * or teaches you something false.
 *
 * ## What it does
 *
 * `run()` reads the captures already in the case folder — it starts by making no requests
 * at all, exactly like `pattern-timezone` — reconstructs every profile those tools
 * observed, and mines each one for handles other than its own. It then gathers the
 * evidence needed to score them: fetching and perceptually hashing the avatars, and
 * optionally fetching the pivoted-to profile's own page for its `og:` metadata, which is
 * the only way an avatar or a bio exists for a handle no tool has been pointed at yet.
 *
 * `parse()` does the scoring, purely, from that capture. Fixing the scorer later is a
 * re-parse of files already on disk, with nothing re-fetched and nobody probed again —
 * which matters more here than anywhere else in the app, because a scoring rule is exactly
 * the kind of thing that gets revised.
 *
 * ## The division of labour is deliberate
 *
 * Hashes are computed in `run()` because they are facts about bytes at a moment in time.
 * Hamming distances are computed in `parse()` because they are arithmetic. If the distance
 * were computed at capture time, changing the threshold would mean re-downloading every
 * avatar; as it stands it means re-reading a JSON file.
 *
 * ## What it will not do
 *
 * **Nothing is promoted.** Every pivot becomes an `EntityCandidate` carrying its signal
 * breakdown, and a human decides. This is not caution for its own sake: a wrongly promoted
 * candidate becomes a real entity, the next run is pointed at it, and the case is then
 * mapping a stranger's life under the operator's own name — with every later finding
 * inheriting the error and looking more convincing the deeper it goes. Auto-dismissal is
 * recoverable. Auto-promotion is not.
 *
 * Depth is capped at two hops by default because the third explodes: a handle with five
 * pointers, each with five, is twenty-five candidates at hop three and a review queue
 * nobody reads.
 */

import path from 'node:path'
import type { Entity, Finding } from '../../shared/types'
import {
  PIVOT_DEFAULT_MAX_HOPS,
  PIVOT_POINTS,
  PIVOT_STRENGTH,
  pivotBand,
  type PivotAssessment,
  type PivotGap,
  type PivotSignal,
  type PivotSignalId
} from '../../shared/pivot'
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
import { findFiles, mergedOptions, optionBoolean, optionNumber, readTextIfExists } from './support/toolkit'
import { fetchImage, hammingHex, type FetchedImage } from './support/image'
import { httpGet, politeDelay } from './support/net'
import {
  accountFromUrl,
  absoluteUrls,
  handlesAreVariants,
  pointersFrom,
  profilesFrom,
  PROFILE_SOURCES,
  sharedBioPhrase,
  type ObservedProfile
} from './support/profiles'

const ID = 'pivot'
const VERSION = '1.0.0'

/**
 * Perceptual-hash distances, out of 64 bits.
 *
 * `NEAR` is what a re-encode and a resize of one picture actually costs — this repository's
 * own test suite measures it. `LOOSE` is where a picture stops being the same picture and
 * starts being a similar one, which is a weaker claim and is scored as such.
 */
const PHASH_NEAR = 6
const PHASH_LOOSE = 12
const DHASH_NEAR = 10

/**
 * How many distinct handles have to share an avatar before it is treated as the platform's
 * default rather than as a match.
 *
 * A default avatar matching a default avatar is the strongest signal in the set firing on
 * the weakest possible evidence, and the URL patterns do not catch all of them: this is
 * the self-calibrating half, and it works on defaults nobody has ever seen before.
 */
const DEFAULT_AVATAR_SHARERS = 3

/** URL shapes that name a placeholder rather than a person. */
const PLACEHOLDER_AVATAR =
  /(^|[/_-])(default|no[-_]?(?:avatar|image|photo|pic)|placeholder|blank|anonymous|missing|unknown|generic|silhouette)([._/-]|$)/i

/** What `run()` transcribes and `parse()` scores. */
interface Transcript {
  maxHops: number
  /** Handles the case already holds: seeds, and accounts a human promoted. */
  knownHandles: string[]
  /** Person and location values the operator seeded, for the attribution signals. */
  seededNames: string[]
  seededCities: string[]
  /** Every profile read back out of the case's captures. */
  profiles: ObservedProfile[]
  /** Hop depth per handle, lowercase-keyed. */
  hops: Record<string, number>
  pivots: TranscribedPivot[]
  /** Avatar hashes by URL. Includes the failures, with their reasons. */
  avatars: Record<string, AvatarRecord>
  /** Hashes seen on this many distinct handles or more: platform defaults. */
  defaultHashes: string[]
  capturesRead: number
  capturesSkipped: string[]
  fetched: number
  fetchNotes: string[]
}

interface TranscribedPivot {
  handle: string
  platform: string
  url: string | null
  via: string
  explicitLink: boolean
  hops: number
  /** `platform/handle` of the profile that pointed at it. */
  from: string
  fromSource: string
  /** Profiles observed *for* this handle, if any tool has been pointed at it. */
  targets: ObservedProfile[]
}

interface AvatarRecord {
  sha256: string | null
  dhash: string | null
  phash: string | null
  reason: string | null
  /** Handles this URL was an avatar for. Used to spot platform defaults. */
  handles: string[]
}

export const pivotAdapter: Adapter = {
  id: ID,
  title: 'Pivot search (identity resolution)',
  version: VERSION,

  accepts: ['username', 'account', 'person'],
  produces: ['username', 'account'],

  requiresKey: false,
  // It can run entirely offline — set `avatars: false` and `fetchProfiles: false` and it
  // makes no requests at all — but the two signals worth having need the network.
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 0,
  defaultTimeoutMs: 240_000,

  doc: {
    what: 'Follows the other handles a profile names — in its bio, in its links, in its display name — and scores each one for whether it plausibly belongs to the same person, without ever deciding that it does.',

    how: 'It starts from captures already on disk rather than from a new sweep: it re-reads the raw output every username tool has written into this case, reconstructs the profiles those tools scraped, and mines each profile for handles other than its own. Four sources of pointer, in descending order of how much the subject asserted them: a URL the profile links to, an @-mention in the bio, a handle the platform itself publishes for another service, and a display name that is shaped like a handle. Each pivoted-to handle is then scored on properties the two profiles either share or do not. An explicit link between them is treated as near-decisive because the person published it. An avatar match is measured by perceptual hash — the picture is reduced to greyscale, downscaled, and reduced to sixty-four bits by a difference hash and a DCT hash, so the same picture re-encoded at a different size still matches on Hamming distance. A shared bio phrase counts only above a rarity and length floor, so two people both writing "opinions are my own" is not evidence. A display name, a seeded real name and a seeded city each contribute, in that order. The arithmetic happens in the parser, so a threshold changed next month re-derives every score from captures made today with nothing re-fetched.',

    why: 'People reuse. Not always the handle — that is the easy case and it is what the plain username sweep already covers — but the picture, the bio sentence they wrote once and pasted everywhere, and above all the links, because the entire point of a profile is to point at your other profiles. Any one of those is weak. The reason to compute them together is that they are independent: a coincidence in a handle says little, a coincidence in a handle and a picture and a phrase says a great deal, and the multiplication is what turns a pile of possible accounts into one worth looking at. For a self-audit the finding is usually uncomfortable and specific: the account you kept separate is joined to the rest by a picture you uploaded to both.',

    betterAt: 'Finding the accounts a plain username sweep structurally cannot: the ones under a different name. It is also the only adapter here that gets better every time another one runs, because its input is the case folder — point maigret at a promoted pivot and the next pivot run has that profile\'s bio and avatar to score against. And it costs almost nothing to re-run: with avatars cached and profile fetching off it makes no requests at all.',

    worseAt: 'Anything it cannot read. It only sees what the collectors managed to scrape, and blackbird returns a display name on roughly one hit in twenty while sherlock returns nothing but a URL, so a case built from sherlock alone gives it almost nothing to work with. Avatar matching needs an image decoder: PNG is decoded locally, but JPEG — which is what most avatar CDNs actually serve — is decoded through Electron, so in a plain Node process that signal reports itself as unevaluated rather than as absent. Fetching the pivoted-to profile fails on exactly the platforms that matter most, because Instagram, X and Facebook all refuse an unauthenticated request. It cannot see a link that exists only in an image, and it cannot follow a handle nobody wrote down.',

    falsePositives: 'The scores are an ordering, not a probability, and the common case is a stranger. Handle collisions are ordinary — short handles, dictionary words and old platforms produce them constantly — so a pivot whose only signal is the handle means an account with that name exists and nothing more. Display names collide harder than they look: this repository\'s own maigret fixture returns three different people for one handle. A default avatar matching another default avatar would fire the strongest signal in the set on nothing, so identical hashes seen on three or more handles are treated as platform defaults and dropped, along with URLs that name themselves as placeholders — which means a genuine match to a picture that happens to be popular is also dropped, and that error direction is chosen deliberately. A shared bio phrase can be a quotation both people copied. And the deepest failure is structural: a wrong pivot promoted at hop one becomes the basis for hop two, so the second generation of findings is about a stranger while carrying the subject\'s name. That is why nothing here promotes anything, and why the hop cap is two.'
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

    const maxHops = optionNumber(options, 'maxHops', PIVOT_DEFAULT_MAX_HOPS, { min: 1, max: 3 })
    const wantAvatars = optionBoolean(options, 'avatars', true)
    const wantProfiles = optionBoolean(options, 'fetchProfiles', true)
    const maxFetches = optionNumber(options, 'maxFetches', 24, { min: 0, max: 200 })
    const gapMs = optionNumber(options, 'requestGapMs', 600, { min: 0, max: 10_000 })
    const timeoutMs = optionNumber(options, 'siteTimeoutSeconds', 12, { min: 2, max: 60 }) * 1000

    const t: Transcript = {
      maxHops,
      knownHandles: [],
      seededNames: [],
      seededCities: [],
      profiles: [],
      hops: {},
      pivots: [],
      avatars: {},
      defaultHashes: [],
      capturesRead: 0,
      capturesSkipped: [],
      fetched: 0,
      fetchNotes: []
    }

    /* --- 1. what the case already holds ------------------------------------ */

    const entities = (await readJson<Entity[]>(path.join(ctx.caseDir, 'entities.json'))) ?? []
    for (const e of entities) {
      if (e.kind === 'username') t.knownHandles.push(e.value)
      else if (e.kind === 'account') {
        const handle = e.value.includes('/') ? e.value.slice(e.value.indexOf('/') + 1) : e.value
        if (handle) t.knownHandles.push(handle)
      } else if (e.kind === 'person' && e.seed) t.seededNames.push(e.label || e.value)
      else if (e.kind === 'location' && e.seed) t.seededCities.push(e.label || e.value)
    }
    // The entity the run was pointed at is always hop 0, even in a case with no seeds yet.
    if (input.entity.kind === 'username') t.knownHandles.push(input.entity.value)
    t.knownHandles = unique(t.knownHandles.map((h) => h.toLowerCase()))
    for (const h of t.knownHandles) t.hops[h] = 0

    /* --- 2. every profile any tool has already observed --------------------- */

    const rawDir = path.join(ctx.caseDir, 'raw')
    const files = await findFiles(rawDir, (n) => n.toLowerCase().endsWith('.json'), 1)
    ctx.progress({ pct: 5, note: `reading ${files.length} raw captures`, total: files.length, done: 0 })

    let read = 0
    for (const file of files) {
      if (ctx.signal.aborted) break
      const text = await readTextIfExists(file.path)
      if (text === null) {
        t.capturesSkipped.push(`${file.name} (unreadable)`)
        continue
      }
      const doc = parseJsonSafe<Record<string, unknown>>(text)
      if (!doc || typeof doc['adapter'] !== 'string') {
        t.capturesSkipped.push(`${file.name} (not a run envelope)`)
        continue
      }
      read++
      ctx.progress({ done: ++t.capturesRead, total: files.length, current: String(doc['adapter']) })
      if (!(PROFILE_SOURCES as readonly string[]).includes(doc['adapter'] as string)) continue
      try {
        t.profiles.push(...profilesFrom(doc as never))
      } catch {
        t.capturesSkipped.push(`${file.name} (profile extraction failed)`)
      }
    }
    t.capturesRead = read
    t.profiles = dedupeProfiles(t.profiles)

    /* --- 3. hop depth, and the pivots themselves ---------------------------- */

    assignHops(t, maxHops)

    const known = new Set(t.knownHandles)
    const pivots = new Map<string, TranscribedPivot>()
    for (const profile of t.profiles) {
      const hop = t.hops[profile.aboutHandle.toLowerCase()]
      if (hop === undefined || hop >= maxHops) continue
      for (const pointer of pointersFrom(profile)) {
        const lower = pointer.handle.toLowerCase()
        if (known.has(lower)) continue
        const key = `${pointer.platform}/${lower}`
        const existing = pivots.get(key)
        const record: TranscribedPivot = {
          handle: pointer.handle,
          platform: pointer.platform,
          url: pointer.url,
          via: pointer.via,
          explicitLink: pointer.explicitLink,
          hops: hop + 1,
          from: profile.key,
          fromSource: profile.platform,
          targets: t.profiles.filter((p) => p.handle.toLowerCase() === lower)
        }
        // Keep the strongest provenance for a handle reached more than one way.
        if (!existing || (record.explicitLink && !existing.explicitLink) || record.hops < existing.hops) {
          pivots.set(key, record)
        }
      }
    }
    t.pivots = [...pivots.values()].sort((a, b) => a.hops - b.hops)

    /* --- 4. fetch the pivoted-to profiles, when asked ----------------------- */

    if (wantProfiles && maxFetches > 0) {
      let budget = maxFetches
      for (const pivot of t.pivots) {
        if (ctx.signal.aborted || budget <= 0) break
        // Only worth a request when nothing in the case already describes this handle.
        if (pivot.targets.length > 0 || !pivot.url) continue
        budget--
        ctx.progress({ note: `reading ${pivot.platform || 'profile'}/${pivot.handle}`, current: pivot.url })
        const res = await httpGet({
          url: pivot.url,
          timeoutMs,
          signal: ctx.signal,
          maxBytes: 512 * 1024,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
        })
        t.fetched++
        if (!res.ok || res.error) {
          t.fetchNotes.push(
            `${pivot.url} — ${res.error ?? `HTTP ${res.status}`}. Nothing is concluded from a refusal.`
          )
          continue
        }
        const meta = profileFromHtml(res.body, res.url, pivot.handle)
        if (meta) pivot.targets.push({ ...meta, tool: ID })
        else t.fetchNotes.push(`${pivot.url} — answered, but carried no profile metadata.`)
        await politeDelay(gapMs, ctx.signal)
      }
    }

    /* --- 5. avatars: fetch once, hash once ---------------------------------- */

    if (wantAvatars) {
      const wanted = new Map<string, string[]>()
      const want = (url: string | null, handle: string): void => {
        if (!url) return
        const list = wanted.get(url) ?? []
        if (!list.includes(handle.toLowerCase())) list.push(handle.toLowerCase())
        wanted.set(url, list)
      }
      for (const p of t.profiles) want(p.avatarUrl, p.handle)
      for (const pivot of t.pivots) for (const target of pivot.targets) want(target.avatarUrl, target.handle)

      // Hashes computed by an earlier pivot run in this case are facts about bytes and do
      // not expire; reusing them is what makes re-running this free.
      const cached = await previousAvatars(files.map((f) => f.path))
      let n = 0
      for (const [url, handles] of wanted) {
        if (ctx.signal.aborted) break
        const hit = cached[url]
        if (hit) {
          t.avatars[url] = { ...hit, handles: unique([...hit.handles, ...handles]) }
          continue
        }
        n++
        ctx.progress({ note: `hashing avatar ${n} of ${wanted.size}`, done: n, total: wanted.size, current: url })
        const img: FetchedImage = await fetchImage(url, { timeoutMs, signal: ctx.signal, maxBytes: 4 * 1024 * 1024 })
        t.fetched++
        t.avatars[url] = {
          sha256: img.sha256,
          dhash: img.hash?.dhash ?? null,
          phash: img.hash?.phash ?? null,
          reason: img.hash ? null : (img.reason ?? 'no hash'),
          handles
        }
        await politeDelay(gapMs, ctx.signal)
      }

      // The self-calibrating half of default detection: a picture worn by three different
      // handles is the platform's, not a person's.
      const byHash = new Map<string, Set<string>>()
      for (const [url, rec] of Object.entries(t.avatars)) {
        if (!rec.phash) continue
        const set = byHash.get(rec.phash) ?? new Set<string>()
        for (const h of rec.handles) set.add(h)
        if (PLACEHOLDER_AVATAR.test(url)) set.add(`__url_placeholder__${url}`)
        byHash.set(rec.phash, set)
      }
      for (const [hash, handles] of byHash) {
        const real = [...handles].filter((h) => !h.startsWith('__url_placeholder__'))
        const namedPlaceholder = handles.size !== real.length
        if (namedPlaceholder || real.length >= DEFAULT_AVATAR_SHARERS) t.defaultHashes.push(hash)
      }
      t.defaultHashes = unique(t.defaultHashes)
    }

    env.artifacts['pivot.json'] = JSON.stringify(t, null, 2)
    env.notes.push(
      `Read ${t.capturesRead} raw capture(s) from ${rawDir}; ${t.profiles.length} profile(s) reconstructed; ` +
        `${t.pivots.length} pivot candidate(s) at up to ${maxHops} hop(s); ${t.fetched} request(s) made.`
    )
    for (const note of t.fetchNotes.slice(0, 20)) env.notes.push(note)
    for (const skipped of t.capturesSkipped.slice(0, 20)) env.notes.push(`Skipped ${skipped}`)

    return finishEnvelope(env, { caseId: input.caseId, ok: true, finishedAt: ctx.now(), startedMs })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/* ------------------------------------------------------------------ *
 * Scoring — pure, and the only place a judgement is made
 * ------------------------------------------------------------------ */

/**
 * One walk producing both halves, so a proposal can carry the id of the finding beside it
 * without either side rebuilding the other's claim string. A finding's id is derived from
 * that string, so two copies of it are two ids that diverge the first time one is edited.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const findings: Finding[] = []
  const proposals: EntityProposal[] = []

  const env = readEnvelope(raw)
  if (!env) return { findings, proposals }
  const t = parseJsonSafe<Transcript>(env.artifacts['pivot.json'] ?? null)
  if (!t || !Array.isArray(t.pivots)) return { findings, proposals }

  const reference = t.profiles.filter((p) => (t.hops[p.aboutHandle?.toLowerCase() ?? ''] ?? 9) === 0)

  findings.push(
    makeFinding(raw, {
      source: localSource(ID),
      claim:
        `Pivot search over ${group(t.capturesRead)} existing capture(s) reconstructed ${group(t.profiles.length)} profile(s) ` +
        `and found ${group(t.pivots.length)} handle(s) named by them that are not in this case, at up to ${t.maxHops} hop(s). ` +
        `${group(t.fetched)} request(s) were made. Every one of these is a hypothesis about identity: a handle appearing on a profile ` +
        `is evidence that somebody wrote it there, not evidence that the account behind it is the same person.`
    })
  )

  for (const pivot of t.pivots) {
    const assessment = assess(pivot, reference, t)

    // The observation. Sourced at the site that carried the pointer, because that site
    // really did say this — it is the one claim here that is about the outside world.
    const observation = makeFinding(raw, {
      source: pivot.fromSource || localSource(ID),
      claim:
        `The ${pivot.fromSource} profile ${pivot.from} names the handle ${pivot.handle}` +
        `${pivot.platform ? ` on ${pivot.platform}` : ''}, via ${pivot.via}. ` +
        `That is a pointer written on a page, not a statement that the account is the same person.`
    })
    findings.push(observation)

    // The judgement. Sourced `local:` so analysis can never corroborate itself.
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: describe(assessment)
      })
    )

    const rationale =
      `${assessment.band} — ${assessment.signals.length ? assessment.signals.map((s) => s.detail).join(' ') : 'nothing fired but the handle itself.'}`

    proposals.push({
      fromFindingId: observation.id,
      kind: 'username',
      value: pivot.handle,
      label: pivot.handle,
      attrs: { pivot: assessment, originPlatform: pivot.platform || undefined },
      rationale
    })
    /*
     * The account is proposed only when the profile linked to it explicitly.
     *
     * Every pivot already proposes a bare `username`, which is the actionable one — it is
     * what a username sweep can be pointed at. Adding a second row for the account
     * doubles the review queue for one discovery, and the operator's complaint about this
     * screen is that there is too much to click through. An explicit link is the one case
     * where the account itself is a claim worth reviewing separately, because the profile
     * asserted that this exact account on this exact site exists.
     */
    if (pivot.platform && pivot.explicitLink) {
      proposals.push({
        fromFindingId: observation.id,
        kind: 'account',
        value: `${pivot.platform}/${pivot.handle}`,
        label: `${pivot.handle} on ${pivot.platform}`,
        attrs: {
          platform: pivot.platform,
          handle: pivot.handle,
          url: pivot.url ?? undefined,
          displayName: pivot.targets[0]?.displayName ?? undefined,
          bio: pivot.targets[0]?.bio ?? undefined,
          avatarUrl: pivot.targets[0]?.avatarUrl ?? undefined,
          pivot: assessment
        },
        rationale
      })
    }
  }

  return { findings, proposals }
}

/** The scoring itself. Every term is recorded, so the total is auditable rather than magic. */
export function assess(
  pivot: TranscribedPivot,
  reference: ObservedProfile[],
  t: Transcript
): PivotAssessment {
  const signals: PivotSignal[] = []
  const gaps: PivotGap[] = []
  const fire = (id: PivotSignalId, detail: string): void => {
    if (signals.some((s) => s.id === id)) return
    signals.push({ id, strength: PIVOT_STRENGTH[id], points: PIVOT_POINTS[id], detail })
  }

  const targets = pivot.targets ?? []
  const from = reference.find((p) => p.key === pivot.from) ?? null

  /* --- links ------------------------------------------------------------- */

  if (pivot.explicitLink) {
    // Reciprocal beats outbound by a wide margin: two pages pointing at each other is a
    // connection the subject published from both ends.
    const linksBack = targets.some((target) => {
      const urls = [...target.links, ...absoluteUrls(target.bio ?? '')]
      return urls.some((u) => {
        const account = accountFromUrl(u)
        return (
          (!!from && account?.platform === from.platform && account.handle.toLowerCase() === from.handle.toLowerCase()) ||
          (!!from?.url && sameUrl(u, from.url))
        )
      })
    })
    if (linksBack) {
      fire('reciprocal-link', `${pivot.from} links to ${pivot.handle}, and that profile links back to ${pivot.from}.`)
    } else {
      fire(
        'outbound-link',
        `${targets.length ? 'The other profile does not link back.' : 'The other profile was not readable, so the reverse link could not be checked.'} ${pivot.from} links to ${pivot.url}`
      )
      if (!targets.length) {
        gaps.push({ id: 'reciprocal-link', why: 'The pivoted-to profile could not be read, so a link back could not be checked.' })
      }
    }
  }

  /* --- avatars ------------------------------------------------------------ */

  const refAvatars = avatarsOf(reference, t)
  const targetAvatars = avatarsOf(targets, t)
  if (refAvatars.length === 0 || targetAvatars.length === 0) {
    gaps.push({
      id: 'avatar-hash',
      why: !targetAvatars.length
        ? 'No avatar was captured for the pivoted-to account, so the pictures could not be compared. Point a profile-scraping tool at it and run this again.'
        : 'No avatar was captured for any account already in the case, so there was nothing to compare against.'
    })
  } else {
    let best: { distance: number; a: AvatarRef; b: AvatarRef } | null = null
    let bytes: { a: AvatarRef; b: AvatarRef } | null = null
    let blockedByDefault = false
    let undecodable: string | null = null

    for (const a of refAvatars) {
      for (const b of targetAvatars) {
        if (a.reason || b.reason) {
          undecodable ??= a.reason ?? b.reason
          continue
        }
        if (a.isDefault || b.isDefault) {
          blockedByDefault = true
          continue
        }
        if (a.sha256 && a.sha256 === b.sha256) bytes = { a, b }
        const dp = hammingHex(a.phash ?? '', b.phash ?? '')
        const dd = hammingHex(a.dhash ?? '', b.dhash ?? '')
        if (dp < 0 || dd < 0) continue
        if (!best || dp < best.distance) best = { distance: dp, a, b }
        if (dp <= PHASH_NEAR && dd <= DHASH_NEAR) {
          fire(
            'avatar-hash',
            `The avatars are perceptually the same picture: Hamming distance ${dp} of 64 on the DCT hash and ${dd} of 64 on the difference hash.`
          )
        }
      }
    }
    if (bytes) {
      fire('avatar-bytes', `Both accounts serve a byte-identical avatar (sha256 ${bytes.a.sha256!.slice(0, 12)}…).`)
    }
    if (!signals.some((s) => s.id === 'avatar-hash') && best && best.distance <= PHASH_LOOSE) {
      // Close but not the same picture. Worth reporting, not worth the strong signal.
      gaps.push({
        id: 'avatar-hash',
        why: `The closest pair of avatars is ${best.distance} of 64 bits apart, which is similar but not the same picture.`
      })
    }
    if (blockedByDefault) {
      gaps.push({
        id: 'avatar-hash',
        why: 'One of the avatars is the platform default. A default matching a default is not evidence, so the comparison was dropped.'
      })
    }
    if (undecodable) {
      gaps.push({ id: 'avatar-hash', why: `An avatar could not be hashed: ${undecodable}.` })
    }
  }

  /* --- text --------------------------------------------------------------- */

  for (const target of targets) {
    for (const ref of reference) {
      const phrase = sharedBioPhrase(ref.bio, target.bio)
      if (phrase) {
        fire('bio-phrase', `Both profiles' text contains the phrase "${phrase}", which is specific enough not to be a coincidence of common words.`)
      }
      if (
        ref.displayName &&
        target.displayName &&
        normaliseName(ref.displayName) === normaliseName(target.displayName)
      ) {
        fire('display-name', `Both profiles show the display name "${target.displayName}".`)
      }
    }
    const haystack = `${target.displayName ?? ''} ${target.bio ?? ''} ${target.location ?? ''}`
    for (const name of t.seededNames) {
      if (name && containsWord(haystack, name)) {
        fire('seeded-name', `The profile carries "${name}", which you seeded as your own name.`)
      }
    }
    for (const city of t.seededCities) {
      if (city && containsWord(haystack, city)) {
        fire('seeded-city', `The profile's location field carries "${city}", which you seeded.`)
      }
    }
  }
  if (!targets.length) {
    gaps.push({
      id: 'bio-phrase',
      why: 'Nothing in this case describes the pivoted-to account, so its text could not be compared.'
    })
  }

  /* --- the handle itself --------------------------------------------------- */

  for (const handle of t.knownHandles) {
    if (handlesAreVariants(handle, pivot.handle)) {
      fire('handle-shape', `The handle is a variant of "${handle}", which this case already holds.`)
      break
    }
  }

  const score = Math.min(100, signals.reduce((n, s) => n + s.points, 0))
  return {
    target: pivot.platform ? `${pivot.platform}/${pivot.handle}` : pivot.handle,
    handle: pivot.handle.toLowerCase(),
    platform: pivot.platform,
    from: pivot.from,
    fromSource: pivot.fromSource,
    via: pivot.via,
    hops: pivot.hops,
    score,
    band: pivotBand(score, signals),
    signals: signals.sort((a, b) => b.points - a.points),
    unevaluated: gaps,
    url: pivot.url
  }
}

function describe(a: PivotAssessment): string {
  const head =
    `${a.target} is a pivot from ${a.from} at ${a.hops} hop${a.hops === 1 ? '' : 's'}, scoring ${a.score} of 100 — ${a.band.replace('-', ' ')}.`
  const fired = a.signals.length
    ? ` Signals: ${a.signals.map((s) => `${s.detail} (${s.strength}, +${s.points})`).join(' ')}`
    : ' No signal fired beyond the handle itself.'
  const missing = a.unevaluated.length
    ? ` Could not be checked: ${a.unevaluated.map((g) => g.why).join(' ')}`
    : ''
  return `${head}${fired}${missing} This is a hypothesis about identity and nothing here promotes it; an account with this name exists, which is not the same as it being yours.`
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

interface AvatarRef {
  url: string
  sha256: string | null
  dhash: string | null
  phash: string | null
  reason: string | null
  isDefault: boolean
}

function avatarsOf(profiles: readonly ObservedProfile[], t: Transcript): AvatarRef[] {
  const out: AvatarRef[] = []
  for (const p of profiles) {
    if (!p.avatarUrl) continue
    const rec = t.avatars?.[p.avatarUrl]
    if (!rec) continue
    out.push({
      url: p.avatarUrl,
      sha256: rec.sha256,
      dhash: rec.dhash,
      phash: rec.phash,
      reason: rec.reason,
      isDefault:
        PLACEHOLDER_AVATAR.test(p.avatarUrl) || (!!rec.phash && (t.defaultHashes ?? []).includes(rec.phash))
    })
  }
  return out
}

/**
 * Hop depth over the handle graph.
 *
 * Seeds are hop 0. A handle named on a hop-`h` handle's profile is hop `h + 1`. Iterating
 * to a fixed point rather than recursing keeps a profile that names its own author from
 * looping, and the cap is applied while walking so a depth-3 sweep is never even computed.
 */
function assignHops(t: Transcript, maxHops: number): void {
  for (let hop = 0; hop < maxHops; hop++) {
    for (const profile of t.profiles) {
      if ((t.hops[profile.aboutHandle.toLowerCase()] ?? -1) !== hop) continue
      for (const pointer of pointersFrom(profile)) {
        const lower = pointer.handle.toLowerCase()
        if (t.hops[lower] === undefined) t.hops[lower] = hop + 1
      }
    }
  }
}

/**
 * Two captures of one site are one profile. Prefer the record that actually carries
 * something: maigret's scrape beats blackbird's bare hit for the same account.
 */
function dedupeProfiles(profiles: ObservedProfile[]): ObservedProfile[] {
  const best = new Map<string, ObservedProfile>()
  const weight = (p: ObservedProfile): number =>
    (p.bio ? 4 : 0) + (p.avatarUrl ? 3 : 0) + (p.displayName ? 2 : 0) + p.links.length + p.namedHandles.length
  for (const p of profiles) {
    const existing = best.get(p.key)
    if (!existing || weight(p) > weight(existing)) best.set(p.key, p)
  }
  return [...best.values()]
}

/**
 * The `og:` block of a fetched profile page.
 *
 * A regex over meta tags rather than a DOM: the app has no HTML parser, this needs four
 * attributes, and an incomplete read here degrades to "no metadata" rather than to a wrong
 * one. The platforms that refuse anonymous requests — X, Instagram, Facebook — return
 * nothing useful either way, and the run notes say so rather than staying silent.
 */
export function profileFromHtml(html: string, url: string, handle: string): ObservedProfile | null {
  const meta = (...names: string[]): string | null => {
    for (const name of names) {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
        'i'
      )
      const alt = new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
        'i'
      )
      const m = re.exec(html) ?? alt.exec(html)
      const v = m?.[1]?.trim()
      if (v) return decodeEntities(v)
    }
    return null
  }

  const platform = siteOrigin(url)
  if (!platform) return null
  const title = meta('og:title', 'twitter:title') ?? titleTag(html)
  const description = meta('og:description', 'twitter:description', 'description')
  const image = meta('og:image', 'og:image:secure_url', 'twitter:image')
  if (!title && !description && !image) return null

  return {
    key: `${platform}/${handle.toLowerCase()}`,
    platform,
    handle,
    url,
    displayName: title,
    bio: description,
    avatarUrl: image && /^https:\/\//i.test(image) ? image : null,
    links: absoluteUrls(description ?? ''),
    namedHandles: [],
    location: null,
    tool: ID,
    aboutHandle: handle
  }
}

function titleTag(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)
  return m?.[1] ? decodeEntities(m[1].trim()) : null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
}

/** Avatar hashes recorded by an earlier pivot run in this case. */
async function previousAvatars(files: readonly string[]): Promise<Record<string, AvatarRecord>> {
  const out: Record<string, AvatarRecord> = {}
  for (const file of files) {
    const text = await readTextIfExists(file)
    if (text === null || !text.includes('"adapter": "pivot"')) continue
    const doc = parseJsonSafe<{ artifacts?: Record<string, string> }>(text)
    const prev = parseJsonSafe<Transcript>(doc?.artifacts?.['pivot.json'] ?? null)
    for (const [url, rec] of Object.entries(prev?.avatars ?? {})) {
      // A failure is not cached: the site may simply have been down.
      if (rec && (rec.phash || rec.sha256)) out[url] ??= rec
    }
  }
  return out
}

async function readJson<T>(file: string): Promise<T | null> {
  const text = await readTextIfExists(file)
  return text === null ? null : parseJsonSafe<T>(text)
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs.filter(Boolean))]
}

function sameUrl(a: string, b: string): boolean {
  const strip = (u: string): string => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase()
  return strip(a) === strip(b)
}

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function containsWord(haystack: string, needle: string): boolean {
  const h = normaliseName(haystack)
  const n = normaliseName(needle)
  if (n.length < 4) return false
  return new RegExp(`(^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(h)
}

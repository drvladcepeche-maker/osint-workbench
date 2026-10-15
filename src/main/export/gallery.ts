/**
 * The avatar gallery: every picture the case found, grouped by the ones that are the same
 * picture.
 *
 * ## The question it answers
 *
 * "Can I find an image of this person?" — and, more usefully, "which of these accounts
 * are wearing the same face?" Two accounts serving one picture is the strongest cheap
 * evidence of one owner this app can produce without a human looking at anything: an
 * avatar is a file the subject uploaded twice, and nobody uploads a stranger's photograph
 * to their own profile by accident.
 *
 * ## Why perceptual hashing and not a digest
 *
 * Every platform re-encodes and re-sizes what it is given, so `sha256` answers "is this
 * the same file", which is nearly always **no** even for two copies of one photograph.
 * The pair of 64-bit perceptual hashes in `adapters/support/image.ts` answers "is this
 * the same picture", which is the question. Both hashes have to agree independently
 * before a pair is grouped — dHash reads horizontal gradients and survives re-compression
 * but is fooled by a mirror flip; pHash reads low-frequency content and survives cropping
 * and gamma but is duller on flat images. Requiring both keeps the false-match rate low
 * on the one signal the operator is most likely to act on.
 *
 * That module is shared with the pivot engine rather than duplicated. There is exactly one
 * implementation of "are these the same picture" in this app, and it is that one.
 *
 * ## Platform defaults are excluded, and shown anyway
 *
 * A default avatar matching a default avatar means nothing at all: every account on that
 * platform has the identical file. Grouping them would fire the strongest signal in the
 * set on the emptiest possible evidence. They are separated out rather than deleted,
 * because "this account never set a picture" is itself worth knowing and because an
 * invisible filter is one the operator cannot check.
 *
 * ## Nothing here fetches
 *
 * The bytes and the hashes were captured by `profile-enrich` and live in
 * `cases/<id>/raw/`. This module re-derives from those captures, exactly the way the
 * coverage classifier re-derives coverage — a fix to the grouping is a re-read of files
 * already on disk, and opening the gallery makes no requests to anybody.
 */

import path from 'node:path'

import { hammingHex } from '../adapters/support/image'
import { cleanUrl } from '../adapters/support/profile'
import type { ExtractedProfile } from '../adapters/support/profile'
import { PROFILE_ENRICH_ID, readCapture, type AvatarRecord } from '../adapters/profile-enrich'
import { siteOrigin } from '../adapters/support/sources'
import { parseJsonSafe } from '../adapters/support/envelope'
import { findFiles, readTextIfExists, type FoundFile } from '../adapters/support/toolkit'
import type { AvatarGallery, GalleryGroup, GalleryImage } from '../../shared/ipc'

/**
 * Bits of 64 two hashes may differ by and still be called the same picture.
 *
 * Six, and both hashes must clear it independently. The number is the adapter's too — it
 * is defined in both places on purpose, since the adapter's claim and the gallery's
 * grouping have to agree or the case file says one thing and the screen says another.
 */
export const AVATAR_MATCH_DISTANCE = 6

/** Pictures a case knows about, before any grouping. */
export interface AvatarHarvest {
  images: GalleryImage[]
  /** Avatar URLs a sweep recorded but nothing has fetched yet. */
  notFetched: { platform: string; handle: string; url: string }[]
  profiles: ExtractedProfile[]
  capturesRead: number
  /** Captures the case folder holds, before the cap. `capturesRead` may be smaller. */
  capturesTotal: number
  /** Captures skipped for size, and therefore neither harvested nor classified. */
  capturesSkipped: { name: string; bytes: number }[]
  enrichRuns: number
}

/**
 * How much of the raw folder one walk is allowed to read.
 *
 * The cap on *bytes* exists because a maigret sweep over three thousand sites is a tens-of-
 * megabytes capture and this walk holds one file in memory at a time; the cap on *count*
 * because a long-running case accumulates hundreds. Neither is allowed to be silent —
 * anything skipped comes back in `capturesSkipped` and `capturesTotal`, and the export
 * turns both into a stated gap rather than an absence.
 */
export interface HarvestOptions {
  maxCaptures?: number
  maxBytes?: number
  /**
   * Called with every capture this walk actually read, before it is interpreted.
   *
   * It is here so a caller that needs a second reading of the same bytes — the export's
   * coverage classifier does — gets it from this walk instead of opening the folder a
   * second time. Nothing is retained: the text is handed over and dropped.
   */
  onCapture?: (file: FoundFile, text: string) => void
}

export const DEFAULT_MAX_CAPTURES = 400
export const DEFAULT_MAX_CAPTURE_BYTES = 32 * 1024 * 1024

function toGalleryImage(a: AvatarRecord): GalleryImage {
  return {
    accountKey: a.key,
    platform: a.platform,
    handle: a.handle,
    url: a.url,
    mediaType: a.mediaType,
    bytes: a.bytes,
    sha256: a.sha256,
    dhash: a.hash?.dhash ?? null,
    phash: a.hash?.phash ?? null,
    isDefault: a.isDefault,
    reason: a.reason,
    // Kept out of the record deliberately: a gallery of forty pictures is a few megabytes
    // and the renderer only needs the ones it draws. `dataUri` is filled by the caller
    // that actually wants bytes — the view, and the export.
    dataUri: a.base64 === null ? null : `data:${a.mediaType || 'image/jpeg'};base64,${a.base64}`
  }
}

/**
 * Every picture in one case, read out of its raw captures.
 *
 * Two kinds of capture are read. `profile-enrich` envelopes carry fetched, hashed avatars
 * with their bytes. Everything else is scanned only for avatar URLs a sweep recorded —
 * those are reported as *not fetched*, never as absent, because "maigret saw a picture and
 * nobody has downloaded it" and "this account has no picture" are different facts and only
 * the second one is reassuring.
 */
export async function harvestAvatars(caseDir: string, options: HarvestOptions = {}): Promise<AvatarHarvest> {
  const maxCaptures = options.maxCaptures ?? DEFAULT_MAX_CAPTURES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES
  const out: AvatarHarvest = {
    images: [],
    notFetched: [],
    profiles: [],
    capturesRead: 0,
    capturesTotal: 0,
    capturesSkipped: [],
    enrichRuns: 0
  }
  const files = await findFiles(path.join(caseDir, 'raw'), (name) => name.toLowerCase().endsWith('.json'), 1)
  out.capturesTotal = files.length

  const seenImage = new Set<string>()
  const seenUnfetched = new Set<string>()

  for (const file of files.slice(0, maxCaptures)) {
    if (file.size > maxBytes) {
      out.capturesSkipped.push({ name: file.name, bytes: file.size })
      continue
    }
    const text = await readTextIfExists(file.path)
    if (text === null) continue
    out.capturesRead++
    options.onCapture?.(file, text)

    const capture = readCapture(text)
    if (capture !== null) {
      out.enrichRuns++
      out.profiles.push(...capture.profiles)
      for (const avatar of capture.avatars) {
        const key = `${avatar.key}|${avatar.url}`
        if (seenImage.has(key)) continue
        seenImage.add(key)
        out.images.push(toGalleryImage(avatar))
      }
      continue
    }

    // A sweep's own capture. Only the avatar URLs are taken; nothing here is fetched.
    const env = parseJsonSafe<{ adapter?: string; artifacts?: Record<string, string> }>(text)
    if (!env || env.adapter === PROFILE_ENRICH_ID) continue
    for (const [name, body] of Object.entries(env.artifacts ?? {})) {
      if (!/^report_.*_simple\.json$/i.test(name)) continue
      const report = parseJsonSafe<Record<string, unknown>>(body)
      if (!report) continue
      for (const value of Object.values(report)) {
        if (!value || typeof value !== 'object') continue
        const entry = value as { username?: unknown; status?: { ids?: unknown; url?: unknown } }
        const ids = entry.status?.ids
        if (!ids || typeof ids !== 'object') continue
        const image = cleanUrl((ids as Record<string, unknown>)['image'] ?? (ids as Record<string, unknown>)['avatar'])
        const url = cleanUrl(entry.status?.url)
        if (image === null || url === null) continue
        const platform = siteOrigin(url)
        const handle = typeof entry.username === 'string' ? entry.username : ''
        const key = `${platform}/${handle.toLowerCase()}|${image}`
        if (seenUnfetched.has(key)) continue
        seenUnfetched.add(key)
        out.notFetched.push({ platform, handle, url: image })
      }
    }
  }

  // A picture that has since been fetched is no longer waiting to be fetched.
  const fetched = new Set(out.images.map((i) => i.url))
  out.notFetched = out.notFetched.filter((n) => !fetched.has(n.url))
  return out
}

/** Are these two the same picture, by the rule stated at the top of this file? */
export function samepicture(a: GalleryImage, b: GalleryImage): { same: boolean; identical: boolean; distance: number } {
  if (a.sha256 !== null && a.sha256 === b.sha256) return { same: true, identical: true, distance: 0 }
  if (a.dhash === null || b.dhash === null || a.phash === null || b.phash === null) {
    return { same: false, identical: false, distance: -1 }
  }
  const dh = hammingHex(a.dhash, b.dhash)
  const ph = hammingHex(a.phash, b.phash)
  if (dh < 0 || ph < 0) return { same: false, identical: false, distance: -1 }
  const same = dh <= AVATAR_MATCH_DISTANCE && ph <= AVATAR_MATCH_DISTANCE
  return { same, identical: false, distance: Math.max(dh, ph) }
}

/**
 * Group the harvest.
 *
 * Union-find over the comparable, non-default pictures. Transitive by construction, which
 * is the right behaviour for re-encodings of one photograph and is also the honest failure
 * mode: a chain A~B~C where A and C are six bits apart is one group, and the group's
 * `maxDistance` says how far apart its furthest pair actually is, so a wide group is
 * visible as a wide group rather than presented as a match.
 */
export function groupAvatars(harvest: AvatarHarvest): AvatarGallery {
  const defaults = harvest.images.filter((i) => i.isDefault)
  const unreadable = harvest.images.filter((i) => !i.isDefault && i.dhash === null)
  const comparable = harvest.images.filter((i) => !i.isDefault && i.dhash !== null)

  const parent = comparable.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      if (samepicture(comparable[i], comparable[j]).same) union(i, j)
    }
  }

  const buckets = new Map<number, GalleryImage[]>()
  for (let i = 0; i < comparable.length; i++) {
    const root = find(i)
    const list = buckets.get(root)
    if (list) list.push(comparable[i])
    else buckets.set(root, [comparable[i]])
  }

  const groups: GalleryGroup[] = []
  const singles: GalleryImage[] = []
  for (const images of buckets.values()) {
    const accounts = new Set(images.map((i) => i.accountKey))
    if (accounts.size < 2) {
      singles.push(...images)
      continue
    }
    let maxDistance = 0
    let allIdentical = true
    for (let i = 0; i < images.length; i++) {
      for (let j = i + 1; j < images.length; j++) {
        const cmp = sameparts(images[i], images[j])
        if (!cmp.identical) allIdentical = false
        if (cmp.distance > maxDistance) maxDistance = cmp.distance
      }
    }
    const platforms = [...new Set(images.map((i) => i.platform))].sort()
    groups.push({
      id: images.map((i) => i.accountKey).sort().join(' + '),
      images: [...images].sort((a, b) => a.platform.localeCompare(b.platform)),
      platforms,
      accounts: [...accounts].sort(),
      identical: allIdentical,
      maxDistance,
      // What the evidence supports is that the bytes each site served hash to the same
      // digest, recorded when they were fetched. "It was uploaded to each of them" is an
      // inference about a human act, and it is not this module's to make: a shared CDN, a
      // cross-post, or one site mirroring another's picture all produce the same digest.
      note: allIdentical
        ? 'Every one of these sites served the same bytes — identical digests, recorded when the pictures were fetched. That is the same photograph file in each place, however it got there.'
        : `The same picture through different encodings — the furthest pair differs by ${maxDistance} bits of 64. Two sites re-compressing one photograph looks exactly like this.`
    })
  }

  groups.sort((a, b) => b.images.length - a.images.length || a.id.localeCompare(b.id))
  singles.sort((a, b) => a.platform.localeCompare(b.platform))

  return {
    groups,
    singles,
    defaults,
    unreadable,
    notFetched: harvest.notFetched,
    capturesRead: harvest.capturesRead,
    enrichRuns: harvest.enrichRuns,
    note: [
      harvest.enrichRuns === 0
        ? 'No profile has been enriched in this case yet, so no picture has been fetched or hashed. Run profile-enrich on a username or an account to fill this in.'
        : `${harvest.images.length} pictures from ${harvest.enrichRuns} enrichment run${harvest.enrichRuns === 1 ? '' : 's'}. Platform default avatars are listed separately and never grouped: every account on a platform shares the same one, so a default matching a default means nothing.`,
      // Anything the walk did not open is stated. A picture that was never looked for must
      // not read as a picture that does not exist.
      harvest.capturesSkipped.length > 0
        ? `${harvest.capturesSkipped.length} capture${harvest.capturesSkipped.length === 1 ? ' was' : 's were'} too large to re-read here and ${harvest.capturesSkipped.length === 1 ? 'was' : 'were'} not searched for pictures.`
        : '',
      harvest.capturesTotal > harvest.capturesRead + harvest.capturesSkipped.length
        ? `Only the newest ${harvest.capturesRead} of ${harvest.capturesTotal} captures were read.`
        : ''
    ]
      .filter(Boolean)
      .join(' ')
  }
}

/** `samepicture` without the boolean, for measuring an already-grouped pair. */
function sameparts(a: GalleryImage, b: GalleryImage): { identical: boolean; distance: number } {
  if (a.sha256 !== null && a.sha256 === b.sha256) return { identical: true, distance: 0 }
  const dh = a.dhash !== null && b.dhash !== null ? hammingHex(a.dhash, b.dhash) : -1
  const ph = a.phash !== null && b.phash !== null ? hammingHex(a.phash, b.phash) : -1
  return { identical: false, distance: Math.max(dh, ph) }
}

/** Harvest and group in one call. Nothing is fetched. */
export async function buildGallery(caseDir: string): Promise<AvatarGallery> {
  return groupAvatars(await harvestAvatars(caseDir))
}

/**
 * Every enriched profile the case holds, keyed by `platform/handle`.
 *
 * Takes a harvest rather than a directory so a caller that already walked the raw folder
 * does not walk it again — the export needs the gallery, the profiles and a coverage
 * reading of the same files, and reading four hundred captures three times is three times
 * the work for one answer.
 */
export function profilesFromHarvest(harvest: AvatarHarvest): Map<string, ExtractedProfile> {
  const out = new Map<string, ExtractedProfile>()
  for (const profile of harvest.profiles) {
    const key = `${profile.platform}/${profile.handle.toLowerCase()}`
    const existing = out.get(key)
    // A later capture wins on fields the earlier one left blank, and loses on the rest:
    // re-running enrichment should add what changed, not erase what a site has stopped
    // publishing since.
    if (existing === undefined) out.set(key, profile)
    else {
      out.set(key, {
        ...existing,
        displayName: existing.displayName ?? profile.displayName,
        realName: existing.realName ?? profile.realName,
        location: existing.location ?? profile.location,
        bio: existing.bio ?? profile.bio,
        avatarUrl: existing.avatarUrl ?? profile.avatarUrl,
        joinedAt: existing.joinedAt ?? profile.joinedAt,
        followers: existing.followers ?? profile.followers,
        following: existing.following ?? profile.following,
        company: existing.company ?? profile.company,
        email: existing.email ?? profile.email,
        url: existing.url ?? profile.url,
        links: [...existing.links, ...profile.links.filter((l) => !existing.links.some((e) => e.url === l.url))]
      })
    }
  }
  return out
}

/** `profilesFromHarvest`, for a caller that has no harvest of its own. */
export async function readProfiles(caseDir: string): Promise<Map<string, ExtractedProfile>> {
  return profilesFromHarvest(await harvestAvatars(caseDir))
}

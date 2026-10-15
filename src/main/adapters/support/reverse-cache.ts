/**
 * A cache keyed by what the picture *is*, so one avatar is never submitted twice.
 *
 * The point is not speed. These four engines are the scarcest resource in the toolbelt —
 * there is no API, no key and no quota to buy, only an IP address that can be taken away —
 * and a duplicate submission spends that resource for an answer already on disk. A case
 * that enriches six accounts belonging to one person will hand this adapter the same
 * avatar six times over, re-encoded slightly differently by each platform.
 *
 * That is why the key is a **perceptual** hash when one is available. A sha256 says
 * "different" for two re-encodings of one photograph, which is exactly the case this cache
 * exists to catch; `support/image.ts` already computes dHash and pHash and this reuses it
 * rather than growing a second hasher. The fallback chain degrades honestly: pHash+dHash,
 * then sha256 of the bytes, then a digest of the source URL — and the fingerprint string
 * records which of the three it was, so a cache hit can say what it matched on.
 *
 * **Only a successful search is cached.** A captcha is a fact about a moment, not about the
 * image; caching one would turn a five-minute block into a permanent silent "no results",
 * which is the precise failure the whole adapter is written to avoid. Blocked, unclear and
 * errored engines are re-run every time.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { BrowserEngineResult } from './browser'

export const CACHE_DIR = path.join('.cache', 'reverse-image')

/** Thirty days. A page that carries an image rarely stops carrying it inside a month. */
export const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface CacheEntry {
  fingerprint: string
  engine: string
  driverVersion: string
  capturedAt: string
  result: BrowserEngineResult
}

/**
 * The identity of a picture, most durable form first.
 *
 * `phash:<p>.<d>` survives a re-encode; `sha256:<hex>` survives nothing but is exact;
 * `url:<hex>` is the last resort for an image that was never fetched, and is a cache key
 * for *that URL* rather than for the picture behind it.
 */
export type Fingerprint = string

export function phashFingerprint(phash: string, dhash: string): Fingerprint {
  return `phash:${phash}.${dhash}`
}

export function sha256Fingerprint(hex: string): Fingerprint {
  return `sha256:${hex}`
}

export function urlFingerprint(url: string): Fingerprint {
  return `url:${createHash('sha256').update(url).digest('hex')}`
}

/** How a human should read a fingerprint in a claim. */
export function describeFingerprint(fp: Fingerprint): string {
  if (fp.startsWith('phash:')) return 'a perceptual hash of the decoded picture, which survives re-encoding'
  if (fp.startsWith('sha256:')) return 'a SHA-256 of the exact bytes, which a re-encode would change'
  return 'a digest of the source URL, because the picture itself was never decoded'
}

function keyFor(fingerprint: Fingerprint, engine: string, driverVersion: string): string {
  const digest = createHash('sha256').update(`${fingerprint}|${engine}|${driverVersion}`).digest('hex')
  return `${engine}-${digest.slice(0, 32)}.json`
}

export function cacheDirFor(caseDir: string): string {
  return path.join(caseDir, CACHE_DIR)
}

/**
 * A cached engine result, or `null`.
 *
 * Never throws: a corrupt or unreadable cache file is a cache miss, because the cost of a
 * miss is one extra search and the cost of a throw is a lost run.
 */
export async function readCache(
  caseDir: string,
  fingerprint: Fingerprint,
  engine: string,
  driverVersion: string,
  ttlMs: number
): Promise<CacheEntry | null> {
  const file = path.join(cacheDirFor(caseDir), keyFor(fingerprint, engine, driverVersion))
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return null
  }
  let entry: CacheEntry
  try {
    entry = JSON.parse(text) as CacheEntry
  } catch {
    return null
  }
  if (!entry || typeof entry !== 'object' || !entry.result || entry.engine !== engine) return null
  if (entry.driverVersion !== driverVersion) return null
  const at = Date.parse(entry.capturedAt ?? '')
  if (!Number.isFinite(at)) return null
  if (ttlMs > 0 && Date.now() - at > ttlMs) return null
  return entry
}

/**
 * Store one engine result. Refuses anything that is not `ok` — see the header.
 *
 * Best-effort: a cache that cannot be written is not a reason to fail a run that already
 * produced its answer.
 */
export async function writeCache(
  caseDir: string,
  fingerprint: Fingerprint,
  driverVersion: string,
  result: BrowserEngineResult,
  capturedAt: string
): Promise<boolean> {
  if (result.status !== 'ok') return false
  const dir = cacheDirFor(caseDir)
  const entry: CacheEntry = {
    fingerprint,
    engine: result.id,
    driverVersion,
    capturedAt,
    // The stored copy drops the page bytes: the cache exists to avoid a second submission,
    // not to be a second archive, and the raw capture of the original run already holds
    // the HTML verbatim under `cases/<id>/raw/`.
    result: { ...result, html: '', text: '', htmlTruncated: false }
  }
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, keyFor(fingerprint, result.id, driverVersion)), JSON.stringify(entry, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

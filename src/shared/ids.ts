/**
 * Id generation.
 *
 * Two families, on purpose:
 *
 *  - **Deterministic ids** for entities and findings, derived from their content.
 *    Re-running Maigret against the same username must converge on the same entity and
 *    the same finding rather than piling up duplicates, and `rebuildIndex()` must
 *    produce byte-identical rows from the same files. Content-addressing gets both for
 *    free.
 *  - **Sortable random ids** (ULID-shaped) for things that are genuinely new events —
 *    raw captures, evidence, jobs, log entries. Lexicographic order equals chronological
 *    order, which makes `ls raw/` readable.
 *
 * No dependencies: `crypto` only.
 */

import { createHash, randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastMs = 0
let lastRandom: number[] = []

function encodeTime(ms: number): string {
  let out = ''
  let n = ms
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32] + out
    n = Math.floor(n / 32)
  }
  return out
}

function encodeRandom(bytes: number[]): string {
  let out = ''
  for (const b of bytes) out += CROCKFORD[b % 32]
  return out
}

/**
 * ULID-shaped: 10 chars of millisecond timestamp + 16 chars of randomness.
 * Monotonic within a millisecond so ids generated in a tight loop still sort correctly.
 */
export function ulid(now = Date.now()): string {
  if (now === lastMs) {
    // Increment the random part rather than re-rolling, so ordering holds.
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      const v = (lastRandom[i] ?? 0) + 1
      if (v < 32) {
        lastRandom[i] = v
        break
      }
      lastRandom[i] = 0
    }
  } else {
    lastMs = now
    lastRandom = Array.from(randomBytes(16)).map((b) => b % 32)
  }
  return encodeTime(now) + encodeRandom(lastRandom)
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Content-addressed id: a prefix plus 20 hex chars (80 bits) of sha256 over the parts.
 * Parts are joined with `\u0000` so that ('a','bc') and ('ab','c') cannot collide.
 */
function contentId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${sha256Hex(parts.join('\u0000')).slice(0, 20)}`
}

/**
 * Entity identity is `(caseId, kind, canonical value)`.
 *
 * Consequence: adding the same email twice is idempotent, and an adapter that discovers
 * an entity the operator already seeded updates that entity instead of forking a
 * near-duplicate. `seed` is *not* part of the key — the first writer's `seed` flag wins,
 * so a seeded entity stays marked as seeded even after a tool re-finds it.
 */
export function entityId(caseId: string, kind: string, canonicalValue: string): string {
  return contentId('ent', [caseId, kind, canonicalValue])
}

/**
 * Finding identity is `(caseId, entityId, tool, source, claim)`.
 *
 * `raw` is excluded deliberately: the same assertion re-observed tomorrow is the same
 * finding with a newer `lastVerified` and a newer raw capture, not a second finding.
 * Every raw capture is still kept on disk — only the *pointer* moves.
 */
export function findingId(
  caseId: string,
  entity: string,
  tool: string,
  source: string,
  claim: string
): string {
  return contentId('fnd', [caseId, entity, tool, source, claim])
}

export function rawId(now = Date.now()): string {
  return `raw_${ulid(now)}`
}

export function evidenceId(now = Date.now()): string {
  return `evd_${ulid(now)}`
}

export function jobId(now = Date.now()): string {
  return `job_${ulid(now)}`
}

export function confidenceChangeId(now = Date.now()): string {
  return `cch_${ulid(now)}`
}

/** Lowercase, ASCII-ish, hyphen-separated. Used for the human-readable part of a case id. */
export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || 'case'
}

/**
 * Case ids double as folder names, so they are readable rather than opaque:
 * `2026-08-30-self-audit-l0-01j9kq3f`.
 */
export function caseId(name: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  const suffix = ulid(now.getTime()).slice(-8).toLowerCase()
  return `${date}-${slugify(name)}-${suffix}`
}

/** Anything used as a path segment must survive Windows. */
export function isSafeIdSegment(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(id)
}

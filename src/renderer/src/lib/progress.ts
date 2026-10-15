import type { Job } from '../../../shared/types'

/**
 * Reading honest progress out of a job.
 *
 * DESIGN.md requires `probing 247 / 3000 · 11 hits · 0:42` plus the site being hit right
 * now, and forbids a bare spinner.
 *
 * `JobProgress` now carries `{ done, total, current, hits }` as real fields, so for an
 * adapter that watches its own tool's output there is nothing to recover: the numbers
 * arrive as numbers. This module's job is what remains — reconciling those fields with
 * `pct`, and falling back to the old regex reading of `note` for adapters that report
 * nothing structured.
 *
 * The fallback is kept deliberately. It is the difference between an adapter that has
 * not been taught to count showing *something* and showing nothing, and it is written so
 * that a failed parse degrades to **less** claim rather than a wrong one: no denominator
 * means no progress bar, not a bar at an invented position.
 */

export interface RunProgress {
  /** Units completed, when the adapter reported a count. */
  done: number | null
  /** Total units, when the adapter reported a denominator. */
  total: number | null
  /** 0..1, from a count pair or from `pct`. Null when genuinely unknown. */
  fraction: number | null
  /** The site / host / unit being worked on right now. */
  target: string | null
  /** Hits the tool has announced so far. Null when it does not report them. */
  hits: number | null
  /** The adapter's own words, kept verbatim when nothing structured was found. */
  note: string | null
  /** True when the numbers came from the job's own fields rather than from its prose. */
  structured: boolean
}

/** `247 / 3000`, `247/3000`, `1,204 of 3,000`. */
const COUNT = /\b(\d[\d,_]*)\s*(?:\/|of)\s*(\d[\d,_]*)\b/i

/** A hostname. Deliberately not a URL matcher: adapters report `github.com`, not a URL. */
const HOST = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi

const num = (s: string): number => Number(s.replace(/[,_]/g, ''))

const finite = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null

export function readProgress(job: Job): RunProgress {
  const p = job.progress
  const note = p.note?.trim() || null
  const pct = typeof p.pct === 'number' ? p.pct : null

  // Structured first. A `done` past a `total` is a malformed report, not a 400% run, so
  // the pair is dropped rather than rendered — the count alone still stands.
  let done = finite(p.done)
  let total = finite(p.total)
  if (done !== null && total !== null && (total === 0 || done > total)) total = null
  const hits = finite(p.hits)
  let target = typeof p.current === 'string' && p.current.trim() ? p.current.trim() : null
  const structured = done !== null || total !== null || target !== null || hits !== null

  // The old path, for an adapter that writes a sentence and nothing else.
  if (done === null && total === null && note) {
    const m = COUNT.exec(note)
    if (m) {
      const a = num(m[1] as string)
      const b = num(m[2] as string)
      if (Number.isFinite(a) && Number.isFinite(b) && b > 0 && a <= b) {
        done = a
        total = b
      }
    }
  }
  if (target === null && note) {
    const hosts = note.match(HOST)
    // The last host in the line is the one being worked on: notes read
    // "probing 247/3000 · github.com", never the other way round.
    if (hosts && hosts.length > 0) target = hosts[hosts.length - 1] ?? null
  }

  const fraction =
    done !== null && total !== null && total > 0
      ? clamp01(done / total)
      : pct !== null
        ? clamp01(pct / 100)
        : null

  return { done, total, fraction, target, hits, note, structured }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

/**
 * The progress line, in DESIGN.md's voice: what is known, in the order it matters, and
 * nothing that isn't.
 *
 *   probing 247 / 3000 · 11 hits · 0:42
 *   probing 247 sites · 11 hits · 0:42      (a tool that counts but states no total)
 *   probing 62% · 11 hits · 0:42
 *   running · 11 hits · 0:42
 *
 * `hits` is the tool's own count while it runs and the number of findings once it has
 * finished. Those are different quantities and the second is the smaller one — a hit
 * becomes several findings, or none, depending on what the parser could read — so the
 * live number is used only while it is live. Showing a count that pretends parsing has
 * already happened would be the exact dishonesty this component exists to avoid.
 */
export function progressLine(p: RunProgress, hits: number, elapsedText: string): string {
  const parts: string[] = []
  if (p.done !== null && p.total !== null) {
    parts.push(`probing ${p.done.toLocaleString('en-US')} / ${p.total.toLocaleString('en-US')}`)
  } else if (p.done !== null) {
    parts.push(`probing ${p.done.toLocaleString('en-US')} sites`)
  } else if (p.fraction !== null) {
    parts.push(`probing ${Math.round(p.fraction * 100)}%`)
  } else {
    parts.push('running')
  }
  const n = p.hits ?? hits
  parts.push(`${n.toLocaleString('en-US')} ${n === 1 ? 'hit' : 'hits'}`)
  parts.push(elapsedText)
  return parts.join(' · ')
}

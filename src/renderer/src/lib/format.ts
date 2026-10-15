/**
 * Formatting for the values the app shows literally.
 *
 * Everything here produces text that lands in a monospace cell, so the rules are the
 * ones that matter in a column: fixed field widths, no locale-dependent separators that
 * change length between renders, and no rounding that hides a difference.
 */

/** `0:42`, `12:07`, `1:03:22`. Field widths are stable within each magnitude. */
export function elapsed(fromIso: string | null, nowMs: number): string {
  if (!fromIso) return '0:00'
  const started = Date.parse(fromIso)
  if (Number.isNaN(started)) return '0:00'
  const total = Math.max(0, Math.floor((nowMs - started) / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** `2026-08-30 14:22:07`. UTC as stored — never localised, because a case file's
 *  timestamps have to match what a second tool reports about the same moment. */
export function stamp(iso: string | null): string {
  if (!iso) return 'never'
  return iso.replace('T', ' ').slice(0, 19)
}

/**
 * `2026-08-30 14:22` — the column form.
 *
 * Seconds are dropped here and only here. A dense table is a scanning surface and the
 * seconds never decide anything at a glance; the full stamp is one selection away in the
 * context panel, which is where a timestamp is ever actually compared.
 */
export function stampMinute(iso: string | null): string {
  if (!iso) return 'never'
  return iso.replace('T', ' ').slice(0, 16)
}

export function day(iso: string | null): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

/** Byte counts with a separator, because 40000000 and 4000000 are the same shape. */
export function bytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`
  return `${(n / 1_000_000).toFixed(1)} MB`
}

export function group(n: number): string {
  return n.toLocaleString('en-US')
}

/** `1 finding` / `3 findings`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${group(n)} ${n === 1 ? one : many}`
}

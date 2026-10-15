/**
 * Activity-pattern analysis: turning a pile of timestamps into a claim about where
 * somebody probably lives, deterministically and with the uncertainty attached.
 *
 * Shared by `reddit-profile` (which observes the timestamps) and `pattern-timezone`
 * (which reads them back out of raw captures that other adapters already made). The
 * arithmetic lives here so there is one implementation to test and one place where the
 * honesty rules about it are written down.
 *
 * ## The method
 *
 * Public post timestamps are almost always published in UTC. People are not awake in
 * UTC. Bin every timestamp by its UTC hour and the histogram of an ordinary human has a
 * pronounced hole in it roughly the width of a night's sleep; where that hole sits tells
 * you how far their local clock is offset from UTC.
 *
 * The estimator is deliberately blunt:
 *
 *   1. Bin into 24 hourly buckets.
 *   2. Smooth with a circular three-hour window, so one quiet hour cannot decide it.
 *   3. Find the six-hour circular window with the least activity.
 *   4. Assume the middle of that window is about 03:30 local — the middle of a night —
 *      and read the offset off that.
 *
 * ## Why it is reported the way it is
 *
 * The estimate is only meaningful when the histogram actually has a hole. If the quiet
 * window is not much quieter than the rest of the day, the shape is telling you the
 * subject posts around the clock — a bot, a scheduler, a shared account, or a person with
 * a rotating shift pattern — and the correct output is "no usable pattern", not a number
 * with a shrug attached. `quality` carries that judgement and `usable` is false when the
 * evidence does not support an estimate.
 *
 * Even a usable estimate is worth about ±2 hours, which is a band of countries, not a
 * city. It is offered as "consistent with", never as "located in".
 */

/** Below this many samples the shape of the histogram is noise. */
export const MIN_SAMPLES = 30

/** Width of the assumed sleep window, in hours. */
const SLEEP_WINDOW = 6

/** Local time assumed for the middle of that window. 03:30 is the middle of a night. */
const ASSUMED_SLEEP_CENTRE_LOCAL = 3.5

/**
 * The quiet window must hold less than this share of what an evenly spread day would put
 * in it, or the histogram has no hole worth reading.
 */
const QUIET_RATIO_THRESHOLD = 0.5

export interface ActivityAnalysis {
  samples: number
  /** Counts per UTC hour, index 0..23. */
  hourHistogram: number[]
  /** Counts per UTC weekday, index 0 = Sunday. */
  weekdayHistogram: number[]
  earliest: string | null
  latest: string | null
  /** Start hour (UTC) of the quietest six-hour window. */
  quietWindowStartUtc: number
  quietWindowShare: number
  busiestHourUtc: number
  /** Estimated UTC offset in whole hours, e.g. `+3`. Meaningless unless `usable`. */
  offsetHours: number
  usable: boolean
  /** Why the estimate is or is not usable, in one sentence. */
  quality: string
  /** Share of activity falling on Saturday/Sunday (UTC). */
  weekendShare: number
}

/**
 * Accepts ISO-8601 strings, epoch seconds and epoch milliseconds.
 *
 * Epoch values are disambiguated by magnitude: anything below 10^11 is treated as
 * seconds. That boundary sits in the year 5138 for seconds and 1973 for milliseconds, so
 * it is unambiguous for any timestamp that could describe a person's internet activity.
 */
export function toDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null
    const ms = value < 1e11 ? value * 1000 : value
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t) return null
    if (/^\d{9,14}$/.test(t)) return toDate(Number(t))
    // EXIF writes `2026:08:30 16:44:37`, which Date cannot read.
    const exif = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})(.*)$/.exec(t)
    const normalised = exif ? `${exif[1]}-${exif[2]}-${exif[3]}T${exif[4]}${(exif[5] ?? '').trim()}` : t
    const d = new Date(normalised)
    if (Number.isNaN(d.getTime())) return null
    // Reject values that are obviously not activity: a 1970 epoch artefact, or the future.
    const year = d.getUTCFullYear()
    if (year < 1995 || year > new Date().getUTCFullYear() + 1) return null
    return d
  }
  return null
}

export function analyseActivity(dates: readonly Date[]): ActivityAnalysis {
  const hourHistogram = new Array<number>(24).fill(0)
  const weekdayHistogram = new Array<number>(7).fill(0)
  let earliestMs = Infinity
  let latestMs = -Infinity

  for (const d of dates) {
    const h = d.getUTCHours()
    hourHistogram[h] = (hourHistogram[h] ?? 0) + 1
    const w = d.getUTCDay()
    weekdayHistogram[w] = (weekdayHistogram[w] ?? 0) + 1
    const ms = d.getTime()
    if (ms < earliestMs) earliestMs = ms
    if (ms > latestMs) latestMs = ms
  }

  const samples = dates.length
  const smoothed = hourHistogram.map((_, i) => {
    const a = hourHistogram[(i + 23) % 24] ?? 0
    const b = hourHistogram[i] ?? 0
    const c = hourHistogram[(i + 1) % 24] ?? 0
    return a + b + c
  })

  let quietStart = 0
  let quietSum = Infinity
  for (let start = 0; start < 24; start++) {
    let sum = 0
    for (let k = 0; k < SLEEP_WINDOW; k++) sum += smoothed[(start + k) % 24] ?? 0
    if (sum < quietSum) {
      quietSum = sum
      quietStart = start
    }
  }
  // `smoothed` triple-counts, so an evenly spread day would put 3 * samples * (6/24) in
  // the window. The ratio of what is actually there to that expectation is the depth of
  // the hole.
  const expected = 3 * samples * (SLEEP_WINDOW / 24)
  const quietWindowShare = expected > 0 ? quietSum / expected : 1

  let busiestHourUtc = 0
  for (let i = 1; i < 24; i++) {
    if ((hourHistogram[i] ?? 0) > (hourHistogram[busiestHourUtc] ?? 0)) busiestHourUtc = i
  }

  const centreUtc = (quietStart + SLEEP_WINDOW / 2) % 24
  let offsetHours = Math.round(ASSUMED_SLEEP_CENTRE_LOCAL - centreUtc)
  // Fold into the range real UTC offsets occupy.
  while (offsetHours > 12) offsetHours -= 24
  while (offsetHours < -11) offsetHours += 24

  const enoughSamples = samples >= MIN_SAMPLES
  const realHole = quietWindowShare < QUIET_RATIO_THRESHOLD
  const usable = enoughSamples && realHole

  const quality = !enoughSamples
    ? `Only ${samples} timestamps; below ${MIN_SAMPLES} the shape of the histogram is noise and no offset is claimed.`
    : realHole
      ? `The quietest six hours hold ${(quietWindowShare * 100).toFixed(0)}% of what an evenly spread day would put there, which is a real gap.`
      : `The quietest six hours still hold ${(quietWindowShare * 100).toFixed(0)}% of an even day's share — there is no sleep gap. That fits an account that posts around the clock: automation, a scheduler, a shared account, or rotating shifts.`

  const weekend = (weekdayHistogram[0] ?? 0) + (weekdayHistogram[6] ?? 0)

  return {
    samples,
    hourHistogram,
    weekdayHistogram,
    earliest: Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : null,
    latest: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    quietWindowStartUtc: quietStart,
    quietWindowShare,
    busiestHourUtc,
    offsetHours,
    usable,
    quality,
    weekendShare: samples > 0 ? weekend / samples : 0
  }
}

/** `+3` / `-5` / `0`, as a UTC offset is written. */
export function formatOffset(hours: number): string {
  if (hours === 0) return 'UTC+0'
  return `UTC${hours > 0 ? '+' : '−'}${Math.abs(hours)}`
}

export function formatHourRange(startHour: number, width = SLEEP_WINDOW): string {
  const end = (startHour + width) % 24
  const pad = (h: number): string => `${String(h).padStart(2, '0')}:00`
  return `${pad(startHour)}–${pad(end)} UTC`
}

/** A compact rendering of the histogram for a claim, e.g. `00:2 01:0 02:0 …`. */
export function renderHistogram(hist: readonly number[]): string {
  return hist.map((n, h) => `${String(h).padStart(2, '0')}:${n}`).join(' ')
}

/**
 * Keys whose values are, in every tool this app runs, an activity timestamp.
 *
 * Deliberately a whitelist. Walking a JSON tree for "anything that looks like a date"
 * picks up build dates, cache expiry headers, licence years and a site's own copyright
 * footer, and the histogram of a machine's cron schedule is not a person's sleep pattern.
 */
export const TIMESTAMP_KEYS = new Set([
  'created_utc',
  'created',
  'created_at',
  'createdat',
  'date',
  'datetime',
  'timestamp',
  'time',
  'published_at',
  'posted_at',
  'edited',
  'upload_date',
  'uploaded_at',
  'datetimeoriginal',
  'createdate',
  'mediacreatedate',
  'trackcreatedate',
  'gpsdatetime'
])

export interface HarvestedTimestamp {
  iso: string
  /** Where in the capture it came from, e.g. `comments-1.json:created_utc`. */
  path: string
}

/**
 * Walk an arbitrary JSON value and collect the values of whitelisted timestamp keys.
 *
 * Bounded on purpose: a raw capture can be tens of megabytes, and an unbounded recursive
 * walk of one is a good way to make the UI stop responding.
 */
export function harvestTimestamps(
  value: unknown,
  label: string,
  limits: { maxNodes?: number; maxDepth?: number; maxResults?: number } = {}
): HarvestedTimestamp[] {
  const maxNodes = limits.maxNodes ?? 200_000
  const maxDepth = limits.maxDepth ?? 12
  const maxResults = limits.maxResults ?? 5_000
  const out: HarvestedTimestamp[] = []
  let nodes = 0

  const walk = (node: unknown, depth: number, key: string): void => {
    if (out.length >= maxResults || nodes >= maxNodes || depth > maxDepth) return
    nodes++
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1, key)
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, depth + 1, k)
      return
    }
    if (!TIMESTAMP_KEYS.has(key.toLowerCase())) return
    const d = toDate(node)
    if (d) out.push({ iso: d.toISOString(), path: `${label}:${key}` })
  }

  walk(value, 0, '')
  return out
}

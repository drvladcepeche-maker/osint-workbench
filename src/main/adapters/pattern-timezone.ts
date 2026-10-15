/**
 * `pattern-timezone` — infer a subject's local clock from timestamps other adapters
 * already collected. No network, no tool, no new data.
 *
 * It is the app's first *correlator* rather than a collector: it reads
 * `cases/<id>/raw/*.json`, pulls out every activity timestamp that belongs to the entity
 * you point it at, and analyses the pile as one dataset. A single Reddit account gives a
 * usable-ish histogram; a Reddit account plus a GitHub account plus the EXIF timestamps
 * from a folder of photographs gives a much better one, and the whole point is that the
 * combination is stronger than any of its parts.
 *
 * The division of labour follows the contract: `run()` transcribes timestamps out of the
 * captures (copying values, deciding nothing), and `parse()` does the arithmetic. Because
 * `parse()` is pure, improving the estimator later is a re-parse of files already on
 * disk — nothing is re-fetched and nobody is probed again.
 */

import path from 'node:path'
import type { Finding } from '../../shared/types'
import { makeFinding, type Adapter, type AdapterContext, type AdapterInput, type RawResult } from './types'
import { beginEnvelope, finishEnvelope, group, parseJsonSafe, readEnvelope } from './support/envelope'
import { localSource } from './support/sources'
import { findFiles, mergedOptions, optionBoolean, optionNumber, readTextIfExists } from './support/toolkit'
import {
  analyseActivity,
  formatHourRange,
  formatOffset,
  harvestTimestamps,
  renderHistogram,
  toDate,
  MIN_SAMPLES
} from './support/activity'

const ID = 'pattern-timezone'
const VERSION = '1.0.0'

/** What `run()` transcribes and `parse()` analyses. */
interface Transcript {
  timestamps: string[]
  /** How many timestamps came from each raw capture, for the provenance line. */
  perCapture: Record<string, number>
  /** How many raw files were read, and how many were skipped and why. */
  capturesRead: number
  capturesSkipped: string[]
  scopedToEntity: boolean
}

export const patternTimezoneAdapter: Adapter = {
  id: ID,
  title: 'Activity pattern → time zone (local analysis)',
  version: VERSION,

  accepts: ['username', 'account', 'person', 'email', 'image', 'domain'],
  produces: [],

  requiresKey: false,
  requiresNetwork: false,

  concurrency: 2,
  minIntervalMs: 0,
  defaultTimeoutMs: 60_000,

  doc: {
    what: 'Collects every activity timestamp already captured for one entity, across every tool that has been run on it, and estimates the subject\'s local time zone from the shape of the resulting hour-of-day histogram.',

    how: 'It reads the raw captures in the case folder — the permanent, unparsed copies of what each tool printed — and walks them for a whitelist of timestamp fields: Reddit\'s `created_utc`, GitHub\'s `created_at` as Maigret extracts it, gallery-dl\'s `date`, ExifTool\'s `DateTimeOriginal`. Everything is normalised to UTC and binned by hour. The 24 buckets are smoothed over a three-hour circular window, the six-hour stretch with the least activity is located, and its midpoint is assumed to be about 03:30 in the subject\'s local time — which converts the position of the quiet window into a UTC offset. It also reports the weekday-versus-weekend split. Every step is counting and arithmetic; no model, no network, no new requests to anyone.',

    why: 'Sleep is the one thing nobody edits out of their public record. A profile location is a text field and a lie is free, but the hours at which somebody actually does things are a property of thousands of separate actions, published in UTC by platforms that timestamp everything. Aggregating across tools is what makes it work: any single source gives a noisy histogram, and the estimate sharpens as unrelated sources agree. It is also the clearest demonstration in the app that correlation beats collection — nothing here required a single new request, and the answer was already sitting in files the other adapters produced.',

    betterAt: 'Costing nothing and improving with everything else. It cannot be rate-limited, blocked, or detected by anyone, because it makes no requests at all; running it a hundred times is free. It is the only adapter whose answer gets better every time a *different* adapter runs, and being pure re-analysis, a better estimator applied next month re-derives a better answer from the same captures with nothing re-fetched. For a self-audit it is the exercise that lands hardest, because the subject supplied every timestamp voluntarily.',

    worseAt: 'Having anything to work with. It needs roughly thirty timestamps before the histogram means anything, and below that it refuses to state an offset rather than producing a confident number from noise. It cannot see a platform that does not publish timestamps, and it inherits every gap in what the collectors managed to fetch. It also cannot distinguish "quiet because asleep" from "quiet because the account was dormant that year", so a long-lived account with distinct eras is analysed as though it were one continuous behaviour.',

    falsePositives: 'The estimate is worth about ±2 hours — a band of countries, never a city — and the assumption underneath it is strong and often wrong: one person, in one place, sleeping at conventional hours. Shift work, insomnia, a newborn, exam season, a long trip, an account shared by two people, or anything scheduled by a bot will all move or erase the gap, and a scheduler in particular can produce a perfectly clean fake pattern. A VPN changes nothing about it, which is the point people find counter-intuitive: this is behavioural, not a network property, so the usual defence does not apply. Aggregating sources introduces its own error — if one of the accounts feeding the histogram is not actually the same person, the result is the average of two lives and belongs to neither. The estimator reports whether the quiet window is genuinely quiet, and when it is not, it says so instead of guessing.'
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

    const scopedToEntity = !optionBoolean(options, 'allEntities', false)
    const maxCaptures = optionNumber(options, 'maxCaptures', 200, { min: 1, max: 2_000 })
    const maxBytes = optionNumber(options, 'maxCaptureBytes', 16 * 1024 * 1024, { min: 1024, max: 128 * 1024 * 1024 })

    const transcript: Transcript = {
      timestamps: [],
      perCapture: {},
      capturesRead: 0,
      capturesSkipped: [],
      scopedToEntity
    }

    // Directly supplied timestamps take precedence — this is how the adapter is unit
    // tested and how an operator can analyse a list pasted from somewhere else.
    const supplied = Array.isArray(input.options['timestamps']) ? (input.options['timestamps'] as unknown[]) : []
    for (const value of supplied) {
      const d = toDate(value)
      if (d) transcript.timestamps.push(d.toISOString())
    }
    if (supplied.length) transcript.perCapture['options.timestamps'] = transcript.timestamps.length

    const rawDir = path.join(ctx.caseDir, 'raw')
    const files = await findFiles(rawDir, (name) => name.toLowerCase().endsWith('.json'), 1)
    ctx.progress({ pct: 15, note: `reading ${Math.min(files.length, maxCaptures)} raw captures` })

    for (const file of files.slice(0, maxCaptures)) {
      if (ctx.signal.aborted) break
      if (file.size > maxBytes) {
        transcript.capturesSkipped.push(`${file.name} (${group(file.size)} bytes, over the ${group(maxBytes)}-byte limit)`)
        continue
      }
      const text = await readTextIfExists(file.path)
      if (text === null) {
        transcript.capturesSkipped.push(`${file.name} (unreadable)`)
        continue
      }
      const doc = parseJsonSafe<Record<string, unknown>>(text)
      if (!doc) {
        transcript.capturesSkipped.push(`${file.name} (not JSON)`)
        continue
      }
      // Only captures about this entity, unless explicitly told otherwise. Mixing two
      // people's timestamps produces a histogram belonging to neither.
      if (scopedToEntity && typeof doc['entityId'] === 'string' && doc['entityId'] !== input.entity.id) continue
      transcript.capturesRead++

      const producer = typeof doc['adapter'] === 'string' ? (doc['adapter'] as string) : file.name
      const before = transcript.timestamps.length

      // 1. Timestamps an adapter transcribed for us explicitly.
      const activity = doc['activity'] as { timestamps?: unknown } | undefined
      if (activity && Array.isArray(activity.timestamps)) {
        for (const value of activity.timestamps) {
          const d = toDate(value)
          if (d) transcript.timestamps.push(d.toISOString())
        }
      }
      // 2. Adapters whose whole output is on stdout (subfinder, exiftool, gallery-dl,
      //    wayback) keep it there rather than in `artifacts`.
      const stdout = typeof doc['stdout'] === 'string' ? parseJsonSafe<unknown>(doc['stdout'] as string) : null
      if (stdout) {
        for (const harvested of harvestTimestamps(stdout, producer)) transcript.timestamps.push(harvested.iso)
      }
      // 3. Artifact bodies are *strings* holding a tool's own JSON, so each has to be
      //    parsed before it can be walked. This is where Reddit's created_utc lives.
      const artifacts = doc['artifacts']
      if (artifacts && typeof artifacts === 'object') {
        for (const [name, body] of Object.entries(artifacts as Record<string, unknown>)) {
          if (typeof body !== 'string') continue
          const nested = parseJsonSafe<unknown>(body)
          if (!nested) continue
          for (const harvested of harvestTimestamps(nested, `${producer}/${name}`)) {
            transcript.timestamps.push(harvested.iso)
          }
        }
      }

      const gained = transcript.timestamps.length - before
      if (gained > 0) transcript.perCapture[`${producer} (${file.name})`] = gained
    }

    // Duplicates are real here: the same Reddit comment appears in two overlapping pages,
    // and counting it twice would deepen a gap that is not there.
    transcript.timestamps = [...new Set(transcript.timestamps)].sort()

    env.artifacts['timestamps.json'] = JSON.stringify(transcript, null, 2)
    env.notes.push(
      `Read ${transcript.capturesRead} raw capture(s) from ${rawDir}${scopedToEntity ? ' scoped to this entity' : ' across every entity in the case'}.`
    )
    for (const skipped of transcript.capturesSkipped.slice(0, 20)) env.notes.push(`Skipped ${skipped}`)

    return finishEnvelope(env, { caseId: input.caseId, ok: true, finishedAt: ctx.now(), startedMs })
  },

  parse(raw: RawResult): Finding[] {
    const env = readEnvelope(raw)
    if (!env) return []
    const transcript = parseJsonSafe<Transcript>(env.artifacts['timestamps.json'] ?? null)
    if (!transcript || !Array.isArray(transcript.timestamps)) return []

    const dates = transcript.timestamps.map((t) => toDate(t)).filter((d): d is Date => d !== null)
    if (!dates.length) {
      return [
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `No activity timestamps were found for ${env.target} in ${group(transcript.capturesRead)} raw capture(s). ` +
            'Run a collector that records them first — reddit-profile, gallery-dl or exiftool — then run this again; it re-reads the case folder and costs no requests.'
        })
      ]
    }

    const analysis = analyseActivity(dates)
    const provenance = Object.entries(transcript.perCapture)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, n]) => `${name}: ${group(n)}`)
      .join('; ')

    const findings: Finding[] = [
      makeFinding(raw, {
        source: localSource(ID),
        claim:
          `Aggregated ${group(analysis.samples)} distinct activity timestamps for ${env.target} from ${group(transcript.capturesRead)} existing capture(s), spanning ${(analysis.earliest ?? '').slice(0, 10)} to ${(analysis.latest ?? '').slice(0, 10)}. ` +
          `Sources: ${provenance || 'none recorded'}. Activity by UTC hour: ${renderHistogram(analysis.hourHistogram)}. No requests were made to anyone to produce this.`
      })
    ]

    if (analysis.usable) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `The quietest six hours of ${env.target}'s recorded activity are ${formatHourRange(analysis.quietWindowStartUtc)}, and the busiest single hour is ${String(analysis.busiestHourUtc).padStart(2, '0')}:00 UTC. ` +
            `Reading the gap as a night's sleep centred near 03:30 local puts the subject at approximately ${formatOffset(analysis.offsetHours)}. ` +
            `${analysis.quality} The estimate is worth about ±2 hours — a band of countries, not a city — and it assumes one person, in one place, keeping conventional hours. A VPN does not affect it, because the signal is behavioural rather than a network property.`
        })
      )
    } else {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `No time zone is claimed for ${env.target}. ${analysis.quality}` +
            (analysis.samples < MIN_SAMPLES
              ? ' Collect more activity before running this again; the histogram is currently noise.'
              : '')
        })
      )
    }

    if (analysis.samples >= MIN_SAMPLES) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `${(analysis.weekendShare * 100).toFixed(0)}% of ${env.target}'s recorded activity falls on a Saturday or Sunday in UTC, against 29% for an evenly spread week. ` +
            'A weekday-heavy split is consistent with an account used from a desk during working hours; a weekend-heavy one with a hobby account. Both are weak signals on their own.'
        })
      )
    }

    return findings
  }
}

/**
 * Did the tool actually get an answer?
 *
 * This module exists because of the single most dangerous failure mode a self-audit has:
 * **a refusal rendered as an absence.** holehe is rate-limited into uselessness from an
 * ordinary home connection — Phase 0 measured 121 of 121 modules returning `rateLimit=True`
 * in 1.25 seconds — and Reddit answers HTTP 403 to anything unauthenticated. Both produce
 * a run that finishes cleanly, exits zero, and yields no accounts. Reported as "nothing
 * found", that is a lie that reassures, and reassurance is the one output a self-audit
 * must never manufacture.
 *
 * ## How it knows
 *
 * By **re-deriving from the permanent raw capture**, exactly the way a fixed parser would.
 * `parse()` is pure and the envelope is kept forever precisely so a second reader can come
 * along later and ask a different question of the same bytes. Nothing here re-runs
 * anything, nothing here reads a claim string, and nothing here infers a number the tool
 * did not print.
 *
 * Four readers, in decreasing specificity:
 *
 *  1. **holehe** — its own CSV, one row per site, with `rateLimit` and `exists` columns.
 *     This gives a real numerator and denominator: "2 of 122 sites answered".
 *  2. **sherlock** — its own CSV, whose `exists` column is `Claimed`, `Available`, or
 *     something else. That third bucket is the site that errored or timed out, and it is
 *     the whole reason this reader exists: Sherlock prints its per-site failures on
 *     **stdout**, so a run where half the site list errored looked spotless from stderr.
 *  3. **reddit-profile** — its `_http.json` artifact, which records the status code of
 *     every endpoint it touched. A 403 there is a refusal aimed at us and says nothing
 *     about the account.
 *  4. **Everything else** — the envelope's exit code, spawn error, timeout flag, stderr
 *     and the tool's own `local:` run note, matched against the phrases these tools use
 *     when they are being blocked. No counts are invented: an adapter that did not count
 *     reports `coverage: null` and the UI shows the words rather than a fraction.
 *
 * The bias is deliberate and one-directional: **when in doubt, say we could not check.**
 * An over-cautious "unchecked" costs the operator a re-run. An over-confident "clear"
 * costs him the belief that he looked. The sharpest case is an envelope that cannot be
 * read at all — missing, corrupt, never located. That is maximal doubt and it classifies
 * as `no-answer`; it used to fall through to `answered-none`, which is not silent, so a
 * run nobody could read counted as ground that had been covered.
 */

import { parseCsv, pyBool } from '../adapters/support/csv'
import type { CheckCoverage, CheckOutcome } from '../../shared/selfaudit'

/** The envelope, as far as this module cares about it. */
interface LooseEnvelope {
  adapter?: string
  adapterId?: string
  target?: string
  exitCode?: number | null
  spawnError?: string | null
  timedOut?: boolean
  truncated?: boolean
  stdout?: string
  stderr?: string
  error?: string | null
  artifacts?: Record<string, string>
  notes?: string[]
}

/**
 * Phrases these tools emit when a site refuses rather than answers.
 *
 * Matched against stderr and collection notes only — never against a claim, and never
 * against the artifact body, where the word "blocked" is as likely to be a subreddit name
 * as a diagnosis.
 */
const REFUSAL_MARKERS: { re: RegExp; says: string }[] = [
  { re: /\b429\b|too many requests|rate.?limit/i, says: 'rate limited' },
  { re: /\b403\b|forbidden/i, says: 'answered 403' },
  { re: /cloudflare|bot protection|captcha|are you a robot/i, says: 'met a bot wall' },
  { re: /too many errors of type/i, says: 'gave up after repeated errors' },
  { re: /connection reset|econnreset|etimedout|socket hang up/i, says: 'lost the connection' },
  { re: /\b5\d\d\b\s|internal server error|bad gateway|service unavailable/i, says: 'got a server error' }
]

export interface CoverageReading {
  outcome: CheckOutcome
  detail: string
  coverage: CheckCoverage | null
}

/**
 * Parse whatever `cases/<id>/raw/<rawId>.json` holds.
 *
 * Two shapes reach disk. A successful run with a JSON media type writes the envelope
 * verbatim; everything else is wrapped by the orchestrator in a record that carries the
 * envelope JSON along inside `stdout`. Both are handled, because the failure shape is the
 * one this module most needs to read.
 */
export function readRawEnvelope(text: string | null): LooseEnvelope | null {
  if (!text || !text.trim()) return null
  let outer: unknown
  try {
    outer = JSON.parse(text)
  } catch {
    return null
  }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return null
  const env = outer as LooseEnvelope
  if (typeof env.adapter === 'string') return env

  // The orchestrator's failure wrapper. The envelope, if there was one, is a JSON string
  // in `stdout`; if there was not, the wrapper itself carries everything worth reading.
  if (typeof env.stdout === 'string' && env.stdout.trim().startsWith('{')) {
    try {
      const inner = JSON.parse(env.stdout) as LooseEnvelope
      if (typeof inner.adapter === 'string') {
        return { ...inner, error: env.error ?? inner.error ?? null, timedOut: env.timedOut ?? inner.timedOut }
      }
    } catch {
      /* fall through to the wrapper */
    }
  }
  return env
}

function refusalIn(text: string): string | null {
  for (const m of REFUSAL_MARKERS) if (m.re.test(text)) return m.says
  return null
}

/** holehe's own tally, re-derived from the CSV it wrote. */
function holeheCoverage(env: LooseEnvelope): CoverageReading | null {
  const artifacts = env.artifacts ?? {}
  const csvName = Object.keys(artifacts).find((n) => n.toLowerCase().endsWith('.csv'))
  if (!csvName) return null
  const table = parseCsv(artifacts[csvName] ?? null)
  if (!table.rows.length) return null

  let registered = 0
  let notRegistered = 0
  let refused = 0
  for (const row of table.rows) {
    // Order matters, and it is the same order the adapter's own parser uses: a
    // rate-limited row very often *also* carries `exists=False`, and reading that False
    // as a negative result is the classic way to misreport this tool.
    if (pyBool(row['rateLimit']) === true) {
      refused++
      continue
    }
    const exists = pyBool(row['exists'])
    if (exists === true) registered++
    else if (exists === false) notRegistered++
    else refused++
  }

  const total = table.rows.length
  const answered = registered + notRegistered
  const coverage: CheckCoverage = { answered, refused, total }

  if (answered === 0) {
    return {
      outcome: 'no-answer',
      detail: `All ${total} sites refused to answer. This run carries no signal about where the address is registered — it is not evidence that the address is unused.`,
      coverage
    }
  }
  // The Phase 0 shape: two or three modules answer and a hundred and twenty do not, and
  // every one of the few that answered said no. Counted as "answered — nothing there"
  // that reads as reassurance, which is the exact failure this module exists to stop. The
  // 0.8 threshold is the adapter's own, so the two agree about when a run is worthless.
  if (registered === 0 && refused / total > 0.8) {
    return {
      outcome: 'no-answer',
      detail:
        `Only ${answered} of ${total} sites answered, and ${refused} refused. The few that answered said no. ` +
        `A run with this little coverage says essentially nothing about where the address is registered — repeat it from a different network before believing any of it.`,
      coverage
    }
  }
  if (refused / total > 0.5) {
    return {
      outcome: 'partial',
      detail:
        `Only ${answered} of ${total} sites answered; ${refused} refused. ` +
        `${registered} of the ${answered} say an account exists. The ${refused} that refused are unchecked, not clear.`,
      coverage
    }
  }
  if (registered === 0) {
    return {
      outcome: 'answered-none',
      detail: `${answered} of ${total} sites answered and none of them has an account for this address. ${refused} refused and remain unchecked.`,
      coverage
    }
  }
  return {
    outcome: 'answered',
    detail: `${answered} of ${total} sites answered; ${registered} say an account exists.${refused ? ` ${refused} refused and remain unchecked.` : ''}`,
    coverage
  }
}

/**
 * Sherlock's own tally, re-derived from the CSV it wrote.
 *
 * Sherlock writes one row per site with `exists` set to `Claimed`, `Available`, or
 * something else — and that third bucket is the interesting one, because it is the site
 * that errored, timed out or answered in a shape the tool could not read. Its per-site
 * failures go to **stdout**, not stderr, so the generic refusal reader never saw them, and
 * its own count of them landed in a `local:` claim `readCoverage` did not read. A run
 * where half the site list errored classified as "answered — nothing there".
 */
function sherlockCoverage(env: LooseEnvelope): CoverageReading | null {
  const artifacts = env.artifacts ?? {}
  const csvName = Object.keys(artifacts).find((n) => n.toLowerCase().endsWith('.csv'))
  const table = csvName ? parseCsv(artifacts[csvName] ?? null) : null
  if (!table || !table.rows.length) {
    // Sherlock writes one row per site in its list — 415 of them on this machine — so no
    // CSV, or an empty one, is not "it asked and every site said no". It is a run whose
    // results never reached disk, and the only honest reading of that is that nothing was
    // checked. The generic fallback used to land this on `answered-none`.
    return {
      outcome: 'no-answer',
      detail:
        'Sherlock wrote no result rows for this run, so there is no record of which sites it reached. ' +
        'The stdout transcript is in the raw capture; nothing about the handle follows from this run.',
      coverage: null
    }
  }

  let claimed = 0
  let available = 0
  let unresolved = 0
  for (const row of table.rows) {
    const exists = (row['exists'] ?? '').trim().toLowerCase()
    if (exists === 'claimed') claimed++
    else if (exists === 'available') available++
    else unresolved++
  }

  const total = table.rows.length
  const answered = claimed + available
  // `WAF`, `Illegal` and `Unknown` are the third bucket in a real capture: a bot wall, a
  // site the tool refused to probe, and a response it could not read. On a real run from
  // this machine that is 35 of 415 — invisible from stderr, and the reason this reader
  // exists rather than the generic one.
  const coverage: CheckCoverage = { answered, refused: unresolved, total }

  if (answered === 0) {
    return {
      outcome: 'no-answer',
      detail: `None of the ${total} sites returned a readable verdict. This run says nothing about where the handle is taken.`,
      coverage
    }
  }
  if (unresolved / total > 0.5) {
    return {
      outcome: 'partial',
      detail:
        `Only ${answered} of ${total} sites returned a verdict; ${unresolved} errored, timed out or answered in a shape the tool could not read. ` +
        `${claimed} of the ${answered} say the handle is taken. The ${unresolved} are unchecked, not clear.`,
      coverage
    }
  }
  if (claimed === 0) {
    return {
      outcome: 'answered-none',
      detail: `${answered} of ${total} sites answered and none of them has an account with this handle.${unresolved ? ` ${unresolved} gave no verdict and remain unchecked.` : ''}`,
      coverage
    }
  }
  return {
    outcome: 'answered',
    detail: `${answered} of ${total} sites answered; ${claimed} say the handle is taken.${unresolved ? ` ${unresolved} gave no verdict and remain unchecked.` : ''}`,
    coverage
  }
}

/** reddit-profile records the status code of every endpoint it touched. */
function redditCoverage(env: LooseEnvelope): CoverageReading | null {
  const raw = (env.artifacts ?? {})['_http.json']
  if (!raw) return null
  let statuses: Record<string, number>
  try {
    statuses = JSON.parse(raw) as Record<string, number>
  } catch {
    return null
  }
  const entries = Object.entries(statuses)
  if (!entries.length) return null

  const ok = entries.filter(([, s]) => s === 200).length
  const forbidden = entries.filter(([, s]) => s === 403).length
  const missing = entries.filter(([, s]) => s === 404).length
  const coverage: CheckCoverage = { answered: ok + missing, refused: entries.length - ok - missing, total: entries.length }

  if (forbidden > 0 && ok === 0) {
    return {
      outcome: 'no-answer',
      detail:
        'Reddit answered HTTP 403 and served its "blocked by network security" page instead of JSON. ' +
        'The block is aimed at unauthenticated clients generally, not at this account — nothing about the account follows from it.',
      coverage
    }
  }
  if (ok === 0 && missing > 0) {
    return {
      outcome: 'answered-none',
      detail: 'Reddit answered 404: there is no account with this handle, or it has been deleted.',
      coverage
    }
  }
  if (forbidden > 0) {
    return {
      outcome: 'partial',
      detail: `${ok} of ${entries.length} Reddit endpoints answered; ${forbidden} returned 403. The listings behind those are unread.`,
      coverage
    }
  }
  return {
    outcome: 'answered',
    detail: `All ${entries.length} Reddit endpoints answered.`,
    coverage
  }
}

/**
 * Classify one completed run.
 *
 * `claims` is the number of findings this run produced that assert something about the
 * *subject* — the `local:<adapter>` run notes are excluded by the caller, because a tool
 * that produced nothing but its own summary found nothing, however many rows that is.
 */
export function readCoverage(input: {
  adapterId: string
  rawText: string | null
  jobState: string
  jobError: string | null
  claims: number
  /**
   * The tool's own `local:` run notes for this job, concatenated.
   *
   * A third input beside the envelope and the job state, because several adapters count
   * what they could not resolve and say so *only* here. Read for refusal phrases exactly
   * as stderr is — never for anything else, and never as a substitute for a real fraction.
   */
  telemetry?: string
}): CoverageReading {
  const env = readRawEnvelope(input.rawText)

  if (input.jobState === 'cancelled') {
    return { outcome: 'skipped', detail: 'Cancelled before it finished. Nothing was concluded.', coverage: null }
  }
  if (input.jobState === 'timeout') {
    return {
      outcome: 'failed',
      detail: `Hit its deadline and was killed. Whatever it had probed by then is on disk; the rest was never asked.${input.jobError ? ` ${firstLine(input.jobError)}` : ''}`,
      coverage: null
    }
  }
  if (env?.spawnError) {
    return {
      outcome: 'unavailable',
      detail: `The tool did not start: ${firstLine(env.spawnError)}. Nothing was checked.`,
      coverage: null
    }
  }
  if (input.jobState === 'failed') {
    return {
      outcome: 'failed',
      detail: `The run failed: ${firstLine(input.jobError ?? env?.error ?? 'no reason recorded')}. Nothing here is evidence of absence.`,
      coverage: null
    }
  }

  if (env) {
    const specific =
      input.adapterId === 'holehe'
        ? holeheCoverage(env)
        : input.adapterId === 'reddit-profile'
          ? redditCoverage(env)
          : input.adapterId === 'sherlock'
            ? sherlockCoverage(env)
            : null
    if (specific) return specific
  }

  /* No readable envelope at all.
   *
   * The capture is missing, unparseable, or was never located. That is not a tool that
   * asked and heard nothing — it is a run this module cannot read, which is **maximal
   * doubt**, and the stated bias of this file is that doubt says "could not check". The
   * old fallback ended here at `answered-none`, which is not `isSilent`, so a run nobody
   * could read counted as covered ground and was excluded from `report.unchecked`. */
  if (!env) {
    return input.claims > 0
      ? {
          outcome: 'partial',
          detail:
            `It produced ${input.claims} result${input.claims === 1 ? '' : 's'}, but no readable capture survives for the run. ` +
            'Whatever it could not reach cannot be recovered from the bytes, so the rest of its ground is unchecked, not clear.',
          coverage: null
        }
      : {
          outcome: 'no-answer',
          detail:
            'No readable capture survives for this run: the envelope is missing, unparseable, or was never located. ' +
            'Without it there is no way to tell an answer from a refusal, so this counts as unchecked rather than as clear.',
          coverage: null
        }
  }

  // Generic path. The tool did not count its own targets, so no fraction is invented —
  // the stderr, the collection notes and the tool's own run note are read for the phrases
  // these tools use when they are being refused rather than answered.
  const noise = [env.stderr ?? '', (env.notes ?? []).join('\n'), input.telemetry ?? ''].join('\n')
  const refusal = refusalIn(noise)

  if (input.claims > 0) {
    return refusal
      ? {
          outcome: 'partial',
          detail: `It returned results, but its own error output says it ${refusal} somewhere along the way. Sites it never reached are unchecked, not clear.`,
          coverage: null
        }
      : { outcome: 'answered', detail: 'Ran to completion and reported results.', coverage: null }
  }

  if (refusal) {
    return {
      outcome: 'no-answer',
      detail: `It produced no results and its error output says it ${refusal}. That is a refusal, not an absence — nothing follows from it.`,
      coverage: null
    }
  }

  if (env.truncated) {
    return {
      outcome: 'partial',
      detail: 'Its output hit the capture cap and was cut. What survived is on disk; what was cut was never read.',
      coverage: null
    }
  }

  return {
    outcome: 'answered-none',
    detail: 'Ran to completion, reported no error, and found nothing. Read the run note beside it for what it actually covered.',
    coverage: null
  }
}

function firstLine(s: string): string {
  const line = s.split('\n')[0]?.trim() ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

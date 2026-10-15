/**
 * `sherlock` — username -> accounts, fast and plain.
 *
 * The reference implementation of the username-sweep idea and the best-behaved tool in
 * the Phase 0 set: predictable exit codes, no banner crash, no self-updating database.
 *
 * **The trap that catches everyone: `--json` is an INPUT flag.** `--json JSON_FILE` loads
 * a site database. Sherlock has no JSON output at all. The structured formats are `--csv`
 * and `--xlsx`, and the CSV is written into the *current working directory* as
 * `<username>.csv` — there is no output-path flag for it. Hence the per-run scratch
 * directory.
 */

import type { Finding } from '../../shared/types'
import {
  makeFinding,
  type Adapter,
  type AdapterContext,
  type AdapterInput,
  type EntityProposal,
  type RawResult
} from './types'
import {
  beginEnvelope,
  finishEnvelope,
  group,
  readEnvelope,
  recordSpawn,
  stderrSummary,
  type RunEnvelope
} from './support/envelope'
import { parseCsv } from './support/csv'
import {
  isWeakProbe,
  loadWmnSites,
  matcherFor,
  readWmnTranscript,
  transcribeWmnIndex,
  WMN_ARTIFACT
} from './support/matcher'
import { createScanner } from './support/progress'
import { localSource, siteOrigin } from './support/sources'
import {
  checkBinary,
  findFiles,
  makeWorkdir,
  mergedOptions,
  optionBoolean,
  optionList,
  optionNumber,
  osintEnv,
  readTextIfExists,
  removeWorkdir,
  resolveBinary,
  subjectValue
} from './support/toolkit'

const ID = 'sherlock'
const VERSION = '1.0.0'
const BIN_CANDIDATES = ['venv/Scripts/sherlock.exe', 'venv/bin/sherlock'] as const

export const sherlockAdapter: Adapter = {
  id: ID,
  title: 'Sherlock (username → accounts)',
  version: VERSION,

  accepts: ['username'],
  produces: ['account'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 3_000,
  defaultTimeoutMs: 300_000,

  doc: {
    what: 'Takes one username and reports which of several hundred sites already have an account under that handle.',

    how: 'It holds a JSON database of sites, each with a profile-URL template and a rule for reading the answer. Three rule types cover almost everything: `status_code`, where a 404 means the handle is free and a 200 means it is taken; `message`, where the page is fetched and searched for a string that only appears on an error page; and `response_url`, where being redirected somewhere else means the profile does not exist. Requests go out concurrently over a shared session with a browser-like user agent, and each site is decided purely on its own response — there is no login, no API key, and no interaction with the site beyond loading the page a visitor would load.',

    why: 'A site cannot avoid telling you whether a username is taken. Registration would be impossible if it could — the signup form has to reject a name already in use, and the profile URL has to distinguish an existing user from a missing one. That necessary leak is the entire mechanism. It matters because handle reuse is the most common linking primitive in OSINT: one person picks one name and carries it across services that share no data, so enumerating the handle enumerates the person\'s footprint.',

    betterAt: 'Being trustworthy about *how it ran*. It is the fastest of the three username tools, it is the only one with clean exit-code semantics (0 with hits, 0 with no hits, 1 with a message when you name a site that does not exist), it does not fetch a new database at startup, and its site list is the most conservatively curated — sites that became unreliable are marked as exclusions rather than left in to generate noise. Constrain it with repeated `--site` and it is the right tool for "is this handle taken on these five platforms", answered in seconds. It is also the sensible first pass before spending five minutes on Maigret.',

    worseAt: 'Everything after the yes. It returns a URL and an HTTP status and nothing else — no display name, no account age, no follower count, no avatar, and no recursion into other handles it might have seen. Its database is smaller than Blackbird\'s and less actively grown than Maigret\'s. It has no output format richer than CSV, and its `--json` flag is not an output flag at all, which has cost more than one person an afternoon.',

    falsePositives: 'The same known, tracked, unsolved problem the whole family has. A site that sits behind Cloudflare answers the challenge page with HTTP 200 and a `status_code` rule reads it as "account exists"; a site that serves a styled "user not found" page with a 200 instead of a 404 does the same; a site with a catch-all route claims every handle. The project manages this by excluding sites that misbehave rather than by solving it, which means the failure mode is a hit on a site that broke since the last database update. In the other direction, a site that rate-limits mid-run can report a real account as not found. And note that a Sherlock hit and a Maigret hit on the same site are one site answering twice, not two independent confirmations — this adapter emits the site\'s own domain as the finding\'s source precisely so the confidence rules can see that and refuse to corroborate.'
  },

  check(ctx) {
    return checkBinary(
      ctx.config,
      ctx.toolkitRoot,
      ID,
      BIN_CANDIDATES,
      'Install it into the toolkit venv: <toolkitRoot>\\venv\\Scripts\\pip.exe install sherlock-project'
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const target = subjectValue(input.entity)
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })

    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN_CANDIDATES)
    // The CSV lands in the process's cwd under a name Sherlock chooses, so the cwd has to
    // be somewhere private and empty.
    const workdir = await makeWorkdir(ctx.caseDir, ID)

    try {
      // Read here, interpreted in `parse()`. Sherlock's own database descends from the
      // WhatsMyName catalogue, so the same entry that decides what Blackbird requests is
      // the one that explains what a Sherlock hit could mean. See `support/matcher.ts`.
      const wmn = loadWmnSites(ctx.toolkitRoot)
      if (wmn.sites.length) {
        env.artifacts[WMN_ARTIFACT] = transcribeWmnIndex(wmn)
        env.notes.push(`Transcribed ${wmn.sites.length} WhatsMyName site definitions from ${wmn.sourcePath}.`)
      } else {
        env.notes.push(
          `No WhatsMyName dataset was found under ${ctx.toolkitRoot}, so hits from this run carry no matcher classification.`
        )
      }

      const args: string[] = [
        target,
        '--csv',
        // Suppress the plain-text report; the CSV is the machine-readable one and two
        // files in the scratch directory would only make the glob ambiguous.
        '--no-txt',
        '--no-color',
        '--timeout',
        String(optionNumber(options, 'siteTimeoutSeconds', 15, { min: 3, max: 120 })),
        // Prints the misses too. It does not change the CSV, but it makes the stdout in
        // the raw capture a full record of what was actually checked.
        '--print-all'
      ]
      for (const site of optionList(options, 'sites', [])) args.push('--site', site)
      if (optionBoolean(options, 'nsfw', false)) args.push('--nsfw')
      if (optionBoolean(options, 'local', false)) args.push('--local')
      if (optionBoolean(options, 'ignoreExclusions', false)) args.push('--ignore-exclusions')

      // `--print-all` is above for the raw capture's sake, and it doubles as the only
      // progress signal Sherlock has: one line per site, `[+]` for a hit and `[-]` for a
      // miss. There is no denominator — Sherlock never states how many sites it holds —
      // so `done` is reported without a `total`, and the job row shows a count with an
      // indeterminate bar rather than a percentage of a number nobody printed.
      let done = 0
      let hits = 0
      let current = ''
      const scan = createScanner({
        onUnit: (label, hit) => {
          done++
          if (hit) hits++
          current = label
          // The opening note is cleared the moment there is a real count: leaving it
          // there would put a sentence under the numbers that says less than they do.
          ctx.progress({ done, hits, current, note: '' })
        }
      })

      ctx.progress({ note: `probing sites for "${target}"`, done: 0, hits: 0 })

      const res = await ctx.spawn(bin.file, {
        args,
        cwd: workdir,
        env: osintEnv(ctx.toolkitRoot),
        timeoutMs: ctx.timeoutMs,
        onStdout: scan
      })
      recordSpawn(env, { file: bin.file, args }, res)

      ctx.progress({ note: 'collecting CSV', current: '' })

      const csvs = await findFiles(workdir, (name) => name.toLowerCase().endsWith('.csv'))
      for (const file of csvs.slice(0, 4)) {
        const body = await readTextIfExists(file.path)
        if (body !== null) env.artifacts[file.name] = body
      }
      if (!csvs.length) env.notes.push(`No .csv appeared in the scratch directory ${workdir}.`)

      // A run with zero hits still writes a header-only CSV, so "no CSV at all" genuinely
      // means the tool did not get as far as producing results. Sherlock's stdout is a
      // usable fallback in that case, which is why it is always captured.
      const haveCsv = csvs.length > 0
      const haveStdout = /Search completed with/i.test(res.stdout)
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: haveCsv || haveStdout,
        error: res.spawnError
          ? `sherlock did not run: ${res.spawnError}`
          : `sherlock exited ${res.exitCode} without producing results. ${stderrSummary(env)}`,
        finishedAt: ctx.now(),
        startedMs
      })
    } finally {
      await removeWorkdir(workdir)
    }
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * Each claimed row as a candidate account.
   *
   * Sherlock returns a URL and a status and nothing else, so a proposal here is exactly
   * as strong as the hit behind it: "this site served a page for this handle". The site
   * origin is folded the same way `Finding.source` is, so a Sherlock proposal and a
   * Maigret proposal about the same site land on one candidate with two proposals — which
   * is the review queue telling the truth, since those two are one site answering twice
   * rather than two independent confirmations.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const csvName = Object.keys(env.artifacts).find((n) => n.toLowerCase().endsWith('.csv'))
  const table = parseCsv(csvName ? env.artifacts[csvName] : null)
  // Recovered from the capture, not from disk: `parse()` is pure.
  const wmn = readWmnTranscript(env.artifacts[WMN_ARTIFACT])

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  let claimed = 0
  let available = 0
  let other = 0

  for (const row of table.rows) {
    const exists = (row['exists'] ?? '').trim().toLowerCase()
    if (exists === 'available') {
      available++
      continue
    }
    if (exists !== 'claimed') {
      other++
      continue
    }
    claimed++
    const url = row['url_user'] || row['url_main'] || ''
    const site = row['name'] || url || 'unknown site'
    const source = siteOrigin(url || site) || site.toLowerCase()
    /* The status code and the response time are measurements of *this run*, and a claim is
     * an identity. `findingId` is content-addressed over `(caseId, entityId, tool, source,
     * claim)`, so "Answered in 0.77 s." inside the claim gave the same assertion a
     * different id on every single re-run: a new row instead of a refreshed one, a
     * `lastVerified` that never moved off null, and a claim count that grew roughly
     * linearly with the number of times the level had been run — which the operator reads
     * as the seed's effect. The rule is general and holds for every adapter in this
     * directory: **nothing that varies from run to run may appear in a claim.**
     *
     * They are not lost. `matcher` is deliberately excluded from the id and is refreshed
     * in place on every re-observation (`caseStore.upsertFinding`), so the newest run's
     * measurement is the one on screen, and every run's is in its own permanent capture. */
    const matcher = matcherFor(wmn, { site: row['name'] ?? '', url })
    const observed = [
      row['http_status'] ? `HTTP ${row['http_status']}` : '',
      row['response_time_s'] ? `answered in ${formatSeconds(row['response_time_s'])}` : ''
    ].filter(Boolean)
    const withRun =
      matcher && observed.length
        ? { ...matcher, reasons: [...matcher.reasons, `On the most recent run this site ${observed.join(', ')}.`] }
        : matcher
    const weakness = isWeakProbe(matcher) ? ` ${matcher?.why}` : ''
    const hit = makeFinding(raw, {
      source,
      matcher: withRun,
      // A handle being taken on a site is the whole of what Sherlock can establish. It is
      // a real and useful fact; it is not a fact about who registered it.
      // See maigret.ts: a URL ends the claim and nothing follows it, so nothing can be
      // selected along with it.
      claim:
        `Sherlock reports that an account named "${env.target}" exists on ${site}.` +
        ` Who holds that account is a separate question this probe does not answer.${weakness}` +
        (url ? ` Profile: ${url}` : ' Sherlock reported no URL for it.')
    })
    findings.push(hit)

    const handle = (row['username'] || env.target || '').trim()
    if (source && handle) {
      proposals.push({
        fromFindingId: hit.id,
        kind: 'account',
        value: `${source}/${handle}`,
        label: `${handle} on ${site}`,
        attrs: { platform: source, handle, ...(url ? { url } : {}) },
        rationale: `${site} answered ${row['http_status'] || 'a request'} for this handle's profile URL. Open it before believing it.`
      })
    }
  }

  findings.push(summaryFinding(raw, env, { claimed, available, other, rowCount: table.rows.length }))
  return { findings, proposals }
}

function formatSeconds(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return `${n.toFixed(2)} s`
}

function summaryFinding(
  raw: RawResult,
  env: RunEnvelope,
  counts: { claimed: number; available: number; other: number; rowCount: number }
): Finding {
  // Sherlock prints its own tally. Comparing it with the CSV row count is a free
  // cross-check on the parser: if they disagree, the CSV was truncated or the format
  // moved, and the operator should be told rather than shown a confident wrong number.
  const reported = /Search completed with (\d+) results?/i.exec(env.stdout)
  const reportedN = reported ? Number(reported[1]) : null
  const mismatch =
    reportedN !== null && reportedN !== counts.claimed
      ? ` Sherlock's own tally says ${group(reportedN)}; the CSV yielded ${group(counts.claimed)}, so this capture is incomplete.`
      : ''
  const unresolved = counts.other
    ? ` ${group(counts.other)} site${counts.other === 1 ? '' : 's'} returned neither Claimed nor Available and must be read as "not checked".`
    : ''
  const empty =
    counts.rowCount === 0
      ? ' Sherlock wrote no CSV rows for this run; the stdout transcript in the raw capture is the only record of what was probed.'
      : ''

  return makeFinding(raw, {
    source: localSource(ID),
    claim:
      `Sherlock probed ${group(counts.rowCount)} sites for the username "${env.target}" in ${(env.durationMs / 1000).toFixed(1)} s: ` +
      `${group(counts.claimed)} claimed, ${group(counts.available)} available.${unresolved}${mismatch}${empty}`
  })
}

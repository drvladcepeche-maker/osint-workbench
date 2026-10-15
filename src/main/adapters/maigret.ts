/**
 * `maigret` — username -> accounts, with profile metadata.
 *
 * The deep end of the username-search family. Where sherlock answers "does this handle
 * exist here", maigret goes back to the sites that answered yes and pulls whatever the
 * page or its public API will hand over: real name, employer, city, follower counts,
 * account creation date, avatar URL, and any *other* usernames it can find, which it then
 * recursively searches for.
 *
 * Two hard-won operational facts, both from the Phase 0 report:
 *
 *  - It **writes a JSON file**, it does not print JSON. `-J simple` plus `--folderoutput`
 *    produces `report_<username>_simple.json` in that folder. Nothing structured reaches
 *    stdout.
 *  - Without `PYTHONIOENCODING=utf-8` it **dies before probing anything**: it prints a
 *    donation banner containing `♥`, which cp1252 cannot encode. `osintEnv()` sets it.
 */

import type { EntityKind, Finding } from '../../shared/types'
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
  parseJsonSafe,
  readEnvelope,
  recordSpawn,
  stderrSummary,
  type RunEnvelope
} from './support/envelope'
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

const ID = 'maigret'
const VERSION = '1.0.0'
const BIN_CANDIDATES = ['venv/Scripts/maigret.exe', 'venv/bin/maigret'] as const

/** The shape of one site entry in `report_<user>_simple.json`. */
interface MaigretSite {
  username?: string
  url_main?: string
  url_user?: string
  http_status?: number
  is_similar?: boolean
  rank?: number
  status?: {
    site_name?: string
    url?: string
    /** `Claimed` | `Available` | `Unknown` | `Illegal` | `Error` */
    status?: string
    ids?: Record<string, string>
    tags?: string[]
  }
}

/**
 * Extracted fields worth their own finding, in the order a human would want to read them.
 *
 * One finding per field rather than one blob, because these are separately checkable
 * claims: "the GitHub account exists" and "GitHub says its owner is Linus Torvalds" can
 * be corroborated, or contradicted, independently of each other.
 */
/**
 * `proposes` is what turns a scraped field into a reviewable candidate entity. Only the
 * fields that genuinely name a *thing* carry one: a follower count and an internal user
 * id are facts about an account, not entities in their own right.
 */
interface IdField {
  key: string
  describe: (v: string, site: string) => string
  proposes?: (v: string, site: string) => { kind: EntityKind; value: string; rationale: string } | null
}

const ID_FIELDS: IdField[] = [
  {
    key: 'fullname',
    describe: (v, s) => `${s} shows the display name "${v}" on this profile.`,
    // A display name is a name a site printed, not a verified identity — and Maigret's
    // own sample shows three different "Torvalds" people across three platforms. It is
    // proposed, never created, which is exactly the case the candidate queue is for.
    proposes: (v, s) =>
      /\s/.test(v.trim())
        ? { kind: 'person', value: v.trim(), rationale: `${s} printed this as the profile's display name.` }
        : null
  },
  {
    key: 'location',
    describe: (v, s) => `${s} shows the location "${v}" on this profile.`,
    proposes: (v, s) => ({
      kind: 'location',
      value: v.trim(),
      rationale: `${s} printed this as the profile's location. Self-reported, and never a coordinate.`
    })
  },
  {
    key: 'company',
    describe: (v, s) => `${s} shows the employer or organisation "${v}" on this profile.`,
    proposes: (v, s) => ({
      kind: 'organisation',
      value: v.trim(),
      rationale: `${s} printed this as the profile's employer or organisation.`
    })
  },
  { key: 'created_at', describe: (v, s) => `${s} reports the account was created at ${v}.` },
  { key: 'uid', describe: (v, s) => `${s} assigns this account the internal user id ${v}.` },
  {
    key: 'image',
    describe: (v, s) => `${s} serves this account's avatar from ${v}`,
    // A platform's placeholder avatar is the same file for every user on that platform.
    // Proposed as an entity it is pure noise, and reverse-searching it returns the
    // platform. Filtered on the URL's last segment only, so a real avatar that merely
    // lives under a path containing the word survives.
    proposes: (v, s) =>
      /^https?:\/\//i.test(v.trim()) && !isPlaceholderAvatar(v.trim())
        ? {
            kind: 'image',
            value: v.trim(),
            rationale: `${s} serves this URL as the profile's avatar. Reverse-image work starts here.`
          }
        : null
  },
  { key: 'follower_count', describe: (v, s) => `${s} reports ${v} followers for this account.` },
  { key: 'bio', describe: (v, s) => `${s} shows the profile text "${truncate(v, 200)}".` },
  {
    key: 'email',
    describe: (v, s) => `${s} exposes the address ${v} on this profile.`,
    proposes: (v, s) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
        ? { kind: 'email', value: v.trim(), rationale: `${s} published this address on the profile page.` }
        : null
  },
  { key: 'gender', describe: (v, s) => `${s} records the gender "${v}" on this profile.` },
  { key: 'country', describe: (v, s) => `${s} records the country "${v}" on this profile.` }
]

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * Is this avatar URL the platform's placeholder rather than this account's picture?
 *
 * Observed on a real `torvalds` sweep: Twitter answers `default_profile.png` for an
 * account that never set one. Every user of that platform has the identical URL, so it
 * identifies the platform and nobody else.
 */
function isPlaceholderAvatar(url: string): boolean {
  const last = url.split('?')[0]?.split('#')[0]?.split('/').pop() ?? ''
  return /^(default|blank|no[-_]?avatar|placeholder|anonymous|mystery)[-_.a-z0-9]*$/i.test(last)
}

/**
 * Maigret's own chatter, which prints in exactly the same `[+] Thing: value` shape as a
 * result line.
 *
 * Observed on a real 20-site run from this machine: `[+] Using sites database: ...` before
 * probing, then `[+] Extracted IDs: ...` and `[+] JSON simple report for x saved in <path>`
 * after it. Counted as hits, those three inflate the live number by three every run. The
 * filter lives here rather than in the scanner because only this file knows what this
 * tool says.
 */
const BANNER_LINE =
  /^(?:Using|Starting|You can|Supported|Loaded|Extracted|Saved|Report|Total|JSON|CSV|HTML|PDF|TXT|XMind)\b/i

export const maigretAdapter: Adapter = {
  id: ID,
  title: 'Maigret (username → accounts + profile metadata)',
  version: VERSION,

  accepts: ['username'],
  produces: ['account', 'person', 'location', 'organisation', 'image', 'email'],

  requiresKey: false,
  requiresNetwork: true,

  // One at a time. A maigret sweep opens up to 100 concurrent connections of its own;
  // running two in parallel is what turns "looked someone up" into "got the IP blocked",
  // and it already self-reported bot-protection errors on a 38-site run.
  concurrency: 1,
  minIntervalMs: 5_000,
  defaultTimeoutMs: 300_000,

  doc: {
    what: 'Takes one username and checks it against Maigret\'s site database, then scrapes the profiles that exist for real names, locations, employers, account ages, avatars and further usernames.',

    how: 'For each site it holds a URL template and a rule for deciding the answer. Most rules are one of three kinds: request the profile URL and look at the HTTP status (404 means free, 200 means taken); request it and search the HTML for a marker string that only appears on a real profile; or call the site\'s own public JSON API, which answers the question directly and truthfully. Every check is an ordinary unauthenticated request — the same one your browser makes when you open the profile — so a "hit" literally means the site served a page for that handle. It then does the part that makes it different: for sites that answered yes, it runs extractors over the response to pull structured fields out of the profile, and if the profile mentions another handle it queues that handle and searches again, up to a recursion limit.',

    why: 'Usernames are reused far more than people realise, because they are chosen once, remembered, and typed for years across services that never talk to each other. Each site independently exposes whether a handle is taken, since it must — that is how registration forms work. Collecting those answers turns a single handle into a map of one person\'s services, and the scraped profile fields are what turn a list of URLs into an identity: the same handle on ten sites is suggestive, but one of those sites printing a full name and a city is what actually links the pseudonym to a person.',

    betterAt: 'Depth. Compared with Sherlock it returns far more per hit — Sherlock tells you github.com/torvalds exists; Maigret tells you the account is user id 1024025, was created on 2011-09-03, belongs to "Linus Torvalds" of the Linux Foundation in Portland, and has 319,111 followers. It also has the largest and most actively maintained site database of the three username tools here, understands identifier types other than usernames (Steam ids, VK ids, Yandex public ids), and follows discovered handles recursively, so it can find accounts under a name you never gave it.',

    worseAt: 'Speed, politeness and predictability. It is the slowest of the three by a wide margin, it opens up to a hundred concurrent connections by default, and on a mere 38-site run from this machine it already reported that 10.5% of sites answered with bot protection. A full `--all-sites` sweep takes many minutes and will get an ordinary home IP rate-limited or challenged. The extraction layer is also the most brittle part: profile scrapers break silently whenever a site changes its HTML, so a missing `fullname` means "the extractor no longer matches", not "the profile has no name".',

    falsePositives: 'This is its most important weakness and it is unsolved, not merely unfixed. A site behind Cloudflare or a login wall answers an anti-bot challenge or a redirect with HTTP 200, and a status-code rule reads that as "the account exists". Sites that show a soft 404 — a styled "user not found" page served with a 200 — fail the same way. Sites with a catch-all profile route claim every handle is taken. In the other direction, a site that rate-limits mid-sweep returns errors that get reported as Unknown rather than as hits, so a second run can produce a different answer for the same handle. Treat a hit as "a URL that responded", open it yourself, and note that the Maigret and Sherlock results for one site are the same site answering twice — this adapter deliberately reports both under the same source name so they can never be counted as two independent confirmations.'
  },

  check(ctx) {
    return checkBinary(
      ctx.config,
      ctx.toolkitRoot,
      ID,
      BIN_CANDIDATES,
      'Install it into the toolkit venv: <toolkitRoot>\\venv\\Scripts\\pip.exe install maigret'
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const target = subjectValue(input.entity)
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })

    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN_CANDIDATES)
    const workdir = await makeWorkdir(ctx.caseDir, ID)

    try {
      // The WhatsMyName catalogue, transcribed into the capture before anything is run.
      // `parse()` needs it to say how much each hit's probe could mean and `parse()` may
      // not touch the filesystem, so the reading happens here and the interpreting happens
      // there — the same split `pattern-timezone` uses for timestamps. Carrying the
      // snapshot also means a re-parse next year classifies against the catalogue as it
      // was during the run, not as it has since become.
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
        '-J',
        'simple',
        '--folderoutput',
        workdir,
        '--timeout',
        String(optionNumber(options, 'siteTimeoutSeconds', 10, { min: 3, max: 120 })),
        '--retries',
        String(optionNumber(options, 'retries', 1, { min: 0, max: 5 })),
        '-n',
        String(optionNumber(options, 'connections', 20, { min: 1, max: 100 })),
        '--no-color',
        // The database update is a network call to GitHub on every start. Off by default
        // so a run is reproducible and so a rate-limited GitHub cannot stop a search.
        '--no-autoupdate'
      ]

      // The progress bar is the ONLY place maigret states how many sites it has finished.
      // It used to be suppressed with `--no-progressbar`, which left the UI with no
      // denominator and no count — the job row could say nothing truthful beyond "still
      // running". Keeping it costs a few hundred kilobytes of redraw frames in the raw
      // capture, which is verbatim tool output and belongs there anyway.
      if (!optionBoolean(options, 'progressBar', true)) args.push('--no-progressbar')

      if (optionBoolean(options, 'allSites', false)) {
        args.push('-a')
      } else {
        args.push('--top-sites', String(optionNumber(options, 'topSites', 50, { min: 1, max: 3000 })))
      }
      for (const site of optionList(options, 'sites', [])) args.push('--site', site)
      const tags = optionList(options, 'tags', [])
      if (tags.length) args.push('--tags', tags.join(','))
      if (!optionBoolean(options, 'recursion', true)) args.push('--no-recursion')
      if (!optionBoolean(options, 'extracting', true)) args.push('--no-extracting')

      // Everything the UI shows while this runs comes from the tool's own words, read as
      // it prints them. Nothing here is estimated: `total` is whatever maigret said it
      // was about to probe, `done` is its own counter, and `hits` counts the profiles it
      // has already announced. When a field never arrives the job row simply omits it.
      let done: number | null = null
      let total: number | null = null
      let hits = 0
      let current = ''
      let pass = 1
      // Holds until the first real count arrives, then gets out of the numbers' way.
      let note = `probing ${optionBoolean(options, 'allSites', false) ? 'all' : optionNumber(options, 'topSites', 50)} sites`
      const push = (): void => {
        ctx.progress({
          ...(done !== null ? { done } : {}),
          ...(total !== null ? { total } : {}),
          hits,
          note,
          ...(current ? { current } : {}),
          ...(done !== null && total ? { pct: Math.round((done / total) * 100) } : {})
        })
      }
      const scan = createScanner({
        onTotal: (n) => {
          total = n
          push()
        },
        onCount: (d, t) => {
          // Maigret's counter restarts from zero when recursion kicks in: it takes a
          // handle it discovered on one profile and searches the whole site list again.
          // Reported as-is, the bar simply runs backwards, which reads as a bug in this
          // app rather than as the thing maigret is actually doing — and that recursion
          // is the most interesting part of the tool. So the restart is named instead of
          // smoothed over, and the count stays the tool's own rather than a cumulative
          // figure nobody printed.
          if (done !== null && d < done) {
            pass++
            note = `pass ${pass} — searching again for a handle found on a profile in pass ${pass - 1}`
          } else if (pass === 1) {
            note = ''
          }
          done = d
          total = t
          push()
        },
        onUnit: (label, hit) => {
          // Maigret's banner uses the same `[+] Thing: value` shape as a result line.
          // Three of them, all before any probing, all filtered here rather than in the
          // scanner — only this file knows what this tool's chatter looks like.
          if (!hit || BANNER_LINE.test(label)) return
          hits++
          current = label
          push()
        }
      })

      ctx.progress({ note, hits: 0 })

      const res = await ctx.spawn(bin.file, {
        args,
        cwd: workdir,
        env: osintEnv(ctx.toolkitRoot),
        timeoutMs: ctx.timeoutMs,
        onStdout: scan
      })
      recordSpawn(env, { file: bin.file, args }, res)

      ctx.progress({ note: 'collecting report', current: '' })

      const reports = await findFiles(workdir, (name) => /^report_.*_simple\.json$/i.test(name))
      let collected = 0
      for (const file of reports.slice(0, 4)) {
        const body = await readTextIfExists(file.path)
        if (body !== null) {
          env.artifacts[file.name] = body
          collected++
        }
      }
      if (!reports.length) {
        env.notes.push(`No report_*_simple.json appeared in the scratch directory ${workdir}.`)
      }

      // Counted rather than measured off `artifacts`: the envelope also carries the
      // transcribed site catalogue, which is not a result and must never make a run that
      // produced nothing look like a run that produced something.
      const haveReport = collected > 0
      return finishEnvelope(env, {
        caseId: input.caseId,
        // Deliberately not `exitCode === 0`. Maigret exits 0 with an empty result and it
        // exits 0 after being blocked; what decides whether there is anything to interpret
        // is whether a report file exists.
        ok: haveReport,
        error: haveReport
          ? null
          : res.spawnError
            ? `maigret did not run: ${res.spawnError}`
            : `maigret exited ${res.exitCode} without writing a report. ${stderrSummary(env)}`,
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
   * The accounts and profile fields this run implies, as candidates.
   *
   * Re-derived from the same walk `parse()` does, so a proposal and the finding it cites
   * are built together and their ids cannot drift apart. Nothing is created here —
   * Maigret's own doc says a hit means "a URL that responded", and its false-positive
   * class (Cloudflare answering a challenge with HTTP 200) is unsolved. Every one of
   * these has to be looked at by a human before it enters the graph.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the report, producing the findings and the proposals together.
 *
 * Kept as a single function rather than duplicated across `parse` and `propose` so a
 * proposal can carry the id of the finding it came from without either side having to
 * rebuild the other's claim string — the finding id is derived from that string, so two
 * copies of it would be two ids that silently diverge the first time one is edited.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const reportName = Object.keys(env.artifacts).find((n) => /_simple\.json$/i.test(n))
  const report = parseJsonSafe<Record<string, MaigretSite>>(reportName ? env.artifacts[reportName] : null)
  if (!report || typeof report !== 'object') {
    return {
      findings: [summaryFinding(raw, env, { probed: 0, claimed: 0, available: 0, unresolved: 0, brokenReport: true })],
      proposals: []
    }
  }

  // Rebuilt from the envelope, never read off disk: `parse()` is pure, and that purity is
  // what makes re-parsing a two-year-old capture a supported operation.
  const wmn = readWmnTranscript(env.artifacts[WMN_ARTIFACT])

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  let claimed = 0
  let available = 0
  let unresolved = 0
  let probed = 0

  for (const [siteName, entry] of Object.entries(report)) {
    if (!entry || typeof entry !== 'object') continue
    probed++
    const status = (entry.status?.status ?? '').toLowerCase()
    if (status === 'available') {
      available++
      continue
    }
    if (status !== 'claimed') {
      unresolved++
      continue
    }
    claimed++

    const url = entry.status?.url || entry.url_user || entry.url_main || ''
    const source = siteOrigin(url || siteName) || siteName.toLowerCase()
    const label = entry.status?.site_name || siteName
    const http = typeof entry.http_status === 'number' ? ` HTTP ${entry.http_status}.` : ''
    const similar = entry.is_similar ? ' Maigret flagged this as a similar-name match rather than an exact one.' : ''
    const matcher = matcherFor(wmn, { site: label, url })
    // The badge in the table is a badge the operator can look past. A weak probe is the
    // thing he most needs to read, so it is written into the claim itself as well.
    const weakness = isWeakProbe(matcher) ? ` ${matcher?.why}` : ''

    const hit = makeFinding(raw, {
      source,
      matcher,
      // What a hit means and nothing more: a handle is taken on a site. Whose it is, is a
      // separate question no username sweep can answer — `Marco Migozzi` is what Instagram
      // returns for the handle `torvalds` in this repo's own test fixture.
      // The URL goes last and carries no punctuation after it. A full stop touching an
      // address is copied along with it and breaks the link, which is exactly what the
      // operator hit; `shared/links.ts` trims it on the way to a click, and this keeps the
      // claim *text* right everywhere else — the clipboard, an export, a grep.
      claim:
        `Maigret reports that an account named "${env.target}" exists on ${label}.${http}` +
        ` Who holds that account is a separate question this probe does not answer.${similar}${weakness}` +
        (url ? ` Profile: ${url}` : ' Maigret reported no URL for it.')
    })
    findings.push(hit)

    const ids = entry.status?.ids ?? {}
    const handle = (ids['username'] || entry.username || env.target || '').trim()
    if (source && handle) {
      // `platform/handle` built from the folded site origin, so a maigret hit and a
      // sherlock hit on the same site converge on one candidate carrying two proposals
      // rather than two near-duplicate candidates.
      proposals.push({
        fromFindingId: hit.id,
        kind: 'account',
        value: `${source}/${handle}`,
        label: `${handle} on ${label}`,
        attrs: { platform: source, handle, ...(url ? { url } : {}) },
        rationale: `${label} served a profile page for "${handle}". A responding URL, not a verified account.`
      })
    }

    for (const field of ID_FIELDS) {
      const value = ids[field.key]
      if (typeof value !== 'string' || !value.trim()) continue
      // The same probe produced the page these fields were scraped out of, so the same
      // question hangs over them: if the response was not about this handle, neither is
      // the name printed on it.
      const detail = makeFinding(raw, { source, matcher, claim: field.describe(value.trim(), label) })
      findings.push(detail)
      const proposed = field.proposes?.(value.trim(), label)
      if (proposed) {
        proposals.push({
          fromFindingId: detail.id,
          kind: proposed.kind,
          // Not the adapter's default: the sweep is what found the page, but this value was
          // scraped *off* that page by maigret's per-site extractor. A name printed on a
          // profile is a profile field, whatever went looking for the profile.
          mechanism: 'profile-field',
          value: proposed.value,
          rationale: proposed.rationale
        })
      }
    }
  }

  findings.push(summaryFinding(raw, env, { probed, claimed, available, unresolved, brokenReport: false }))
  return { findings, proposals }
}

function summaryFinding(
  raw: RawResult,
  env: RunEnvelope,
  counts: { probed: number; claimed: number; available: number; unresolved: number; brokenReport: boolean }
): Finding {
  if (counts.brokenReport) {
    return makeFinding(raw, {
      source: localSource(ID),
      claim: `Maigret produced a report for "${env.target}" that could not be read as JSON, so no site results were extracted. The capture is preserved and can be re-parsed. ${stderrSummary(env)}`.trim()
    })
  }
  const blocked = /bot protection|too many errors|captcha/i.test(env.stderr + env.stdout)
  const caveat = counts.unresolved
    ? ` ${group(counts.unresolved)} site${counts.unresolved === 1 ? '' : 's'} gave no usable answer (error, ban, captcha or timeout) and must be read as "not checked", not as "no account".`
    : ''
  const blockNote = blocked
    ? ' Maigret reported bot-protection errors during this run, so the negative results are less trustworthy than the positive ones.'
    : ''
  return makeFinding(raw, {
    source: localSource(ID),
    claim:
      `Maigret probed ${group(counts.probed)} sites for the username "${env.target}" in ${group(Math.round(env.durationMs / 1000))} s: ` +
      `${group(counts.claimed)} claimed, ${group(counts.available)} available.${caveat}${blockNote}`
  })
}

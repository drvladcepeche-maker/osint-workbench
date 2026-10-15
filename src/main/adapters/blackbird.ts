/**
 * `blackbird` — username or email -> accounts, widest coverage per second.
 *
 * 716 sites in ~35 seconds in the Phase 0 smoke test, with a flat JSON result array that
 * is by far the easiest of the three username tools to parse, plus a `category` field the
 * other two do not have.
 *
 * Two operational notes:
 *
 *  - It is a **script, not an installed entry point**: it must be run as
 *    `python blackbird.py` with the working directory set to the clone, and it writes its
 *    report to `results/<target>_<MM_DD_YYYY>_blackbird/…json` *relative to that clone*.
 *    There is no output-path flag, so the report is located by looking for the newest
 *    matching file written after this run started.
 *  - Its `requirements.txt` **pins exact versions and downgrades shared dependencies**
 *    (it pulled `aiohttp` and `reportlab` below what Maigret requires). Everything still
 *    ran afterwards, so the conflict is currently cosmetic, but install order now
 *    silently decides which versions win. Give it its own interpreter:
 *
 *        py -3.12 -m venv <toolkitRoot>\venv-bb
 *        <toolkitRoot>\venv-bb\Scripts\pip.exe install -r <toolkitRoot>\blackbird\requirements.txt
 *
 *    This adapter prefers `venv-bb` when it exists and falls back to the shared venv
 *    otherwise, saying so in `check()`.
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
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
  parseJsonSafe,
  readEnvelope,
  recordSpawn,
  stderrSummary
} from './support/envelope'
import {
  isWeakProbe,
  loadWmnSites,
  matcherFor,
  readWmnTranscript,
  transcribeWmnIndex,
  WMN_ARTIFACT
} from './support/matcher'
import { localSource, siteOrigin } from './support/sources'
import {
  findFiles,
  mergedOptions,
  optionBoolean,
  optionNumber,
  optionString,
  osintEnv,
  readTextIfExists,
  resolveBinary,
  subjectValue
} from './support/toolkit'

const ID = 'blackbird'
const VERSION = '1.0.0'
/** Preferred first: its own venv, because its pins downgrade the shared one. */
const PY_CANDIDATES = ['venv-bb/Scripts/python.exe', 'venv-bb/bin/python', 'venv/Scripts/python.exe', 'venv/bin/python'] as const
const REPO_REL = 'blackbird'

interface BlackbirdHit {
  name?: string
  url?: string
  category?: string
  /** `FOUND` in practice; the tool only writes hits. */
  status?: string
  metadata?: unknown
}

interface BlackbirdMetadata {
  name?: string
  type?: string
  value?: unknown
}

export const blackbirdAdapter: Adapter = {
  id: ID,
  title: 'Blackbird (username/email → accounts, widest list)',
  version: VERSION,

  accepts: ['username', 'email'],
  produces: ['account', 'image'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 5_000,
  defaultTimeoutMs: 300_000,

  doc: {
    what: 'Checks one username, or one email address, against a catalogue of roughly 716 sites and returns the ones that have an account, grouped by category.',

    how: 'It works from the WhatsMyName dataset: a JSON catalogue where every site carries a URL template with an `{account}` placeholder, the HTTP status that means "exists" (`e_code`), a string that must be present in the body for it to count (`e_string`), and the matching pair for "missing" (`m_code` / `m_string`). Requiring *both* a status code and a body string is the important detail — a site only counts as a hit when it answers 200 **and** the page contains the marker that only a real profile has, which rejects a large share of the soft-404 pages that fool a status-code-only check. Requests are issued asynchronously, thirty at a time by default. For a subset of sites it goes further and reads structured values straight out of the JSON API response — avatar URLs, course lists, display names — using a path expression stored in the catalogue.',

    why: 'Same underlying leak as the rest of the family: a site must distinguish a taken handle from a free one, and it does so over an unauthenticated request. What makes the catalogue approach worth having separately is that the dataset is community-maintained with an explicit `protection` field naming which sites sit behind captcha, Cloudflare or bot filtering, and each entry records known-good example accounts — so the site list carries its own record of which entries are trustworthy, rather than the tool discovering that at your expense.',

    betterAt: 'Coverage per second and breadth of catalogue: 716 sites in about 35 seconds, roughly twenty times Sherlock\'s throughput on a full run, with the flattest and easiest-to-read output of the three. It is the only one of them that takes an email address as well as a username, its `category` field lets you filter a sweep to just coding, dating or gaming sites, and its two-signal matching rule makes it structurally less prone to soft-404 false positives than a status-code-only check.',

    worseAt: 'Everything around the search. It refreshes its site list over the network on every start unless told not to, which makes an unpinned run non-reproducible — this adapter passes `--no-update` by default for that reason. It is a script rather than an installed command, it writes its report into its own clone directory under a date-stamped name, and its dependency pins actively downgrade packages that Maigret and other tools depend on. Its extracted metadata is sparse: on the Phase 0 run only two of ninety hits carried any at all, so for profile detail Maigret is still the tool. Its AI flags need an API key and are irrelevant here.',

    falsePositives: 'The dual status-plus-string rule helps but does not solve it. A site that changes its markup invalidates its `e_string`, and the entry then either stops finding anyone or starts finding everyone, depending on which way the string broke — and because the dataset self-updates, that change can arrive between two runs on the same handle without you touching anything. Sites in the catalogue\'s `protection` list return Cloudflare interstitials that can satisfy a loose marker. Thirty concurrent requests is also enough to trip rate limiting on smaller sites, which turns real accounts into silent misses. And its email mode inherits the whole set of problems the holehe adapter documents: it is inferring registration from a public endpoint\'s behaviour, and a site that has changed that behaviour will lie in whichever direction the change went.'
  },

  check(ctx) {
    const repo = path.join(ctx.toolkitRoot, REPO_REL)
    if (!existsSync(path.join(repo, 'blackbird.py'))) {
      return `blackbird: no blackbird.py at ${repo}. Clone it: git clone https://github.com/p1ngul1n0/blackbird "${repo}"`
    }
    const py = resolveBinary(ctx.config, ctx.toolkitRoot, ID, PY_CANDIDATES)
    if (!py.exists) return `blackbird: no Python interpreter found at ${py.file}.`
    if (/venv-bb/i.test(py.file)) return null
    return (
      'blackbird: running from the SHARED venv. Its requirements.txt pins exact versions and ' +
      'downgraded aiohttp/reportlab below what maigret asks for. Give it its own interpreter: ' +
      `py -3.12 -m venv ${path.join(ctx.toolkitRoot, 'venv-bb')} && ` +
      `${path.join(ctx.toolkitRoot, 'venv-bb', 'Scripts', 'pip.exe')} install -r ${path.join(repo, 'requirements.txt')}`
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const target = subjectValue(input.entity)
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })

    const py = resolveBinary(ctx.config, ctx.toolkitRoot, ID, PY_CANDIDATES)
    const repo = path.join(ctx.toolkitRoot, REPO_REL)
    if (/venv-bb/i.test(py.file) === false) {
      env.notes.push('Ran from the shared venv, not a dedicated venv-bb. See the adapter header for why that is fragile.')
    }

    // Blackbird's site list *is* the WhatsMyName catalogue, so this is not an approximation
    // for this adapter: it is the very entry the tool used, transcribed into the capture so
    // that `parse()` can read the shape of each probe without touching the filesystem.
    // `--no-update` keeps the run pinned to the copy on disk, which is the copy recorded
    // here, so the two cannot disagree.
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
      'blackbird.py',
      input.entity.kind === 'email' ? '--email' : '--username',
      target,
      '--json',
      '--timeout',
      String(optionNumber(options, 'siteTimeoutSeconds', 15, { min: 3, max: 120 })),
      '--max-concurrent-requests',
      String(optionNumber(options, 'maxConcurrentRequests', 15, { min: 1, max: 60 }))
    ]
    // Reproducibility over freshness: a self-updating site list means two runs on the same
    // handle can legitimately disagree, which is the last thing a case file needs.
    if (!optionBoolean(options, 'updateSites', false)) args.push('--no-update')
    if (optionBoolean(options, 'excludeNsfw', true)) args.push('--no-nsfw')
    const filter = optionString(options, 'filter', '')
    if (filter) args.push('--filter', filter)

    ctx.progress({ pct: 5, note: 'probing the WhatsMyName catalogue' })

    const res = await ctx.spawn(py.file, {
      args,
      cwd: repo,
      env: osintEnv(ctx.toolkitRoot),
      timeoutMs: ctx.timeoutMs
    })
    recordSpawn(env, { file: py.file, args }, res)

    ctx.progress({ pct: 90, note: 'collecting report' })

    // No output-path flag: find the newest *_blackbird.json written since this run began.
    // A one-minute grace window absorbs clock skew between Node and the filesystem.
    const since = startedMs - 60_000
    const reports = (
      await findFiles(path.join(repo, 'results'), (name) => /_blackbird\.json$/i.test(name), 3)
    ).filter((f) => f.mtimeMs >= since)

    const newest = reports[0]
    let collected = false
    if (newest) {
      const body = await readTextIfExists(newest.path)
      if (body !== null) {
        env.artifacts[newest.name] = body
        collected = true
        env.notes.push(`Report collected from ${newest.path}. Blackbird keeps its own copy there; this app does not delete it.`)
      }
    } else {
      env.notes.push(`No *_blackbird.json newer than the start of this run was found under ${path.join(repo, 'results')}.`)
    }

    // Tracked rather than counted off `artifacts`, which also holds the transcribed site
    // catalogue: that is context, not a result, and a run that produced nothing must not
    // start reporting `ok` because of it.
    const haveReport = collected
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: haveReport,
      error: res.spawnError
        ? `blackbird did not run: ${res.spawnError}`
        : `blackbird exited ${res.exitCode} without leaving a JSON report. ${stderrSummary(env)}`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * The accounts and avatars this run implies, as candidates.
   *
   * Blackbird's two-signal rule — the expected status code *and* the marker string —
   * makes a hit here better evidence than a status-code-only check, and still not
   * evidence that a person owns the account. The catalogue is community-maintained and
   * self-updating, so an entry whose marker string rotted finds either nobody or
   * everybody; which of the two is invisible from the report. So each hit is named, and
   * none of it is created.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the report, producing the findings and the proposals together.
 *
 * A proposal has to cite the id of the finding it came from, and that id is derived from
 * the finding's claim string. Building the two in separate passes would mean two copies
 * of every claim, and two copies diverge the first time one of them is edited.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const name = Object.keys(env.artifacts).find((n) => /_blackbird\.json$/i.test(n))
  const hits = parseJsonSafe<BlackbirdHit[]>(name ? env.artifacts[name] : null)
  if (!Array.isArray(hits)) {
    return {
      findings: [
        makeFinding(raw, {
          source: localSource(ID),
          claim: `Blackbird produced a report for "${env.target}" that was not a JSON array, so no site results were extracted. The capture is preserved and can be re-parsed. ${stderrSummary(env)}`.trim()
        })
      ],
      proposals: []
    }
  }

  // From the capture, never from disk — `parse()` is pure.
  const wmn = readWmnTranscript(env.artifacts[WMN_ARTIFACT])

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  const categories = new Map<string, number>()
  let found = 0
  // Blackbird is pointed at either a username or an email address, and whichever it was
  // is the handle the site answered about. There is nothing else in the report to use.
  const handle = (env.target ?? '').trim()

  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue
    if ((hit.status ?? 'FOUND').toUpperCase() !== 'FOUND') continue
    found++
    const site = hit.name || hit.url || 'unknown site'
    const url = hit.url ?? ''
    const source = siteOrigin(url || site) || site.toLowerCase()
    const category = (hit.category ?? '').trim()
    if (category) categories.set(category, (categories.get(category) ?? 0) + 1)

    const matcher = matcherFor(wmn, { site: hit.name ?? '', url })
    const weakness = isWeakProbe(matcher) ? ` ${matcher?.why}` : ''
    // Blackbird takes an email address as well as a handle, and the two facts are not the
    // same sentence: a site says a *name* is taken, or it says an account is registered to
    // an *address*. Neither says who that account belongs to.
    const existence =
      env.entityKind === 'email'
        ? `an account registered to "${env.target}" exists on ${site}`
        : `an account named "${env.target}" exists on ${site}`

    const account = makeFinding(raw, {
      source,
      matcher,
      claim:
        `Blackbird reports that ${existence}${category ? ` (category: ${category})` : ''}, ` +
        'having required both the expected status code and a marker string in the body.' +
        ` Who holds that account is a separate question this probe does not answer.${weakness}` +
        (url ? ` Profile: ${url}` : ' Blackbird reported no URL for it.')
    })
    findings.push(account)

    if (isPlatform(source) && handle) {
      // `platform/handle` off the same folded origin that went into `Finding.source`, so a
      // blackbird hit and a sherlock hit on one site converge on a single candidate
      // carrying two proposals rather than two near-duplicates.
      proposals.push({
        fromFindingId: account.id,
        kind: 'account',
        value: `${source}/${handle}`,
        label: `${handle} on ${site}`,
        attrs: { platform: source, handle, ...(category ? { category } : {}), ...(url ? { url } : {}) },
        rationale: `${site} matched both the status code and the body marker its catalogue entry demands for "${handle}". Two signals from one site, which is not two sources — and a marker string that has rotted matches everybody.`
      })
    }

    for (const item of describeMetadata(hit.metadata, site)) {
      // Extracted out of the same response, so it inherits the same question about whether
      // that response was about this handle at all.
      const detail = makeFinding(raw, { source, matcher, claim: item.claim })
      findings.push(detail)
      if (item.imageUrl) {
        proposals.push({
          fromFindingId: detail.id,
          kind: 'image',
          // The sweep found the account; the avatar URL came off the site's own API
          // response about it. That is a field on a profile, not a site-list row.
          mechanism: 'profile-field',
          value: item.imageUrl,
          label: `${site} avatar${handle ? ` for ${handle}` : ''}`,
          attrs: { platform: source, ...(handle ? { handle } : {}), ...(url ? { profileUrl: url } : {}) },
          rationale: `${site}'s own API served this URL as the account's avatar. It is where reverse-image work starts; it is not evidence that the person in it owns the account.`
        })
      }
    }
  }

  const byCategory = [...categories.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([c, n]) => `${c} ${n}`)
    .join(', ')

  findings.push(
    makeFinding(raw, {
      source: localSource(ID),
      claim:
        `Blackbird reported ${group(found)} account${found === 1 ? '' : 's'} for "${env.target}" in ${(env.durationMs / 1000).toFixed(1)} s` +
        `${byCategory ? `, spread across ${byCategory}` : ''}. ` +
        'Blackbird writes only the sites that matched, so this run says nothing about the sites that did not — the absence of a platform here is not evidence of absence.'
    })
  )
  return { findings, proposals }
}

/**
 * Did the fold produce something that is actually a site operator?
 *
 * A catalogue entry with no URL falls back to the site's display name, and `unknown site`
 * folded is still `unknown site`. As a `Finding.source` that is harmless — it is an
 * independence key nothing else will collide with — but as the platform half of
 * `platform/handle` it would put a candidate in the queue that names no site at all.
 */
function isPlatform(source: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(source)
}

/**
 * One described metadata field: the claim it becomes, and — only when the field is an
 * image and the URL is a real one — the URL a candidate `image` would be built from.
 */
interface MetadataItem {
  claim: string
  imageUrl: string | null
}

/**
 * Blackbird's `metadata` is an array of extractor results, each with a name, a type and a
 * value that may be a string or an array. Only strings and flat arrays are described;
 * anything else is left in the raw capture rather than guessed at.
 */
function describeMetadata(metadata: unknown, site: string): MetadataItem[] {
  if (!Array.isArray(metadata)) return []
  const out: MetadataItem[] = []
  for (const entry of metadata as BlackbirdMetadata[]) {
    if (!entry || typeof entry !== 'object') continue
    const label = (entry.name ?? entry.type ?? 'field').toString().trim()
    const value = entry.value
    if (typeof value === 'string' && value.trim()) {
      out.push({
        claim: `${site} exposes "${label}" for this account: ${value.trim().slice(0, 300)}`,
        imageUrl: avatarUrl(entry, value.trim())
      })
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      if (!value.length) continue
      out.push({ claim: `${site} exposes "${label}" for this account: ${value.slice(0, 20).join(', ')}`, imageUrl: null })
    }
    if (out.length >= 10) break
  }
  return out
}

/** Blackbird labels an extracted avatar with `type: "Image"` (and usually `name: "Avatar"`). */
const IMAGE_FIELD = /^(image|avatar|picture|photo|profile[ _-]?(?:image|picture|photo))$/i

/**
 * The last path segment of a platform's stock avatar. Duolingo's real capture returns
 * `…/avatar/default_2` for an account with no picture, and a candidate built from that is
 * a reverse-image search for the platform's own placeholder — noise in the review queue,
 * and identical for every user of that site.
 */
const PLACEHOLDER_IMAGE = /^(default|no[-_]?(?:avatar|image|photo|pic)|placeholder|blank|anonymous|missing|unknown)/i

/** The URL to propose as an `image`, or `null` when the field is not an image or the value is not one. */
function avatarUrl(entry: BlackbirdMetadata, value: string): string | null {
  const kind = (entry.type ?? '').toString().trim()
  const label = (entry.name ?? '').toString().trim()
  if (!IMAGE_FIELD.test(kind) && !IMAGE_FIELD.test(label)) return null
  if (!/^https?:\/\/\S+$/i.test(value)) return null
  const leaf = (value.split('?')[0] ?? '').split('#')[0]?.split('/').filter(Boolean).pop() ?? ''
  if (!leaf || PLACEHOLDER_IMAGE.test(leaf)) return null
  return value
}

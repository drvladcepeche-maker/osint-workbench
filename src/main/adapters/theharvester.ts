/**
 * `theHarvester` — domain -> email addresses, hostnames and IPs, from public aggregators.
 *
 * Two things make this adapter different from the others:
 *
 *  1. **It lives in its own interpreter.** theHarvester 5.0.0 requires Python >= 3.14,
 *     which is the exact inverse of the 3.12 the rest of the toolbelt is pinned to. It
 *     cannot share the venv, so it gets `venv-th`. (Also: `pip install theHarvester` from
 *     PyPI installs a 97 kB stub that reports success and contains no package. Never do
 *     that. The real project is installed from GitHub.)
 *  2. **Its exit code is worthless and it knows it.** It returns 0 when every source
 *     failed. What saves it is the `.jsonl` summary it writes alongside the results: one
 *     record per source with a status, a stop reason and a duration. That telemetry is the
 *     only way to distinguish "the domain has no exposed addresses" from "certificate
 *     transparency returned HTTP 502 today", and this adapter turns every one of those
 *     rows into its own finding so the distinction is visible in the case file rather
 *     than buried in a log.
 */

import path from 'node:path'
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
import { dataSourceOrigin, localSource } from './support/sources'
import {
  checkBinary,
  makeWorkdir,
  mergedOptions,
  optionList,
  optionNumber,
  osintEnv,
  readTextIfExists,
  removeWorkdir,
  resolveBinary
} from './support/toolkit'

const ID = 'theharvester'
const VERSION = '1.0.0'
const BIN_CANDIDATES = ['venv-th/Scripts/theHarvester.exe', 'venv-th/bin/theHarvester'] as const

/**
 * Sources that work with no API key at all. Everything else in theHarvester's ~40-source
 * list wants a paid or registered key, and DECISIONS.md rules those out.
 */
const FREE_SOURCES = ['duckduckgo', 'crtsh', 'certspotter', 'anubis', 'otx', 'hackertarget', 'rapiddns', 'urlscan']

interface SourceExecution {
  source?: string
  status?: string
  stop_reason?: string
  error_type?: string | null
  result_count?: number
  duration_ms?: number
}

interface HarvesterSummary {
  target?: string
  result_count?: number
  evidence_status?: string
  source_executions?: SourceExecution[]
  started_at?: string
  completed_at?: string
  run_id?: string
}

/**
 * What a result of this kind implies, when it implies an entity at all.
 *
 * `value` is the filter as much as the extractor: it returns `null` for anything that is
 * not a clean instance of its kind, and a `null` is simply not proposed. The finding is
 * emitted either way — theHarvester saying it found `admin@` is worth recording even when
 * `admin@` is not an address.
 */
interface ResultProposal {
  kind: EntityKind
  /** The entity value this result implies, or `null` when the string is not one. */
  value(raw: string, apex: string): string | null
  rationale(value: string, target: string): string
}

/** Result arrays theHarvester writes into its `.json`, and how to describe each one. */
const RESULT_FIELDS: { key: string; singular: string; plural: string; proposes?: ResultProposal }[] = [
  {
    key: 'emails',
    singular: 'email address',
    plural: 'email addresses',
    proposes: {
      kind: 'email',
      value: emailValue,
      rationale: (v, t) =>
        `Harvested from a page, document or certificate that mentioned ${t}. Search-engine sources scrape addresses out of page text, so ${v} may be a template's role address, an example from documentation, or somebody else's entirely.`
    }
  },
  {
    key: 'hosts',
    singular: 'hostname',
    plural: 'hostnames',
    proposes: {
      kind: 'domain',
      value: hostValue,
      rationale: (v, t) =>
        `An aggregator holds a record of ${v} in connection with ${t}. Certificate transparency and passive DNS both record what once existed, so this is a name that was published, not a host that answers today.`
    }
  },
  {
    key: 'ips',
    singular: 'IP address',
    plural: 'IP addresses',
    proposes: {
      kind: 'ipaddr',
      value: ipValue,
      rationale: (v, t) =>
        `Returned as an address associated with ${t}. theHarvester merges its sources before writing, so ${v} cannot be traced to the source that supplied it or to the hostname it belonged to, and shared hosting puts one address in front of thousands of sites.`
    }
  },
  { key: 'urls', singular: 'URL', plural: 'URLs' },
  { key: 'interesting_urls', singular: 'notable URL', plural: 'notable URLs' },
  { key: 'asns', singular: 'ASN', plural: 'ASNs' },
  {
    key: 'linkedin_people',
    singular: 'LinkedIn name',
    plural: 'LinkedIn names',
    proposes: {
      kind: 'person',
      value: personValue,
      rationale: (v, t) =>
        `A search source returned ${v} as a LinkedIn name connected with ${t}. A name on a page about the organisation — not proof of employment, not tied to any account here, and not necessarily one specific person.`
    }
  },
  { key: 'twitter_people', singular: 'Twitter handle', plural: 'Twitter handles' }
]

export const theHarvesterAdapter: Adapter = {
  id: ID,
  title: 'theHarvester (domain → emails, hosts, IPs)',
  version: VERSION,

  accepts: ['domain'],
  produces: ['email', 'domain', 'ipaddr', 'person'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 10_000,
  defaultTimeoutMs: 300_000,

  doc: {
    what: 'Points a set of public search engines, certificate logs and passive-DNS aggregators at one domain and collects the email addresses, hostnames and IP addresses they already hold.',

    how: 'It is a query fan-out, not a scanner. For each selected source it issues that source\'s own public query — a site-restricted search on DuckDuckGo, a certificate-transparency lookup on crt.sh, a passive-DNS query to AlienVault OTX — parses the reply with a per-source parser, and merges everything into one deduplicated result set. It touches the target domain\'s own infrastructure only if you explicitly ask for DNS resolution or screenshots; by default every request goes to a third party that already collected the data. Alongside the results it writes a JSON Lines run summary recording, per source, whether that source completed, failed or found nothing, and why it stopped.',

    why: 'Organisations leak their own perimeter through infrastructure that has to be public. Every TLS certificate a company issues is published to certificate-transparency logs by design, which means every hostname it has ever put a certificate on is a matter of public record — including the staging, admin and VPN hosts nobody meant to advertise. Email addresses leak the same way, through pages, PDFs and press releases the search engines already indexed. Asking the aggregators is both quieter and more complete than probing the target: the target sees nothing, and the aggregators have years of history the live server no longer serves.',

    betterAt: 'Email addresses and breadth of result type. It is the only tool here that returns addresses at all, and the only one that mixes hostnames, IPs, ASNs and people from one query. Its per-source telemetry is genuinely rare and genuinely useful — most tools of this kind report a merged result and leave you unable to tell a quiet domain from a broken source. Use it when the question is "what does the public internet already hold about this organisation", rather than "what subdomains exist".',

    worseAt: 'Subdomain enumeration specifically, which is what people usually reach for it. On the Phase 0 comparison, subfinder returned 24,948 subdomains for the same domain in 55 seconds while theHarvester returned none from two sources in twenty, eighteen of which was one source timing out. Most of its ~40 sources need API keys, so a keyless run is working from perhaps eight of them. It costs a second 187 MB Python 3.14 virtual environment because of its interpreter requirement, and it pulls in Playwright, which will try to download several hundred megabytes of browsers to your home directory if a source ever asks for one.',

    falsePositives: 'The exit code is the trap: it returns 0 when every source errored, so a run that found nothing looks exactly like a run that worked. Read the per-source status, which is why this adapter emits one finding per source execution. Beyond that, the data is aggregated and stale by construction — certificate transparency records hostnames that were certificated once and may have been dead for years, and passive DNS records what resolved at some point in the past, so a hostname here is evidence that something existed, not that it exists. Search-engine sources scrape addresses out of page text, which produces plausible-looking addresses that were never real: role addresses from a template, examples from documentation, and addresses belonging to a different organisation that happened to be mentioned on the page. Per-result attribution is also unavailable — theHarvester merges everything before writing it, so a specific hostname cannot be traced back to the source that supplied it.'
  },

  check(ctx) {
    return checkBinary(
      ctx.config,
      ctx.toolkitRoot,
      ID,
      BIN_CANDIDATES,
      'theHarvester 5 needs its own Python >= 3.14 environment: py -3.14 -m venv <toolkitRoot>\\venv-th && ' +
        '<toolkitRoot>\\venv-th\\Scripts\\pip.exe install git+https://github.com/laramies/theHarvester.git ' +
        '(never `pip install theHarvester` from PyPI — that name is a 97 kB stub).'
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const target = input.entity.value
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })

    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN_CANDIDATES)
    const workdir = await makeWorkdir(ctx.caseDir, ID)

    try {
      const sources = optionList(options, 'sources', FREE_SOURCES)
      const prefix = path.join(workdir, 'harvest')
      const args: string[] = [
        '-d',
        target,
        '-b',
        sources.join(','),
        '-f',
        prefix,
        '-l',
        String(optionNumber(options, 'limit', 200, { min: 1, max: 5000 })),
        '-j',
        String(optionNumber(options, 'sourceWorkers', 3, { min: 1, max: 10 }))
      ]

      ctx.progress({ pct: 10, note: `querying ${sources.length} keyless sources` })

      const res = await ctx.spawn(bin.file, {
        args,
        cwd: workdir,
        env: osintEnv(ctx.toolkitRoot),
        timeoutMs: ctx.timeoutMs
      })
      recordSpawn(env, { file: bin.file, args }, res)

      ctx.progress({ pct: 85, note: 'collecting results and per-source telemetry' })

      // `-f` writes three files at once. The .jsonl summary is the more valuable of the
      // two we keep — without it a zero-result run is indistinguishable from a broken one.
      for (const ext of ['json', 'jsonl', 'xml']) {
        const body = await readTextIfExists(`${prefix}.${ext}`)
        if (body !== null) env.artifacts[`harvest.${ext}`] = body
      }
      if (!env.artifacts['harvest.json'] && !env.artifacts['harvest.jsonl']) {
        env.notes.push(`No harvest.json or harvest.jsonl appeared next to ${prefix}.`)
      }

      const haveResults = Boolean(env.artifacts['harvest.json'] || env.artifacts['harvest.jsonl'])
      return finishEnvelope(env, {
        caseId: input.caseId,
        // Explicitly not the exit code: theHarvester returns 0 with every source failed.
        ok: haveResults,
        error: res.spawnError
          ? `theHarvester did not run: ${res.spawnError}`
          : `theHarvester exited ${res.exitCode} without writing result files. ${stderrSummary(env)}`,
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
   * The addresses, hosts, IPs and people this run's results name.
   *
   * theHarvester merges every source before it writes, so nothing here can be attributed
   * to the aggregator that supplied it, and its search-engine sources scrape addresses
   * out of page text — which is how a documentation example ends up looking like an
   * employee. Each value is proposed only when it is a clean instance of its kind, and
   * the domain the run was pointed at is never proposed back to itself.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the results, producing the findings and the proposals together, so a
 * proposal can carry the id of the finding built beside it. The id is derived from the
 * claim string; rebuilding that string in a second pass would be two copies of it, and
 * two copies diverge the first time one is edited.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  const summary = readSummary(env.artifacts['harvest.jsonl'])
  const results = parseJsonSafe<Record<string, unknown>>(env.artifacts['harvest.json'] ?? null)

  // --- per-source telemetry, always, even when nothing was found ---
  const executions = Array.isArray(summary?.source_executions) ? summary.source_executions : []
  const succeeded: string[] = []
  const failed: string[] = []
  for (const exec of executions) {
    const name = (exec?.source ?? '').trim()
    if (!name) continue
    const status = (exec.status ?? 'unknown').toLowerCase()
    const stop = (exec.stop_reason ?? '').trim()
    const count = typeof exec.result_count === 'number' ? exec.result_count : 0
    if (status === 'completed') succeeded.push(name)
    else failed.push(name)

    /* No duration in the claim.
     *
     * These rows carry a real source origin rather than `local:`, so they count as claims
     * — and a finding's id is content-addressed over its claim. "in 412 ms" therefore gave
     * the same assertion a new id on every run: a second row rather than a refreshed one,
     * and a claim count that climbed with the number of re-runs. The rule applies to every
     * adapter here: nothing that varies from run to run belongs in a claim. Each run's
     * timing is in `harvest.jsonl` inside that run's own permanent capture, which is where
     * a measurement of a run belongs. */
    findings.push(
      makeFinding(raw, {
        source: dataSourceOrigin(name),
        claim:
          status === 'completed'
            ? `Queried for ${env.target} via theHarvester: ${name} completed and returned ${group(count)} result${count === 1 ? '' : 's'}${stop ? ` (${stop})` : ''}.`
            : `Queried for ${env.target} via theHarvester: ${name} did NOT complete (${status}${stop ? `, ${stop}` : ''}). Anything this source would have known is missing from this run.`
      })
    )
  }

  // --- results ---
  // theHarvester merges everything before writing, so a specific host cannot be traced
  // to the source that supplied it. When exactly one source succeeded the attribution is
  // unambiguous; otherwise the finding is attributed to the set, and says so.
  // When exactly one source succeeded the attribution is unambiguous and the finding is
  // sourced at the host that served the data. Otherwise it cannot be attributed to any of
  // them, so it is sourced as local analysis — which is what an unattributable merge is.
  //
  // It used to be `theharvester(crtsh+otx)`: the tool's own name in the corroboration key,
  // which ARCHITECTURE §2 forbids for a reason this case demonstrates twice over. Nothing
  // recognised it as derived, so two merged results counted as an independent source; and
  // the string varies with *which* sources happened to answer, so a re-run of the same
  // query minted a second finding instead of refreshing the first.
  const attribution =
    succeeded.length === 1 ? dataSourceOrigin(succeeded[0] as string) : localSource(ID)
  const attributionNote =
    succeeded.length === 1
      ? ''
      : ` theHarvester merges its sources before writing results, so this specific value cannot be attributed to one of ${succeeded.length ? succeeded.join(', ') : 'them'} and cannot count as an independent source.`

  // The domain the run was pointed at, with `www.` folded off it the same way
  // `normaliseEntityValue` folds it — otherwise `www.example.com` would be proposed as a
  // discovery of `example.com`, which is the entity the operator already has.
  const apex = (env.target ?? '').trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '')
  const alreadyProposed = new Set<string>()

  let totalResults = 0
  const perFieldCounts: string[] = []
  if (results) {
    for (const field of RESULT_FIELDS) {
      const values = toStringList(results[field.key])
      if (!values.length) continue
      totalResults += values.length
      perFieldCounts.push(`${group(values.length)} ${values.length === 1 ? field.singular : field.plural}`)
      for (const value of values.slice(0, MAX_PER_FIELD)) {
        const finding = makeFinding(raw, {
          source: attribution,
          claim: `theHarvester found the ${field.singular} ${value} for ${env.target}.${attributionNote}`
        })
        findings.push(finding)

        // Only the values that became findings can become proposals: a proposal must cite
        // a finding this run produced, and the ones past MAX_PER_FIELD have none.
        const spec = field.proposes
        if (!spec) continue
        const proposed = spec.value(value, apex)
        if (!proposed) continue
        const key = `${spec.kind}\u0000${proposed.toLowerCase()}`
        if (alreadyProposed.has(key)) continue
        alreadyProposed.add(key)
        proposals.push({
          fromFindingId: finding.id,
          kind: spec.kind,
          value: proposed,
          rationale: spec.rationale(proposed, env.target)
        })
      }
      if (values.length > MAX_PER_FIELD) {
        findings.push(
          makeFinding(raw, {
            source: localSource(ID),
            claim: `theHarvester returned ${group(values.length)} ${field.plural} for ${env.target}; the first ${MAX_PER_FIELD} were turned into findings and all of them are in the raw capture.`
          })
        )
      }
    }
  }

  findings.push(runSummaryFinding(raw, env, { summary, succeeded, failed, totalResults, perFieldCounts, haveResults: Boolean(results) }))
  return { findings, proposals }
}

/* ------------------------------------------------------------------ *
 * What each result kind has to look like before it is worth proposing
 * ------------------------------------------------------------------ */

/** An address, whole. `admin@` and `name@ * .com` are results worth recording and not addresses. */
function emailValue(raw: string): string | null {
  const v = raw.trim()
  if (v.length > 254) return null
  return /^[^\s@*]+@[^\s@*]+\.[A-Za-z]{2,}$/.test(v) ? v : null
}

/** One DNS label: letters, digits, hyphen, and the underscore that service records use. */
const HOST_LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/

/**
 * A hostname, whole, and not the domain the run was pointed at.
 *
 * theHarvester writes a resolved host as `name:address`. The name is the part that is a
 * domain; the address, when there is one, arrives in `ips` on its own.
 */
function hostValue(raw: string, apex: string): string | null {
  let v = raw.trim().toLowerCase().replace(/\.+$/, '')
  const colon = v.indexOf(':')
  if (colon > 0) v = v.slice(0, colon)
  if (!v || v.length > 253) return null
  if (apex && (v === apex || v === `www.${apex}`)) return null
  const labels = v.split('.')
  if (labels.length < 2) return null
  return labels.every((l) => l.length > 0 && l.length <= 63 && HOST_LABEL.test(l)) ? v : null
}

/** An address, v4 or v6. `0.0.0.0` is what a resolver writes when it has nothing. */
function ipValue(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v)
  if (m) {
    if (v === '0.0.0.0') return null
    return m.slice(1, 5).every((o) => Number(o) <= 255) ? v : null
  }
  if (/^(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/.test(v)) return v
  if (v.includes('::') && /^[0-9a-f:]{2,45}$/.test(v)) return v
  return null
}

/**
 * A person's name and nothing else.
 *
 * LinkedIn results arrive as anything from `Jane Doe` to `Jane Doe - Head of Platform at
 * Acme`. The second is a job title with a name attached, and cutting it down to the name
 * would be this adapter deciding where the name ends. Two to four name-shaped words, no
 * digits, no separator that marks a title: everything else stays a finding.
 */
const NAME_SHAPE = /^\p{L}[\p{L}\p{M}'’.-]*(?: \p{L}[\p{L}\p{M}'’.-]*){1,3}$/u

function personValue(raw: string): string | null {
  const v = raw.trim().replace(/\s+/g, ' ')
  if (!v || v.length > 80) return null
  if (/[0-9@|]| - | at |,/i.test(v)) return null
  return NAME_SHAPE.test(v) ? v : null
}

/** How many values of one kind become individual findings. The rest stay in the raw file. */
const MAX_PER_FIELD = 100

function readSummary(jsonl: string | undefined): HarvesterSummary | null {
  if (!jsonl) return null
  // The file is JSON Lines; the run summary is the record with type "summary". Taking the
  // last parseable object is the robust reading — a truncated final line is skipped.
  let found: HarvesterSummary | null = null
  for (const line of jsonl.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const rec = parseJsonSafe<HarvesterSummary & { type?: string }>(t)
    if (!rec) continue
    if (rec.type === 'summary' || Array.isArray(rec.source_executions)) found = rec
  }
  return found
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const s = o['host'] ?? o['ip'] ?? o['url'] ?? o['email'] ?? o['name']
      if (typeof s === 'string' && s.trim()) out.push(s.trim())
    }
  }
  return out
}

function runSummaryFinding(
  raw: RawResult,
  env: RunEnvelope,
  ctx: {
    summary: HarvesterSummary | null
    succeeded: string[]
    failed: string[]
    totalResults: number
    perFieldCounts: string[]
    haveResults: boolean
  }
): Finding {
  const evidence = ctx.summary?.evidence_status ? ` theHarvester rated its own evidence "${ctx.summary.evidence_status}".` : ''
  const breakdown = ctx.perFieldCounts.length ? ` Returned ${ctx.perFieldCounts.join(', ')}.` : ' Returned nothing.'
  const brokenNote = ctx.failed.length
    ? ` ${ctx.failed.length} of ${ctx.succeeded.length + ctx.failed.length} sources did not complete (${ctx.failed.join(', ')}), so "nothing found" here does not mean "nothing exists" — it means those sources were not consulted successfully.`
    : ''
  const unreadable = ctx.haveResults ? '' : ' The results file could not be read as JSON; only the run summary was interpreted.'
  return makeFinding(raw, {
    source: localSource(ID),
    claim:
      `theHarvester queried ${group(ctx.succeeded.length + ctx.failed.length)} sources about ${env.target} in ${(env.durationMs / 1000).toFixed(1)} s.` +
      `${breakdown}${brokenNote}${evidence}${unreadable} theHarvester exits 0 even when every source fails, so its exit code (${env.exitCode}) is not evidence of anything.`
  })
}

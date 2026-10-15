/**
 * `subfinder` — domain -> subdomains, from passive sources only.
 *
 * The strongest tool in the Phase 0 set by result count: 24,948 subdomains for one domain
 * in 55 seconds, with zero API keys, in clean JSON Lines.
 *
 * **It writes 5 KB of config to `C:\Users\<you>\AppData\Roaming\subfinder\` on first run**
 * — it is a Go program calling `os.UserHomeDir()`. Overriding `USERPROFILE` did not
 * relocate it. Both paths *are* overridable per invocation, so this adapter always passes
 * `-config` and `-pc` pointing inside the toolkit root, and creates that directory first.
 *
 * Two smaller traps, both from the report: `-json` emits **one object per line**, not a
 * JSON array — never `JSON.parse` the whole thing — and piping its stdout into a
 * truncating reader produces SIGPIPE, which surfaces as a misleading exit code 1.
 */

import path from 'node:path'
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
  parseJsonLines,
  readEnvelope,
  recordSpawn,
  stderrSummary,
  type RunEnvelope
} from './support/envelope'
import { dataSourceOrigin, localSource } from './support/sources'
import {
  checkBinary,
  ensureFile,
  mergedOptions,
  optionBoolean,
  optionList,
  optionNumber,
  osintEnv,
  resolveBinary
} from './support/toolkit'

const ID = 'subfinder'
const VERSION = '1.0.0'
const BIN_CANDIDATES = ['bin/subfinder.exe', 'bin/subfinder'] as const

interface SubfinderRecord {
  host?: string
  input?: string
  source?: string
  /** Present when `-cs` is passed: every source that reported this host. */
  sources?: string[]
}

export const subfinderAdapter: Adapter = {
  id: ID,
  title: 'subfinder (domain → subdomains, passive)',
  version: VERSION,

  accepts: ['domain'],
  produces: ['domain'],

  requiresKey: false,
  requiresNetwork: true,

  concurrency: 1,
  minIntervalMs: 5_000,
  defaultTimeoutMs: 300_000,

  doc: {
    what: 'Enumerates subdomains of a domain by asking around thirty public datasets that already recorded them, without sending a single request to the target.',

    how: 'It queries passive sources in parallel and merges what they return. The three that carry a keyless run are certificate transparency (crt.sh and Certspotter publish every TLS certificate ever issued, and a certificate names the hosts it is valid for), passive DNS aggregators (AlienVault OTX, Anubis and others record the answers they have seen to real DNS queries over the years), and web-scale crawl indexes (Common Crawl and the Wayback Machine have URLs, and a URL contains a hostname). Nothing is guessed and nothing is brute-forced by default: it is entirely a set of API calls to third parties, so the target sees no traffic at all. Each result carries the source that supplied it, which this adapter turns into the finding\'s source so that two aggregators reporting the same host can genuinely corroborate each other.',

    why: 'A subdomain is where the interesting things live — the staging server, the admin panel, the forgotten VPN concentrator, the intern\'s demo — and organisations defend the apex domain while forgetting the rest. They cannot hide them, because two systems publish them involuntarily. Certificate transparency is mandatory for a publicly trusted certificate, so the moment a host gets HTTPS, its name is in a public append-only log forever, including hosts that were never linked from anywhere. Passive DNS is the same effect from the other direction: every resolver that ever answered for the host contributed a record. The consequence is that "we never published that hostname" has not been a defence since about 2018.',

    betterAt: 'Volume, speed, silence and cost. It is the only tool here that returns tens of thousands of results with no key and no configuration, it finishes in under a minute, and because every query goes to a third party the target has no way to know it was enumerated. Compared with theHarvester on the same domain in the same session it returned 24,948 hosts against zero. Compared with amass, which was cut from this toolbelt, it produces parseable output at all — amass v5 removed JSON output and returned nothing.',

    worseAt: 'Telling you what is real. It returns names, never confirmation: it does not resolve anything unless asked, so a large fraction of a 25,000-host result is historical, decommissioned, or belongs to a wildcard record. It only finds what somebody already published, so a purely internal host with no certificate and no public DNS history is invisible to it. It gives you no addresses, no ownership and no service information. And it does exactly one thing — for emails, people or content, it is the wrong tool entirely.',

    falsePositives: 'The dominant failure is a wildcard DNS record: a domain answering `*.example.com` with a single address means every name anyone ever probed or mistyped ends up in the passive-DNS datasets, and thousands of them come back as "subdomains" that were never provisioned by anybody. Certificate transparency contributes its own noise — a certificate issued once in 2019 for a host that has not existed since is still in the log and will still be returned, and multi-SAN certificates from shared hosting name other customers\' domains alongside yours. Some aggregators also return records for domains that merely *contain* your domain as a substring. None of this is detectable from a passive run, which is why the results are worth exactly as much as the resolution step you do afterwards, and why every finding here is a claim that a name was recorded somewhere, not that a host exists.'
  },

  check(ctx) {
    return checkBinary(
      ctx.config,
      ctx.toolkitRoot,
      ID,
      BIN_CANDIDATES,
      'Download the prebuilt binary from https://github.com/projectdiscovery/subfinder/releases into <toolkitRoot>\\bin\\ (you do not need Go).'
    )
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)
    const target = input.entity.value
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })

    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN_CANDIDATES)

    // Both config paths default into C:\Users\<you>\AppData\Roaming\subfinder\. Pointing
    // them at the toolkit root is the only reliable way to keep the OS profile clean —
    // overriding USERPROFILE/HOME was tested in Phase 0 and did not relocate them.
    // Both files must EXIST before the spawn: subfinder auto-creates its config only at
    // the default AppData path, and refuses to start ("Could not read config") when
    // `-config` names a file that is not there. An empty YAML file is a valid config.
    const configDir = path.join(ctx.toolkitRoot, 'config')
    const configFile = path.join(configDir, 'subfinder-config.yaml')
    const providerFile = path.join(configDir, 'subfinder-provider-config.yaml')
    await ensureFile(configFile)
    await ensureFile(providerFile)

    const args: string[] = [
      '-d',
      target,
      '-oJ',
      '-silent',
      '-nc',
      // Include every source that reported each host, so two aggregators agreeing becomes
      // two findings with distinct sources and can actually corroborate.
      '-cs',
      // No self-update check: a network call on every run, and it can write to disk.
      '-duc',
      '-config',
      configFile,
      '-pc',
      providerFile,
      '-timeout',
      String(optionNumber(options, 'sourceTimeoutSeconds', 30, { min: 5, max: 120 })),
      '-max-time',
      String(optionNumber(options, 'maxMinutes', 5, { min: 1, max: 30 }))
    ]
    const maxPerSource = optionNumber(options, 'maxResultsPerSource', 0, { min: 0, max: 100_000 })
    if (maxPerSource > 0) args.push('-mr', String(maxPerSource))
    const sources = optionList(options, 'sources', [])
    if (sources.length) args.push('-s', sources.join(','))
    const exclude = optionList(options, 'excludeSources', [])
    if (exclude.length) args.push('-es', exclude.join(','))
    if (optionBoolean(options, 'allSources', false)) args.push('-all')

    ctx.progress({ pct: 10, note: `querying passive sources for ${target}` })

    const res = await ctx.spawn(bin.file, {
      args,
      env: osintEnv(ctx.toolkitRoot),
      timeoutMs: ctx.timeoutMs
    })
    recordSpawn(env, { file: bin.file, args }, res)

    // JSONL on stdout, so there is no artifact file to collect. It is kept in `stdout`
    // exactly as emitted; the envelope is the artifact.
    const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim()).length
    env.notes.push(`${lines} JSON Lines record(s) captured from stdout.`)
    if (res.truncated) {
      env.notes.push('Output hit the orchestrator cap and was truncated; the final line may be incomplete.')
    }

    return finishEnvelope(env, {
      caseId: input.caseId,
      // Exit code 1 has been observed from SIGPIPE alone, so the presence of output is the
      // better test. Zero results with a clean exit is still a successful run to interpret.
      ok: lines > 0 || res.exitCode === 0,
      error: res.spawnError
        ? `subfinder did not run: ${res.spawnError}`
        : `subfinder exited ${res.exitCode} with no output. ${stderrSummary(env)}`,
      finishedAt: ctx.now(),
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * Each discovered hostname as a candidate `domain`, once, no matter how many
   * aggregators reported it.
   *
   * The apex the run was pointed at is excluded: it is already in the graph, and
   * proposing it would put a row in the review queue whose only possible outcome is
   * "yes, that is the thing I typed". Everything else is named exactly as strongly as the
   * tool knows it — a name that was published somewhere, once, possibly years ago,
   * possibly by a wildcard record that never corresponded to a host at all.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/**
 * One walk of the JSON Lines, producing the findings and the proposals together.
 *
 * Only hosts inside the finding cap can be proposed: a proposal must cite a finding this
 * run produced, and the orchestrator drops one that cites anything else. Hosts beyond the
 * cap stay in the raw capture and come back on a re-parse with a larger cap, which is the
 * same bargain the findings already make.
 */
function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const { records, badLines } = parseJsonLines<SubfinderRecord>(env.stdout)
  const hosts = new Set<string>()
  const sourceCounts = new Map<string, number>()
  const pairs: { host: string; source: string }[] = []

  for (const rec of records) {
    const host = (rec?.host ?? '').trim().toLowerCase()
    if (!host) continue
    hosts.add(host)
    const names = Array.isArray(rec.sources) && rec.sources.length ? rec.sources : rec.source ? [rec.source] : []
    if (!names.length) {
      // subfinder ran without `-collect-sources`, or the record carries none. Nothing
      // outside this machine is named, so the claim is sourced as what it actually is:
      // this tool's own output. `Finding.source` is the corroboration key and may never
      // hold a program's name — `subfinder(unattributed)` read as a real independent
      // source, so two unattributed records corroborated each other and neither had a
      // source at all.
      pairs.push({ host, source: localSource(ID) })
      continue
    }
    for (const name of names) {
      const key = (name ?? '').trim().toLowerCase()
      if (!key) continue
      sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1)
      pairs.push({ host, source: dataSourceOrigin(key) })
    }
  }

  const cap = MAX_FINDINGS
  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  // `www.` is folded off the apex the same way `normaliseEntityValue` folds it, so
  // `www.example.com` is recognised as the entity the run was already pointed at rather
  // than proposed as a discovery of it.
  const apex = (env.target ?? '').trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '')
  const proposed = new Set<string>()

  for (const pair of pairs.slice(0, cap)) {
    const finding = makeFinding(raw, {
      source: pair.source,
      claim: `The hostname ${pair.host} is recorded as a subdomain of ${env.target}. This is a record that the name was published, not confirmation that the host resolves or answers today.`
    })
    findings.push(finding)

    if (proposed.has(pair.host) || !isProposableHost(pair.host, apex)) continue
    proposed.add(pair.host)
    const under = apex ? pair.host.endsWith(`.${apex}`) : false
    proposals.push({
      fromFindingId: finding.id,
      kind: 'domain',
      value: pair.host,
      attrs: { apex, firstReportedBy: pair.source },
      rationale: under
        ? `${pair.source} holds a record of this name under ${apex}. A published name, not a live host — a wildcard record puts every name anyone ever mistyped into these datasets, and a certificate issued once in 2019 is still in the log.`
        : `${pair.source} returned this name for a query about ${apex}, but it does not sit under ${apex}. Some aggregators match a domain as a substring, so this may belong to somebody else entirely.`
    })
  }

  findings.push(
    summaryFinding(raw, env, {
      hosts: hosts.size,
      pairs: pairs.length,
      emitted: Math.min(pairs.length, cap),
      badLines,
      sourceCounts
    })
  )
  return { findings, proposals }
}

/** One DNS label: letters, digits, hyphen, and the underscore that service records use. */
const HOST_LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/

/**
 * Is this string a hostname worth putting in front of an operator?
 *
 * Rejected: the apex itself (already in the graph), a wildcard record (`*.example.com` is
 * a DNS configuration, not a host), and anything that is not shaped like a dotted
 * hostname. Passive datasets carry all three.
 */
function isProposableHost(host: string, apex: string): boolean {
  if (!host || host.length > 253) return false
  if (apex && (host === apex || host === `www.${apex}`)) return false
  const labels = host.split('.')
  if (labels.length < 2) return false
  return labels.every((l) => l.length > 0 && l.length <= 63 && HOST_LABEL.test(l))
}

/**
 * A 25,000-host result is real and must be kept, but turning it into 25,000 rows in
 * `findings.jsonl` would make the case file unusable for the sake of a list nobody reads
 * in that form. Every host stays in the raw capture; a bounded slice becomes findings,
 * and the summary says exactly how many were left behind.
 */
const MAX_FINDINGS = 500

function summaryFinding(
  raw: RawResult,
  env: RunEnvelope,
  stats: { hosts: number; pairs: number; emitted: number; badLines: number; sourceCounts: Map<string, number> }
): Finding {
  const bySource = [...stats.sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([s, n]) => `${s} ${group(n)}`)
    .join(', ')
  const omitted =
    stats.pairs > stats.emitted
      ? ` ${group(stats.pairs - stats.emitted)} host/source pairs were not turned into findings to keep the case file readable; every one of them is in the raw capture and can be re-parsed.`
      : ''
  const bad = stats.badLines ? ` ${group(stats.badLines)} output line(s) could not be parsed and were skipped.` : ''
  const truncated = env.truncated ? ' The capture was truncated at the output cap, so this count is a lower bound.' : ''
  return makeFinding(raw, {
    source: localSource(ID),
    claim:
      `subfinder found ${group(stats.hosts)} distinct subdomain${stats.hosts === 1 ? '' : 's'} of ${env.target} in ${(env.durationMs / 1000).toFixed(1)} s from passive sources` +
      `${bySource ? ` (${bySource})` : ''}. No traffic was sent to ${env.target} itself.${omitted}${bad}${truncated}`
  })
}

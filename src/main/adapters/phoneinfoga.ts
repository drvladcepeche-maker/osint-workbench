import type { Finding } from '../../shared/types'
import { makeFinding, type Adapter, type AdapterContext, type AdapterInput, type RawResult } from './types'
import { beginEnvelope, finishEnvelope, readEnvelope, recordSpawn, stderrSummary } from './support/envelope'
import { localSource } from './support/sources'
import { checkBinary, mergedOptions, optionBoolean, osintEnv, resolveBinary } from './support/toolkit'

const ID = 'phoneinfoga'
const VERSION = '1.0.0'
const BIN = ['bin/phoneinfoga/phoneinfoga.exe', 'bin/phoneinfoga.exe', 'bin/phoneinfoga'] as const

export const phoneinfogaAdapter: Adapter = {
  id: ID,
  title: 'PhoneInfoga (phone → local metadata and search links)',
  version: VERSION,
  accepts: ['phone'],
  produces: [],
  requiresKey: false,
  requiresNetwork: false,
  concurrency: 1,
  minIntervalMs: 5000,
  defaultTimeoutMs: 60000,
  doc: {
    what: 'Parses an international phone number into national and E.164 formats, reports numbering-plan metadata and prepares public search links. It is a phone-number annotation tool, not a subscriber lookup or a location tracker.',
    how: 'Runs PhoneInfoga with its local parser and Google query-link generator only. Numverify, OVH and Google Custom Search scanners are explicitly disabled on every invocation, even if credentials happen to exist in the environment. Generated links are stored as leads for a person to inspect later; this adapter never opens them or sends the number to a search engine.',
    why: 'Country calling codes and national numbering plans provide useful format and allocation metadata without establishing who owns or physically carries a phone. Number portability, roaming, virtual-number services and reassignment break the intuitive link between a prefix, a carrier and a person. The adapter records only what the numbering metadata supports and leaves identity claims to independently reviewed evidence.',
    betterAt: 'Normalising an international number, separating national and E.164 forms, identifying its numbering country and preparing reproducible search queries without disclosing the number to a search provider during this adapter run. This is useful as a first, low-impact enrichment step before a human decides whether to open any search link.',
    worseAt: 'Identifying a subscriber, proving current carrier ownership, locating a handset or determining who uses a recycled or shared number. A numbering prefix can be ported, and a displayed carrier label can be absent or outdated. The generated Google URLs contain no search results and cannot establish that a number appears on any page.',
    falsePositives: 'Numbering metadata describes an allocation plan, not a subscriber or current location. Search links are only queries; matching pages may be stale, unrelated, quote the number in passing or refer to another person. A generated query is not evidence that a result exists, and no person, account or address is inferred from the links.'
  },
  check(ctx) {
    return checkBinary(ctx.config, ctx.toolkitRoot, ID, BIN,
      'Install the verified release into <toolkitRoot>\\bin\\phoneinfoga\\phoneinfoga.exe.')
  },
  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const opts = mergedOptions(ctx.config, ID, input.options)
    const target = input.entity.value
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target, startedAt })
    const bin = resolveBinary(ctx.config, ctx.toolkitRoot, ID, BIN)
    const args = ['scan', '-n', target]
    for (const scanner of ['numverify', 'ovh', 'googlecse']) args.push('-D', scanner)
    if (!optionBoolean(opts, 'includeDorks', true)) args.push('-D', 'googlesearch')
    const res = await ctx.spawn(bin.file, {
      args,
      env: osintEnv(ctx.toolkitRoot, { NUMVERIFY_API_KEY: '', GOOGLE_API_KEY: '', GOOGLECSE_CX: '' }),
      timeoutMs: ctx.timeoutMs
    })
    recordSpawn(env, { file: bin.file, args }, res)
    const local = res.stdout.split(/Results for local/i)[1] ?? ''
    const links = (res.stdout.match(/^\s*URL:\s+https?:\/\//gim) ?? []).length
    env.notes.push('Generated search links: ' + links + '.')
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: res.exitCode === 0 && !!local,
      error: res.spawnError ? 'PhoneInfoga did not run: ' + res.spawnError :
        'PhoneInfoga exited ' + res.exitCode + ' without local metadata. ' + stderrSummary(env),
      finishedAt: ctx.now(),
      startedMs
    })
  },
  parse(raw: RawResult): Finding[] {
    const env = readEnvelope(raw)
    if (!env || !raw.ok) return []
    const text = env.stdout
    const local = text.split(/Results for local/i)[1] ?? ''
    const section = local.split(/\n\s*\n|^\s*\d+ scanner\(s\) succeeded/m)[0] ?? local
    const labels: Record<string, string> = {
      'Raw local': 'raw national format', Local: 'national format', E164: 'E.164 format',
      International: 'international format', Country: 'numbering country',
      Carrier: 'carrier label', 'Line type': 'line type'
    }
    const findings: Finding[] = []
    for (const line of section.split(/\r?\n/)) {
      const m = line.match(/^\s*(Raw local|Local|E164|International|Country|Carrier|Line type):\s*(.+?)\s*$/i)
      if (m) findings.push(makeFinding(raw, {
        source: localSource(ID),
        claim: 'PhoneInfoga local parser reports ' + (labels[m[1]] ?? m[1]) + ' "' + m[2] +
          '". This is numbering metadata, not subscriber identity or physical location.'
      }))
    }
    // Keep the generated queries available as openable evidence, but never confuse them
    // with search results. Group by PhoneInfoga's own dork category to avoid one finding
    // per URL while retaining every link for deliberate manual review.
    const linksByCategory = new Map<string, string[]>()
    let inGoogleSearch = false
    let category = 'General'
    for (const line of text.split(/\r?\n/)) {
      const heading = line.match(/^\s*Results for\s+(.+)\s*$/i)
      if (heading) {
        inGoogleSearch = heading[1].trim().toLowerCase() === 'googlesearch'
        continue
      }
      if (!inGoogleSearch) continue
      const group = line.match(/^\s*(Social media|Disposable providers|Reputation|Individuals|General):\s*$/i)
      if (group) {
        category = group[1]
        continue
      }
      const url = line.match(/^\s*URL:\s+(https?:\/\/\S+)/i)?.[1]
      if (!url) continue
      const bucket = linksByCategory.get(category) ?? []
      bucket.push(url)
      linksByCategory.set(category, bucket)
    }
    for (const [group, urls] of linksByCategory) {
      findings.push(makeFinding(raw, {
        source: localSource(ID),
        claim: 'PhoneInfoga generated ' + urls.length + ' Google search URL(s) in the "' + group +
          '" category for manual review: ' + urls.join(' ; ') +
          '. These are query links, not search results or evidence; they were generated locally and were not opened or submitted.'
      }))
    }
    return findings
  }
}

/**
 * Adapter tests.
 *
 * Two halves, and the first one matters more than it looks.
 *
 * **1. The doc gate with teeth.** `AdapterRegistry.register()` already refuses an empty
 * doc field, but its floor is twelve characters — enough to stop `TODO`, nowhere near
 * enough to stop `how: 'checks a bunch of sites'`. A doc that technically passes while
 * saying nothing is worse than a crash, because a crash is visible and filler is not: the
 * whole product is "understand the mechanism", and the UI renders these six fields beside
 * every result. So the tests here enforce real lengths per field, reject a `how` that
 * merely restates `what`, reject marketing filler, and reject two adapters sharing the
 * same text.
 *
 * **2. `parse()` against real captured output.** Every fixture in
 * `test/fixtures/adapters/` is genuine output from the Phase 0 smoke runs (targets:
 * `torvalds`, `example.com`, `test@example.com` — no personal data anywhere), or a live
 * capture from a free keyless API. Two exceptions are marked `SYNTHETIC` in the filename
 * and explained where they are used. Because `parse()` is pure, none of this touches the
 * network.
 *
 * Each parser is exercised on four shapes: normal output, zero results, malformed or
 * truncated output, and a run where the tool errored partway.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { builtInAdapters, registerBuiltInAdapters } from '../src/main/adapters'
import { AdapterRegistry, finaliseFinding, type Adapter, type RawResult } from '../src/main/adapters/types'
import type { RunEnvelope } from '../src/main/adapters/support/envelope'
import { readEnvelope } from '../src/main/adapters/support/envelope'
import { parseCsv, pyBool } from '../src/main/adapters/support/csv'
import {
  buildWmnIndex,
  transcribeWmnIndex,
  WMN_ARTIFACT,
  type WmnSiteRecord
} from '../src/main/adapters/support/matcher'
import { dataSourceOrigin, hostOf, localSource, siteOrigin } from '../src/main/adapters/support/sources'
import { fusedPunctuation } from '../src/shared/links'
import { analyseActivity, harvestTimestamps, toDate } from '../src/main/adapters/support/activity'
import { independenceKey } from '../src/shared/confidence'
import { ADAPTER_DOC_FIELDS, type AdapterDoc, type Finding } from '../src/shared/types'

export interface AdapterTest {
  name: string
  fn: () => void | Promise<void>
}

export const adapterTests: AdapterTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  adapterTests.push({ name, fn })
}

/* ------------------------------------------------------------------ *
 * Fixtures and helpers
 * ------------------------------------------------------------------ */

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'adapters')

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

const T0 = '2026-08-30T13:00:00.000Z'
const T1 = '2026-08-30T13:00:05.000Z'

/** Build the `RawResult` an orchestrator would hand `parse()`, from a partial envelope. */
function rawFrom(adapterId: string, env: Partial<RunEnvelope>, over: Partial<RawResult> = {}): RawResult {
  const full: RunEnvelope = {
    adapter: adapterId,
    adapterVersion: '1.0.0',
    entityId: 'ent_test',
    entityKind: 'username',
    target: 'torvalds',
    startedAt: T0,
    finishedAt: T1,
    durationMs: 5_000,
    command: { file: 'tool.exe', args: [] },
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    spawnError: null,
    stdout: '',
    stderr: '',
    artifacts: {},
    notes: [],
    ...env
  }
  return {
    adapterId,
    caseId: 'c1',
    entityId: full.entityId,
    ok: true,
    exitCode: full.exitCode,
    signal: full.signal,
    stdout: JSON.stringify(full, null, 2),
    stderr: full.stderr,
    mediaType: 'application/json',
    startedAt: full.startedAt,
    finishedAt: full.finishedAt,
    durationMs: full.durationMs,
    truncated: full.truncated,
    timedOut: full.timedOut,
    command: full.command,
    error: null,
    raw: {
      rawId: 'raw_test',
      path: 'raw/raw_test.json',
      sha256: 'deadbeef',
      bytes: 1,
      mediaType: 'application/json',
      excerpt: ''
    },
    ...over
  }
}

function adapter(id: string): Adapter {
  const found = builtInAdapters().find((a) => a.id === id)
  assert.ok(found, `no adapter registered with id "${id}"`)
  return found
}

/** Run a parser and assert every finding it produced is contract-legal. */
/**
 * A duration written into a claim, as the tools write one: `in 7 s`, `after 412 ms`.
 *
 * Whitespace before the unit is required so a year written as `1990s` is not caught. The
 * unit list is the one the adapters in this directory actually emit.
 */
const DURATION_IN_CLAIM = /\b\d+(?:[.,]\d+)?\s+(?:ms|s|sec|secs|seconds)\b/i

function parseChecked(id: string, raw: RawResult): Finding[] {
  const findings = adapter(id).parse(raw)
  for (const f of findings) {
    const final = finaliseFinding(id, raw, f)
    assert.equal(final.confidence, 'unverified')
    assert.ok(final.source.trim(), `${id} produced a finding with no source`)
    assert.ok(final.claim.trim(), `${id} produced a finding with an empty claim`)
    assert.ok(final.claim.length > 20, `${id} produced a suspiciously short claim: ${final.claim}`)
    /* A claim is an identity: `findingId` hashes it, so anything in it that changes from
       one run to the next mints a second finding for the same assertion instead of
       refreshing the first. Sherlock ending every claim with "Answered in 0.77 s." made a
       level's claim count climb with the number of times it had been run, which the
       operator reads as the seed's effect. A `local:` run note is the exception and the
       only one: it is a summary *of the run*, excluded from every count of claims about
       the subject, and describing the run is the whole of what it is for. */
    if (!final.source.trim().toLowerCase().startsWith('local:')) {
      assert.ok(
        !DURATION_IN_CLAIM.test(final.claim),
        `${id} put a per-run duration inside an identity-bearing claim, so every re-run will mint a new finding: ${final.claim}`
      )
    }
  }
  return findings
}

function claims(findings: readonly Finding[]): string {
  return findings.map((f) => f.claim).join('\n')
}

function sourcesOf(findings: readonly Finding[]): Set<string> {
  return new Set(findings.map((f) => f.source))
}

/* ------------------------------------------------------------------ *
 * 1. The doc gate, with teeth
 * ------------------------------------------------------------------ */

/**
 * Per-field minimums. Far above the registry's 12-character floor, because the registry
 * exists to catch an empty field and this exists to catch a lazy one. The numbers are set
 * just under what the shortest honest field in the app actually needs, so they fail on
 * filler rather than on brevity.
 */
const DOC_MINIMUMS: Record<keyof AdapterDoc, number> = {
  what: 90,
  how: 200,
  why: 240,
  betterAt: 150,
  worseAt: 150,
  falsePositives: 250
}

/** Phrases that mean nothing. A doc field containing one of these is selling, not explaining. */
const FILLER = [
  'state of the art',
  'state-of-the-art',
  'cutting edge',
  'cutting-edge',
  'powerful tool',
  'easy to use',
  'seamlessly',
  'leverages the power',
  'industry standard',
  'best in class',
  'simply put',
  'and much more',
  'etc.'
]

test('every registered adapter passes the strict doc gate, not just the registry floor', () => {
  const registry = new AdapterRegistry()
  registerBuiltInAdapters(registry)
  assert.ok(registry.size() >= 13, `expected the full adapter set to register, got ${registry.size()}`)

  for (const a of registry.list()) {
    const doc = a.doc as unknown as Record<string, string>
    for (const field of ADAPTER_DOC_FIELDS) {
      const value = doc[field]
      assert.equal(typeof value, 'string', `${a.id}.doc.${field} is missing`)
      const text = (value ?? '').trim()
      const min = DOC_MINIMUMS[field]
      assert.ok(
        text.length >= min,
        `${a.id}.doc.${field} is ${text.length} characters; at least ${min} are needed to describe a mechanism rather than name one.`
      )
      const lower = text.toLowerCase()
      for (const phrase of FILLER) {
        assert.ok(!lower.includes(phrase), `${a.id}.doc.${field} contains marketing filler: "${phrase}"`)
      }
      // A field that is one sentence fragment is a label, not an explanation.
      assert.ok(/[.!?]/.test(text), `${a.id}.doc.${field} has no sentence in it`)
    }
    assert.notEqual(doc['how'], doc['what'], `${a.id}.doc.how just repeats doc.what`)
    assert.ok(
      !(doc['how'] ?? '').startsWith((doc['what'] ?? '').slice(0, 60)),
      `${a.id}.doc.how opens by restating doc.what`
    )
    assert.notEqual(doc['betterAt'], doc['worseAt'], `${a.id} has identical betterAt and worseAt`)
  }
})

test('no two adapters share doc text (catches copy-paste between adapters)', () => {
  const seen = new Map<string, string>()
  for (const a of builtInAdapters()) {
    const doc = a.doc as unknown as Record<string, string>
    for (const field of ADAPTER_DOC_FIELDS) {
      const key = `${field}::${(doc[field] ?? '').trim().toLowerCase()}`
      const previous = seen.get(key)
      assert.equal(previous, undefined, `${a.id}.doc.${field} is identical to ${previous}.doc.${field}`)
      seen.set(key, a.id)
    }
  }
})

test('the maigret and sherlock docs actually compare the two, as the operator asked', () => {
  const m = maigretDoc()
  const s = sherlockDoc()
  assert.ok(/sherlock/i.test(`${m.betterAt} ${m.worseAt} ${m.falsePositives}`), 'maigret doc never mentions Sherlock')
  assert.ok(/maigret/i.test(`${s.betterAt} ${s.worseAt} ${s.falsePositives}`), 'sherlock doc never mentions Maigret')
  // Both must be honest about the shared, unsolved false-positive class.
  for (const [id, doc] of [
    ['maigret', m],
    ['sherlock', s]
  ] as const) {
    assert.ok(
      /cloudflare|anti-bot|bot protection|soft 404|soft-404/i.test(doc.falsePositives),
      `${id}.doc.falsePositives does not mention the anti-bot / soft-404 failure class`
    )
  }
})

function maigretDoc(): AdapterDoc {
  return adapter('maigret').doc
}
function sherlockDoc(): AdapterDoc {
  return adapter('sherlock').doc
}

test('adapter metadata is coherent: ids, accepts, network flags, no paid keys', () => {
  for (const a of builtInAdapters()) {
    assert.ok(/^[a-z0-9][a-z0-9._-]*$/.test(a.id), `${a.id} is not a filename-safe id`)
    assert.ok(a.accepts.length > 0, `${a.id} accepts nothing`)
    assert.equal(a.requiresKey, false, `${a.id} requires a key; DECISIONS.md rules out paid services`)
    assert.ok(a.version, `${a.id} has no version`)
  }
  // The two adapters that must work with no network at all.
  assert.equal(adapter('exiftool').requiresNetwork, false)
  assert.equal(adapter('pattern-timezone').requiresNetwork, false)
})

test('every parser survives garbage without throwing', () => {
  const garbage: RawResult[] = [
    rawFrom('x', {}, { stdout: '' }),
    rawFrom('x', {}, { stdout: 'not json at all' }),
    rawFrom('x', {}, { stdout: '{"adapter":' }),
    rawFrom('x', {}, { stdout: '[]' }),
    rawFrom('x', {}, { stdout: 'null' })
  ]
  for (const a of builtInAdapters()) {
    for (const raw of garbage) {
      const findings = a.parse({ ...raw, adapterId: a.id })
      assert.ok(Array.isArray(findings), `${a.id}.parse did not return an array`)
    }
  }
})

/* ------------------------------------------------------------------ *
 * 2. Support: source normalisation — the corroboration guard
 * ------------------------------------------------------------------ */

test('siteOrigin folds the three username tools onto ONE source per site', () => {
  // This is the regression test for the app's worst failure mode: three wrappers around
  // the same site list appearing to be three independent confirmations.
  const maigretUrl = 'https://github.com/torvalds'
  const sherlockUrl = 'https://www.github.com/torvalds'
  const blackbirdUrl = 'https://api.github.com/users/torvalds'
  const keys = new Set([maigretUrl, sherlockUrl, blackbirdUrl].map((u) => independenceKey(siteOrigin(u))))
  assert.equal(keys.size, 1, `expected one independence key, got ${[...keys].join(', ')}`)
  assert.equal([...keys][0], 'github.com')
})

test('siteOrigin folds user subdomains to the platform but keeps distinct sites apart', () => {
  assert.equal(siteOrigin('https://torvalds.wordpress.com/'), 'wordpress.com')
  assert.equal(siteOrigin('https://public-api.wordpress.com/rest/v1.1/sites/torvalds.wordpress.com'), 'wordpress.com')
  assert.equal(siteOrigin('https://www.habbo.es/api/public/users?name=torvalds'), 'habbo.es')
  assert.equal(siteOrigin('https://www.habbo.de/api/public/users?name=torvalds'), 'habbo.de')
  assert.notEqual(siteOrigin('https://habbo.es/x'), siteOrigin('https://habbo.de/x'))
  // Multi-label public suffixes must not collapse to the suffix itself.
  assert.equal(siteOrigin('https://mail.example.co.uk/x'), 'example.co.uk')
  assert.equal(siteOrigin('https://example.com.bg'), 'example.com.bg')
  // An address has no registrable domain to fold to.
  assert.equal(siteOrigin('http://192.0.2.10:8080/x'), '192.0.2.10')
  assert.equal(siteOrigin(''), '')
})

test('a local: source can never be counted as an independent site', () => {
  const key = independenceKey(localSource('maigret'))
  assert.equal(key, 'local:maigret')
  assert.notEqual(key, independenceKey('github.com'))
  // And it must not be parseable as a hostname, or two derived claims could corroborate.
  assert.notEqual(key, hostOf('maigret'))
})

test('data source names map to the host that served them, across tools', () => {
  // subfinder's `crtsh` and theHarvester's `crtsh` are one certificate-log frontend.
  assert.equal(dataSourceOrigin('crtsh'), 'crt.sh')
  assert.equal(independenceKey(dataSourceOrigin('crtsh')), independenceKey(dataSourceOrigin('CRTSH')))
  assert.notEqual(dataSourceOrigin('crtsh'), dataSourceOrigin('certspotter'))
  // Unknown names pass through rather than being guessed at.
  assert.equal(dataSourceOrigin('some-new-source'), 'some-new-source')
})

/* ------------------------------------------------------------------ *
 * 3. Support: CSV, dates, activity analysis
 * ------------------------------------------------------------------ */

test('CSV parsing survives quoted commas, doubled quotes, CRLF and ragged rows', () => {
  const table = parseCsv('a,b,c\r\n1,"two, and a half","he said ""hi"""\r\n4,5\r\n')
  assert.deepEqual(table.header, ['a', 'b', 'c'])
  assert.equal(table.rows.length, 2)
  assert.equal(table.rows[0]?.['b'], 'two, and a half')
  assert.equal(table.rows[0]?.['c'], 'he said "hi"')
  assert.equal(table.rows[1]?.['c'], '', 'a short row is padded, not dropped')
  assert.equal(table.raggedRows, 1)

  assert.equal(parseCsv('').rows.length, 0)
  assert.equal(parseCsv('only,a,header\n').rows.length, 0, 'a header-only file is zero rows, not an error')
})

test('Python booleans in CSV: blank is not false', () => {
  assert.equal(pyBool('True'), true)
  assert.equal(pyBool('false'), false)
  assert.equal(pyBool(''), null, '"the field was blank" must not collapse into "the tool said no"')
  assert.equal(pyBool(undefined), null)
})

test('toDate accepts epoch seconds, epoch millis, ISO and the EXIF colon format', () => {
  assert.equal(toDate(1_756_000_000)?.toISOString(), new Date(1_756_000_000_000).toISOString())
  assert.equal(toDate(1_756_000_000_000)?.toISOString(), new Date(1_756_000_000_000).toISOString())
  assert.equal(toDate('2026-08-30T13:00:00Z')?.toISOString(), '2026-08-30T13:00:00.000Z')
  assert.equal(toDate('2026:08:30 16:44:37')?.getUTCFullYear(), 2026)
  assert.equal(toDate('not a date'), null)
  assert.equal(toDate(0), null)
  assert.equal(toDate('1970-01-01T00:00:00Z'), null, 'an epoch-zero artefact is not activity')
})

test('activity analysis finds the sleep gap and refuses to guess when there is none', () => {
  // Zero activity in UTC hours 22,23,0,1,2,3 — a subject whose local night is 01:00-07:00
  // at UTC+3.
  const dates: Date[] = []
  for (let day = 0; day < 7; day++) {
    for (const hour of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) {
      dates.push(new Date(Date.UTC(2026, 6, 1 + day, hour, 15, 0)))
    }
  }
  const analysis = analyseActivity(dates)
  assert.equal(analysis.usable, true, analysis.quality)
  assert.equal(analysis.offsetHours, 3, `expected UTC+3, got ${analysis.offsetHours}`)
  assert.equal(analysis.samples, dates.length)
  assert.equal(analysis.hourHistogram[0], 0)
  assert.ok((analysis.hourHistogram[12] ?? 0) > 0)

  // A flat, round-the-clock histogram is a bot or a shared account. No offset is claimed.
  const flat: Date[] = []
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) flat.push(new Date(Date.UTC(2026, 6, 1 + day, hour, 0, 0)))
  }
  const flatAnalysis = analyseActivity(flat)
  assert.equal(flatAnalysis.usable, false)
  assert.ok(/around the clock|no sleep gap/i.test(flatAnalysis.quality), flatAnalysis.quality)

  // Too few samples: also refused, with a different reason.
  const few = analyseActivity(dates.slice(0, 10))
  assert.equal(few.usable, false)
  assert.ok(/below|noise/i.test(few.quality), few.quality)
})

test('timestamp harvesting is a whitelist, not "anything date-shaped"', () => {
  const doc = {
    children: [{ data: { created_utc: 1_756_000_000, subreddit: 'linux' } }],
    copyright_year: '2011-01-01T00:00:00Z',
    cache: { expires_at_epoch: 1_756_000_000 }
  }
  const found = harvestTimestamps(doc, 'test')
  assert.equal(found.length, 1, 'only whitelisted keys must be harvested')
  assert.ok(found[0]?.path.endsWith('created_utc'))
})

/* ------------------------------------------------------------------ *
 * 4. parse() against real captured output — one adapter at a time
 * ------------------------------------------------------------------ */

/* ---- maigret ---- */

test('maigret: parses the real report_torvalds_simple.json', () => {
  const findings = parseChecked(
    'maigret',
    rawFrom('maigret', { artifacts: { 'report_torvalds_simple.json': fixture('maigret-report.json') } })
  )
  const text = claims(findings)
  assert.ok(findings.length >= 17, `expected at least 17 findings, got ${findings.length}`)
  assert.ok(sourcesOf(findings).has('github.com'), 'the GitHub hit must be attributed to github.com')
  // The scraped identity fields are the reason to run Maigret rather than Sherlock.
  assert.ok(text.includes('Linus Torvalds'), 'the extracted display name must become its own finding')
  assert.ok(text.includes('Portland, OR'), 'the extracted location must become its own finding')
  assert.ok(text.includes('Linux Foundation'), 'the extracted employer must become its own finding')
  assert.ok(/probed 16 sites/.test(text), 'the summary must state how many sites were probed')
  assert.ok(sourcesOf(findings).has(localSource('maigret')), 'the run summary must be a local: source')
})

test('maigret: zero results, a broken report, and a blocked run each say something true', () => {
  const empty = parseChecked('maigret', rawFrom('maigret', { artifacts: { 'report_x_simple.json': '{}' } }))
  assert.equal(empty.length, 1)
  assert.ok(/probed 0 sites/.test(empty[0]?.claim ?? ''))

  const truncated = parseChecked(
    'maigret',
    rawFrom('maigret', { artifacts: { 'report_x_simple.json': fixture('maigret-report.json').slice(0, 4000) } })
  )
  assert.equal(truncated.length, 1)
  assert.ok(/could not be read as JSON/i.test(truncated[0]?.claim ?? ''), truncated[0]?.claim)

  const blocked = parseChecked(
    'maigret',
    rawFrom('maigret', {
      artifacts: { 'report_x_simple.json': blockedMaigretReport() },
      stderr: 'Too many errors of type "Bot protection" (34.21%). Try to switch to another ip address'
    })
  )
  const text = claims(blocked)
  assert.ok(/not checked/i.test(text), 'unresolved sites must be reported as unchecked, not as absent')
  assert.ok(/bot-protection/i.test(text), 'a blocked run must say the negatives are untrustworthy')
})

/** A real report shape with every site left unresolved — what a blocked run looks like. */
function blockedMaigretReport(): string {
  const report: Record<string, unknown> = {}
  for (const site of ['GitHub', 'Reddit', 'Instagram', 'Twitter']) {
    report[site] = {
      url_user: `https://${site.toLowerCase()}.com/torvalds`,
      http_status: 403,
      status: { site_name: site, url: `https://${site.toLowerCase()}.com/torvalds`, status: 'Unknown', ids: {} }
    }
  }
  return JSON.stringify(report)
}

/* ---- sherlock ---- */

test('sherlock: parses the real torvalds.csv and folds www. onto the site domain', () => {
  const findings = parseChecked(
    'sherlock',
    rawFrom('sherlock', {
      artifacts: { 'torvalds.csv': fixture('sherlock-torvalds.csv') },
      stdout: '[*] Search completed with 2 results'
    })
  )
  assert.equal(findings.length, 3, 'two hits plus the run summary')
  const sources = sourcesOf(findings)
  assert.ok(sources.has('github.com'), `expected github.com, got ${[...sources].join(', ')}`)
  assert.ok(sources.has('reddit.com'))
  assert.ok(/2 claimed/.test(claims(findings)))
})

/**
 * The same site, twice, with a different response time and a different status code.
 *
 * A finding's id is content-addressed over `(caseId, entityId, tool, source, claim)`, so a
 * measurement of the run inside the claim gives the same assertion a different identity
 * every time it is re-observed: `upsertFinding` inserts instead of refreshing,
 * `lastVerified` never leaves `null`, and the claim count grows roughly linearly with the
 * number of re-runs. That in turn makes the re-scan's whole three-bucket apparatus
 * meaningless, because nothing can ever be recognised as the same claim twice.
 */
test('sherlock: the same hit keeps its identity across runs that were timed differently', () => {
  const base = fixture('sherlock-torvalds.csv')
  // The last two columns are `http_status` and `response_time_s`, and both are
  // measurements of one run. `\r?` because the fixture is a real capture off Windows.
  const rerun = base
    .split('\n')
    .map((line, i) => (i === 0 || !line.trim() ? line : line.replace(/,\d+,[\d.]+(\r?)$/, ',201,1.94813$1')))
    .join('\n')
  assert.notEqual(rerun, base, 'the second run must actually differ, or this test proves nothing')

  const first = parseChecked('sherlock', rawFrom('sherlock', { artifacts: { 'torvalds.csv': base } }))
  const second = parseChecked('sherlock', rawFrom('sherlock', { artifacts: { 'torvalds.csv': rerun } }))

  const perSite = (fs: readonly Finding[]): string[] =>
    fs.filter((f) => !f.source.startsWith('local:')).map((f) => f.claim).sort()
  assert.deepEqual(perSite(second), perSite(first), 'a re-run must refresh the same claims, not mint new ones')

  const github = second.find((f) => f.source === 'github.com')
  assert.ok(github, 'the fixture has a github row')
  assert.ok(
    (github?.matcher?.reasons ?? []).some((r) => /most recent run/i.test(r) && /201/.test(r)),
    `the measurement is not lost, it moves to the matcher: ${JSON.stringify(github?.matcher?.reasons)}`
  )
})

test('sherlock: a zero-result run reports zero rather than nothing', () => {
  const findings = parseChecked(
    'sherlock',
    rawFrom('sherlock', {
      target: 'zzqx9v7nonexistentuser',
      artifacts: { 'zzqx9v7nonexistentuser.csv': 'username,name,url_main,url_user,exists,http_status,response_time_s\n' },
      stdout: fixture('sherlock-noresult-stdout.txt')
    })
  )
  assert.equal(findings.length, 1)
  assert.ok(/0 claimed/.test(findings[0]?.claim ?? ''), findings[0]?.claim)
})

test('sherlock: a CSV that disagrees with sherlock own tally is reported as incomplete', () => {
  const truncated = fixture('sherlock-torvalds.csv').split('\n').slice(0, 2).join('\n')
  const findings = parseChecked(
    'sherlock',
    rawFrom('sherlock', {
      artifacts: { 'torvalds.csv': truncated },
      stdout: '[*] Search completed with 2 results'
    })
  )
  assert.ok(/this capture is incomplete/i.test(claims(findings)), claims(findings))
})

test('sherlock: a run that produced no CSV at all still yields an honest summary', () => {
  const findings = parseChecked(
    'sherlock',
    rawFrom('sherlock', { artifacts: {}, exitCode: 1, stderr: "Error: Desired sites not found: 'NotARealSite123'." })
  )
  assert.equal(findings.length, 1)
  assert.ok(/no CSV rows/i.test(findings[0]?.claim ?? ''), findings[0]?.claim)
})

/* ---- blackbird ---- */

test('blackbird: parses the real 90-hit report including extracted metadata', () => {
  const findings = parseChecked(
    'blackbird',
    rawFrom('blackbird', { artifacts: { 'torvalds_08_30_2026_blackbird.json': fixture('blackbird-report.json') } })
  )
  assert.ok(findings.length >= 91, `expected at least 91 findings, got ${findings.length}`)
  const text = claims(findings)
  assert.ok(text.includes('Codeforces'))
  assert.ok(/Duolingo exposes "Courses"/.test(text), 'extracted metadata must become its own finding')
  // api.github.com must fold to github.com so it cannot corroborate maigret's github hit.
  assert.ok(sourcesOf(findings).has('github.com'))
  assert.ok(/says nothing about the sites that did not/i.test(text), 'absence of evidence must be flagged')
})

test('blackbird: zero hits, a non-array report, and a missing report', () => {
  const zero = parseChecked('blackbird', rawFrom('blackbird', { artifacts: { 'x_blackbird.json': '[]' } }))
  assert.equal(zero.length, 1)
  assert.ok(/reported 0 accounts/.test(zero[0]?.claim ?? ''))

  const notArray = parseChecked('blackbird', rawFrom('blackbird', { artifacts: { 'x_blackbird.json': '{"error":true}' } }))
  assert.ok(/not a JSON array/i.test(notArray[0]?.claim ?? ''))

  const missing = parseChecked('blackbird', rawFrom('blackbird', { artifacts: {}, stderr: 'Traceback (most recent call last)' }))
  assert.ok(/not a JSON array/i.test(missing[0]?.claim ?? ''), missing[0]?.claim)
})

/* ---- matcher quality, and the wording of an account-existence claim ---- */

/**
 * A slice of the real WhatsMyName catalogue, in the shape `run()` transcribes into the
 * envelope. Real entries: `GitHub (User)` probes `api.github.com/users/{account}` and
 * checks a marker inside the returned user object; `Pikabu` probes
 * `https://pikabu.ru/ajax.php`, which contains no handle at all.
 */
const WMN_FIXTURE: WmnSiteRecord[] = [
  {
    name: 'GitHub (User)',
    uriCheck: 'https://api.github.com/users/{account}',
    uriPretty: 'https://github.com/{account}',
    eCode: 200,
    hasEString: true,
    protection: ['user-agent']
  },
  {
    name: 'Reddit',
    uriCheck: 'https://www.reddit.com/user/{account}/about.json',
    uriPretty: 'https://www.reddit.com/user/{account}',
    eCode: 200,
    hasEString: true,
    protection: []
  },
  {
    name: 'Pikabu',
    uriCheck: 'https://pikabu.ru/ajax.php',
    uriPretty: 'https://pikabu.ru/@{account}',
    eCode: 200,
    hasEString: true,
    protection: ['ddos-guard']
  },
  {
    name: 'Codeforces',
    uriCheck: 'https://codeforces.com/api/user.info?handles={account}',
    uriPretty: 'https://codeforces.com/profile/{account}',
    eCode: 200,
    hasEString: true,
    protection: []
  }
]

function wmnArtifact(): string {
  return transcribeWmnIndex(buildWmnIndex(WMN_FIXTURE, 'test://wmn-data.json'))
}

/**
 * Framing that would turn "a handle is taken here" into "this is the subject's account".
 *
 * The distinction is the entire point: `exampleuser` on Roblox may be a stranger, and this
 * repo's own Instagram fixture returns `Marco Migozzi` for the handle `torvalds`.
 */
const POSSESSIVE_FRAMING = /\b(?:his|her|their|your)\b|belongs to|owned by|the subject's/i

/** The one shape an account-existence claim is allowed to take. */
const EXISTENCE_SHAPE = /\ban account (?:named|registered to) "[^"]+" exists on \S/

test('a username hit claims a name is taken, and never that the account is the subject\'s', () => {
  const wmn = wmnArtifact()
  const maigret = parseChecked(
    'maigret',
    rawFrom('maigret', {
      artifacts: { 'report_torvalds_simple.json': fixture('maigret-report.json'), [WMN_ARTIFACT]: wmn }
    })
  )
  const sherlock = parseChecked(
    'sherlock',
    rawFrom('sherlock', {
      artifacts: { 'torvalds.csv': fixture('sherlock-torvalds.csv'), [WMN_ARTIFACT]: wmn },
      stdout: '[*] Search completed with 2 results'
    })
  )
  const blackbird = parseChecked(
    'blackbird',
    rawFrom('blackbird', {
      artifacts: { 'torvalds_08_30_2026_blackbird.json': fixture('blackbird-report.json'), [WMN_ARTIFACT]: wmn }
    })
  )

  // The exact fact-shape, per adapter, on the one site all three of them found.
  const github = (fs: readonly Finding[]): Finding =>
    fs.find((f) => f.source === 'github.com' && EXISTENCE_SHAPE.test(f.claim)) as Finding
  assert.ok(
    /^Maigret reports that an account named "torvalds" exists on GitHub\. .*Profile: https:\/\/github\.com\/torvalds$/s.test(
      github(maigret)?.claim ?? ''
    ),
    github(maigret)?.claim
  )
  assert.ok(
    /^Sherlock reports that an account named "torvalds" exists on GitHub\. .*Profile: https:\/\/www\.github\.com\/torvalds$/s.test(
      github(sherlock)?.claim ?? ''
    ),
    github(sherlock)?.claim
  )
  assert.ok(
    /^Blackbird reports that an account named "torvalds" exists on GitHub/.test(github(blackbird)?.claim ?? ''),
    github(blackbird)?.claim
  )

  for (const [id, findings] of [
    ['maigret', maigret],
    ['sherlock', sherlock],
    ['blackbird', blackbird]
  ] as const) {
    const hits = findings.filter((f) => EXISTENCE_SHAPE.test(f.claim))
    assert.ok(hits.length > 0, `${id} produced no account-existence claim at all`)
    for (const f of hits) {
      assert.ok(
        /Who holds that account is a separate question this probe does not answer\./.test(f.claim),
        `${id} states existence without separating it from ownership: ${f.claim}`
      )
    }
    for (const f of findings) {
      assert.equal(
        POSSESSIVE_FRAMING.test(f.claim),
        false,
        `${id} implied the account is the subject's: ${f.claim}`
      )
      assert.equal(/found a claimed account|found an account for/.test(f.claim), false, `${id} kept the old wording: ${f.claim}`)
      // A full stop touching an address is copied along with it and breaks the link. The
      // renderer trims it on the way to a click; this keeps the claim *text* right in the
      // clipboard, in an export, and in a grep. See shared/links.ts.
      assert.deepEqual(
        fusedPunctuation(f.claim),
        [],
        `${id} left sentence punctuation fused to a URL: ${f.claim}`
      )
    }
  }
})

test('a weak probe writes its own weakness into the claim; a strong one leaves it alone', () => {
  const weak = parseChecked(
    'maigret',
    rawFrom('maigret', {
      target: 'exampleuser',
      artifacts: {
        'report_exampleuser_simple.json': JSON.stringify({
          Pikabu: {
            url_user: 'https://pikabu.ru/@exampleuser',
            http_status: 200,
            status: { site_name: 'Pikabu', url: 'https://pikabu.ru/@exampleuser', status: 'Claimed', ids: {} }
          }
        }),
        [WMN_ARTIFACT]: wmnArtifact()
      }
    })
  )
  const hit = weak.find((f) => f.source === 'pikabu.ru') as Finding
  assert.ok(hit, 'the hit must still be reported — the operator wants to see it, correctly labelled')
  assert.equal(hit.matcher?.strength, 'weak')
  assert.equal(hit.matcher?.label, 'weak matcher')
  assert.ok(/does not name a user/i.test(hit.claim), `the claim itself must say why it is weak: ${hit.claim}`)
  assert.ok(
    hit.matcher?.reasons.some((r) => r.includes('https://pikabu.ru/ajax.php')),
    'the reasons must quote the URL that was actually requested, not the pretty one'
  )

  const strong = parseChecked(
    'sherlock',
    rawFrom('sherlock', {
      artifacts: { 'torvalds.csv': fixture('sherlock-torvalds.csv'), [WMN_ARTIFACT]: wmnArtifact() },
      stdout: '[*] Search completed with 2 results'
    })
  )
  const github = strong.find((f) => f.source === 'github.com') as Finding
  assert.equal(github.matcher?.strength, 'strong')
  assert.ok(!/weak|does not name a user/i.test(github.claim), `a strong probe must not be apologised for: ${github.claim}`)
})

test('the matcher describes the probe, not the subject: derived claims carry none and ids ignore it', () => {
  const withCatalogue = parseChecked(
    'sherlock',
    rawFrom('sherlock', {
      artifacts: { 'torvalds.csv': fixture('sherlock-torvalds.csv'), [WMN_ARTIFACT]: wmnArtifact() },
      stdout: '[*] Search completed with 2 results'
    })
  )
  const without = parseChecked(
    'sherlock',
    rawFrom('sherlock', {
      artifacts: { 'torvalds.csv': fixture('sherlock-torvalds.csv') },
      stdout: '[*] Search completed with 2 results'
    })
  )

  // A run summary probed nothing, so it gets no badge at all.
  const summary = withCatalogue.find((f) => f.source === localSource('sherlock')) as Finding
  assert.ok(summary)
  assert.equal(summary.matcher ?? null, null, 'a derived claim must never carry a probe badge')

  // The catalogue changes the explanation and must not change the identity.
  const a = withCatalogue.find((f) => f.source === 'github.com') as Finding
  const b = without.find((f) => f.source === 'github.com') as Finding
  assert.equal(a.id, b.id, 'the finding id must not depend on the matcher, or a reclassification would fork the row')
  assert.equal(a.matcher?.strength, 'strong')
  assert.equal(b.matcher?.label, 'unknown matcher', 'no catalogue means unchecked, not fine')
  assert.equal(a.claim, b.claim, 'a strong probe reads the same either way')
})

/* ---- holehe ---- */

test('holehe: the real all-rate-limited capture is reported as no signal, not as no accounts', () => {
  const findings = parseChecked(
    'holehe',
    rawFrom('holehe', {
      entityKind: 'email',
      target: 'test@example.com',
      artifacts: { 'holehe_1788097561_test@example.com_results.csv': fixture('holehe-results.csv') }
    })
  )
  assert.equal(findings.length, 1, 'a fully rate-limited run must produce no account findings at all')
  const claim = findings[0]?.claim ?? ''
  assert.ok(/did not answer/.test(claim), claim)
  assert.ok(/essentially no signal/i.test(claim), 'the >80% rate-limited case must be called out')
  assert.ok(/unchecked, not clear/.test(claim))
})

test('holehe: a registered address yields the account plus its masked recovery hints', () => {
  // Derived from the real CSV by flipping one row to the shape holehe writes on a hit.
  const rows = fixture('holehe-results.csv').split(/\r?\n/)
  const header = rows[0] as string
  const hit = 'imgur,imgur.com,password recovery,False,False,True,te****@e*****.com,+33 6 ** ** ** 12,'
  const findings = parseChecked(
    'holehe',
    rawFrom('holehe', {
      entityKind: 'email',
      target: 'test@example.com',
      artifacts: { 'holehe_1_results.csv': `${header}\n${hit}\n${rows[1]}\n` }
    })
  )
  const text = claims(findings)
  assert.ok(/an account is registered to test@example\.com on imgur/.test(text), text)
  assert.ok(/password recovery flow/.test(text), 'the method that produced the answer must be stated')
  assert.ok(/te\*\*\*\*@e\*\*\*\*\*\.com/.test(text), 'the masked recovery address must become its own finding')
  assert.ok(/masked recovery phone number/.test(text))
  assert.ok(sourcesOf(findings).has('imgur.com'))
})

test('holehe: an empty CSV concludes nothing rather than concluding absence', () => {
  const findings = parseChecked('holehe', rawFrom('holehe', { entityKind: 'email', artifacts: { 'x.csv': '' } }))
  assert.equal(findings.length, 1)
  assert.ok(/nothing can be concluded/i.test(findings[0]?.claim ?? ''), findings[0]?.claim)
})

/* ---- theHarvester ---- */

test('theHarvester: per-source telemetry becomes findings, so a broken source is visible', () => {
  const findings = parseChecked(
    'theharvester',
    rawFrom('theharvester', {
      entityKind: 'domain',
      target: 'example.com',
      artifacts: { 'harvest.json': fixture('theharvester.json'), 'harvest.jsonl': fixture('theharvester.jsonl') }
    })
  )
  const text = claims(findings)
  // The real capture has duckduckgo completing with nothing and crtsh failing on HTTP 502.
  assert.ok(/duckduckgo completed and returned 0 results/.test(text), text)
  assert.ok(/crtsh did NOT complete \(failed, http-502\)/.test(text), text)
  assert.ok(/is missing from this run/.test(text), 'a failed source must be flagged as a gap, not a negative')
  assert.ok(/exit code \(0\) is not evidence/.test(text), 'the useless exit code must be called out')
  const sources = sourcesOf(findings)
  assert.ok(sources.has('crt.sh'), `expected crt.sh, got ${[...sources].join(', ')}`)
  assert.ok(sources.has('duckduckgo.com'))
})

test('theHarvester: results are attributed to the single successful source when there is one', () => {
  const summary = {
    type: 'summary',
    target: 'example.com',
    evidence_status: 'complete',
    source_executions: [{ source: 'crtsh', status: 'completed', stop_reason: 'exhausted', result_count: 2, duration_ms: 900 }]
  }
  const results = { cmd: '-d example.com', hosts: ['mail.example.com', 'vpn.example.com'], emails: ['a@example.com'] }
  const findings = parseChecked(
    'theharvester',
    rawFrom('theharvester', {
      entityKind: 'domain',
      target: 'example.com',
      artifacts: { 'harvest.json': JSON.stringify(results), 'harvest.jsonl': JSON.stringify(summary) }
    })
  )
  const text = claims(findings)
  assert.ok(/found the hostname mail\.example\.com/.test(text), text)
  assert.ok(/found the email address a@example\.com/.test(text), text)
  assert.ok(sourcesOf(findings).has('crt.sh'))
  assert.ok(!/cannot be attributed/.test(text), 'with one successful source, attribution is unambiguous')
})

test('theHarvester: a truncated jsonl still yields whatever the json held', () => {
  const findings = parseChecked(
    'theharvester',
    rawFrom('theharvester', {
      entityKind: 'domain',
      target: 'example.com',
      artifacts: { 'harvest.json': '{"hosts":["a.example.com"]}', 'harvest.jsonl': '{"type":"summ' }
    })
  )
  assert.ok(/a\.example\.com/.test(claims(findings)))
  assert.ok(/queried 0 sources/.test(claims(findings)))
})

/* ---- subfinder ---- */

test('subfinder: parses real JSONL and attributes each host to the aggregator that served it', () => {
  const findings = parseChecked(
    'subfinder',
    rawFrom('subfinder', { entityKind: 'domain', target: 'example.com', stdout: fixture('subfinder.jsonl') })
  )
  assert.ok(findings.length >= 100, `expected many findings, got ${findings.length}`)
  const sources = sourcesOf(findings)
  assert.ok(sources.has('jldc.me'), `anubis must map to its host; got ${[...sources].slice(0, 5).join(', ')}`)
  const summary = findings[findings.length - 1]?.claim ?? ''
  assert.ok(/distinct subdomains of example\.com/.test(summary), summary)
  assert.ok(/No traffic was sent to example\.com itself/.test(summary))
  assert.ok(/was published, not confirmation/.test(claims(findings)), 'each host claim must not assert the host is live')
})

test('subfinder: multiple sources for one host become separate, corroborable findings', () => {
  const stdout = [
    JSON.stringify({ host: 'vpn.example.com', input: 'example.com', sources: ['crtsh', 'certspotter'] }),
    JSON.stringify({ host: 'mail.example.com', input: 'example.com', sources: ['crtsh'] })
  ].join('\n')
  const findings = parseChecked('subfinder', rawFrom('subfinder', { entityKind: 'domain', target: 'example.com', stdout }))
  const vpn = findings.filter((f) => f.claim.includes('vpn.example.com'))
  assert.equal(vpn.length, 2, 'two aggregators reporting one host must be two findings')
  assert.deepEqual(
    new Set(vpn.map((f) => independenceKey(f.source))),
    new Set(['crt.sh', 'certspotter.com']),
    'and they must have distinct independence keys, so corroboration is possible'
  )
})

test('subfinder: a truncated final line costs one line, not the file', () => {
  const lines = fixture('subfinder.jsonl').split('\n').slice(0, 20)
  const stdout = `${lines.join('\n')}\n{"host":"trunc`
  const findings = parseChecked('subfinder', rawFrom('subfinder', { entityKind: 'domain', target: 'example.com', stdout, truncated: true }))
  const summary = findings[findings.length - 1]?.claim ?? ''
  assert.ok(/1 output line\(s\) could not be parsed/.test(summary), summary)
  assert.ok(/lower bound/.test(summary), 'a truncated capture must be flagged as a lower bound')
  assert.ok(findings.length >= 20)
})

test('subfinder: zero results is a statement, not a failure', () => {
  const findings = parseChecked('subfinder', rawFrom('subfinder', { entityKind: 'domain', target: 'example.com', stdout: '' }))
  assert.equal(findings.length, 1)
  assert.ok(/found 0 distinct subdomains/.test(findings[0]?.claim ?? ''))
})

/* ---- exiftool ---- */

test('exiftool: parses the real capture and flags a file with nothing left in it', () => {
  const findings = parseChecked(
    'exiftool',
    rawFrom('exiftool', { entityKind: 'image', target: 'testimg.jpg', stdout: fixture('exiftool.json') })
  )
  const text = claims(findings)
  assert.ok(/read 24 tags from testimg\.jpg/.test(text), text)
  assert.ok(/JPEG, 64x48/.test(text))
  // The Phase 0 test image carries only container tags — no camera block, no GPS, no
  // editing history. That is what a file looks like after a platform has stripped it, and
  // the parser must say so rather than reporting "nothing found".
  assert.ok(/Only container-level tags are present/.test(text), text)
  assert.ok(/says nothing about the original/.test(text))
  assert.ok(sourcesOf(findings).has(localSource('exiftool')))
})

test('exiftool: GPS, camera identity, editing software and serial numbers each become findings', () => {
  const record = [
    {
      SourceFile: '/photos/IMG_0042.jpg',
      FileName: 'IMG_0042.jpg',
      FileType: 'JPEG',
      Make: 'Apple',
      Model: 'iPhone 14 Pro',
      Software: 'Adobe Photoshop 25.0',
      DateTimeOriginal: '2026:07:04 19:22:11',
      OffsetTimeOriginal: '+03:00',
      SerialNumber: 'C02XY1234567',
      Artist: 'A Photographer',
      GPSPosition: '+48.85840000 +2.29450000',
      GPSAltitude: '31 m',
      ImageSize: '4032x3024'
    }
  ]
  const findings = parseChecked(
    'exiftool',
    rawFrom('exiftool', { entityKind: 'image', target: 'IMG_0042.jpg', stdout: JSON.stringify(record) })
  )
  const text = claims(findings)
  assert.ok(/48\.858400,2\.294500/.test(text), `GPS not extracted: ${text}`)
  assert.ok(/Apple iPhone 14 Pro/.test(text))
  assert.ok(/Adobe Photoshop 25\.0/.test(text))
  assert.ok(/not a straight-from-camera original/.test(text), 'editing software must be flagged as a tampering signal')
  assert.ok(/C02XY1234567/.test(text))
  assert.ok(/UTC offset \+03:00/.test(text), 'the capture-time zone offset is a location leak and must surface')
  assert.ok(/trivially forgeable/.test(text), 'the summary must warn that every field is a claim')
  assert.ok(sourcesOf(findings).has('file:IMG_0042.jpg'), 'file-derived claims are sourced to the file itself')
})

test('exiftool: an unreadable file and a malformed payload produce an honest note, not a crash', () => {
  const failed = parseChecked(
    'exiftool',
    rawFrom('exiftool', { entityKind: 'image', target: 'missing.jpg', stdout: '', stderr: 'Error: File not found - missing.jpg', exitCode: 1 })
  )
  assert.equal(failed.length, 1)
  assert.ok(/no readable metadata/i.test(failed[0]?.claim ?? ''))
  assert.ok(/File not found/.test(failed[0]?.claim ?? ''), 'the reason must travel with the claim')

  const truncated = parseChecked(
    'exiftool',
    rawFrom('exiftool', { entityKind: 'image', target: 'x.jpg', stdout: fixture('exiftool.json').slice(0, 200) })
  )
  assert.equal(truncated.length, 1)
  assert.ok(/no readable metadata/i.test(truncated[0]?.claim ?? ''))
})

/* ---- gallery-dl ---- */

test('gallery-dl: parses the real simulate-mode dump', () => {
  const findings = parseChecked(
    'gallery-dl',
    rawFrom('gallery-dl', {
      entityKind: 'image',
      target: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
      stdout: fixture('gallery-dl.json')
    })
  )
  const text = claims(findings)
  assert.ok(/serves a media file/.test(text), text)
  assert.ok(/without downloading anything/.test(text), 'the summary must say nothing was downloaded')
  assert.ok(sourcesOf(findings).has('wikimedia.org'))
})

test('gallery-dl: uploader metadata becomes findings; an auth failure does not', () => {
  const dump = [
    [2, { category: 'reddit', username: 'example_operator', date: '2026-07-04 19:22:11' }],
    [3, 'https://i.redd.it/abc.jpg', { category: 'reddit', username: 'example_operator', title: 'A picture of a cat' }]
  ]
  const findings = parseChecked(
    'gallery-dl',
    rawFrom('gallery-dl', { entityKind: 'account', target: 'https://www.reddit.com/user/example_operator', stdout: JSON.stringify(dump) })
  )
  const text = claims(findings)
  assert.ok(/attributes this media to the account "example_operator"/.test(text), text)
  assert.ok(/titles this item "A picture of a cat"/.test(text))

  const failed = parseChecked(
    'gallery-dl',
    rawFrom('gallery-dl', {
      entityKind: 'account',
      target: 'https://www.instagram.com/someone',
      stdout: '',
      stderr: '[instagram][error] HttpError: 401 Unauthorized',
      exitCode: 1
    })
  )
  assert.equal(failed.length, 1)
  assert.ok(/not a JSON array/i.test(failed[0]?.claim ?? ''))
  assert.ok(/401 Unauthorized/.test(failed[0]?.claim ?? ''))
})

/* ---- wayback ---- */

test('wayback: parses a live CDX capture into a history with a first and last snapshot', () => {
  const findings = parseChecked(
    'wayback',
    rawFrom('wayback', {
      entityKind: 'domain',
      target: 'example.com',
      stdout: fixture('wayback-cdx.json'),
      command: { file: 'GET', args: ['https://web.archive.org/cdx/search/cdx?url=example.com&limit=200'] }
    })
  )
  const text = claims(findings)
  assert.ok(/indexed captures matching example\.com/.test(text), text)
  assert.ok(/The earliest archived capture/.test(text))
  assert.ok(/The most recent archived capture/.test(text))
  assert.ok(/web\.archive\.org\/web\/\d{14}\//.test(text), 'a retrievable snapshot URL must be given')
  assert.ok(/crawl dates, not publication dates/.test(text), 'the crawl-vs-publication caveat must be stated')
  assert.ok(sourcesOf(findings).has('web.archive.org'))
})

test('wayback: no captures is a statement about coverage, not an absence of history', () => {
  for (const body of ['', '[]', '[["timestamp","original"]]']) {
    const findings = parseChecked('wayback', rawFrom('wayback', { entityKind: 'domain', target: 'nowhere.example', stdout: body }))
    assert.equal(findings.length, 1)
    assert.ok(/holds no captures/.test(findings[0]?.claim ?? ''))
    assert.ok(/not that nothing was ever published/.test(findings[0]?.claim ?? ''))
  }
})

test('wayback: a malformed CDX response is preserved rather than interpreted', () => {
  const findings = parseChecked('wayback', rawFrom('wayback', { entityKind: 'domain', target: 'example.com', stdout: '<html>502 Bad Gateway' }))
  assert.equal(findings.length, 1)
  assert.ok(/could not be read as JSON/i.test(findings[0]?.claim ?? ''))
  assert.ok(/can be re-parsed/.test(findings[0]?.claim ?? ''))
})

test('wayback: hitting the requested row limit is reported as a lower bound', () => {
  const rows: unknown[][] = [['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length']]
  for (let i = 0; i < 5; i++) {
    rows.push([`2020010${i}120000`, `http://example.com/${i}`, 'text/html', '200', `D${i}`, '100'])
  }
  const findings = parseChecked(
    'wayback',
    rawFrom('wayback', {
      entityKind: 'domain',
      target: 'example.com',
      stdout: JSON.stringify(rows),
      command: { file: 'GET', args: ['https://web.archive.org/cdx/search/cdx?url=example.com&limit=5'] }
    })
  )
  assert.ok(/hit the requested limit of 5 rows/.test(claims(findings)), claims(findings))
})

/* ---- reddit-profile ---- */

test('reddit-profile: derives identity, histogram, timezone, subreddits and vocabulary', () => {
  // SYNTHETIC fixtures: Reddit's keyless JSON answered HTTP 403 from this machine for
  // every endpoint tried (see the adapter header), so the success path is exercised
  // against documents built to Reddit's documented listing schema, with a known-good
  // shape — no activity in UTC hours 22-03, which must read as UTC+3.
  const findings = parseChecked(
    'reddit-profile',
    rawFrom('reddit-profile', {
      target: 'example_operator',
      artifacts: {
        'about.json': fixture('reddit-about-SYNTHETIC.json'),
        'comments-1.json': fixture('reddit-comments-SYNTHETIC.json'),
        '_http.json': JSON.stringify({ 'about.json': 200, 'comments-1.json': 200 })
      }
    })
  )
  const text = claims(findings)
  assert.ok(/permanent internal id t2_a1b2c3/.test(text), text)
  assert.ok(/created 2014-03-17/.test(text))
  assert.ok(/moderator of at least one subreddit/.test(text))
  assert.ok(/Kernel bugs and coffee/.test(text), 'the profile text must be captured')
  assert.ok(/Activity by UTC hour: 00:0/.test(text), 'the raw histogram must be in a claim')
  assert.ok(/local clock at about UTC\+3/.test(text), `timezone estimate wrong: ${text}`)
  assert.ok(/±2 hours/.test(text), 'the uncertainty must travel with the estimate')
  assert.ok(/a band of countries, not a city/.test(text))
  assert.ok(/posted \d+ of 126 captured items in r\/linux/.test(text), text)
  assert.ok(/most frequent non-stopword terms/.test(text))
  // Every derived claim must be a local: source so it cannot corroborate a real one.
  const derived = findings.filter((f) => /UTC\+3|frequent non-stopword/.test(f.claim))
  assert.ok(derived.length > 0)
  for (const f of derived) assert.equal(f.source, localSource('reddit-profile'))
})

test('reddit-profile: a 403 block page is a refusal aimed at us, not a fact about the account', () => {
  const findings = parseChecked(
    'reddit-profile',
    rawFrom('reddit-profile', {
      target: 'example_operator',
      artifacts: {
        'about.json.error.html': fixture('reddit-blocked-403.html'),
        '_http.json': JSON.stringify({ 'about.json': 403 })
      },
      stderr: 'about.json: HTTP 403\n'
    })
  )
  assert.equal(findings.length, 1)
  const claim = findings[0]?.claim ?? ''
  assert.ok(/blocked by network security/i.test(claim), claim)
  assert.ok(/Nothing can be concluded about the account/.test(claim))
  assert.equal(findings[0]?.source, localSource('reddit-profile'), 'a block must not be attributed to reddit.com as a fact')
})

test('reddit-profile: 404, rate limiting and an empty history are each distinguished', () => {
  const missing = parseChecked(
    'reddit-profile',
    rawFrom('reddit-profile', { target: 'zzqx9v7nonexistentuser', artifacts: { '_http.json': JSON.stringify({ 'about.json': 404 }) } })
  )
  assert.ok(/no public account named/.test(missing[0]?.claim ?? ''))

  const limited = parseChecked(
    'reddit-profile',
    rawFrom('reddit-profile', { target: 'example_operator', artifacts: { '_http.json': JSON.stringify({ 'about.json': 429 }) } })
  )
  assert.ok(/rate-limited this run/.test(limited[0]?.claim ?? ''))

  const emptyHistory = parseChecked(
    'reddit-profile',
    rawFrom('reddit-profile', {
      target: 'example_operator',
      artifacts: {
        'about.json': fixture('reddit-about-SYNTHETIC.json'),
        'comments-1.json': JSON.stringify({ kind: 'Listing', data: { after: null, children: [] } }),
        '_http.json': JSON.stringify({ 'about.json': 200 })
      }
    })
  )
  assert.ok(/not evidence that the account is unused/.test(claims(emptyHistory)), claims(emptyHistory))
})

/* ---- hibp-passwords ---- */

test('hibp-passwords: a real range response plus a real match count reads as a hit', () => {
  // Real capture: GET https://api.pwnedpasswords.com/range/5BAA6 (the prefix of
  // SHA-1("password")), with Add-Padding.
  const findings = parseChecked(
    'hibp-passwords',
    rawFrom('hibp-passwords', {
      entityKind: 'email',
      target: 'test@example.com',
      stdout: fixture('hibp-range-5BAA6.txt'),
      artifacts: {
        'match.json': JSON.stringify({ prefix: '5BAA6', bucketEntries: 1000, occurrences: 52_372_427, paddingRequested: true, suffix: null })
      }
    })
  )
  assert.equal(findings.length, 1)
  const claim = findings[0]?.claim ?? ''
  assert.ok(/appears 52,372,427 times/.test(claim), claim)
  assert.ok(/first page of every credential-stuffing dictionary/.test(claim))
  assert.ok(/prefix 5BAA6/.test(claim))
  assert.equal(findings[0]?.source, 'api.pwnedpasswords.com')
})

test('hibp-passwords: the raw capture never contains the password or its full hash', () => {
  // The whole point of the k-anonymity design. If this ever fails, the case file has
  // become an offline cracking target.
  const raw = rawFrom('hibp-passwords', {
    entityKind: 'email',
    target: 'test@example.com',
    stdout: fixture('hibp-range-5BAA6.txt'),
    artifacts: {
      'match.json': JSON.stringify({ prefix: '5BAA6', bucketEntries: 1000, occurrences: 52_372_427, paddingRequested: true, suffix: null })
    },
    command: { file: 'GET', args: ['https://api.pwnedpasswords.com/range/5BAA6'] }
  })
  const env = readEnvelope(raw)
  assert.ok(env)
  assert.equal(env.artifacts['match.json']?.includes('1E4C9B93F3F0682250B6CF8331B7EE68FD8'), false, 'the suffix must never be stored')
  assert.equal(JSON.stringify(env.command).includes('1E4C9B93'), false, 'the URL must carry only the prefix')
  assert.equal(env.target.toLowerCase().includes('password'), false, 'the candidate must never become the target')
  for (const f of parseChecked('hibp-passwords', raw)) {
    assert.equal(f.claim.includes('1E4C9B93F3F0682250B6CF8331B7EE68FD8'), false, 'no claim may quote the suffix')
  }
})


test('hibp-passwords: not found is reported without turning into reassurance', () => {
  const findings = parseChecked(
    'hibp-passwords',
    rawFrom('hibp-passwords', {
      entityKind: 'email',
      target: 'test@example.com',
      stdout: fixture('hibp-range-5BAA6.txt'),
      artifacts: { 'match.json': JSON.stringify({ prefix: 'AAAAA', bucketEntries: 812, occurrences: 0, paddingRequested: true, suffix: null }) }
    })
  )
  assert.equal(findings.length, 1)
  const claim = findings[0]?.claim ?? ''
  assert.ok(/does not appear in the Pwned Passwords corpus/.test(claim))
  assert.ok(/It does not mean it is strong/.test(claim), 'a miss must not read as an endorsement')
})

test('hibp-passwords: a malformed match record concludes nothing', () => {
  const findings = parseChecked(
    'hibp-passwords',
    rawFrom('hibp-passwords', { entityKind: 'email', target: 'test@example.com', artifacts: { 'match.json': '{"prefix":' } })
  )
  assert.equal(findings.length, 1)
  assert.ok(/could not be interpreted/.test(findings[0]?.claim ?? ''))
})

/* ---- pattern-timezone ---- */

test('pattern-timezone: aggregates transcribed timestamps into an offset estimate', () => {
  const timestamps: string[] = []
  for (let day = 0; day < 7; day++) {
    for (const hour of [4, 6, 8, 10, 12, 14, 16, 18, 20, 21]) {
      timestamps.push(new Date(Date.UTC(2026, 6, 1 + day, hour, 30, 0)).toISOString())
    }
  }
  const findings = parseChecked(
    'pattern-timezone',
    rawFrom('pattern-timezone', {
      target: 'example_operator',
      artifacts: {
        'timestamps.json': JSON.stringify({
          timestamps,
          perCapture: { 'reddit-profile (raw_1.json)': 70 },
          capturesRead: 1,
          capturesSkipped: [],
          scopedToEntity: true
        })
      }
    })
  )
  const text = claims(findings)
  assert.ok(/Aggregated 70 distinct activity timestamps/.test(text), text)
  assert.ok(/No requests were made to anyone/.test(text), 'the zero-cost property must be stated')
  assert.ok(/approximately UTC\+3/.test(text), text)
  assert.ok(/A VPN does not affect it/.test(text), 'the counter-intuitive caveat must be stated')
  for (const f of findings) assert.equal(f.source, localSource('pattern-timezone'), 'derived analysis must never look like a source')
})

test('pattern-timezone: too little data, and no data at all, both refuse to guess', () => {
  const few = parseChecked(
    'pattern-timezone',
    rawFrom('pattern-timezone', {
      target: 'example_operator',
      artifacts: {
        'timestamps.json': JSON.stringify({
          timestamps: [new Date(Date.UTC(2026, 6, 1, 9, 0, 0)).toISOString(), new Date(Date.UTC(2026, 6, 2, 10, 0, 0)).toISOString()],
          perCapture: {},
          capturesRead: 1,
          capturesSkipped: [],
          scopedToEntity: true
        })
      }
    })
  )
  assert.ok(/No time zone is claimed/.test(claims(few)), claims(few))
  assert.ok(!/approximately UTC/.test(claims(few)), 'no offset may be stated below the sample floor')

  const none = parseChecked(
    'pattern-timezone',
    rawFrom('pattern-timezone', {
      target: 'example_operator',
      artifacts: {
        'timestamps.json': JSON.stringify({ timestamps: [], perCapture: {}, capturesRead: 3, capturesSkipped: [], scopedToEntity: true })
      }
    })
  )
  assert.equal(none.length, 1)
  assert.ok(/No activity timestamps were found/.test(none[0]?.claim ?? ''))
  assert.ok(/costs no requests/.test(none[0]?.claim ?? ''))
})

test('pattern-timezone: a malformed transcript yields nothing rather than a wrong answer', () => {
  const findings = parseChecked(
    'pattern-timezone',
    rawFrom('pattern-timezone', { target: 'x', artifacts: { 'timestamps.json': '{"timestamps":' } })
  )
  assert.deepEqual(findings, [])
})

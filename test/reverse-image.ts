/**
 * `reverse-image` parser tests.
 *
 * The parser is where this adapter earns its keep, because the thing it must never do is
 * make a refusal look like an absence. Every other adapter can get that wrong and cost you
 * a lead; this one can get it wrong and tell you an avatar appears nowhere on the internet
 * when in fact a captcha was served in under a second.
 *
 * So the shapes exercised here are the five outcomes an engine can reach — answered with
 * rows, answered with none, refused, unreadable, not applicable — plus the two ways the
 * whole run can fail. The fixtures are trimmed copies of real captures taken on 2026-09-03
 * against `https://upload.wikimedia.org/wikipedia/commons/a/af/Tux.png`, a public logo:
 * TinEye and Yandex genuinely answered, Google genuinely served `/sorry/index`. No personal
 * data appears anywhere in them.
 */

import assert from 'node:assert/strict'

import { reverseImageAdapter } from '../src/main/adapters/reverse-image'
import { finaliseFinding, type RawResult } from '../src/main/adapters/types'
import type { RunEnvelope } from '../src/main/adapters/support/envelope'
import { engineById, REVERSE_ENGINES, specFor } from '../src/main/adapters/support/reverse-engines'
import {
  describeFingerprint,
  phashFingerprint,
  readCache,
  sha256Fingerprint,
  urlFingerprint,
  writeCache
} from '../src/main/adapters/support/reverse-cache'
import { resolveBrowserToolchain } from '../src/main/adapters/support/browser'
import type { BrowserEngineResult, BrowserRunResult } from '../src/main/adapters/support/browser'
import type { Finding } from '../src/shared/types'
import { DEFAULT_CONFIG } from '../src/main/config'

export interface ReverseImageTest {
  name: string
  fn: () => void | Promise<void>
}

export const reverseImageTests: ReverseImageTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  reverseImageTests.push({ name, fn })
}

const T0 = '2026-09-03T17:30:00.000Z'
const T1 = '2026-09-03T17:31:20.000Z'

function engineResult(over: Partial<BrowserEngineResult> & { id: string }): BrowserEngineResult {
  const engine = engineById(over.id)
  return {
    site: engine?.site ?? over.id,
    status: 'ok',
    requestedUrl: '',
    handoffUrl: engine?.handoffUrl.replace('{IMAGE_URL_ENC}', 'https%3A%2F%2Fexample.org%2Ft.png') ?? '',
    finalUrl: '',
    httpStatus: 200,
    title: '',
    block: null,
    error: null,
    summary: '',
    readyMarker: '',
    results: [],
    notes: [],
    html: '',
    text: '',
    htmlTruncated: false,
    durationMs: 1000,
    ...over
  }
}

function rawWith(run: Partial<BrowserRunResult>, envOver: Partial<RunEnvelope> = {}): RawResult {
  const full: BrowserRunResult = {
    driverVersion: '1.0.0',
    startedAt: T0,
    finishedAt: T1,
    browser: { name: 'chromium', version: '148.0.7778.96', userAgent: 'Mozilla/5.0', headless: true },
    engines: [],
    ...run
  }
  const env: RunEnvelope = {
    adapter: 'reverse-image',
    adapterVersion: '1.0.0',
    entityId: 'ent_img',
    entityKind: 'image',
    target: 'tux.png',
    startedAt: T0,
    finishedAt: T1,
    durationMs: 80_000,
    command: { file: 'node', args: ['driver.cjs', 'task.json'] },
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    spawnError: null,
    stdout: JSON.stringify(full),
    stderr: '',
    artifacts: {},
    notes: [],
    ...envOver
  }
  return {
    adapterId: 'reverse-image',
    caseId: 'c1',
    entityId: env.entityId,
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(env, null, 2),
    stderr: env.stderr,
    mediaType: 'application/json',
    startedAt: T0,
    finishedAt: T1,
    durationMs: 80_000,
    truncated: false,
    timedOut: false,
    command: env.command,
    error: null,
    raw: {
      rawId: 'raw_ri',
      path: 'raw/raw_ri.json',
      sha256: 'deadbeef',
      bytes: 1,
      mediaType: 'application/json',
      excerpt: ''
    }
  }
}

function parsed(raw: RawResult): Finding[] {
  const findings = reverseImageAdapter.parse(raw)
  for (const f of findings) {
    const final = finaliseFinding('reverse-image', raw, f)
    assert.equal(final.confidence, 'unverified')
    assert.ok(final.source.trim(), 'a finding with no source')
    assert.ok(final.claim.length > 20, `suspiciously short claim: ${final.claim}`)
  }
  return findings
}

function text(findings: readonly Finding[]): string {
  return findings.map((f) => f.claim).join('\n')
}

/* ------------------------------------------------------------------ *
 * The one that matters: a block is not an absence
 * ------------------------------------------------------------------ */

test('a captcha is reported as a refusal with a URL to open, never as zero results', () => {
  const findings = parsed(
    rawWith({
      engines: [
        engineResult({
          id: 'google',
          status: 'blocked',
          finalUrl: 'https://www.google.com/sorry/index?continue=https://www.google.com/search',
          block: { kind: 'captcha', marker: "Google's unusual-traffic interstitial (URL contains \"/sorry/index\")" }
        })
      ]
    })
  )
  const all = text(findings)
  assert.match(all, /refused this search rather than answering it/)
  assert.match(all, /captcha was served/)
  assert.match(all, /says nothing about whether matches exist/)
  assert.match(all, /lens\.google\.com\/uploadbyurl/, 'the blocked finding must hand back a working URL')
  // The words that would make a block read as an absence must not appear anywhere.
  assert.doesNotMatch(all, /returned no matches/)
  assert.doesNotMatch(all, /genuine empty result/)
  // And the run summary must count it as refused rather than as answered.
  assert.match(all, /0 answered, 1 refused/)
})

test('a consent wall is a block too, and the claim says the app never accepts terms', () => {
  const findings = parsed(
    rawWith({
      engines: [
        engineResult({
          id: 'google',
          status: 'blocked',
          finalUrl: 'https://consent.google.com/m?continue=https://lens.google.com/',
          block: { kind: 'consent', marker: "Google's consent wall (URL contains \"consent.google.com\")" }
        })
      ]
    })
  )
  assert.match(text(findings), /consent wall was served .* never accepts terms on your behalf/s)
})

test('an engine that answered with nothing says so, and says it is not a block', () => {
  const findings = parsed(
    rawWith({
      engines: [
        engineResult({ id: 'tineye', status: 'ok', results: [], readyMarker: 'the phrase "tineye searched"', summary: '0 results' })
      ]
    })
  )
  const all = text(findings)
  assert.match(all, /returned no matches/)
  assert.match(all, /genuine empty result/)
  assert.match(all, /not a block/)
  assert.match(all, /1 answered, 0 refused/)
})

test('a page that loaded but could not be read is unclear, not empty', () => {
  const findings = parsed(rawWith({ engines: [engineResult({ id: 'yandex', status: 'unclear' })] }))
  const all = text(findings)
  assert.match(all, /nothing recognisable as a result list/)
  assert.match(all, /unknown rather than empty/)
  assert.match(all, /selector rot/)
  assert.doesNotMatch(all, /returned no matches/)
  assert.match(all, /0 answered, 0 refused with a challenge or a wall, 1 were unreadable/)
})

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

test('rows become findings and only "same" rows become candidates', () => {
  const raw = rawWith({
    engines: [
      engineResult({
        id: 'tineye',
        status: 'ok',
        summary: '18,718 results',
        readyMarker: 'the phrase "tineye searched"',
        results: [
          { kind: 'same', url: 'https://medium.com/@somebody/list/3f95a466f868', host: 'medium.com', text: 'a list', imageUrl: '' },
          { kind: 'same', url: 'https://en.wikipedia.org/wiki/File:Tux.png', host: 'en.wikipedia.org', text: 'File:Tux.png', imageUrl: '' }
        ]
      }),
      engineResult({
        id: 'bing',
        status: 'ok',
        readyMarker: 'the selector #b_content',
        results: [
          { kind: 'similar', url: 'https://github.com/notthisperson', host: 'github.com', text: 'a profile', imageUrl: '' }
        ]
      })
    ]
  })
  const findings = parsed(raw)
  const all = text(findings)
  assert.match(all, /places this image on medium\.com/)
  assert.match(all, /the engine's own count line reads "18,718 results"/)
  assert.match(all, /presents this as a page carrying the picture/)
  assert.match(all, /only as visually similar, which is a weaker claim/)

  const proposals = reverseImageAdapter.propose?.(raw) ?? []
  const values = proposals.map((p) => `${p.kind}:${p.value}`)
  // Bing's row is `similar`; it must not have minted an account for a stranger.
  assert.ok(!values.some((v) => v.includes('notthisperson')), `a similar-only row proposed an entity: ${values.join(', ')}`)
  assert.ok(values.includes('account:medium.com/somebody'), `no account was proposed for the Medium row: ${values.join(', ')}`)
  // `/wiki/File:Tux.png` ends in .png and is a page about the file, not the file.
  assert.ok(values.includes('domain:en.wikipedia.org'), `a MediaWiki file page was misread: ${values.join(', ')}`)
  for (const p of proposals) {
    assert.ok(p.rationale.length > 40, 'a proposal without a real rationale')
    assert.ok(
      /borrowed|not connected|nothing more|Confirm/.test(p.rationale),
      `a proposal whose rationale does not warn about the inference: ${p.rationale}`
    )
    const cited = findings.find((f) => finaliseFinding('reverse-image', raw, f).id === p.fromFindingId)
    assert.ok(cited, 'a proposal citing a finding this run did not produce')
  }
})

test("TinEye's first-indexed date is lifted out of the page text into its own finding", () => {
  // The date is prose, not a row, and it is the one thing TinEye can tell you that nothing
  // else in the toolbelt can. It is read out of the captured text, so this exercises the
  // artifact path as well as the pattern.
  const findings = parsed(
    rawWith(
      { engines: [engineResult({ id: 'tineye', status: 'ok', readyMarker: 'x', results: [] })] },
      {
        artifacts: {
          'tineye.txt':
            'Upload an image 18,718 results TinEye searched 85.6 billion images for: tux.png ' +
            'First indexed by TinEye on February 5, 2008 Include 1,117 results not available'
        }
      }
    )
  )
  const all = text(findings)
  assert.match(all, /TinEye first indexed this image on February 5, 2008/)
  assert.match(all, /lower bound only/, 'the date must be stated as a floor, not as the age of the picture')
})

test('a highlight that does not appear produces no finding, and never a blank one', () => {
  const findings = parsed(
    rawWith(
      { engines: [engineResult({ id: 'tineye', status: 'ok', readyMarker: 'x', results: [] })] },
      { artifacts: { 'tineye.txt': 'Upload an image 0 results TinEye searched 85.6 billion images' } }
    )
  )
  assert.doesNotMatch(text(findings), /first indexed/i)
})

test('every run carries the similarity caveat and a per-outcome count', () => {
  const findings = parsed(
    rawWith({
      engines: [
        engineResult({ id: 'tineye', status: 'ok', readyMarker: 'x', results: [] }),
        engineResult({ id: 'yandex', status: 'blocked', block: { kind: 'captcha', marker: 'a checkbox captcha' } }),
        engineResult({ id: 'bing', status: 'skipped', skipReason: 'Bing Visual Search has no upload path wired here.' })
      ]
    })
  )
  const all = text(findings)
  assert.match(all, /does not mean the person is the same person/)
  assert.match(all, /stock photographs, memes, game art, generated faces and platform default avatars/)
  assert.match(all, /1 answered, 1 refused with a challenge or a wall, 0 were unreadable, 0 failed, 1 were not applicable/)
})

test('a cached result says it came from the cache and was not resubmitted', () => {
  const findings = parsed(
    rawWith({
      engines: [engineResult({ id: 'tineye', status: 'ok', readyMarker: 'x', results: [], cachedFrom: T0 })]
    })
  )
  assert.match(text(findings), /served from the local cache, captured 2026-09-03/)
  assert.match(text(findings), /not submitted again/)
})

/* ------------------------------------------------------------------ *
 * Failure shapes
 * ------------------------------------------------------------------ */

test('a run where the browser never started blames the app, not the image', () => {
  const findings = parsed(
    rawWith({
      fatal: 'Chromium could not be launched: Executable does not exist',
      engines: [engineResult({ id: 'tineye', status: 'error', error: 'Chromium could not be launched' })]
    })
  )
  const all = text(findings)
  assert.match(all, /could not be searched/)
  assert.match(all, /failure of this app, not an answer/)
  assert.match(all, /nothing here is a statement about the image/)
  assert.doesNotMatch(all, /returned no matches/)
})

test('a run that never reached a browser says so, and repeats the reason', () => {
  const findings = reverseImageAdapter.parse(
    rawWith({}, { stdout: 'not json', notes: ['This image entity carries neither a readable local file nor a public https URL.'] })
  )
  assert.equal(findings.length, 1)
  assert.match(findings[0].claim, /No reverse image search was performed/)
  assert.match(findings[0].claim, /nothing here is a statement about the picture/)
  assert.match(findings[0].claim, /neither a readable local file nor a public https URL/)
})

test('the parser never throws on garbage, and never invents findings from it', () => {
  for (const stdout of ['', 'null', '[]', '{"adapter":', '{"adapter":"reverse-image"}']) {
    const raw = rawWith({}, {})
    const findings = reverseImageAdapter.parse({ ...raw, stdout })
    assert.ok(Array.isArray(findings))
    const proposals = reverseImageAdapter.propose?.({ ...raw, stdout }) ?? []
    assert.ok(Array.isArray(proposals))
  }
})

/* ------------------------------------------------------------------ *
 * Engine table and toolchain
 * ------------------------------------------------------------------ */

test('every engine declares a handoff URL with the image slot in it', () => {
  for (const e of REVERSE_ENGINES) {
    assert.match(e.handoffUrl, /\{IMAGE_URL_ENC\}/, `${e.id} has no image slot in its handoff URL`)
    assert.ok(e.selfHosts.length > 0, `${e.id} declares no self hosts, so its own navigation would read as results`)
    assert.ok(e.results.every((r) => r.selectors.length > 0), `${e.id} has a result group with no selectors`)
    assert.ok(e.acceptsUrl === (e.urlSteps.length > 0), `${e.id} disagrees with itself about taking a URL`)
    assert.ok(e.acceptsFile === (e.fileSteps.length > 0), `${e.id} disagrees with itself about taking a file`)
  }
})

test('specFor refuses a mode an engine cannot do, which is what makes it skippable', () => {
  const bing = engineById('bing')
  assert.ok(bing)
  assert.equal(specFor(bing, 'file'), null, 'Bing has no upload flow and must not pretend to')
  assert.notEqual(specFor(bing, 'url'), null)
  const tineye = engineById('tineye')
  assert.ok(tineye)
  assert.notEqual(specFor(tineye, 'file'), null)
})

test('the toolchain check reports a missing Playwright instead of throwing', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.adapters['reverse-image'] = { options: { playwrightModule: '/nowhere/playwright' } }
  const found = resolveBrowserToolchain(config, 'reverse-image')
  assert.equal(found.modulePath, '/nowhere/playwright')
  assert.ok(found.problem)
  assert.match(found.problem ?? '', /Playwright was not found/)
  assert.match(found.problem ?? '', /playwrightModule/, 'the reason must name the way out')
})

/* ------------------------------------------------------------------ *
 * The cache
 * ------------------------------------------------------------------ */

test('the cache stores an answered engine and refuses a blocked one', async () => {
  const fsp = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const base = process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test')
  await fsp.mkdir(base, { recursive: true })
  const caseDir = await fsp.mkdtemp(path.join(base, 'ri-'))
  void os

  const fp = phashFingerprint('e9a5365ada89cb06', '3038684cce8ecce8')
  // A real capture time, not the fixture's: the TTL is measured against the wall clock, and
  // a fixed timestamp would make this test pass only in the minute it was written.
  const now = new Date().toISOString()
  const ok = engineResult({ id: 'tineye', status: 'ok', readyMarker: 'x', html: 'x'.repeat(100) })
  assert.equal(await writeCache(caseDir, fp, '1.0.0', ok, now), true)

  const blocked = engineResult({ id: 'yandex', status: 'blocked', block: { kind: 'captcha', marker: 'm' } })
  assert.equal(await writeCache(caseDir, fp, '1.0.0', blocked, now), false, 'a captcha must never be cached')

  const hit = await readCache(caseDir, fp, 'tineye', '1.0.0', 60_000)
  assert.ok(hit)
  assert.equal(hit?.result.status, 'ok')
  assert.equal(hit?.result.html, '', 'the cache must not become a second copy of the page bytes')

  assert.equal(await readCache(caseDir, fp, 'yandex', '1.0.0', 60_000), null)
  // A different picture is a different key.
  assert.equal(await readCache(caseDir, sha256Fingerprint('ab'.repeat(32)), 'tineye', '1.0.0', 60_000), null)
  // A driver whose flow has changed invalidates everything it captured.
  assert.equal(await readCache(caseDir, fp, 'tineye', '2.0.0', 60_000), null)
  // So does age: a TTL of one millisecond expires an entry captured a moment ago.
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(await readCache(caseDir, fp, 'tineye', '1.0.0', 1), null)

  await fsp.rm(caseDir, { recursive: true, force: true })
})

test('a fingerprint says which of the three things it was derived from', () => {
  assert.match(describeFingerprint(phashFingerprint('a', 'b')), /survives re-encoding/)
  assert.match(describeFingerprint(sha256Fingerprint('ab')), /exact bytes/)
  assert.match(describeFingerprint(urlFingerprint('https://example.org/a.png')), /never decoded/)
  assert.notEqual(urlFingerprint('https://example.org/a.png'), urlFingerprint('https://example.org/b.png'))
})

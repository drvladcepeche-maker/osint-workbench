/**
 * Self-Audit tests.
 *
 * Ordered by how much each one matters, and the first two matter far more than the rest.
 *
 *  1. **A level's case folder never contains a value that level was not entitled to.**
 *     L0 is supposed to model a stranger who knows one username. If L0's folder can be
 *     grepped for a phone number, the simulation is decorative and every conclusion drawn
 *     from it is wrong. This is the property `seedsForLevel` exists to guarantee, and it
 *     is checked by walking every byte of the folder rather than by trusting the function.
 *  2. **No seed value reaches a log.** The vault holds real personal data. It may be
 *     written to the vault, to the level's `entities.json`, to the raw capture of a tool
 *     that was pointed at it, and to the snapshot that has to name it to explain the
 *     delta. Nowhere else — and specifically not into `job:log`, an error message, or the
 *     console, which are the three places a value ends up by accident.
 *  3. **A refusal never reads as an absence.** holehe answering `rateLimit=True` for all
 *     122 of its modules must classify as "could not check". This is the whole honesty
 *     layer, and it is tested against the real Phase 0 capture where exactly that
 *     happened.
 *
 * Then the delta's causal headline, the reset-path map's refusal to draw an edge it
 * cannot support, the re-scan's separation of "removed" from "unchecked", and the
 * letters.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { OsintService } from '../src/main/service'
import { makeFinding, type Adapter, type RawResult } from '../src/main/adapters/types'
import { SelfAudit } from '../src/main/selfaudit'
import { SeedVault, cleanValues, missingFor, seedsForLevel } from '../src/main/selfaudit/vault'
import { readCoverage, readRawEnvelope } from '../src/main/selfaudit/coverage'
import { computeDelta } from '../src/main/selfaudit/delta'
import { computeRescan } from '../src/main/selfaudit/rescan'
import { buildResetPaths, maskConsistent } from '../src/main/selfaudit/resetpaths'
import { buildReport } from '../src/main/selfaudit/report'
import { buildLetter, findContact } from '../src/main/selfaudit/gdpr'
import { containsValue, fold } from '../src/main/selfaudit/match'
import { seedContextFrom } from '../src/shared/ranking'
import { isRelative } from '../src/shared/types'
import {
  emptyProfile,
  isSilent,
  type SelfAuditCheck,
  type SelfAuditProfile,
  type SelfAuditSnapshot,
  type SnapshotFinding,
  type SnapshotSeed
} from '../src/shared/selfaudit'

export interface SelfAuditTest {
  name: string
  fn: () => void | Promise<void>
}

export const selfAuditTests: SelfAuditTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  selfAuditTests.push({ name, fn })
}

/* ------------------------------------------------------------------ *
 * Fixtures and helpers
 * ------------------------------------------------------------------ */

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'adapters')

async function scratch(prefix: string): Promise<string> {
  const base = path.join(process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test'), prefix)
  await fsp.mkdir(base, { recursive: true })
  return fsp.mkdtemp(path.join(base, 'run-'))
}

/**
 * Neutral test data, distinctive enough to grep for and belonging to nobody.
 *
 * Every value here is invented. The username and address are the ones the rest of the
 * suite already uses for real captures; the rest are nonsense words chosen so a substring
 * hit in a case folder cannot be a coincidence.
 */
const PROFILE: SelfAuditProfile = {
  values: {
    usernames: ['torvalds'],
    emails: ['test@example.com'],
    domains: [],
    names: ['Jane Vraklund'],
    cities: ['Blimborg'],
    schools: ['Zzyzx Academy'],
    phones: ['+359881234567'],
    family: ['Quorin Vraklund']
  },
  updatedAt: null
}

/** Markers that must never appear in a folder below the level that owns them. */
const MARKERS: Record<string, string> = {
  emails: 'test@example.com',
  names: 'Jane Vraklund',
  cities: 'Blimborg',
  schools: 'Zzyzx Academy',
  phones: '881234567',
  family: 'Quorin'
}

function fixtureDoc(): Adapter['doc'] {
  return {
    what: 'A fixture adapter used only by the self-audit tests.',
    how: 'It echoes the entity it was pointed at back as one finding, which is exactly enough to make a level produce a snapshot.',
    why: 'Because the level machinery is what is under test, not any particular mechanism.',
    betterAt: 'Being predictable with no network, no binary and no rate limit.',
    worseAt: 'Producing any information whatsoever about the real world.',
    falsePositives: 'It cannot produce false positives because it makes no claims about anything outside its own input.'
  }
}

const SA_FIXTURE = 'sa-fixture'

/** Registered once per process; the registry refuses a duplicate id. */
function ensureFixtureAdapter(service: OsintService): void {
  if (service.registry.has(SA_FIXTURE)) return
  service.registry.register({
    id: SA_FIXTURE,
    title: 'self-audit fixture',
    accepts: ['username', 'email', 'person', 'phone', 'location', 'organisation', 'domain'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: fixtureDoc(),
    run: async (input, ctx): Promise<RawResult> => {
      const now = ctx.now()
      return {
        adapterId: SA_FIXTURE,
        caseId: input.caseId,
        entityId: input.entity.id,
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ adapter: SA_FIXTURE, target: input.entity.value, artifacts: {}, notes: [] }),
        stderr: '',
        mediaType: 'application/json',
        startedAt: now,
        finishedAt: now,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        command: null,
        error: null,
        raw: { rawId: '', path: '', sha256: '', bytes: 0, mediaType: 'application/json', excerpt: '' }
      }
    },
    parse: (raw) => {
      const env = JSON.parse(raw.stdout) as { target: string }
      return [
        makeFinding(raw, {
          source: 'fixture.example',
          claim: `The fixture adapter was pointed at ${env.target}.`
        })
      ]
    }
  })
}

/**
 * A fixture adapter that reports one account on its first run and nothing afterwards.
 *
 * This is the shape of the thing the re-scan exists to detect and could not: an account
 * that was there, was deleted, and is gone by the next sweep. It has to be produced by the
 * **pipeline** rather than by hand-building two snapshots, because the defect was in the
 * pipeline — `findings.jsonl` is append-and-refresh, so a snapshot built from the whole
 * file is a superset of the previous one by construction and `disappeared` could never
 * hold anything.
 */
const SA_VANISH = 'sa-vanish'
const vanishRuns = new Map<string, number>()

function ensureVanishingAdapter(service: OsintService): void {
  if (service.registry.has(SA_VANISH)) return
  service.registry.register({
    id: SA_VANISH,
    title: 'self-audit vanishing fixture',
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: {
      what: 'A fixture adapter that reports an account once and then stops finding it.',
      how: 'It counts the runs it has been given for a case and returns a hit only on the first.',
      why: 'Because "the account you deleted is no longer reported" is the one shape the re-scan has to get right, and it cannot be produced by an adapter that always answers the same.',
      betterAt: 'Being a deletion, deterministically, with no network.',
      worseAt: 'Everything else. It knows nothing about the world.',
      falsePositives: 'It makes no claim about anything outside its own counter.'
    },
    run: async (input, ctx): Promise<RawResult> => {
      const now = ctx.now()
      const n = (vanishRuns.get(input.caseId) ?? 0) + 1
      vanishRuns.set(input.caseId, n)
      return {
        adapterId: SA_VANISH,
        caseId: input.caseId,
        entityId: input.entity.id,
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ adapter: SA_VANISH, target: input.entity.value, run: n, artifacts: {}, notes: [] }),
        stderr: '',
        mediaType: 'application/json',
        startedAt: now,
        finishedAt: now,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        command: null,
        error: null,
        raw: { rawId: '', path: '', sha256: '', bytes: 0, mediaType: 'application/json', excerpt: '' }
      }
    },
    parse: (raw) => {
      const env = JSON.parse(raw.stdout) as { target: string; run: number }
      if (env.run > 1) return []
      return [
        makeFinding(raw, {
          source: 'vanishing.example',
          claim: `An account named "${env.target}" exists on vanishing.example.`
        })
      ]
    }
  })
}

/** Every regular file under a directory, as text. Binary is read as latin1 so a byte match still works. */
async function walkText(dir: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) out.push({ path: full, text: await fsp.readFile(full, 'latin1') })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 1. A level never receives a value it was not entitled to
 * ------------------------------------------------------------------ */

test('a level is seeded only from the fields it is entitled to', () => {
  const l1 = seedsForLevel(PROFILE, 1).map((s) => s.value)
  assert.ok(l1.includes('test@example.com'))
  assert.ok(!l1.includes('Jane Vraklund'), 'a real name is L2, not L1')

  const l4 = seedsForLevel(PROFILE, 4).map((s) => s.value)
  for (const v of ['torvalds', 'test@example.com', 'Jane Vraklund', 'Blimborg', 'Zzyzx Academy', '+359881234567', 'Quorin Vraklund']) {
    assert.ok(l4.includes(v), `L4 should hold every field, missing ${v}`)
  }

  assert.deepEqual(missingFor(emptyProfile(), 0), ['usernames'])
  assert.deepEqual(missingFor(PROFILE, 4), [], 'a full profile is missing nothing at L4')
})

/**
 * The rung the whole product turns on, tested as a *rule* rather than as a fixture.
 *
 * The assertion this replaces read `deepEqual(l0, ['torvalds'], 'L0 is one username and
 * nothing else')` against a profile holding exactly one username — so it passed whatever
 * `seedsForLevel` did with a list, and the message was a claim the assertion never made.
 * With the whole list at L0, handle reuse across the operator's own accounts — the single
 * delta DECISIONS.md names as the point of the feature — sat entirely inside the baseline
 * with no rung to appear on.
 */
test('L0 takes one username and L1 adds the rest', () => {
  const many: SelfAuditProfile = {
    ...PROFILE,
    values: { ...PROFILE.values, usernames: ['torvalds', 'linus.t', 'ltorvalds'] }
  }

  const l0 = seedsForLevel(many, 0)
  assert.deepEqual(
    l0.map((s) => s.value),
    ['torvalds'],
    'L0 models a stranger who saw one platform, so it gets the first handle and no other'
  )
  assert.equal(l0[0]?.level, 0, 'the primary handle records itself as an L0 seed')

  const l1 = seedsForLevel(many, 1).filter((s) => s.field === 'usernames')
  assert.deepEqual(
    l1.map((s) => s.value),
    ['torvalds', 'linus.t', 'ltorvalds'],
    'L1 holds every handle, because that is the rung where reuse across accounts can show'
  )
  assert.deepEqual(
    l1.filter((s) => s.level === 1).map((s) => s.value),
    ['linus.t', 'ltorvalds'],
    'the handles L1 added record themselves as L1 seeds, so the delta cannot credit L0 with them'
  )

  // The rule, not the fixture: one value in the field means L0 and L1 hold the same set,
  // and no level below the field's own entry level holds anything.
  const one: SelfAuditProfile = { ...PROFILE, values: { ...PROFILE.values, usernames: ['solo'] } }
  assert.deepEqual(seedsForLevel(one, 0).map((s) => s.value), ['solo'])
  assert.deepEqual(
    seedsForLevel(one, 1).filter((s) => s.field === 'usernames').map((s) => s.value),
    ['solo'],
    'a single handle does not get duplicated at L1'
  )
  assert.equal(
    seedsForLevel(many, 0).filter((s) => s.field !== 'usernames').length,
    0,
    'L0 holds nothing from any other field'
  )
})

test('L0’s case folder cannot be grepped for anything above L0', async () => {
  const root = await scratch('sa-isolation')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)

  const { whenFinished } = audit.start({ level: 0, adapterIds: [SA_FIXTURE] })
  const state = await whenFinished
  assert.equal(state.phase, 'done', state.error ?? '')
  assert.ok(state.caseId, 'the run must have created a case')

  /* Save a letter while L0 is the level in play.
   *
   * This is the path the greppability proof used to miss entirely, and the one that broke
   * it: `saveLetter` completed the letter from the vault, so the file carried the
   * operator's real name (L2), his address (L1) and his postal address — and it wrote that
   * file into whichever level's case folder was on screen. Nothing reads `letters/*.txt`,
   * so no conclusion changed; the invariant this design leans on twice in prose simply
   * stopped being true. A test that never saves a letter cannot notice that, so this one
   * saves one and then greps. */
  const letter = await audit.saveLetter({
    platform: 'reddit.com',
    article: 'erasure',
    lang: 'en',
    postalAddress: '12 Blimborg Street, Blimborg'
  })
  assert.ok(
    letter.path.includes(`${path.sep}_selfaudit${path.sep}letters${path.sep}`),
    `a letter belongs to the operator, not to a level: ${letter.path}`
  )
  const saved = await fsp.readFile(letter.path, 'utf8')
  assert.ok(
    saved.includes('Jane Vraklund') && saved.includes('test@example.com'),
    'the letter must actually be filled in from the vault — otherwise this proves nothing'
  )

  const files = await walkText(service.store.dir(state.caseId))
  assert.ok(files.length > 0, 'the case folder should not be empty')
  assert.ok(
    files.some((f) => f.text.includes('torvalds')),
    'L0 is entitled to the username, so it must actually be there — otherwise this test proves nothing'
  )

  for (const [field, marker] of Object.entries(MARKERS)) {
    const leaked = files.filter((f) => f.text.includes(marker))
    assert.equal(
      leaked.length,
      0,
      `L0's folder contains the ${field} marker "${marker}" in ${leaked.map((f) => path.basename(f.path)).join(', ')}`
    )
  }

  await service.dispose()
  audit.dispose()
})

test('L2 receives the name and the address, and still nothing from L3 or L4', async () => {
  const root = await scratch('sa-l2')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)

  const state = await audit.start({ level: 2, adapterIds: [SA_FIXTURE] }).whenFinished
  assert.equal(state.phase, 'done', state.error ?? '')

  const files = await walkText(service.store.dir(state.caseId))
  const all = files.map((f) => f.text).join('\n')
  assert.ok(all.includes('test@example.com'), 'L2 is entitled to the L1 address')
  assert.ok(all.includes('Jane Vraklund'), 'L2 is entitled to the real name')

  for (const marker of [MARKERS.cities, MARKERS.schools, MARKERS.phones, MARKERS.family]) {
    assert.ok(!all.includes(marker as string), `L2's folder contains an L3/L4 value: ${marker}`)
  }

  await service.dispose()
  audit.dispose()
})

/* ------------------------------------------------------------------ *
 * 2. No seed value reaches a log
 * ------------------------------------------------------------------ */

test('a run writes no seed value to any log or console stream', async () => {
  const root = await scratch('sa-log')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)

  const captured: string[] = []
  service.orchestrator.on('job:log', (entry: { message: string }) => captured.push(entry.message))

  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  const record = (...args: unknown[]): void => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
  console.log = record
  console.warn = record
  console.error = record
  console.info = record

  try {
    const state = await audit.start({ level: 4, adapterIds: [SA_FIXTURE] }).whenFinished
    assert.equal(state.phase, 'done', state.error ?? '')
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
    console.info = original.info
  }

  const text = captured.join('\n')
  for (const [field, marker] of Object.entries(MARKERS)) {
    assert.ok(!text.includes(marker), `a ${field} value reached a log stream: ${marker}`)
  }
  // The username is a seed too, and the same rule applies to it.
  assert.ok(!text.includes('torvalds'), 'the username reached a log stream')

  await service.dispose()
  audit.dispose()
})

test('the vault refuses to grow without bound and de-duplicates case-insensitively', () => {
  assert.deepEqual(cleanValues(['  a ', 'A', 'b', '', null, 'b']), ['a', 'b'])
  assert.equal(cleanValues(Array.from({ length: 500 }, (_, i) => `u${i}`)).length, 64)
  assert.equal(cleanValues(['x'.repeat(5000)])[0]?.length, 200)
  assert.deepEqual(cleanValues('not an array'), [])
})

test('clearing the vault removes the profile and leaves the case folders alone', async () => {
  const root = await scratch('sa-clear')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)
  const state = await audit.start({ level: 0, adapterIds: [SA_FIXTURE] }).whenFinished

  const vault = new SeedVault(service.loaded.paths.casesDir)
  assert.ok(fs.existsSync(vault.profilePath))

  await audit.clearProfile()
  assert.ok(!fs.existsSync(vault.profilePath), 'the vault file should be gone')
  assert.ok(fs.existsSync(service.store.dir(state.caseId)), 'the case folder must survive')
  assert.ok((await service.listFindings(state.caseId)).length > 0, 'the findings must survive')

  await service.dispose()
  audit.dispose()
})

/* ------------------------------------------------------------------ *
 * 3. A refusal is never an absence
 * ------------------------------------------------------------------ */

test('holehe rate-limited on every module reads as "could not check", never as "nothing found"', () => {
  const csv = fs.readFileSync(path.join(FIXTURES, 'holehe-results.csv'), 'utf8')
  const envelope = JSON.stringify({
    adapter: 'holehe',
    target: 'test@example.com',
    exitCode: 0,
    stderr: '',
    artifacts: { 'holehe_1_test_results.csv': csv },
    notes: []
  })

  const reading = readCoverage({
    adapterId: 'holehe',
    rawText: envelope,
    jobState: 'done',
    jobError: null,
    claims: 0
  })

  // The real Phase 0 shape: 120 of 122 modules rate-limited, and the two that answered
  // both said no. Two negatives out of 122 is not a negative result about the address.
  assert.equal(reading.outcome, 'no-answer', 'a run with 2 of 122 answering must not classify as a clean sweep')
  assert.ok(reading.coverage, 'holehe counts its own modules, so a real fraction is available')
  assert.equal(reading.coverage?.answered, 2)
  assert.equal(reading.coverage?.refused, 120)
  assert.equal(reading.coverage?.total, 122)
  assert.ok(
    /says essentially nothing|no signal|not evidence/i.test(reading.detail),
    `detail must refuse to reassure: ${reading.detail}`
  )
})

test('a Reddit 403 is a refusal aimed at us, and a 404 is not', () => {
  const forbidden = readCoverage({
    adapterId: 'reddit-profile',
    rawText: JSON.stringify({
      adapter: 'reddit-profile',
      artifacts: { '_http.json': JSON.stringify({ 'about.json': 403 }) }
    }),
    jobState: 'done',
    jobError: null,
    claims: 0
  })
  assert.equal(forbidden.outcome, 'no-answer')
  assert.ok(/403/.test(forbidden.detail))

  const missing = readCoverage({
    adapterId: 'reddit-profile',
    rawText: JSON.stringify({
      adapter: 'reddit-profile',
      artifacts: { '_http.json': JSON.stringify({ 'about.json': 404 }) }
    }),
    jobState: 'done',
    jobError: null,
    claims: 0
  })
  assert.equal(missing.outcome, 'answered-none', 'a 404 is an answer: there is no such account')
})

test('a blocked sweep with no results is not reported as a clean sweep', () => {
  const blocked = readCoverage({
    adapterId: 'maigret',
    rawText: JSON.stringify({
      adapter: 'maigret',
      stderr: 'Too many errors of type "Bot protection", 429 Too Many Requests',
      artifacts: {},
      notes: []
    }),
    jobState: 'done',
    jobError: null,
    claims: 0
  })
  assert.equal(blocked.outcome, 'no-answer')

  const clean = readCoverage({
    adapterId: 'maigret',
    rawText: JSON.stringify({ adapter: 'maigret', stderr: '', artifacts: {}, notes: [] }),
    jobState: 'done',
    jobError: null,
    claims: 0
  })
  assert.equal(clean.outcome, 'answered-none')

  const missingBinary = readCoverage({
    adapterId: 'sherlock',
    rawText: JSON.stringify({ adapter: 'sherlock', spawnError: 'ENOENT: sherlock.exe' }),
    jobState: 'failed',
    jobError: 'sherlock did not run',
    claims: 0
  })
  assert.equal(missingBinary.outcome, 'unavailable')
})

/**
 * Sherlock's third bucket, which used to be invisible.
 *
 * A real capture from this machine holds 415 rows: `Claimed`, `Available`, and then `WAF`,
 * `Illegal` and `Unknown` — a bot wall, a site the tool would not probe, and a response it
 * could not read. Those failures are printed on **stdout**, which the generic reader never
 * looks at, and Sherlock's own count of them lands in a `local:` claim `readCoverage` did
 * not read. So a run where a large part of the site list errored classified as
 * "answered — nothing there": covered ground, excluded from the unchecked list.
 */
test('sherlock’s unresolved sites become a coverage fraction rather than silence', () => {
  const rows = (n: number, verdict: string): string =>
    Array.from({ length: n }, (_, i) => `u,site${verdict}${i},https://a,https://a/u,${verdict},200,0.1`).join('\n')
  const csv = [
    'username,name,url_main,url_user,exists,http_status,response_time_s',
    rows(3, 'Claimed'),
    rows(97, 'Available'),
    rows(120, 'WAF')
  ].join('\n')

  const mostlyBlocked = readCoverage({
    adapterId: 'sherlock',
    rawText: JSON.stringify({ adapter: 'sherlock', target: 'u', stderr: '', artifacts: { 'u.csv': csv }, notes: [] }),
    jobState: 'done',
    jobError: null,
    claims: 3
  })
  assert.equal(mostlyBlocked.coverage?.total, 220)
  assert.equal(mostlyBlocked.coverage?.answered, 100)
  assert.equal(mostlyBlocked.coverage?.refused, 120)
  assert.equal(mostlyBlocked.outcome, 'partial', 'more sites blocked than answered is not a completed sweep')
  assert.ok(/unchecked, not clear/i.test(mostlyBlocked.detail), mostlyBlocked.detail)

  // No result rows at all. Sherlock writes one per site in its list, so an empty file is a
  // run whose results never reached disk — not 415 sites saying no.
  const noRows = readCoverage({
    adapterId: 'sherlock',
    rawText: JSON.stringify({
      adapter: 'sherlock',
      artifacts: { 'u.csv': 'username,name,url_main,url_user,exists,http_status,response_time_s\n' },
      notes: []
    }),
    jobState: 'done',
    jobError: null,
    claims: 0
  })
  assert.equal(noRows.outcome, 'no-answer')
  assert.ok(isSilent(noRows.outcome), 'and it must count as unchecked ground, not as covered ground')
})

test('a run whose capture cannot be read is unchecked, never "found nothing"', () => {
  /* The terminal fallback used to return `answered-none` whenever the claim count was
     zero, no refusal marker fired, and the envelope was null — and the envelope is null
     when the capture is missing, unparseable, or was never located. `answered-none` is not
     silent, so a run nobody could read counted as covered ground and was left out of
     `report.unchecked`. Absence of an envelope is maximal doubt, and this module's stated
     bias is that doubt says "we could not check". */
  for (const rawText of [null, '', 'not json at all', '[]']) {
    const reading = readCoverage({ adapterId: 'maigret', rawText, jobState: 'done', jobError: null, claims: 0 })
    assert.equal(reading.outcome, 'no-answer', `an unreadable capture (${JSON.stringify(rawText)}) is not an absence`)
    assert.ok(isSilent(reading.outcome))
    assert.ok(!/found nothing/i.test(reading.detail), reading.detail)
  }

  // With results in hand the tool demonstrably answered, so it is not silent — but what it
  // could not reach is unrecoverable from bytes that are not there.
  const withClaims = readCoverage({ adapterId: 'maigret', rawText: null, jobState: 'done', jobError: null, claims: 4 })
  assert.equal(withClaims.outcome, 'partial')
  assert.ok(/unchecked, not clear/i.test(withClaims.detail), withClaims.detail)
})

test('an adapter’s own run note is read for refusals the envelope never mentions', () => {
  const quietStderr = JSON.stringify({ adapter: 'sherlock', stderr: '', artifacts: {}, notes: [] })
  const withoutNote = readCoverage({
    adapterId: 'maigret',
    rawText: quietStderr,
    jobState: 'done',
    jobError: null,
    claims: 0
  })
  assert.equal(withoutNote.outcome, 'answered-none', 'a genuinely clean run still reads as an answer')

  const withNote = readCoverage({
    adapterId: 'maigret',
    rawText: quietStderr,
    jobState: 'done',
    jobError: null,
    claims: 0,
    telemetry: 'maigret probed 415 sites: 120 returned 429 Too Many Requests and must be read as not checked.'
  })
  assert.equal(withNote.outcome, 'no-answer', 'the tool counted its own refusals; that is not an absence')
})

test('the orchestrator’s failure wrapper is still readable as an envelope', () => {
  const inner = JSON.stringify({ adapter: 'holehe', target: 'x', artifacts: {}, notes: [] })
  const wrapped = JSON.stringify({ adapterId: 'holehe', ok: false, error: 'exit 1', stdout: inner, stderr: '' })
  const env = readRawEnvelope(wrapped)
  assert.equal(env?.adapter, 'holehe')
  assert.equal(env?.error, 'exit 1')
  assert.equal(readRawEnvelope('not json'), null)
})

/* ------------------------------------------------------------------ *
 * 4. The delta writes a causal sentence, not a count
 * ------------------------------------------------------------------ */

function snapFinding(over: Partial<SnapshotFinding> = {}): SnapshotFinding {
  return {
    id: `fnd_${Math.random().toString(16).slice(2, 12)}`,
    entityId: 'ent_a',
    source: 'https://github.com/torvalds',
    sourceKey: 'github.com',
    tool: 'maigret',
    claim: 'An account named torvalds exists on github.com.',
    confidence: 'unverified',
    firstSeen: '2026-08-30T10:00:00.000Z',
    lastVerified: null,
    rawPath: 'raw/raw_1.json',
    derived: false,
    ...over
  }
}

function snapshot(over: Partial<SelfAuditSnapshot> = {}): SelfAuditSnapshot {
  return {
    id: `sas_${Math.random().toString(16).slice(2, 10)}`,
    level: 1,
    caseId: 'case-x',
    at: '2026-08-30T10:00:00.000Z',
    seeds: [],
    checks: [],
    findings: [],
    accounts: [],
    attributions: [],
    counts: { claims: 0, telemetry: 0, accounts: 0, sources: 0, silentChecks: 0 },
    ...over
  }
}

test('the delta names the bridge: a reused handle plus a newly seeded fact', () => {
  const from = snapshot({
    level: 1,
    seeds: [{ entityId: 'e1', kind: 'username', value: 'torvalds', label: 'torvalds', field: 'usernames', level: 0 }],
    findings: [snapFinding(), snapFinding({ sourceKey: 'reddit.com', source: 'reddit.com', tool: 'sherlock' })]
  })

  const to = snapshot({
    level: 2,
    at: '2026-08-31T10:00:00.000Z',
    seeds: [
      ...from.seeds,
      { entityId: 'e2', kind: 'person', value: 'jane vraklund', label: 'Jane Vraklund', field: 'names', level: 2 }
    ],
    findings: from.findings,
    accounts: [
      {
        key: 'github.com/torvalds',
        platform: 'github.com',
        handle: 'torvalds',
        url: null,
        state: 'candidate',
        confidence: 'unverified',
        independentSources: 1,
        tools: ['maigret'],
        findingIds: []
      },
      {
        key: 'reddit.com/torvalds',
        platform: 'reddit.com',
        handle: 'torvalds',
        url: null,
        state: 'candidate',
        confidence: 'unverified',
        independentSources: 1,
        tools: ['sherlock'],
        findingIds: []
      }
    ],
    attributions: [
      {
        findingId: 'fnd_x',
        field: 'names',
        seedValue: 'Jane Vraklund',
        level: 2,
        // A claim match: only these carry a site, and only these can build a bridge.
        where: 'claim',
        excerpt: 'GitHub shows the display name "Jane Vraklund" on this profile.',
        sourceKey: 'github.com',
        tool: 'maigret'
      }
    ]
  })

  const delta = computeDelta(to, from)
  assert.ok(delta.headline.includes('torvalds'), `the headline must name the handle: ${delta.headline}`)
  assert.ok(delta.headline.includes('github.com'), `the headline must name where it lands: ${delta.headline}`)
  assert.ok(
    /connects|stop being anonymous/i.test(delta.headline),
    `the headline must be a causal claim, not a count: ${delta.headline}`
  )
  // A real run turns up two dozen platforms for one handle; the headline names a count and
  // a couple of examples rather than becoming an unreadable list.
  assert.ok(delta.headline.length < 400, `the headline must stay one readable sentence: ${delta.headline.length} chars`)
  assert.ok(delta.headlineBasis.length >= 2, 'a causal claim must show what it rests on')
  assert.ok(delta.caveats.length > 0, 'caveats are never empty')
  assert.ok(
    delta.caveats.some((c) => /apart \(L1 at .*, L2 at .*\)/.test(c)),
    'the gap between the two runs must be declared, with both stamps'
  )
})

test('a delta whose new tools were all refused says so instead of reporting nothing found', () => {
  const from = snapshot({ level: 0, seeds: [{ entityId: 'e1', kind: 'username', value: 'torvalds', label: 'torvalds', field: 'usernames', level: 0 }] })
  const to = snapshot({
    level: 1,
    at: '2026-08-31T10:00:00.000Z',
    seeds: [
      ...from.seeds,
      { entityId: 'e2', kind: 'email', value: 'test@example.com', label: 'test@example.com', field: 'emails', level: 1 }
    ],
    checks: [
      {
        adapterId: 'holehe',
        adapterTitle: 'holehe',
        entityId: 'e2',
        entityKind: 'email',
        entityLabel: 'test@example.com',
        outcome: 'no-answer',
        detail: 'All 122 sites refused to answer.',
        jobId: 'job_1',
        jobState: 'done',
        findingIds: [],
        coverage: { answered: 0, refused: 122, total: 122 }
      }
    ],
    counts: { claims: 0, telemetry: 1, accounts: 0, sources: 0, silentChecks: 1 }
  })

  const delta = computeDelta(to, from)
  assert.ok(
    /could not get an answer|nothing was checked/i.test(delta.headline),
    `a level whose tools were refused must say so: ${delta.headline}`
  )
  assert.ok(!/nothing (was )?found\b/i.test(delta.headline), 'it must not read as "nothing found"')
})

test('L0 has no level below it and reads as a baseline', () => {
  const delta = computeDelta(snapshot({ level: 0 }), null)
  assert.equal(delta.from, null)
  assert.ok(delta.caveats.length > 0)
})

function check(over: Partial<SelfAuditCheck> = {}): SelfAuditCheck {
  return {
    adapterId: 'maigret',
    adapterTitle: 'maigret',
    entityId: 'e1',
    entityKind: 'username',
    entityLabel: 'torvalds',
    outcome: 'answered',
    detail: 'Ran to completion and reported results.',
    jobId: 'job_1',
    jobState: 'done',
    findingIds: [],
    coverage: null,
    ...over
  }
}

const HANDLE_SEED: SnapshotSeed = {
  entityId: 'e1',
  kind: 'username',
  value: 'torvalds',
  label: 'torvalds',
  field: 'usernames',
  level: 0
}
const EMAIL_SEED: SnapshotSeed = {
  entityId: 'e2',
  kind: 'email',
  value: 'test@example.com',
  label: 'test@example.com',
  field: 'emails',
  level: 1
}

/**
 * The delta's headline branch used to say "adding email addresses made Maigret runnable"
 * about a tool that accepts usernames and was simply switched off at the level below. The
 * only shape under which the sentence is true is that *none* of the kinds the adapter
 * accepts existed below and at least one does here.
 */
test('a tool the operator deselected below is not something the seed unlocked', () => {
  const from = snapshot({
    level: 0,
    seeds: [HANDLE_SEED],
    // The trace a deselected tool now leaves. Before, it left none at all: no job, no
    // `unavailable` row, no `skipped` row — so the ground it would have covered read as
    // covered, and its arrival at L1 read as the seed's doing.
    checks: [check({ adapterId: 'maigret', outcome: 'skipped', jobId: null, jobState: null, detail: 'You dropped it from this level’s chain before the run.' })]
  })
  const to = snapshot({
    level: 1,
    at: '2026-08-31T10:00:00.000Z',
    seeds: [HANDLE_SEED, EMAIL_SEED],
    checks: [
      // Accepts usernames, which L0 already had. Its absence below was a choice.
      check({ adapterId: 'maigret', adapterAccepts: ['username'] }),
      // Accepts email and nothing else, and email is what L1 added.
      check({ adapterId: 'holehe', adapterTitle: 'holehe', entityId: 'e2', entityKind: 'email', jobId: 'job_2', adapterAccepts: ['email'] })
    ]
  })

  const delta = computeDelta(to, from)
  assert.deepEqual(delta.newlyRunnable.map((c) => c.adapterId), ['holehe'], 'only the email tool was unlocked by the seed')
  assert.deepEqual(
    delta.runnableForOtherReasons.map((c) => c.adapterId),
    ['maigret'],
    'the deselected username tool is reported, in its own bucket, out of the headline'
  )
  assert.ok(
    !/maigret/i.test(delta.headline),
    `the headline must not credit the seed with a tool that was switched off below: ${delta.headline}`
  )
})

/**
 * "Newly findable" is a comparison, and a comparison needs both sides to have been asked.
 */
test('reach a tool was refused below is not comparable, and never counted as new', () => {
  const shared = { seeds: [HANDLE_SEED] }
  const from = snapshot({
    ...shared,
    level: 0,
    checks: [check({ adapterId: 'maigret', outcome: 'no-answer', detail: 'It met a bot wall.' })]
  })
  const to = snapshot({
    ...shared,
    level: 1,
    at: '2026-08-31T10:00:00.000Z',
    seeds: [HANDLE_SEED, EMAIL_SEED],
    checks: [check({ adapterId: 'maigret', adapterAccepts: ['username'] }), check({ adapterId: 'holehe', adapterTitle: 'holehe', entityId: 'e2', entityKind: 'email', jobId: 'job_2', adapterAccepts: ['email'] })],
    findings: [
      snapFinding({ sourceKey: 'github.com', tool: 'maigret' }),
      snapFinding({ sourceKey: 'spotify.com', source: 'spotify.com', tool: 'holehe', claim: 'An account is registered on spotify.com.' })
    ]
  })

  const delta = computeDelta(to, from)
  assert.deepEqual(delta.newReach.map((r) => r.sourceKey), ['spotify.com'], 'only the tool that could speak below counts')
  assert.deepEqual(
    delta.incomparableReach.map((r) => r.sourceKey),
    ['github.com'],
    'maigret was refused at L0, so github.com was never asked there'
  )
  assert.ok(
    delta.caveats.some((c) => /not comparable/i.test(c)),
    `the exclusion has to be stated, not silent: ${delta.caveats.join(' | ')}`
  )
})

/**
 * `addedSeeds` is a diff of two snapshots, and a snapshot is a moment rather than an
 * entitlement. Run L0, add a handle, run L1, and that handle is new to the diff — but it
 * belongs to L0, so crediting L1 with it answers the one question the feature exists for
 * with the wrong fact.
 */
test('a seed belonging to the level below means that level is stale, not that this one added it', () => {
  const from = snapshot({ level: 0, seeds: [HANDLE_SEED] })
  const late: SnapshotSeed = { ...HANDLE_SEED, entityId: 'e9', value: 'linus.t', label: 'linus.t', level: 0 }
  const to = snapshot({
    level: 1,
    at: '2026-08-31T10:00:00.000Z',
    seeds: [HANDLE_SEED, late, EMAIL_SEED]
  })

  const delta = computeDelta(to, from)
  assert.deepEqual(delta.addedSeeds.map((s) => s.label), ['test@example.com'], 'only seeds this rung introduces are causes')
  assert.deepEqual(delta.staleSeeds.map((s) => s.label), ['linus.t'], 'the L0 handle added after L0 ran is evidence L0 is out of date')
  assert.ok(!/linus\.t/.test(delta.headline), `the causal sentence must not name it: ${delta.headline}`)
  assert.ok(/out of date/i.test(delta.caveats[0] ?? ''), `and the staleness must lead the caveats: ${delta.caveats[0]}`)
})

test('a delta refuses to read down the ladder', async () => {
  const root = await scratch('sa-delta-guard')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)
  await audit.start({ level: 2, adapterIds: [SA_FIXTURE] }).whenFinished

  // Reachable over IPC, which the MCP server makes a live surface. Inverted, it produces a
  // confident, well-formed answer to a question nobody can ask: empty `addedSeeds`, a large
  // `lostReach`, and "Nothing was added between L4 and L2".
  await assert.rejects(() => audit.delta(2, 4), /below L2/)
  await assert.rejects(() => audit.delta(2, 2), /below L2/)
  assert.ok(await audit.delta(2), 'the default comparison still works')

  await service.dispose()
  audit.dispose()
})

/* ------------------------------------------------------------------ *
 * 5. Matching is conservative
 * ------------------------------------------------------------------ */

test('seed matching respects word boundaries, folds diacritics and refuses short values', () => {
  assert.ok(containsValue('Lives in Blimborg, apparently.', 'blimborg'))
  assert.ok(!containsValue('The Blimborgian dialect', 'Blimborg'), 'a prefix inside a longer word is not a match')
  assert.ok(containsValue('Йорданов', 'йорданов'))
  assert.ok(!containsValue('this is a fuse', 'use'), 'three characters is under the floor')
  assert.equal(fold('Ĝeorgi'), 'georgi')
})

/* ------------------------------------------------------------------ *
 * 6. The reset-path map draws only what it can support
 * ------------------------------------------------------------------ */

test('a masked hint produces an edge only when it identifies something', () => {
  assert.ok(maskConsistent('te****@e*****.com', 'test@example.com'))
  assert.ok(!maskConsistent('te****@e*****.com', 'tom@elsewhere.com'))
  // Two visible characters and a TLD fit millions of addresses. No edge.
  assert.ok(!maskConsistent('t****@g****.com', 'tester@gmail.com'))
  assert.ok(maskConsistent('+359 88 *** ** 67', '+359881234567'))
  assert.ok(!maskConsistent('+3 ** ** ** 67', '+359881234567'), 'too few literal digits to identify a number')
})

test('rate-limited sites become unchecked rows, never absent edges', () => {
  const csv = fs.readFileSync(path.join(FIXTURES, 'holehe-results.csv'), 'utf8')
  const rawPath = 'raw/raw_holehe.json'
  const snap = snapshot({
    level: 1,
    seeds: [{ entityId: 'e2', kind: 'email', value: 'test@example.com', label: 'test@example.com', field: 'emails', level: 1 }],
    findings: [snapFinding({ tool: 'holehe', rawPath, source: 'local:holehe', sourceKey: 'local:holehe', derived: true })],
    checks: [
      {
        adapterId: 'holehe',
        adapterTitle: 'holehe',
        entityId: 'e2',
        entityKind: 'email',
        entityLabel: 'test@example.com',
        outcome: 'no-answer',
        detail: 'All 122 sites refused to answer.',
        jobId: 'j',
        jobState: 'done',
        findingIds: [],
        coverage: { answered: 0, refused: 122, total: 122 }
      }
    ]
  })

  const raws = new Map([
    [
      rawPath,
      JSON.stringify({ adapter: 'holehe', target: 'test@example.com', artifacts: { 'r.csv': csv }, notes: [] })
    ]
  ])

  const map = buildResetPaths({ snapshot: snap, raws })
  assert.equal(map.edges.length, 0, 'a rate-limited row must never become an edge')
  assert.ok(map.unchecked.length > 100, 'every refused site must be named as unchecked')
  assert.ok(map.degraded, 'a run where the oracle never answered is a degraded map')
  assert.ok(/not checked/i.test(map.degradedNote ?? ''), map.degradedNote ?? 'no note')
})

test('an observed hit becomes an edge, and a consistent mask becomes a chain step that says it is inferred', () => {
  const csv = [
    'name,domain,method,frequent_rate_limit,rateLimit,exists,emailrecovery,phoneNumber,others',
    'oldforum,oldforum.example,password recovery,False,False,True,te****@e*****.com,,',
    'spotify,spotify.com,register,False,False,True,,,',
    'imgur,imgur.com,login,False,True,False,,,'
  ].join('\n')
  const rawPath = 'raw/raw_h.json'

  const snap = snapshot({
    level: 4,
    seeds: [
      { entityId: 'e2', kind: 'email', value: 'alias@oldmail.example', label: 'alias@oldmail.example', field: 'emails', level: 1 },
      { entityId: 'e3', kind: 'email', value: 'test@example.com', label: 'test@example.com', field: 'emails', level: 1 }
    ],
    findings: [snapFinding({ tool: 'holehe', rawPath, source: 'local:holehe', sourceKey: 'local:holehe', derived: true })]
  })

  const raws = new Map([
    [
      rawPath,
      JSON.stringify({
        adapter: 'holehe',
        target: 'alias@oldmail.example',
        artifacts: { 'r.csv': csv },
        notes: []
      })
    ]
  ])

  const map = buildResetPaths({ snapshot: snap, raws })
  const observed = map.edges.filter((e) => e.status === 'observed')
  assert.equal(observed.length, 2, 'two sites said an account exists')
  assert.ok(observed.every((e) => e.fromValue === 'alias@oldmail.example'))

  const inferred = map.edges.find((e) => e.status === 'consistent')
  assert.ok(inferred, 'the mask matches a seeded address, so a consistent edge is drawn')
  assert.ok(/consistent with, not proof of/i.test(inferred?.note ?? ''), inferred?.note ?? '')

  assert.ok(
    map.unchecked.some((u) => u.platform === 'imgur.com'),
    'the rate-limited row is unchecked, not absent'
  )
  assert.ok(map.hubs[0], 'a value reaching two sites is a hub')
  assert.equal(map.hubs[0]?.platforms.length, 2)
})

/* ------------------------------------------------------------------ *
 * 7. The report leads with what it could not check
 * ------------------------------------------------------------------ */

test('the remediation list is ordered by reach and names what it disconnects', () => {
  /* Three platforms, and only two of them are anything a report may state as fact: one a
     human promoted, one two independent tools agreed on. The third is a single tool hit —
     the shape a Sherlock sweep over a common handle returns by the dozen from anti-bot
     pages that answer 200. It stays on the page and it stays out of the number. */
  const accounts = [
    {
      key: 'github.com/torvalds',
      platform: 'github.com',
      handle: 'torvalds',
      url: null,
      state: 'entity' as const,
      confidence: 'unverified' as const,
      independentSources: 1,
      tools: ['maigret'],
      findingIds: []
    },
    {
      key: 'reddit.com/torvalds',
      platform: 'reddit.com',
      handle: 'torvalds',
      url: null,
      state: 'candidate' as const,
      confidence: 'corroborated' as const,
      independentSources: 2,
      tools: ['maigret', 'sherlock'],
      findingIds: []
    },
    {
      key: 'gitlab.com/torvalds',
      platform: 'gitlab.com',
      handle: 'torvalds',
      url: null,
      state: 'candidate' as const,
      confidence: 'unverified' as const,
      independentSources: 1,
      tools: ['maigret'],
      findingIds: []
    }
  ]

  const snap = snapshot({
    level: 1,
    accounts,
    findings: [snapFinding()],
    checks: [
      {
        adapterId: 'holehe',
        adapterTitle: 'holehe',
        entityId: 'e2',
        entityKind: 'email',
        entityLabel: 'test@example.com',
        outcome: 'no-answer',
        detail: 'All 122 sites refused.',
        jobId: 'j',
        jobState: 'done',
        findingIds: [],
        coverage: { answered: 0, refused: 122, total: 122 }
      }
    ],
    counts: { claims: 1, telemetry: 0, accounts: 3, sources: 1, silentChecks: 1 }
  })

  const report = buildReport(snap, buildResetPaths({ snapshot: snap, raws: new Map() }))

  assert.ok(report.unchecked.length > 0, 'a silent check must be surfaced')
  const handleFix = report.remediation.find((r) => r.kind === 'handle-reuse')
  assert.ok(handleFix, 'one handle on three platforms is the finding')
  assert.equal(handleFix?.reach, 2, 'reach counts only the promoted one and the corroborated one')
  assert.equal(handleFix?.unverifiedReach, 1, 'the single-tool hit is reported, separately, as unverified')
  assert.ok(/torvalds/.test(handleFix?.action ?? ''), 'the action must name the handle')
  assert.ok(
    /2 sites are confirmed/.test(handleFix?.action ?? '') && /1 more/.test(handleFix?.action ?? ''),
    `the imperative must state the verified number as fact and the rest as unchecked: ${handleFix?.action}`
  )
  assert.equal(handleFix?.targets.length, 3, 'every platform is still listed for the operator to open')

  const reaches = report.remediation.map((r) => r.reach)
  assert.deepEqual([...reaches].sort((a, b) => b - a), reaches, 'the list is ordered by reach')

  // PRODUCT.md: no fear framing, no threat scores.
  const text = JSON.stringify(report)
  assert.ok(!/EXPOSED|CRITICAL|threat score|risk score/i.test(text), 'no fear framing anywhere in the report')
})

/* ------------------------------------------------------------------ *
 * 8. Re-scan separates removal from silence
 * ------------------------------------------------------------------ */

/**
 * The end-to-end version, because the unit test above cannot see the defect.
 *
 * `computeRescan` was always correct; what it was handed was not. A level reuses one case
 * folder and `upsertFinding` never removes, so a snapshot taken from the whole file always
 * contained everything the level had ever seen — `disappeared` was structurally empty, and
 * an operator who deleted an account and waited three weeks was told "nothing changed".
 * This runs the real pipeline twice against an adapter whose account goes away.
 */
test('a re-scan through the real pipeline can report a claim that stopped being reported', async () => {
  const root = await scratch('sa-rescan-pipeline')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  ensureVanishingAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)

  const first = await audit.start({ level: 0, adapterIds: [SA_FIXTURE, SA_VANISH] }).whenFinished
  assert.equal(first.phase, 'done', first.error ?? '')

  const diff = await audit.rescan({ level: 0, adapterIds: [SA_FIXTURE, SA_VANISH] })
  assert.ok(diff, 'a second run of the same level must produce a diff')

  assert.equal(diff?.disappeared.length, 1, 'the account the tool stopped reporting must be visible as gone')
  assert.equal(diff?.disappeared[0]?.sourceKey, 'vanishing.example')
  assert.equal(
    diff?.unexplained.length,
    1,
    'the tool answered normally this time, so this is the only bucket that supports "it worked"'
  )
  assert.equal(diff?.explainedBySilence.length, 0)
  assert.ok(/supports "it worked"/.test(diff?.verdict ?? ''), diff?.verdict ?? '')
  assert.ok(
    !/Nothing changed/.test(diff?.verdict ?? ''),
    `the verdict must not claim nothing changed: ${diff?.verdict}`
  )

  // The other adapter still reports the same thing, and re-observing it is a refresh
  // rather than a second row — otherwise the claim count would climb with every re-run.
  assert.equal(diff?.appeared.length, 0, 'a re-run of an unchanged tool must not look like new findings')
  assert.ok((diff?.stillThere ?? 0) >= 1, 'the unchanged claim is still there')

  const findings = await service.listFindings(first.caseId)
  const claimRows = findings.filter((f) => !f.source.startsWith('local:'))
  assert.equal(claimRows.length, 2, 'two runs of two adapters must leave two claims, not four')

  await service.dispose()
  audit.dispose()
})

test('a claim that vanished while its tool was refused is not evidence of removal', () => {
  const gone = snapFinding({ sourceKey: 'spotify.com', source: 'spotify.com', tool: 'holehe', claim: 'An account is registered on spotify.com.' })
  const kept = snapFinding()

  const previous = snapshot({ at: '2026-08-01T10:00:00.000Z', findings: [gone, kept] })
  const current = snapshot({
    at: '2026-08-30T10:00:00.000Z',
    findings: [kept],
    checks: [
      {
        adapterId: 'holehe',
        adapterTitle: 'holehe',
        entityId: 'e2',
        entityKind: 'email',
        entityLabel: 'test@example.com',
        outcome: 'no-answer',
        detail: 'All 122 sites refused this time.',
        jobId: 'j',
        jobState: 'done',
        findingIds: [],
        coverage: { answered: 0, refused: 122, total: 122 }
      },
      {
        adapterId: 'maigret',
        adapterTitle: 'maigret',
        entityId: 'e1',
        entityKind: 'username',
        entityLabel: 'torvalds',
        outcome: 'answered',
        detail: 'Ran to completion.',
        jobId: 'j2',
        jobState: 'done',
        findingIds: [kept.id],
        coverage: null
      }
    ]
  })

  const diff = computeRescan(current, previous)
  assert.equal(diff.disappeared.length, 1)
  assert.equal(diff.unexplained.length, 0, 'holehe was refused, so this disappearance explains nothing')
  assert.equal(diff.explainedBySilence.length, 1)
  assert.ok(/refused/i.test(diff.verdict), diff.verdict)

  // Now the same disappearance while holehe was answering: the only shape that supports
  // the good news.
  const answering: SelfAuditSnapshot = {
    ...current,
    checks: current.checks.map((c) =>
      c.adapterId === 'holehe'
        ? { ...c, outcome: 'answered' as const, detail: 'Every site answered this time.' }
        : c
    )
  }
  const diff2 = computeRescan(answering, previous)
  assert.equal(diff2.unexplained.length, 1, 'a disappearance while the tool answered is the only one that counts')
  assert.ok(/supports "it worked"/.test(diff2.verdict), diff2.verdict)
})

/* ------------------------------------------------------------------ *
 * 9. The letters
 * ------------------------------------------------------------------ */

test('an Article 17 letter cites the articles and is sendable in both languages', () => {
  for (const lang of ['en', 'bg'] as const) {
    const letter = buildLetter({
      platform: 'reddit.com',
      article: 'erasure',
      lang,
      handle: 'torvalds',
      email: 'test@example.com',
      fullName: 'Jane Vraklund',
      minorWhenCreated: true
    })

    assert.ok(letter.subject.length > 20, 'the subject must identify the request')
    assert.ok(letter.body.includes('17'), `${lang}: the article must be cited`)
    assert.ok(letter.body.includes('19'), `${lang}: Art. 19 notification must be requested`)
    assert.ok(letter.body.includes('12'), `${lang}: the one-month deadline must be cited`)
    assert.ok(letter.body.includes('torvalds') && letter.body.includes('test@example.com'), `${lang}: the account must be identified`)
    assert.ok(letter.body.includes('Jane Vraklund'), `${lang}: the letter must be signed`)
    assert.ok(!/\(name\)|\(име\)/.test(letter.body), `${lang}: no unfilled placeholder may survive`)
    assert.ok(letter.escalation.includes('kzld@cpdp.bg'), `${lang}: the KZLD escalation path is required`)
    assert.ok(letter.contact?.email === 'privacy@reddit.com', 'the contact book must be consulted')
    assert.equal(letter.contact?.verified, false, 'no contact is ever marked verified')
  }
})

test('an Article 21 letter names AI training when asked, and warns when not', () => {
  const withAi = buildLetter({
    platform: 'meta',
    article: 'objection',
    lang: 'en',
    handle: 'someone',
    fullName: 'Jane Vraklund',
    includeAiTraining: true
  })
  assert.ok(/artificial intelligence|machine-learning/i.test(withAi.body))
  assert.ok(withAi.body.includes('21(1)'))
  assert.ok(withAi.body.includes('6(1)(f)'), 'the legal basis being objected to must be named')

  const withoutAi = buildLetter({
    platform: 'meta',
    article: 'objection',
    lang: 'bg',
    handle: 'someone',
    fullName: 'Jane Vraklund',
    includeAiTraining: false
  })
  assert.ok(
    withoutAi.warnings.some((w) => /AI-training clause is off/i.test(w)),
    'leaving the clause off must be flagged, not silently accepted'
  )
})

test('an unknown platform produces a letter that says where to find the controller', () => {
  const letter = buildLetter({ platform: 'someforum.example', article: 'erasure', lang: 'en', handle: 'x', fullName: 'Y' })
  assert.equal(letter.contact, null)
  assert.ok(letter.warnings.some((w) => /No contact is recorded/.test(w)))
  assert.ok(/privacy policy/i.test(letter.warnings.join(' ')))
  assert.equal(findContact('www.reddit.com')?.key, 'reddit', 'a host must resolve through the alias table')
  assert.equal(findContact('instagram.com')?.key, 'meta')
})

/* ------------------------------------------------------------------ *
 * Taking a seed back out
 * ------------------------------------------------------------------ */

test('removing a seed value clears the vault and leaves the level case alone', async () => {
  const root = await scratch('sa-removeseed')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)

  const state = await audit.start({ level: 0, adapterIds: [SA_FIXTURE] }).whenFinished
  assert.equal(state.phase, 'done', state.error ?? '')

  // The level materialised the handle into its own case and ran a tool at it, so the
  // usage has to find both the entity and what it produced.
  const before = await audit.seedUsage('usernames', 'torvalds')
  assert.equal(before.inVault, true)
  assert.equal(before.cases.length, 1)
  assert.equal(before.cases[0]?.code, 'L0')
  assert.ok(before.findings > 0, 'the fixture adapter should have produced something to protect')

  const removal = await audit.removeSeed({ field: 'usernames', value: 'torvalds' })
  assert.deepEqual(removal.profile.values.usernames, [], 'the vault is his typing and comes out clean')
  assert.equal(removal.purged.length, 0, 'a case folder is an audit trail and is not touched by default')
  assert.equal(removal.kept.length, 1, 'and the level still holding it has to be reported, not hidden')

  // The level is immediately re-runnable without it: the plan reads the vault at the
  // moment it runs, so nothing stale is re-seeded.
  const plan = await audit.plan(0)
  assert.equal(plan.seeds.length, 0, 'a removed seed must not come back on the next run')
  assert.equal(plan.runs.length, 0)

  // And the case still holds what it collected.
  const caseId = before.cases[0]!.caseId
  assert.ok((await service.listFindings(caseId)).length > 0, 'findings survive a vault edit')
  assert.ok(await service.store.getEntity(caseId, before.cases[0]!.entityId))

  await service.dispose()
  audit.dispose()
})

/**
 * After an explicit purge, the claims the seed produced are still on disk — `deleteEntity`
 * orphans rather than deletes, because the observation happened and its capture is
 * permanent. What they may not do is keep counting. `snapshotCase` read every finding
 * unconditionally, so those claims stayed in `counts.claims`, stayed under "Where you
 * appear", and kept driving remediation reach, while `snapshot.seeds` no longer named the
 * seed that caused them: a number with no visible cause.
 */
test('claims left behind by a purged seed are reported apart and counted nowhere', async () => {
  const root = await scratch('sa-orphans')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile({
    ...PROFILE,
    values: { ...PROFILE.values, usernames: ['torvalds', 'kaldrin'] }
  })

  const first = await audit.start({ level: 1, adapterIds: [SA_FIXTURE] }).whenFinished
  assert.equal(first.phase, 'done', first.error ?? '')

  const before = await audit.report(1)
  assert.equal(before?.orphaned.length, 0, 'nothing has been purged yet')
  const claimsBefore = before?.appearances.reduce((n, a) => n + a.findingIds.length, 0) ?? 0
  assert.ok(claimsBefore >= 3, 'two handles and one address should each have produced a claim')

  // Out of the vault and out of the case: the operator said he wants this one gone.
  const removal = await audit.removeSeed({ field: 'usernames', value: 'kaldrin', purgeCases: true })
  assert.equal(removal.purged.length, 1)
  assert.ok((removal.purged[0]?.orphanedFindings ?? 0) > 0)

  const after = await audit.start({ level: 1, adapterIds: [SA_FIXTURE] }).whenFinished
  assert.equal(after.phase, 'done', after.error ?? '')

  const report = await audit.report(1)
  assert.ok(report, 'the level still has a report')
  assert.ok(report!.orphaned.length > 0, 'the claims the purged seed produced have to be visible somewhere')
  assert.ok(
    report!.orphaned.every((f) => !report!.appearances.some((a) => a.findingIds.includes(f.id))),
    'and nowhere in "Where you appear"'
  )

  const snap = (await audit.snapshots(1))[0]
  assert.ok(snap, 'the second run wrote a snapshot')
  assert.equal(snap?.counts.orphanedClaims, report!.orphaned.length, 'the count names them separately')
  assert.ok((snap?.counts.claims ?? 0) > 0, 'the seeds that survived still produce claims')
  assert.ok(
    (snap?.counts.claims ?? 0) < claimsBefore,
    'and the headline count went down when the seed was purged, instead of standing still'
  )
  assert.ok(
    !report!.remediation.some((r) => r.evidence.some((id) => report!.orphaned.some((f) => f.id === id))),
    'and they may not drive a recommendation either'
  )

  await service.dispose()
  audit.dispose()
})

/**
 * A relative is materialised as a `person`, exactly like the subject's own name at L2, and
 * that made the two indistinguishable everywhere downstream. The marker is on the entity
 * because the three readers that need it — the gender inference, the query builder and the
 * bridge headline — all read the entity record rather than the vault.
 */
test('a family name is materialised as a relative, and does not read as the subject', async () => {
  const root = await scratch('sa-relatives')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)

  const state = await audit.start({ level: 4, adapterIds: [SA_FIXTURE] }).whenFinished
  assert.equal(state.phase, 'done', state.error ?? '')

  const entities = await service.listEntities(state.caseId)
  const people = entities.filter((e) => e.kind === 'person')
  assert.equal(people.length, 2, 'L4 holds the subject’s own name and one relative')
  const relative = people.find((e) => isRelative(e))
  const subject = people.find((e) => !isRelative(e))
  assert.equal(relative?.label, 'Quorin Vraklund', 'the L4 family name is the relative')
  assert.equal(subject?.label, 'Jane Vraklund', 'the L2 real name is the subject')

  const seeds = seedContextFrom(entities, null)
  assert.deepEqual(seeds.names, ['Jane Vraklund'], 'only the subject’s own name ranks rows as his')
  assert.deepEqual(seeds.relatives, ['Quorin Vraklund'], 'the relative is kept, at its own weight')
  assert.notEqual(
    seeds.subject.gender,
    'ambiguous',
    'a relative reading as a different gender must not switch the signal off — that made L4 rank worse than L2'
  )

  await service.dispose()
  audit.dispose()
})

test('purging a seed removes it from the level case too, and orphans what it produced', async () => {
  const root = await scratch('sa-purgeseed')
  const service = await OsintService.create(root)
  ensureFixtureAdapter(service)
  const audit = new SelfAudit(service)
  await audit.saveProfile(PROFILE)

  const state = await audit.start({ level: 0, adapterIds: [SA_FIXTURE] }).whenFinished
  assert.equal(state.phase, 'done', state.error ?? '')
  const caseId = state.caseId
  const findingsBefore = (await service.listFindings(caseId)).length
  assert.ok(findingsBefore > 0)

  const removal = await audit.removeSeed({ field: 'usernames', value: 'torvalds', purgeCases: true })
  assert.equal(removal.purged.length, 1)
  assert.equal(removal.purged[0]?.code, 'L0')
  assert.equal(removal.purged[0]?.orphanedFindings, findingsBefore)

  // The entity is gone; the findings are not. Same rule as everywhere else — the
  // observation happened and its raw capture is permanent.
  assert.equal((await service.listEntities(caseId)).length, 0)
  assert.equal((await service.listFindings(caseId)).length, findingsBefore)
  const tombs = await service.removedEntities(caseId)
  assert.equal(tombs.length, 1)
  assert.equal(tombs[0]?.orphanedFindings, findingsBefore)

  await service.dispose()
  audit.dispose()
})

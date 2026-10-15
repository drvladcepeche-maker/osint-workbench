/**
 * The test suite.
 *
 * Runs in plain Node (better-sqlite3 v13 ships an N-API prebuild, so the same binary
 * loads under Node and under Electron with no rebuild step). `scripts/build-tests.mjs`
 * bundles this file with esbuild; `scripts/run-tests.mjs` executes the bundle.
 *
 * What it proves, in order of how much it matters:
 *   1. A doc-less adapter cannot be registered.
 *   2. A single tool hit cannot exceed `unverified`, and corroboration keys on the
 *      source rather than the tool.
 *   3. `rebuildIndex()` reconstructs the database exactly, from files alone.
 *   4. The orchestrator survives a hanging tool and a non-zero exit with useful stderr.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  AdapterDocError,
  AdapterRegistrationError,
  AdapterRegistry,
  finaliseFinding,
  makeFinding,
  type Adapter,
  type RawResult
} from '../src/main/adapters/types'
import { echoAdapter } from '../src/main/adapters/echo'
import { registerBuiltInAdapters } from '../src/main/adapters'
import { adapterTests } from './adapters'
import { engineTests } from './engine'
import { exportTests } from './export'
import { searchTests } from './search'
import { imageTests } from './image'
import { integrationTests } from './integration'
import { lifecycleTests } from './lifecycle'
import { matcherTests } from './matcher'
import { pivotTests } from './pivot'
import { nameTests } from './names'
import { platformTests } from './platforms'
import { relevanceTests } from './relevance'
import { repoTests } from './repo'
import { reverseImageTests } from './reverse-image'
import { selfAuditTests } from './selfaudit'
import { CaseStore } from '../src/main/store/caseStore'
import { openDatabase, rebuildIndex, searchFindings, listFindings } from '../src/main/db'
import { OsintService } from '../src/main/service'
import { runProcess } from '../src/main/spawn'
import {
  canCorroborate,
  ConfidenceError,
  distinctSources,
  independenceKey,
  promote
} from '../src/shared/confidence'
import { detectEntityKind, normaliseEntityValue } from '../src/shared/normalise'
import { entityId, findingId } from '../src/shared/ids'
import type { Finding } from '../src/shared/types'

/* ------------------------------------------------------------------ *
 * Tiny harness — no runner dependency
 * ------------------------------------------------------------------ */

interface Case {
  name: string
  fn: () => void | Promise<void>
}
const tests: Case[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

async function tmpdir(prefix: string): Promise<string> {
  // Inside the repo's own scratch folder, not the system temp dir.
  const base = path.join(process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test'), prefix)
  await fsp.mkdir(base, { recursive: true })
  return fsp.mkdtemp(path.join(base, os.EOL === '\n' ? 'run-' : 'run-'))
}

function docFixture(): Adapter['doc'] {
  return {
    what: 'A fixture adapter used only by the test suite.',
    how: 'It does nothing at all and returns a constant, which is exactly enough to exercise the registry.',
    why: 'Because the registry contract is what is under test, not any particular mechanism.',
    betterAt: 'Being predictable in a unit test with no network and no filesystem.',
    worseAt: 'Producing any information whatsoever about the real world.',
    falsePositives: 'It cannot produce false positives because it makes no claims about anything.'
  }
}

function stubAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    id: 'stub',
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: docFixture(),
    run: async () => {
      throw new Error('not used')
    },
    parse: () => [],
    ...overrides
  } as Adapter
}

/* ------------------------------------------------------------------ *
 * 1. Adapter doc enforcement — the hard product requirement
 * ------------------------------------------------------------------ */

test('registry accepts a fully documented adapter', () => {
  const r = new AdapterRegistry()
  r.register(stubAdapter())
  assert.equal(r.size(), 1)
  assert.ok(r.get('stub'))
})

test('registry REFUSES an adapter with no doc object at all', () => {
  const r = new AdapterRegistry()
  assert.throws(() => r.register(stubAdapter({ doc: undefined as never })), AdapterDocError)
})

test('registry REFUSES an adapter with any one empty doc field', () => {
  for (const field of ['what', 'how', 'why', 'betterAt', 'worseAt', 'falsePositives'] as const) {
    const r = new AdapterRegistry()
    const doc = { ...docFixture(), [field]: '' }
    let threw: unknown = null
    try {
      r.register(stubAdapter({ doc }))
    } catch (err) {
      threw = err
    }
    assert.ok(threw instanceof AdapterDocError, `expected AdapterDocError for empty doc.${field}`)
    assert.equal((threw as AdapterDocError).field, field)
    assert.equal(r.size(), 0, `adapter with empty doc.${field} must not be registered`)
  }
})

test('registry REFUSES whitespace-only and placeholder doc fields', () => {
  for (const bad of ['   ', 'TODO', 'tbd', 'n/a', '-', '???']) {
    const r = new AdapterRegistry()
    assert.throws(
      () => r.register(stubAdapter({ doc: { ...docFixture(), how: bad } })),
      AdapterDocError,
      `expected rejection of doc.how = ${JSON.stringify(bad)}`
    )
  }
})

test('registry REFUSES a doc field too short to describe a mechanism', () => {
  const r = new AdapterRegistry()
  assert.throws(() => r.register(stubAdapter({ doc: { ...docFixture(), how: 'scrapes' } })), AdapterDocError)
})

test('registry rejects duplicate ids, bad ids, and missing accepts', () => {
  const r = new AdapterRegistry()
  r.register(stubAdapter())
  assert.throws(() => r.register(stubAdapter()), AdapterRegistrationError)
  assert.throws(() => r.register(stubAdapter({ id: 'Bad Id' })), AdapterRegistrationError)
  assert.throws(() => r.register(stubAdapter({ id: 'x', accepts: [] })), AdapterRegistrationError)
})

test('the built-in echo adapter passes its own doc gate', () => {
  const r = new AdapterRegistry()
  registerBuiltInAdapters(r)
  assert.ok(r.get('echo'))
  for (const v of Object.values(echoAdapter.doc)) assert.ok(v.trim().length >= 12)
})

/* ------------------------------------------------------------------ *
 * 2. Confidence — the central rule
 * ------------------------------------------------------------------ */

function fakeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'fnd_test',
    caseId: 'c1',
    entityId: 'ent_1',
    source: 'github.com',
    tool: 'maigret',
    claim: 'An account exists',
    confidence: 'unverified',
    evidenceRef: null,
    firstSeen: '2026-08-30T10:00:00.000Z',
    lastVerified: null,
    raw: { rawId: 'raw_1', path: 'raw/raw_1.json', sha256: 'x', bytes: 1, mediaType: 'application/json', excerpt: '' },
    ...over
  }
}

test('an adapter cannot emit anything above unverified', () => {
  const raw = {
    adapterId: 'stub',
    caseId: 'c1',
    entityId: 'ent_1',
    raw: fakeFinding().raw
  } as RawResult

  const cheat = { ...fakeFinding({ tool: 'stub', confidence: 'confirmed' }) }
  assert.throws(() => finaliseFinding('stub', raw, cheat), ConfidenceError)

  const honest = makeFinding(raw, { source: 'github.com', claim: 'An account exists' })
  assert.equal(honest.confidence, 'unverified')
  assert.equal(finaliseFinding('stub', raw, honest).confidence, 'unverified')
})

test('corroboration needs two DISTINCT sources, not two tools', () => {
  const a = fakeFinding({ id: 'f1', tool: 'maigret', source: 'https://github.com/someone' })
  // A second tool reading the SAME site. This is the exact false-positive amplifier the
  // rule exists to stop.
  const b = fakeFinding({ id: 'f2', tool: 'sherlock', source: 'github.com' })
  assert.equal(independenceKey(a.source), independenceKey(b.source))

  const blocked = canCorroborate(a, [b])
  assert.equal(blocked.ok, false)
  assert.equal(blocked.sources.length, 1)
  assert.throws(() => promote({ finding: a, to: 'corroborated', actor: 'corroborator', supporting: [b] }), ConfidenceError)

  // A genuinely different origin.
  const c = fakeFinding({ id: 'f3', tool: 'sherlock', source: 'keybase.io' })
  const allowed = canCorroborate(a, [c])
  assert.equal(allowed.ok, true)
  const res = promote({ finding: a, to: 'corroborated', actor: 'corroborator', supporting: [c] })
  assert.equal(res.finding.confidence, 'corroborated')
  assert.deepEqual(res.change.independentSources, ['github.com', 'keybase.io'])
  assert.deepEqual(res.change.supportingFindingIds, ['f3'])
})

test('the independence fold is applied where findings are made, not left to each adapter', () => {
  const raw = { adapterId: 'stub', caseId: 'c1', entityId: 'ent_1', raw: fakeFinding().raw } as RawResult
  const made = (source: string): Finding =>
    finaliseFinding('stub', raw, makeFinding(raw, { source, claim: 'An account exists' }))

  // What sixteen adapters were each expected to remember. `gallery-dl` did not, and
  // sourced media at the CDN — so a site and its own content host counted as two
  // independent sources for one fact.
  assert.equal(made('https://api.github.com/users/torvalds').source, 'github.com')
  assert.equal(made('www.github.com').source, 'github.com')
  assert.equal(made('pbs.twimg.com').source, 'twimg.com')
  assert.equal(made('web.archive.org').source, 'archive.org')
  assert.equal(made('api.pwnedpasswords.com').source, 'pwnedpasswords.com')

  // Folding at the seam means two adapters that named one site differently produce **one**
  // finding, not two rows that look like agreement.
  assert.equal(made('https://github.com/torvalds').id, made('api.github.com').id)

  // Derived sources are left exactly as they are, letter case and all: `file:` names a
  // file a person reads, and folding either prefix to a host would collide every derived
  // claim in the app onto `local` or `file`.
  assert.equal(made('local:stub').source, 'local:stub')
  assert.equal(made('file:Holiday.JPG').source, 'file:Holiday.JPG')

  // A tool name in the corroboration key is refused rather than folded. There is no right
  // answer to fold it to, and keeping it let two runs of one tool corroborate each other.
  assert.throws(() => made('stub'), AdapterRegistrationError)
  assert.throws(() => made('theharvester(crtsh+otx)'), AdapterRegistrationError)
  assert.throws(() => made('subfinder(unattributed)'), /localSource/)
})

test('a local: source can never be one of the two, so analysis cannot promote itself', () => {
  const observed = fakeFinding({ id: 'f1', tool: 'maigret', source: 'github.com' })
  // The same adapter's own derived output: a histogram, a run summary, an inference over
  // captures already in the case. It observed nothing, so it is not a second opinion.
  const derived = fakeFinding({
    id: 'f2',
    tool: 'maigret',
    source: 'local:maigret',
    claim: 'maigret probed 38 sites and reported 3 hits'
  })

  const blocked = canCorroborate(observed, [derived])
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.sources, ['github.com'])
  assert.match(blocked.reason ?? '', /local:maigret/)
  assert.throws(
    () => promote({ finding: observed, to: 'corroborated', actor: 'corroborator', supporting: [derived] }),
    ConfidenceError
  )

  // Nor two of them together, however many adapters computed them.
  const otherDerived = fakeFinding({ id: 'f3', tool: 'pattern-timezone', source: 'local:pattern-timezone' })
  assert.equal(canCorroborate(observed, [derived, otherDerived]).ok, false)

  // A claim read out of the operator's own file is the same kind of thing: nobody was
  // asked, so nobody answered.
  const fromFile = fakeFinding({ id: 'f4', tool: 'exiftool', source: 'file:holiday.jpg' })
  assert.equal(canCorroborate(observed, [fromFile]).ok, false)

  // And two derived sources are still two *different* keys — `local:` is never folded to
  // the host `local`, or every adapter's analysis would look like one source.
  assert.notEqual(independenceKey('local:maigret'), independenceKey('local:pattern-timezone'))
  assert.notEqual(independenceKey('local:maigret'), 'local')
})

test('two sources that disagree do not corroborate each other', () => {
  const github = fakeFinding({
    id: 'f1',
    tool: 'maigret',
    source: 'github.com',
    claim: 'github.com shows the display name "Ivan Petrov" on this profile.'
  })
  // Same entity, different site, and it names somebody else. Mentioning the same handle is
  // the reason the row is in front of anybody; it is not agreement.
  const keybase = fakeFinding({
    id: 'f2',
    tool: 'sherlock',
    source: 'keybase.io',
    claim: 'keybase.io shows the display name "Maria Petrova" on this profile.'
  })

  assert.deepEqual(distinctSources([github, keybase]), ['github.com', 'keybase.io'])
  const blocked = canCorroborate(github, [keybase])
  assert.equal(blocked.ok, false)
  assert.equal(blocked.sources.length, 2, 'two independent sources — the refusal is about what they say')
  assert.match(blocked.reason ?? '', /disagree/)
  assert.throws(
    () => promote({ finding: github, to: 'corroborated', actor: 'corroborator', supporting: [keybase] }),
    ConfidenceError
  )

  // The same two sources agreeing do corroborate.
  const agreeing = fakeFinding({
    id: 'f3',
    tool: 'sherlock',
    source: 'keybase.io',
    claim: 'keybase.io shows the display name "Ivan Petrov" on this profile.'
  })
  assert.equal(canCorroborate(github, [agreeing]).ok, true)
  assert.equal(
    promote({ finding: github, to: 'corroborated', actor: 'corroborator', supporting: [agreeing] }).finding.confidence,
    'corroborated'
  )

  // A pair that disagrees is refused even when the finding being promoted says nothing
  // itself: the set has to agree, not just each half with the middle.
  const silent = fakeFinding({ id: 'f4', source: 'gitlab.com', claim: 'The handle is taken on gitlab.com.' })
  assert.equal(canCorroborate(silent, [github, keybase]).ok, false)

  // And silence is never disagreement — most of a username sweep states nothing about who
  // holds the account, and those rows corroborate exactly as they did before.
  const alsoSilent = fakeFinding({ id: 'f5', source: 'keybase.io', claim: 'The handle is taken on keybase.io.' })
  assert.equal(canCorroborate(silent, [alsoSilent]).ok, true)
})

test('only a human can confirm, and only with a note', () => {
  const f = fakeFinding()
  const others = [fakeFinding({ id: 'f2', source: 'keybase.io' }), fakeFinding({ id: 'f3', source: 'gitlab.com' })]
  // Any number of agreeing tools tops out at corroborated.
  assert.throws(() => promote({ finding: f, to: 'confirmed', actor: 'corroborator', supporting: others }), ConfidenceError)
  assert.throws(() => promote({ finding: f, to: 'confirmed', actor: 'human' }), ConfidenceError)
  const ok = promote({ finding: f, to: 'confirmed', actor: 'human', note: 'Opened the profile; the bio matches.' })
  assert.equal(ok.finding.confidence, 'confirmed')
  assert.equal(ok.change.actor, 'human')
  assert.ok(ok.finding.lastVerified)
})

test('corroboration cannot cross entities or cases', () => {
  const f = fakeFinding()
  assert.throws(
    () =>
      promote({
        finding: f,
        to: 'corroborated',
        actor: 'corroborator',
        supporting: [fakeFinding({ id: 'f2', source: 'keybase.io', entityId: 'ent_OTHER' })]
      }),
    ConfidenceError
  )
  assert.throws(
    () =>
      promote({
        finding: f,
        to: 'corroborated',
        actor: 'corroborator',
        supporting: [fakeFinding({ id: 'f2', source: 'keybase.io', caseId: 'c2' })]
      }),
    ConfidenceError
  )
})

/* ------------------------------------------------------------------ *
 * 3. Normalisation and ids
 * ------------------------------------------------------------------ */

test('entity identity is deterministic and dedupes on canonical value', () => {
  const a = normaliseEntityValue('domain', 'HTTPS://WWW.Example.com/path?x=1')
  assert.equal(a.value, 'example.com')
  assert.equal(entityId('c1', 'domain', a.value), entityId('c1', 'domain', 'example.com'))

  const e = normaliseEntityValue('email', 'A.B+tag@GMail.com')
  assert.equal(e.value, 'a.b+tag@gmail.com')
  assert.equal((e.attrs as { canonicalForm: string }).canonicalForm, 'ab@gmail.com')

  assert.equal(normaliseEntityValue('username', '@Exampleuser').value, 'exampleuser')
  assert.equal(normaliseEntityValue('location', '48.8584, 2.2945').value, '48.858400,2.294500')
})

test('finding identity excludes raw, so a re-run is a refresh not a duplicate', () => {
  const a = findingId('c1', 'ent_1', 'maigret', 'github.com', 'An account exists')
  const b = findingId('c1', 'ent_1', 'maigret', 'github.com', 'An account exists')
  assert.equal(a, b)
  assert.notEqual(a, findingId('c1', 'ent_1', 'sherlock', 'github.com', 'An account exists'))
})

test('type detection picks the specific kind first', () => {
  assert.equal(detectEntityKind('a@b.co'), 'email')
  assert.equal(detectEntityKind('8.8.8.8'), 'ipaddr')
  assert.equal(detectEntityKind('48.85,2.29'), 'location')
  assert.equal(detectEntityKind('https://github.com/foo'), 'account')
  assert.equal(detectEntityKind('example.com'), 'domain')
  assert.equal(detectEntityKind('exampleuser'), 'username')
  assert.equal(detectEntityKind(''), null)
})

/* ------------------------------------------------------------------ *
 * 4. Case store + SQLite + the rebuild proof
 * ------------------------------------------------------------------ */

test('case store writes a readable folder and enforces the consent rule', async () => {
  const dir = await tmpdir('store')
  const store = new CaseStore(path.join(dir, 'cases'))
  await store.ensureRoot()

  await assert.rejects(() => store.createCase({ name: 'x', basis: 'consent' }), /subjectConsent/)

  const c = await store.createCase({ name: 'Consent case', basis: 'consent', subjectConsent: true })
  assert.ok(fs.existsSync(path.join(store.dir(c.id), 'case.json')))
  assert.ok(fs.existsSync(path.join(store.dir(c.id), 'entities.json')))
  assert.ok(fs.existsSync(path.join(store.dir(c.id), 'findings.jsonl')))
  assert.ok(fs.existsSync(path.join(store.dir(c.id), 'raw')))
  assert.ok(fs.existsSync(path.join(store.dir(c.id), 'evidence')))

  const e1 = await store.upsertEntity(c.id, { kind: 'username', value: 'Exampleuser', seed: true })
  const e2 = await store.upsertEntity(c.id, { kind: 'username', value: 'exampleuser' })
  assert.equal(e1.id, e2.id, 'the same canonical value must be one entity')
  assert.equal(e2.seed, true, 'seed must be sticky-true once set')
  assert.equal((await store.readEntities(c.id)).length, 1)
})

test('rebuildIndex() reconstructs the database exactly, from files alone', async () => {
  const dir = await tmpdir('rebuild')
  const store = new CaseStore(path.join(dir, 'cases'))
  await store.ensureRoot()

  const c = await store.createCase({ name: 'Rebuild proof', basis: 'training' })
  const entity = await store.upsertEntity(c.id, { kind: 'username', value: 'rebuildme', seed: true })

  const sources = ['github.com', 'keybase.io', 'gitlab.com']
  const created: Finding[] = []
  for (const source of sources) {
    const raw = await store.writeRaw(c.id, JSON.stringify({ source, hit: true }), { mediaType: 'application/json' })
    const { finding } = await store.upsertFinding(c.id, {
      entityId: entity.id,
      source,
      tool: 'echo',
      claim: 'An account named rebuildme exists',
      raw
    })
    created.push(finding)
  }
  // Promote one, so the confidence log is part of what must survive.
  const first = created[0]!
  const promoted = promote({ finding: first, to: 'corroborated', actor: 'corroborator', supporting: created.slice(1) })
  await store.replaceFinding(c.id, promoted.finding)
  await store.appendConfidenceChange(c.id, promoted.change)
  await store.addEvidence(c.id, { findingId: first.id, type: 'text', body: 'a screenshot would go here', ext: 'txt' })

  const dbFile = path.join(dir, 'data', 'index.db')
  const db1 = openDatabase(dbFile)
  const stats1 = await rebuildIndex(db1, store)
  const snapshot = (db: ReturnType<typeof openDatabase>): string =>
    JSON.stringify({
      cases: db.prepare('SELECT * FROM cases ORDER BY id').all(),
      entities: db.prepare('SELECT * FROM entities ORDER BY id').all(),
      findings: db.prepare('SELECT * FROM findings ORDER BY id').all(),
      evidence: db.prepare('SELECT * FROM evidence ORDER BY id').all(),
      cc: db.prepare('SELECT * FROM confidence_changes ORDER BY id').all()
    })
  const before = snapshot(db1)
  const searchBefore = searchFindings(db1, c.id, 'rebuildme').length
  db1.close()

  // Delete the database entirely, including the WAL sidecars.
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix)) fs.rmSync(dbFile + suffix)
  }
  assert.equal(fs.existsSync(dbFile), false)

  const db2 = openDatabase(dbFile)
  const stats2 = await rebuildIndex(db2, store)
  const after = snapshot(db2)
  const searchAfter = searchFindings(db2, c.id, 'rebuildme').length

  assert.equal(after, before, 'a rebuilt index must be byte-identical to the original')
  assert.equal(stats2.cases, stats1.cases)
  assert.equal(stats2.findings, 3)
  assert.equal(stats2.entities, 1)
  assert.equal(stats2.evidence, 1)
  assert.equal(stats2.confidenceChanges, 1)
  assert.equal(stats2.skipped.length, 0)
  assert.equal(searchAfter, searchBefore)
  assert.ok(searchAfter > 0, 'FTS5 must work after a rebuild')

  // The promoted confidence survived, because it lives in the files.
  const promotedAfter = listFindings(db2, c.id).find((f) => f.id === first.id)
  assert.equal(promotedAfter?.confidence, 'corroborated')
  db2.close()
})

test('concurrent writers do not lose entities or findings', async () => {
  // Regression: the orchestrator runs adapters in parallel and each one persists through
  // a read-modify-write of the same file. Without a per-file lock the second writer
  // reads stale contents and erases the first one's work — silently, and only under
  // concurrency.
  const dir = await tmpdir('concurrent')
  const store = new CaseStore(path.join(dir, 'cases'))
  await store.ensureRoot()
  const c = await store.createCase({ name: 'Concurrent', basis: 'training' })

  const N = 25
  const entities = await Promise.all(
    Array.from({ length: N }, (_, i) => store.upsertEntity(c.id, { kind: 'username', value: `user-${i}` }))
  )
  assert.equal((await store.readEntities(c.id)).length, N, 'every concurrently added entity must survive')

  const raw = await store.writeRaw(c.id, '{}', { mediaType: 'application/json' })
  await Promise.all(
    entities.map((e, i) =>
      store.upsertFinding(c.id, { entityId: e.id, source: `src-${i}.example`, tool: 'echo', claim: `claim ${i}`, raw })
    )
  )
  const { records, badLines } = await store.readFindings(c.id)
  assert.equal(badLines.length, 0)
  assert.equal(records.length, N, 'every concurrently written finding must survive')
})

test('a corrupt case folder is skipped, not fatal', async () => {
  const dir = await tmpdir('corrupt')
  const store = new CaseStore(path.join(dir, 'cases'))
  await store.ensureRoot()
  const good = await store.createCase({ name: 'Good', basis: 'training' })
  const bad = await store.createCase({ name: 'Bad', basis: 'training' })
  await fsp.writeFile(path.join(store.dir(bad.id), 'case.json'), '{ this is not json')

  const db = openDatabase(path.join(dir, 'data', 'index.db'))
  const stats = await rebuildIndex(db, store)
  assert.equal(stats.cases, 1)
  assert.equal(stats.skipped.length, 1)
  assert.equal(stats.skipped[0]?.caseId, bad.id)
  assert.ok(db.prepare('SELECT 1 FROM cases WHERE id = ?').get(good.id))
  db.close()
})

test('a corrupt findings line costs one finding, not the file', async () => {
  const dir = await tmpdir('badline')
  const store = new CaseStore(path.join(dir, 'cases'))
  await store.ensureRoot()
  const c = await store.createCase({ name: 'Bad line', basis: 'training' })
  const e = await store.upsertEntity(c.id, { kind: 'username', value: 'x' })
  const raw = await store.writeRaw(c.id, '{}', { mediaType: 'application/json' })
  await store.upsertFinding(c.id, { entityId: e.id, source: 'a.com', tool: 'echo', claim: 'ok', raw })
  await fsp.appendFile(path.join(store.dir(c.id), 'findings.jsonl'), '{ broken\n')

  const { records, badLines } = await store.readFindings(c.id)
  assert.equal(records.length, 1)
  assert.equal(badLines.length, 1)
})

/* ------------------------------------------------------------------ *
 * 5. Spawn: hangs and non-zero exits
 * ------------------------------------------------------------------ */

test('a hanging tool is killed at the timeout', async () => {
  const started = Date.now()
  const res = await runProcess(process.execPath, {
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 800,
    maxOutputBytes: 1024
  })
  assert.equal(res.timedOut, true)
  assert.ok(res.spawnError?.includes('Timed out'))
  assert.ok(Date.now() - started < 6000, 'the kill must not take seconds longer than the timeout')
})

test('a non-zero exit keeps the stderr that explains it', async () => {
  const res = await runProcess(process.execPath, {
    args: ['-e', 'console.error("Cloudflare challenge encountered"); process.exit(3)'],
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 64
  })
  assert.equal(res.exitCode, 3)
  assert.equal(res.timedOut, false)
  assert.ok(res.stderr.includes('Cloudflare challenge'))
})

test('a missing binary is a result, not a crash', async () => {
  const res = await runProcess('definitely-not-a-real-binary-xyz', { timeoutMs: 5000, maxOutputBytes: 1024 })
  assert.equal(res.exitCode, null)
  assert.ok(res.spawnError)
})

test('output past the cap is truncated and flagged', async () => {
  const res = await runProcess(process.execPath, {
    args: ['-e', 'process.stdout.write("x".repeat(200000))'],
    timeoutMs: 10_000,
    maxOutputBytes: 1024
  })
  assert.equal(res.truncated, true)
  assert.ok(res.stdout.length <= 1024)
})

/* ------------------------------------------------------------------ *
 * 6. End to end through the real service
 * ------------------------------------------------------------------ */

test('service: case -> entity -> echo adapter -> finding in SQLite', async () => {
  const root = await tmpdir('service')
  await fsp.mkdir(path.join(root, 'config'), { recursive: true })
  const service = await OsintService.create(root)

  const c = await service.createCase({ name: 'E2E', basis: 'training' })
  assert.equal(c.publishable, true, 'training cases are publishable')

  const entity = await service.addEntity({ caseId: c.id, kind: 'username', value: 'E2EUser', seed: true })
  const job = await service.runJobAndWait({ caseId: c.id, entityId: entity.id, adapterId: 'echo' })

  assert.equal(job.state, 'done', job.error ?? '')
  assert.equal(job.findingIds.length, 1)
  assert.ok(job.rawId, 'raw output must be persisted')

  const rows = service.db.prepare('SELECT * FROM findings WHERE case_id = ?').all(c.id) as { confidence: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.confidence, 'unverified', 'one tool hit is never more than unverified')

  const hits = await service.searchFindings(c.id, 'E2EUser')
  assert.equal(hits.length, 1, 'FTS5 must index the finding')

  const rawText = await service.readRaw(c.id, hits[0]!.id)
  assert.ok(rawText.includes('e2euser'), 'the raw capture must be re-readable from disk')

  // Re-running the same adapter must refresh, not duplicate.
  const again = await service.runJobAndWait({ caseId: c.id, entityId: entity.id, adapterId: 'echo' })
  assert.equal(again.state, 'done')
  const after = service.db.prepare('SELECT COUNT(*) n FROM findings WHERE case_id = ?').get(c.id) as { n: number }
  assert.equal(after.n, 1, 're-running a tool must not duplicate findings')
  const refreshed = (await service.listFindings(c.id))[0]!
  assert.ok(refreshed.lastVerified, 'a re-observation must move lastVerified')
  assert.equal(refreshed.confidence, 'unverified', 're-observation is not corroboration')

  await service.dispose()
})

test('service: a case with basis "self" is not publishable', async () => {
  const root = await tmpdir('publishable')
  const service = await OsintService.create(root)
  const self = await service.createCase({ name: 'My own footprint', basis: 'self' })
  assert.equal(self.publishable, false)
  const ctf = await service.createCase({ name: 'Sakura room', basis: 'ctf-fictional' })
  assert.equal(ctf.publishable, true)
  const pub = await service.createCase({ name: 'Some company', basis: 'public-entity' })
  assert.equal(pub.publishable, true)
  await service.dispose()
})

test('orchestrator: per-adapter concurrency and rate limiting are respected', async () => {
  const root = await tmpdir('orch')
  const service = await OsintService.create(root)
  const c = await service.createCase({ name: 'Concurrency', basis: 'training' })

  const entities = await Promise.all(
    ['a', 'b', 'c', 'd'].map((v) => service.addEntity({ caseId: c.id, kind: 'username', value: `user-${v}` }))
  )

  // Force a gap between starts and observe it.
  service.config.adapters['echo'] = { concurrency: 1, minIntervalMs: 120 }
  const started = Date.now()
  await Promise.all(
    entities.map((e) => service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'echo' }))
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 3 * 120, `four serialised runs at 120 ms apart should take >= 360 ms, took ${elapsed}`)

  const n = service.db.prepare('SELECT COUNT(*) n FROM findings WHERE case_id = ?').get(c.id) as { n: number }
  assert.equal(n.n, 4)
  await service.dispose()
})

test('orchestrator: an adapter that throws still persists its raw output', async () => {
  const root = await tmpdir('throwing')
  const service = await OsintService.create(root)
  service.registry.register({
    id: 'exploder',
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: docFixture(),
    run: async () => {
      throw new Error('the tool exploded on contact with reality')
    },
    parse: () => []
  })
  const c = await service.createCase({ name: 'Exploder', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'boom' })
  const job = await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'exploder' })

  assert.equal(job.state, 'failed')
  assert.ok(job.error?.includes('exploded'))
  assert.ok(job.rawId, 'a failed run must still leave its raw output on disk')
  const rawFiles = await fsp.readdir(path.join(service.store.dir(c.id), 'raw'))
  assert.equal(rawFiles.length, 1)
  await service.dispose()
})

test('orchestrator: a parser that throws does not lose the raw capture', async () => {
  const root = await tmpdir('badparser')
  const service = await OsintService.create(root)
  service.registry.register({
    id: 'badparser',
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: docFixture(),
    run: async (input, ctx) => ({
      adapterId: 'badparser',
      caseId: input.caseId,
      entityId: input.entity.id,
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: '{"real":"output"}',
      stderr: '',
      mediaType: 'application/json',
      startedAt: ctx.now(),
      finishedAt: ctx.now(),
      durationMs: 1,
      truncated: false,
      timedOut: false,
      command: null,
      error: null,
      raw: { rawId: '', path: '', sha256: '', bytes: 0, mediaType: 'application/json', excerpt: '' }
    }),
    parse: () => {
      throw new Error('parser bug')
    }
  })
  const c = await service.createCase({ name: 'Bad parser', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'x' })
  const job = await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'badparser' })

  assert.equal(job.state, 'failed')
  assert.ok(job.error?.includes('can be re-parsed'))
  const rawDir = path.join(service.store.dir(c.id), 'raw')
  const files = await fsp.readdir(rawDir)
  assert.equal(files.length, 1)
  const kept = await fsp.readFile(path.join(rawDir, files[0]!), 'utf8')
  assert.ok(kept.includes('real'), 'the unparsed output must survive a parser bug')
  await service.dispose()
})

test('orchestrator: a refused run still says so in the case file', async () => {
  const root = await tmpdir('refusal')
  const service = await OsintService.create(root)
  const failing = (id: string, parse: Adapter['parse']): Adapter => ({
    id,
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: docFixture(),
    run: async (input, ctx) => ({
      adapterId: id,
      caseId: input.caseId,
      entityId: input.entity.id,
      // What every adapter that computes `ok` from "did anyone answer" produces when
      // nobody did: websearch's `ok: served > 0`, archive-today's `ok: servedBy !== null`.
      ok: false,
      exitCode: 1,
      signal: null,
      stdout: '{}',
      stderr: 'every backend refused',
      mediaType: 'application/json',
      startedAt: ctx.now(),
      finishedAt: ctx.now(),
      durationMs: 1,
      truncated: false,
      timedOut: false,
      command: null,
      error: 'every backend refused this client',
      raw: { rawId: '', path: '', sha256: '', bytes: 0, mediaType: 'application/json', excerpt: '' }
    }),
    parse
  })

  // An adapter with a refusal template of its own. Until the orchestrator ran `parse()` on
  // a failed run, this branch was unreachable code in every adapter that had written one.
  service.registry.register(
    failing('refuser', (raw) => [
      makeFinding(raw, {
        source: 'local:refuser',
        claim: 'Every backend refused this client. Nothing was learned about the subject.'
      }),
      // A claim about the world, from a run that did not reach the world. This is the one
      // that must not land: it is how "the listing endpoint returned 403" becomes "the
      // account has no public posts".
      makeFinding(raw, { source: 'example.com', claim: 'example.com holds no account for this handle.' })
    ])
  )
  // And one with nothing to say for itself, which is most of them.
  service.registry.register(failing('silent-failer', () => []))

  const c = await service.createCase({ name: 'Refusals', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })

  const job = await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'refuser' })
  assert.equal(job.state, 'failed', 'the run still failed — parsing it does not make it a success')

  const findings = await service.listFindings(c.id)
  assert.equal(findings.length, 1, 'the refusal lands and the site-sourced claim does not')
  assert.equal(findings[0]?.source, 'local:refuser')
  assert.match(findings[0]?.claim ?? '', /refused/)
  assert.equal(job.findingIds.length, 1, 'the job has to name what it wrote')

  const silent = await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'silent-failer' })
  assert.equal(silent.state, 'failed')
  const all = await service.listFindings(c.id)
  const synthesised = all.find((f) => f.tool === 'silent-failer')
  assert.ok(synthesised, 'a failed run leaves a record whether or not its adapter wrote one')
  assert.equal(synthesised?.source, 'local:silent-failer')
  assert.match(synthesised?.claim ?? '', /may be read as an absence/)

  // Neither can ever be counted toward corroboration, which is the point of `local:`: a
  // refusal is a fact about the run, not a second opinion about the subject.
  assert.deepEqual(distinctSources(all), [])
  await service.dispose()
})

test('orchestrator: cancelling a queued job settles it as cancelled', async () => {
  const root = await tmpdir('cancel')
  const service = await OsintService.create(root)
  service.registry.register({
    id: 'slow',
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: docFixture(),
    concurrency: 1,
    run: async (_input, ctx) =>
      new Promise((_res, rej) => {
        const t = setTimeout(() => rej(new Error('should have been cancelled')), 30_000)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t)
          rej(new Error('cancelled'))
        })
      }),
    parse: () => []
  })
  const c = await service.createCase({ name: 'Cancel', basis: 'training' })
  const e1 = await service.addEntity({ caseId: c.id, kind: 'username', value: 'one' })
  const e2 = await service.addEntity({ caseId: c.id, kind: 'username', value: 'two' })

  const running = service.orchestrator.enqueue({ caseId: c.id, entityId: e1.id, adapterId: 'slow' })
  const queued = service.orchestrator.enqueue({ caseId: c.id, entityId: e2.id, adapterId: 'slow' })

  assert.equal(service.orchestrator.cancel(queued.job.id), true)
  const queuedResult = await queued.whenSettled
  assert.equal(queuedResult.state, 'cancelled')

  assert.equal(service.orchestrator.cancel(running.job.id), true)
  const runningResult = await running.whenSettled
  assert.equal(runningResult.state, 'cancelled')

  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * 7. Adapters — doc quality and every parser against real captured output
 * ------------------------------------------------------------------ */

for (const t of adapterTests) test(t.name, t.fn)
for (const t of reverseImageTests) test(t.name, t.fn)

/* The search path: backend parsers against real results pages, query construction, the
   TimeMap reader, and the two failures that make a search adapter dangerous — a CAPTCHA
   served as HTTP 202, and an engine that silently drops the operators. */
for (const t of searchTests) test(t.name, t.fn)

imageTests(test)
matcherTests(test)
pivotTests(test)

/* The pasted-link parser, and the agreement between every fold in the app. This module
   was written with the folds already duplicated and then never registered here, so the
   drift test that was supposed to police the duplication had not run once. */
platformTests(test)

/* Properties of the repository itself — currently one, and it earned it. */
repoTests(test)

/* ------------------------------------------------------------------ *
 * 8. Run options across IPC, secret redaction, structured progress, candidates
 * ------------------------------------------------------------------ */

for (const t of integrationTests) test(t.name, t.fn)

/* Removing, correcting, and running many adapters at once. */
for (const t of lifecycleTests) test(t.name, t.fn)

/* ------------------------------------------------------------------ *
 * 9. Self-Audit — level isolation, the honesty layer, the delta, the letters
 * ------------------------------------------------------------------ */

for (const t of selfAuditTests) test(t.name, t.fn)
nameTests(test)

/* ------------------------------------------------------------------ *
 * 10. Ranking — links, gender, and contradiction scoring over the seeds
 * ------------------------------------------------------------------ */

relevanceTests(test)

/* ------------------------------------------------------------------ *
 * 11. The investigation engine — provenance, planning, stopping, and the
 *     invariant that automation promotes nothing
 * ------------------------------------------------------------------ */

for (const t of engineTests) test(t.name, t.fn)

/* ------------------------------------------------------------------ *
 * 12. The export — the document handed to the person it is about, and the
 *     rules that stop it claiming more than the case holds
 * ------------------------------------------------------------------ */

for (const t of exportTests) test(t.name, t.fn)

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  let passed = 0
  const failures: { name: string; err: unknown }[] = []
  for (const t of tests) {
    try {
      await t.fn()
      passed++
      console.log(`  ok   ${t.name}`)
    } catch (err) {
      failures.push({ name: t.name, err })
      console.log(`  FAIL ${t.name}`)
      console.log(`       ${(err as Error).message?.split('\n').slice(0, 6).join('\n       ')}`)
    }
  }
  console.log(`\n${passed}/${tests.length} passed`)
  if (failures.length) {
    console.error(`\n${failures.length} failing test(s).`)
    process.exitCode = 1
  }
}

void main()

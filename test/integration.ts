/**
 * The three things this pass added, tested where they actually happen.
 *
 *  1. **Options and a timeout cross the IPC surface.** They always existed on the
 *     orchestrator and were dropped by `RunJobRequest`, which meant `hibp-passwords` —
 *     whose entire input is an option — could not be run from the UI at all.
 *  2. **A declared secret never reaches disk.** Not in the raw capture, not in a stderr
 *     tail, not in a job's error message. Proved with an adapter that deliberately leaks
 *     its input on every path, because the guarantee has to hold for the adapter that
 *     gets it wrong, not only for the one that gets it right.
 *  3. **`produces` grows the graph, and only a human does the growing.** A discovery
 *     becomes a candidate; a candidate becomes an entity when a person says so, and
 *     never before.
 *
 * Plus the structured progress fields, and the scanner that reads them out of a real
 * captured maigret transcript.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { createScanner } from '../src/main/adapters/support/progress'
import { AdapterRegistrationError, AdapterRegistry, makeFinding, type Adapter, type RawResult } from '../src/main/adapters/types'
import { REDACTED } from '../src/main/orchestrator'
import { OsintService, sanitiseRunRequest } from '../src/main/service'
import { sha1Hex } from '../src/main/adapters/support/net'
import type { Job, JobProgress } from '../src/shared/types'

export interface IntegrationTest {
  name: string
  fn: () => void | Promise<void>
}

export const integrationTests: IntegrationTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  integrationTests.push({ name, fn })
}

function doc(): Adapter['doc'] {
  return {
    what: 'A fixture adapter used only by the test suite.',
    how: 'It does nothing at all and returns a constant, which is exactly enough to exercise the plumbing under test.',
    why: 'Because the plumbing is what is under test, not any particular mechanism.',
    betterAt: 'Being predictable in a unit test with no network and no filesystem.',
    worseAt: 'Producing any information whatsoever about the real world.',
    falsePositives: 'It cannot produce false positives because it makes no claims about anything.'
  }
}

/** A run that succeeds and hands `parse` whatever JSON the caller built. */
function jsonResult(input: { caseId: string; entityId: string }, adapterId: string, body: string, now: string): RawResult {
  return {
    adapterId,
    caseId: input.caseId,
    entityId: input.entityId,
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: body,
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
}

async function scratch(prefix: string): Promise<string> {
  const base = path.join(process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test'), prefix)
  await fsp.mkdir(base, { recursive: true })
  return fsp.mkdtemp(path.join(base, 'run-'))
}

/* ------------------------------------------------------------------ *
 * 1. Options and timeoutMs across IPC
 * ------------------------------------------------------------------ */

test('run options survive the IPC surface and reach the adapter', async () => {
  const service = await OsintService.create(await scratch('runopts'))
  service.registry.register({
    id: 'optreader',
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: doc(),
    run: async (input, ctx) =>
      jsonResult(
        { caseId: input.caseId, entityId: input.entity.id },
        'optreader',
        JSON.stringify({ seen: input.options, deadline: ctx.timeoutMs }),
        ctx.now()
      ),
    parse: (raw) => {
      const seen = JSON.parse(raw.stdout) as { seen: Record<string, unknown>; deadline: number }
      return [
        makeFinding(raw, {
          source: 'local:optreader',
          claim: `options=${JSON.stringify(seen.seen)} deadline=${seen.deadline}`
        })
      ]
    }
  })

  const c = await service.createCase({ name: 'Options', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'optuser' })
  const job = await service.runJobAndWait({
    caseId: c.id,
    entityId: e.id,
    adapterId: 'optreader',
    options: { topSites: 12, tags: ['dev'] },
    timeoutMs: 9_000
  })

  assert.equal(job.state, 'done', job.error ?? '')
  const claim = (await service.listFindings(c.id))[0]?.claim ?? ''
  assert.ok(claim.includes('"topSites":12'), `options did not reach the adapter: ${claim}`)
  assert.ok(claim.includes('"tags":["dev"]'), `array options did not survive: ${claim}`)
  assert.ok(claim.includes('deadline=9000'), `timeoutMs did not reach the adapter: ${claim}`)
  await service.dispose()
})

test('a run request is sanitised before it can reach an adapter', () => {
  const base = { caseId: 'c', entityId: 'e', adapterId: 'a' }

  assert.deepEqual(sanitiseRunRequest(base), base, 'a request with no options must pass through unchanged')

  // A prototype-polluting key would otherwise be merged into the options bag an adapter
  // spreads into its argv.
  const cleaned = sanitiseRunRequest({ ...base, options: JSON.parse('{"__proto__":{"x":1},"ok":2}') })
  assert.deepEqual(Object.keys(cleaned.options ?? {}), ['ok'])

  assert.throws(() => sanitiseRunRequest({ ...base, options: [1, 2] as never }), /plain object/)
  assert.throws(() => sanitiseRunRequest({ ...base, options: { f: () => 1 } as never }), /not a value/)
  // A NaN deadline turns the orchestrator's watchdog into NaN and the run is never killed.
  assert.throws(() => sanitiseRunRequest({ ...base, timeoutMs: Number.NaN }), /timeoutMs/)
  assert.throws(() => sanitiseRunRequest({ ...base, timeoutMs: 5 }), /timeoutMs/)
  assert.throws(() => sanitiseRunRequest({ ...base, timeoutMs: 1e12 }), /timeoutMs/)
})

/* ------------------------------------------------------------------ *
 * 2. A declared secret never reaches disk
 * ------------------------------------------------------------------ */

/**
 * The adapter here leaks its input on purpose — into stdout, into stderr, into the
 * command line, and into the error message. That is the point: `hibp-passwords` is
 * careful, and "careful" is a property of one author on one afternoon. The orchestrator's
 * guarantee has to hold without the adapter's cooperation.
 */
test('a secret option is scrubbed from the raw capture, the stderr and the error message', async () => {
  const service = await OsintService.create(await scratch('secret'))
  const PASSWORD = 'correct-horse-battery-staple'
  const HASH = sha1Hex(PASSWORD)

  const leaky = (id: string, ok: boolean): Adapter => ({
    id,
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    secretOptions: ['password'],
    doc: doc(),
    run: async (input, ctx) => {
      const pw = String(input.options['password'] ?? '')
      return {
        ...jsonResult({ caseId: input.caseId, entityId: input.entity.id }, id, JSON.stringify({ pw, hash: sha1Hex(pw) }), ctx.now()),
        ok,
        stderr: `request failed while sending ${pw}`,
        command: { file: 'curl', args: ['--data', pw] },
        error: ok ? null : `the endpoint rejected ${pw}`
      }
    },
    parse: (raw) => [makeFinding(raw, { source: 'local:' + id, claim: 'a run happened' })]
  })

  service.registry.register(leaky('leaky-ok', true))
  service.registry.register(leaky('leaky-fail', false))

  const c = await service.createCase({ name: 'Secret', basis: 'self' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'secretuser' })

  for (const adapterId of ['leaky-ok', 'leaky-fail']) {
    const job = await service.runJobAndWait({
      caseId: c.id,
      entityId: e.id,
      adapterId,
      options: { password: PASSWORD }
    })
    assert.ok(job.rawId, `${adapterId} must still persist its raw output`)
    assert.ok(
      !(job.error ?? '').includes(PASSWORD),
      `${adapterId} leaked the secret into the job's error message`
    )
  }

  // Read every byte the case folder holds and look for the secret in any of them.
  const dir = service.store.dir(c.id)
  const files: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) await walk(p)
      else files.push(p)
    }
  }
  await walk(dir)
  assert.ok(files.length > 0, 'the case folder must contain something to check')

  let sawRedaction = false
  for (const file of files) {
    const text = await fsp.readFile(file, 'utf8')
    assert.ok(!text.includes(PASSWORD), `${path.relative(dir, file)} contains the secret`)
    assert.ok(!text.toLowerCase().includes(HASH.toLowerCase()), `${path.relative(dir, file)} contains the full hash`)
    if (text.includes(REDACTED)) sawRedaction = true
  }
  assert.ok(sawRedaction, 'the raw capture must record that something was withheld, not silently drop it')

  await service.dispose()
})

/**
 * Found by auditing a live run rather than by reading the code.
 *
 * `hibp-passwords` used to persist the whole range response, which looks obviously safe —
 * 2,006 anonymous suffixes is the entire point of k-anonymity. But the finding it produces
 * states the occurrence count, that count is unique within the bucket, and
 * count + bucket + prefix is the complete SHA-1 of the candidate. The case folder was
 * therefore an offline cracking target for anyone who opened it, while the adapter's own
 * header comment claimed the opposite.
 *
 * Driven through the real `run()`, because the leak lived in what `run()` chose to write
 * and nothing in `parse()` could ever have shown it. `fetch` is stubbed with the captured
 * range response, so this stays offline and deterministic like the rest of the suite.
 */
test('hibp-passwords does not store the suffix list beside the count that identifies it', async () => {
  const body = await fsp.readFile(
    path.join(process.cwd(), 'test', 'fixtures', 'adapters', 'hibp-range-5BAA6.txt'),
    'utf8'
  )
  const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8'
  const lines = body.split(/\r?\n/).filter((l) => l.trim())
  const count = Number(lines.find((l) => l.toUpperCase().startsWith(SUFFIX))?.split(':')[1])
  assert.ok(count > 0, 'the fixture must contain the canonical line this test is about')
  assert.equal(
    lines.filter((l) => l.trim().endsWith(`:${count}`)).length,
    1,
    'the premise: that occurrence count is unique in the bucket, so publishing it names the line'
  )

  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } })) as typeof fetch

  try {
    const service = await OsintService.create(await scratch('hibpaudit'))
    const c = await service.createCase({ name: 'Password audit', basis: 'self' })
    const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'audit-subject' })
    const job = await service.runJobAndWait({
      caseId: c.id,
      entityId: e.id,
      adapterId: 'hibp-passwords',
      options: { password: 'password' }
    })
    assert.equal(job.state, 'done', job.error ?? '')

    const findings = await service.listFindings(c.id)
    assert.equal(findings.length, 1)
    assert.ok(findings[0]!.claim.includes(count.toLocaleString('en-US')), 'the count is the finding, and it is reported')

    // Every byte the case folder holds.
    const dir = service.store.dir(c.id)
    const walk = async (d: string, into: string[]): Promise<string[]> => {
      for (const entry of await fsp.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name)
        if (entry.isDirectory()) await walk(p, into)
        else into.push(p)
      }
      return into
    }
    let sawPrefix = false
    for (const file of await walk(dir, [])) {
      const text = await fsp.readFile(file, 'utf8')
      const upper = text.toUpperCase()
      assert.ok(!upper.includes(SUFFIX), `${path.basename(file)} still holds the matching suffix`)
      assert.ok(!upper.includes(`5BAA6${SUFFIX}`), `${path.basename(file)} still holds the full hash`)
      // A neighbouring suffix would be just as damaging: it is the *list* that has to go,
      // not only our own line.
      const other = lines.find((l) => !l.toUpperCase().startsWith(SUFFIX))?.split(':')[0]?.trim()
      assert.ok(other && !upper.includes(other.toUpperCase()), `${path.basename(file)} still holds the bucket`)
      if (text.includes('5BAA6')) sawPrefix = true
    }
    assert.ok(sawPrefix, 'the prefix — the part that really was transmitted — must still be recorded')
    await service.dispose()
  } finally {
    globalThis.fetch = realFetch
  }
})

/* ------------------------------------------------------------------ *
 * 3. Structured progress
 * ------------------------------------------------------------------ */

test('structured progress fields reach the job instead of a sentence to be regexed', async () => {
  const service = await OsintService.create(await scratch('progress'))
  service.registry.register({
    id: 'counter',
    accepts: ['username'],
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: doc(),
    run: async (input, ctx) => {
      ctx.progress({ done: 0, total: 38, hits: 0 })
      ctx.progress({ done: 12, total: 38, current: 'github.com', hits: 3 })
      return jsonResult({ caseId: input.caseId, entityId: input.entity.id }, 'counter', '{}', ctx.now())
    },
    parse: () => []
  })

  const seen: JobProgress[] = []
  service.orchestrator.on('job:update', (j: Job) => seen.push({ ...j.progress }))

  const c = await service.createCase({ name: 'Progress', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'counted' })
  const job = await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'counter' })

  assert.equal(job.state, 'done', job.error ?? '')
  assert.equal(job.progress.done, 12)
  assert.equal(job.progress.total, 38)
  assert.equal(job.progress.current, 'github.com')
  assert.equal(job.progress.hits, 3)
  assert.ok(
    seen.some((p) => p.done === 0 && p.total === 38),
    'every intermediate progress report must be emitted, not only the last'
  )
  await service.dispose()
})

test('the stdout scanner reads maigret\'s real counter and sherlock\'s real result lines', () => {
  // The captured transcript from the Phase 0 smoke run — a real 38-site sweep, progress
  // bar and all. Fed in small chunks because that is how it arrives from a pipe, and a
  // token split across two chunks must be counted once or not at all, never twice.
  const transcript = [
    '[+] MAIGRET - collect a dossier by username from 3000+ sites\n',
    '[+] Using sites database: C:\\Users\\x/.maigret\\data.json (3363 sites)\n',
    '[-] Starting a search on top 38 sites from the Maigret database...\n',
    '[*] Checking username torvalds on:\r',
    'Searching |     | 1/38 [3%] in 1s (~36s, [+] Telegram: https://t.me/torvalds\n',
    ' \u251c\u2500fullname: ToRvaLDs\n',
    'Searching |###  | 5/38 [13%] in 1s (~26s,[+] GitHub: https://github.com/torvalds\n',
    'Searching |#####| 12/38 [32%] in 1s (~5s,[-] Facebook: Not Found!\n'
  ]

  let done: number | null = null
  let total: number | null = null
  let stated: number | null = null
  let hits = 0
  let units = 0
  let last = ''
  const scan = createScanner({
    onTotal: (n) => {
      stated = n
    },
    onCount: (d, t) => {
      done = d
      total = t
    },
    onUnit: (label, hit) => {
      // The banner uses the same shape as a result line; the adapter filters it, and this
      // asserts the filter is doing real work rather than being decoration.
      if (/^(Using |Starting |MAIGRET)/.test(label)) return
      units++
      if (hit) hits++
      last = label
    }
  })
  for (const chunk of transcript) scan(chunk)

  assert.equal(stated, 38, 'the stated total must be read before any counting starts')
  assert.equal(done, 12, 'the newest counter frame wins')
  assert.equal(total, 38)
  assert.equal(hits, 2, 'two profiles were announced')
  assert.equal(units, 3, 'a miss is a finished unit too')
  assert.equal(last, 'Facebook')

  // Nothing usable in it, and it must not invent anything.
  let fired = false
  const quiet = createScanner({ onCount: () => (fired = true), onUnit: () => (fired = true) })
  quiet('nothing structured here at all\n')
  assert.equal(fired, false, 'unrecognised output must contribute nothing')
})

/* ------------------------------------------------------------------ *
 * 4. produces -> candidates -> entities, with a human in the middle
 * ------------------------------------------------------------------ */

const DISCOVERED = ['github.com/found-one', 'gitlab.com/found-two'] as const

/**
 * Proposes two accounts, plus one proposal citing a finding that does not exist.
 *
 * Takes an id because the adapter registry is process-wide and shared by every
 * `OsintService` in this file — registering the same id twice is a startup error, which is
 * exactly the behaviour the registry is supposed to have.
 */
function discoverer(id = 'discoverer'): Adapter {
  return {
    id,
    accepts: ['username'],
    produces: ['account'],
    requiresKey: false,
    requiresNetwork: false,
    doc: doc(),
    run: async (input, ctx) =>
      jsonResult({ caseId: input.caseId, entityId: input.entity.id }, id, '{}', ctx.now()),
    parse: (raw) =>
      DISCOVERED.map((v) =>
        makeFinding(raw, { source: v.split('/')[0] as string, claim: `An account ${v} responded.` })
      ),
    propose: (raw) => [
      ...DISCOVERED.map((v) => ({
        fromFindingId: makeFinding(raw, {
          source: v.split('/')[0] as string,
          claim: `An account ${v} responded.`
        }).id,
        kind: 'account' as const,
        value: v,
        rationale: `${v.split('/')[0]} served a page for this handle. A responding URL, not a verified account.`
      })),
      {
        fromFindingId: 'fnd_0000000000000000000',
        kind: 'account' as const,
        value: 'nowhere.example/ghost',
        rationale: 'Cites a finding this run never produced; must be dropped.'
      }
    ]
  }
}

test('a discovery becomes a candidate, never an entity', async () => {
  const service = await OsintService.create(await scratch('candidates'))
  service.registry.register(discoverer())

  const c = await service.createCase({ name: 'Growth', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'grower', seed: true })
  const job = await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'discoverer' })
  assert.equal(job.state, 'done', job.error ?? '')

  assert.equal((await service.listEntities(c.id)).length, 1, 'nothing may enter the graph on its own')

  const pending = await service.listCandidates(c.id, 'pending')
  assert.equal(pending.length, 2, 'a proposal citing an unknown finding must be dropped, not stored')
  assert.ok(!pending.some((p) => p.value.includes('nowhere.example')))

  const one = pending.find((p) => p.value === 'github.com/found-one')
  assert.ok(one, 'the candidate keeps the canonical platform/handle form')
  assert.equal(one.bestConfidence, 'unverified', 'a candidate is only as good as the finding behind it')
  assert.equal(one.claims.length, 1)
  assert.equal(one.claims[0]?.claim, 'An account github.com/found-one responded.')
  assert.equal(one.claims[0]?.source, 'github.com')
  assert.equal((await service.getCase(c.id))?.counts.candidates, 2)

  // The candidate's id is the id the entity WILL have, which is what makes "is this
  // already in the graph?" a lookup rather than a scan.
  const entity = await service.promoteCandidate({ caseId: c.id, candidateId: one.id })
  assert.equal(entity.id, one.id)
  assert.equal(entity.seed, false, 'a promoted discovery is discovered, never a seed')
  assert.equal((await service.listEntities(c.id)).length, 2)
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 1)

  const other = (await service.listCandidates(c.id, 'pending'))[0]!
  await service.dismissCandidate({ caseId: c.id, candidateId: other.id })
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 0)

  // Re-running must not resurrect a decision the operator already made. A queue that
  // re-asks a question you have answered is a queue nobody reads.
  const again = await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'discoverer' })
  assert.equal(again.state, 'done', again.error ?? '')
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 0)
  assert.equal((await service.listCandidates(c.id, 'dismissed')).length, 1)
  assert.equal((await service.listEntities(c.id)).length, 2, 're-running must not add anything by itself')

  await service.dispose()
})

test('two tools proposing the same account converge on one candidate with two proposals', async () => {
  const service = await OsintService.create(await scratch('converge'))
  const twin = (id: string): Adapter => ({
    ...discoverer(id),
    id,
    parse: (raw) => [makeFinding(raw, { source: 'github.com', claim: `${id} saw github.com/shared.` })],
    propose: (raw) => [
      {
        fromFindingId: makeFinding(raw, { source: 'github.com', claim: `${id} saw github.com/shared.` }).id,
        kind: 'account',
        value: 'github.com/shared',
        rationale: `${id} got a page back for this handle.`
      }
    ]
  })
  service.registry.register(twin('twin-a'))
  service.registry.register(twin('twin-b'))

  const c = await service.createCase({ name: 'Converge', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'shared' })
  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'twin-a' })
  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'twin-b' })

  const pending = await service.listCandidates(c.id, 'pending')
  assert.equal(pending.length, 1, 'the same account from two tools is one candidate')
  assert.equal(pending[0]?.proposals.length, 2)
  // Two tools reading GitHub is one source. The candidate says so, exactly as the
  // confidence rules would.
  assert.equal(pending[0]?.independentSources, 1)
  await service.dispose()
})

test('the review queue counts sources the way corroboration does, derived ones excluded', async () => {
  const service = await OsintService.create(await scratch('queuesources'))
  const proposer = (id: string, source: string): Adapter => ({
    ...discoverer(id),
    id,
    parse: (raw) => [makeFinding(raw, { source, claim: `${id} places the picture at a location.` })],
    propose: (raw) => [
      {
        fromFindingId: makeFinding(raw, { source, claim: `${id} places the picture at a location.` }).id,
        kind: 'location',
        value: '48.858400,2.294500',
        rationale: `${id} read a GPS fix.`
      }
    ]
  })
  // Two photos out of one camera roll, with the same GPS fix. Two proposals, two `file:`
  // sources, and one device: the queue used to call this "2 independent sources, so it is
  // not one site's bug", which is the sentence this test exists to make impossible.
  service.registry.register(proposer('exif-one', 'file:img_1.jpg'))
  service.registry.register(proposer('exif-two', 'file:img_2.jpg'))
  // A real site, so the count is proved to be counting rather than simply zero.
  service.registry.register(proposer('site-probe', 'flickr.com'))

  const c = await service.createCase({ name: 'Queue sources', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'shared' })
  for (const id of ['exif-one', 'exif-two']) {
    await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: id })
  }

  const twoFiles = (await service.listCandidates(c.id, 'pending'))[0]
  assert.ok(twoFiles)
  assert.equal(twoFiles.proposals.length, 2)
  assert.equal(twoFiles.independentSources, 0, 'the operator’s own EXIF, read twice, is not two sources')
  assert.deepEqual(twoFiles.derivedSources, ['file:img_1.jpg', 'file:img_2.jpg'], 'named, so the queue can say what did name it')

  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'site-probe' })
  const withSite = (await service.listCandidates(c.id, 'pending'))[0]
  assert.equal(withSite?.independentSources, 1, 'one site answered; the two files still count for nothing')
  await service.dispose()
})

test('"promote all confirmed" promotes only what a human already vouched for', async () => {
  const service = await OsintService.create(await scratch('confirmed'))
  service.registry.register(discoverer('discoverer-bulk'))

  const c = await service.createCase({ name: 'Bulk', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'bulk' })
  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'discoverer-bulk' })

  // Nothing is confirmed yet, so the bulk action must do nothing at all.
  assert.equal((await service.promoteConfirmedCandidates(c.id)).length, 0)
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 2)

  const target = (await service.listCandidates(c.id, 'pending')).find(
    (p) => p.value === 'github.com/found-one'
  )!
  await service.promoteFinding({
    caseId: c.id,
    findingId: target.claims[0]!.findingId,
    to: 'confirmed',
    actor: 'human',
    note: 'Opened the profile in a logged-out window; it is there.'
  })

  // The candidate's confidence is read from its findings, so confirming the finding is
  // what changes what the queue says. Nothing is copied, so nothing can go stale.
  const refreshed = (await service.listCandidates(c.id, 'pending')).find((p) => p.id === target.id)
  assert.equal(refreshed?.bestConfidence, 'confirmed')

  const promoted = await service.promoteConfirmedCandidates(c.id)
  assert.equal(promoted.length, 1)
  assert.equal(promoted[0]?.value, 'github.com/found-one')
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 1, 'the unconfirmed one stays put')
  await service.dispose()
})

/*
 * The confidence round trip.
 *
 * `findings:promote` was reachable from the main process and from nothing else for the
 * whole life of the app: the IPC channel, the handler and the preload method all existed,
 * and no renderer component had ever called any of them. So the path below had never once
 * been exercised end to end, and "it is wired" was an assumption rather than a result.
 *
 * These two tests are the assumption turned into an assertion. The first follows a single
 * promotion all the way to disk and back through a rebuild — because a confidence that
 * lives only in SQLite evaporates on the next schema-version bump, silently, and the
 * operator would never learn that the note they wrote had been discarded. The second
 * guards the direction of the rule that the new UI must not weaken.
 */
test('a promotion reaches the files and survives a full index rebuild', async () => {
  const service = await OsintService.create(await scratch('promoteroundtrip'))
  service.registry.register(discoverer('discoverer-roundtrip'))

  const c = await service.createCase({ name: 'Round trip', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'rounder' })
  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'discoverer-roundtrip' })

  const before = await service.listFindings(c.id)
  const target = before[0]!
  assert.equal(target.confidence, 'unverified', 'an adapter can only ever emit unverified')
  assert.equal(target.lastVerified, null, 'nothing has re-observed or verified it yet')

  const note = 'Opened the profile in a logged-out window. The avatar matches the seed.'
  const updated = await service.promoteFinding({
    caseId: c.id,
    findingId: target.id,
    to: 'confirmed',
    actor: 'human',
    note
  })
  assert.equal(updated.confidence, 'confirmed')
  assert.ok(updated.lastVerified, 'a confidence decision is an act of verification and is stamped')

  // 1. The finding file. This is the line that makes the promotion survive anything at
  //    all: the index is a cache and is rebuilt from here, so a confidence that never
  //    reached this file is a confidence that is one rebuild from being lost.
  const findingsFile = path.join(service.store.dir(c.id), 'findings.jsonl')
  const onDisk = (await fsp.readFile(findingsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { id: string; confidence: string })
  assert.equal(
    onDisk.find((f) => f.id === target.id)?.confidence,
    'confirmed',
    'the promoted confidence must be in findings.jsonl, not only in the index'
  )
  assert.equal(onDisk.length, before.length, 'replacing a finding rewrites its line, it does not append one')

  // 2. The audit log — the file that answers "why do I believe this".
  const logFile = path.join(service.store.dir(c.id), 'confidence-log.jsonl')
  const log = (await fsp.readFile(logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.equal(log.length, 1, 'one change, one line')
  assert.equal(log[0]?.findingId, target.id)
  assert.equal(log[0]?.from, 'unverified')
  assert.equal(log[0]?.to, 'confirmed')
  assert.equal(log[0]?.actor, 'human')
  assert.equal(log[0]?.note, note, 'the operator’s own words, stored verbatim')

  // 3. The rebuild. Wipe the cache entirely and reconstruct it from the files alone.
  service.db.exec('DELETE FROM findings; DELETE FROM confidence_changes;')
  assert.equal((await service.listFindings(c.id)).length, 0, 'the cache is genuinely empty')

  const stats = await service.rebuildIndex()
  assert.equal(stats.confidenceChanges, 1, 'the audit log is rebuilt too')
  const after = await service.listFindings(c.id)
  assert.equal(
    after.find((f) => f.id === target.id)?.confidence,
    'confirmed',
    'a confirmed finding is still confirmed after the index is rebuilt from files'
  )
  assert.equal(
    (await service.confidenceLog(c.id)).length,
    1,
    'and the reason it is confirmed is still readable'
  )
  await service.dispose()
})

test('the new verification path cannot reach "confirmed" without a human and a note', async () => {
  const service = await OsintService.create(await scratch('promoterules'))
  service.registry.register(discoverer('discoverer-rules'))

  const c = await service.createCase({ name: 'Rules', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'ruler' })
  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'discoverer-rules' })
  const target = (await service.listFindings(c.id))[0]!

  // The whole product rests on this one: no quantity of tool agreement produces
  // `confirmed`. Corroboration tops out a level below it, deliberately.
  await assert.rejects(
    () =>
      service.promoteFinding({
        caseId: c.id,
        findingId: target.id,
        to: 'confirmed',
        actor: 'corroborator',
        note: 'Two tools said the same thing.'
      }),
    /Only a human may set "confirmed"/
  )

  // A confirmation with no stated basis is indistinguishable from a guess, so the note is
  // load-bearing rather than decorative. The UI disables the button, but the rule is what
  // actually enforces it — a caller that bypassed the button must still be refused.
  for (const note of [undefined, '', '   ']) {
    await assert.rejects(
      () =>
        service.promoteFinding({
          caseId: c.id,
          findingId: target.id,
          to: 'confirmed',
          actor: 'human',
          note
        }),
      /Confirming requires a note/
    )
  }

  // And corroboration still refuses two readings of one origin, which is the failure mode
  // the level exists to catch rather than to launder.
  await assert.rejects(
    () =>
      service.promoteFinding({
        caseId: c.id,
        findingId: target.id,
        to: 'corroborated',
        actor: 'corroborator',
        supportingFindingIds: [target.id]
      }),
    /at least 2 independent/
  )

  // Nothing above moved it.
  assert.equal((await service.listFindings(c.id)).find((f) => f.id === target.id)?.confidence, 'unverified')
  assert.equal((await service.confidenceLog(c.id)).length, 0, 'a refused promotion writes no audit line')
  await service.dispose()
})

/**
 * A pivot finding is one claim that proposes several things.
 *
 * `profile-enrich` reading a bio with five links is the real shape: one sentence about one
 * page, five candidates out of it. Confirming that sentence says the page lists those
 * links. It does not say the five accounts belong to the subject — and before this, "one
 * human confirmation" would have promoted all five in one click, rebuilding auto-promotion
 * out of two rules that are each individually correct.
 */
function pivot(id: string): Adapter {
  const CLAIM = 'The profile page lists three outbound links.'
  return {
    id,
    accepts: ['username'],
    produces: ['account'],
    requiresKey: false,
    requiresNetwork: false,
    doc: doc(),
    run: async (input, ctx) =>
      jsonResult({ caseId: input.caseId, entityId: input.entity.id }, id, '{}', ctx.now()),
    // One finding. Not one per link — the observation is "this page says these things",
    // made once, by reading one page.
    parse: (raw) => [makeFinding(raw, { source: 'github.com', claim: CLAIM })],
    propose: (raw) =>
      ['mastodon.social/a', 'keybase.io/b', 'gitlab.com/c'].map((v) => ({
        fromFindingId: makeFinding(raw, { source: 'github.com', claim: CLAIM }).id,
        kind: 'account' as const,
        value: v,
        rationale: 'Listed in the bio of a page this run read. A link on a page, not a verified account.'
      }))
  }
}

test('confirming one pivot finding does not bulk-promote everything it proposed', async () => {
  const service = await OsintService.create(await scratch('pivotbulk'))
  service.registry.register(pivot('pivot-bulk'))

  const c = await service.createCase({ name: 'Pivot', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'pivoter' })
  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'pivot-bulk' })

  const pending = await service.listCandidates(c.id, 'pending')
  assert.equal(pending.length, 3, 'one finding, three proposals, three candidates')
  const findingId = pending[0]!.claims[0]!.findingId
  assert.ok(
    pending.every((p) => p.claims.every((cl) => cl.findingId === findingId)),
    'all three descend from the same single claim'
  )

  await service.promoteFinding({
    caseId: c.id,
    findingId,
    to: 'confirmed',
    actor: 'human',
    note: 'Opened the page. It does list those three links.'
  })

  // Every candidate now reads as confirmed, because confidence lives on the finding and
  // they all cite the same one. That is correct, and it is exactly why the bulk action
  // cannot treat it as three separate vouches.
  const afterConfirm = await service.listCandidates(c.id, 'pending')
  assert.ok(
    afterConfirm.every((p) => p.bestConfidence === 'confirmed'),
    'the shared confirmation is visible on all three'
  )

  assert.equal(
    (await service.promoteConfirmedCandidates(c.id)).length,
    0,
    'one confirmation is one vouch, not three'
  )
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 3, 'all three stay in the queue')

  // And the individual path is untouched: the operator may still decide about each one,
  // which is the whole point of leaving them here.
  const one = await service.promoteCandidate({ caseId: c.id, candidateId: afterConfirm[0]!.id })
  assert.equal(one.value, afterConfirm[0]!.value)
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 2)
  await service.dispose()
})

test('candidates survive a full index rebuild, because they live in the files', async () => {
  const root = await scratch('candrebuild')
  const service = await OsintService.create(root)
  service.registry.register(discoverer('discoverer-rebuild'))

  const c = await service.createCase({ name: 'Rebuildable', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'username', value: 'rebuilder' })
  await service.runJobAndWait({ caseId: c.id, entityId: seed.id, adapterId: 'discoverer-rebuild' })
  const before = await service.listCandidates(c.id, 'all')
  assert.equal(before.length, 2)

  // The file is the truth; the table is a cache. Wipe the cache and rebuild it.
  service.db.exec('DELETE FROM candidates; DELETE FROM candidate_proposals;')
  assert.equal((await service.listCandidates(c.id, 'all')).length, 0)

  const stats = await service.rebuildIndex()
  assert.equal(stats.candidates, 2)
  const after = await service.listCandidates(c.id, 'all')
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'a rebuilt candidate must be identical')

  const onDisk = await fsp.readFile(path.join(service.store.dir(c.id), 'candidates.jsonl'), 'utf8')
  assert.equal(onDisk.trim().split('\n').length, 2, 'one candidate per line, readable in a text editor')
  await service.dispose()
})

test('the registry refuses an adapter that proposes what it never said it could discover', () => {
  const r = new AdapterRegistry()
  assert.throws(
    () =>
      r.register({
        id: 'silent-grower',
        accepts: ['username'],
        produces: [],
        requiresKey: false,
        requiresNetwork: false,
        doc: doc(),
        run: async () => {
          throw new Error('not used')
        },
        parse: () => [],
        propose: () => []
      }),
    AdapterRegistrationError
  )
  assert.throws(
    () =>
      r.register({
        id: 'bad-secrets',
        accepts: ['username'],
        produces: [],
        requiresKey: false,
        requiresNetwork: false,
        secretOptions: ['' as string],
        doc: doc(),
        run: async () => {
          throw new Error('not used')
        },
        parse: () => []
      }),
    AdapterRegistrationError
  )
  assert.equal(r.size(), 0)
})

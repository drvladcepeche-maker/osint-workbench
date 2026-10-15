/**
 * Removing an entity, correcting one, and running many adapters at once.
 *
 * Two gaps the operator hit while running a real consented audit, tested where the
 * decisions actually live:
 *
 *  1. **Nothing could be removed.** A typo in a seed was permanent, and the question
 *     underneath it — what happens to the findings that seed produced — is the one that
 *     has to be answered in code rather than left to whichever branch runs first. The
 *     answer is that they are kept and orphaned, and these tests hold it: the entity is
 *     gone from `entities.json` and the index, the findings are still on both, the raw
 *     captures are untouched, and a tombstone names what left.
 *  2. **Every run was one adapter against one entity.** `planRuns` is the fix, and the
 *     half of it worth testing hardest is the half that runs *nothing*: an adapter that
 *     does not accept a kind has not failed, and a plan of zero has to be able to say
 *     why. A silent nothing is indistinguishable from a bug, and he has already been
 *     caught by exactly that.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { OsintService, pruneProvenanceOnRemoval } from '../src/main/service'
import { makeFinding, type Adapter, type RawResult } from '../src/main/adapters/types'
import { REMOVED_ENTITIES_FILE } from '../src/main/store/caseStore'
import { idleKindReason, kindWithArticle } from '../src/shared/ipc'

export interface LifecycleTest {
  name: string
  fn: () => void | Promise<void>
}

export const lifecycleTests: LifecycleTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  lifecycleTests.push({ name, fn })
}

function doc(): Adapter['doc'] {
  return {
    what: 'A fixture adapter used only by the test suite.',
    how: 'It returns a constant without touching the network, which is exactly enough to exercise the plumbing under test.',
    why: 'Because the plumbing is what is under test, not any particular mechanism.',
    betterAt: 'Being predictable in a unit test with no network and no filesystem.',
    worseAt: 'Producing any information whatsoever about the real world.',
    falsePositives: 'It cannot produce false positives because it makes no claims about anything.'
  }
}

async function scratch(prefix: string): Promise<string> {
  const base = path.join(process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test'), prefix)
  await fsp.mkdir(base, { recursive: true })
  return fsp.mkdtemp(path.join(base, 'run-'))
}

/** An adapter that always says one thing about whatever it is pointed at. */
function speaker(id: string, accepts: Adapter['accepts'], source = `local:${id}`): Adapter {
  return {
    id,
    accepts,
    produces: [],
    requiresKey: false,
    requiresNetwork: false,
    doc: doc(),
    run: async (input, ctx): Promise<RawResult> => ({
      adapterId: id,
      caseId: input.caseId,
      entityId: input.entity.id,
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ about: input.entity.value }),
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
    parse: (raw) => {
      const { about } = JSON.parse(raw.stdout) as { about: string }
      return [makeFinding(raw, { source, claim: `${id} looked at ${about}` })]
    }
  }
}

/* ------------------------------------------------------------------ *
 * Removing
 * ------------------------------------------------------------------ */

test('removing an entity keeps its findings, orphans them, and says how many', async () => {
  const service = await OsintService.create(await scratch('remove'))
  service.registry.register(speaker('rm-a', ['username'], 'alpha.example'))
  service.registry.register(speaker('rm-b', ['username'], 'beta.example'))

  const c = await service.createCase({ name: 'Removal', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'rm-a' })
  await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'rm-b' })

  const before = await service.listFindings(c.id)
  assert.equal(before.length, 2, 'the fixture should have produced two findings')

  const usage = await service.entityUsage(c.id, e.id)
  assert.equal(usage?.findings, 2, 'the confirmation has to count, not estimate')
  assert.equal(usage?.attached, true)

  const removal = await service.deleteEntity({ caseId: c.id, entityId: e.id })
  assert.equal(removal.orphanedFindings, 2, 'the removal must report what the usage promised')

  // Gone from the files and from the derived index.
  assert.equal(await service.store.getEntity(c.id, e.id), null)
  assert.equal((await service.listEntities(c.id)).length, 0)

  // Kept in both. This is the decision: a finding is the record that a tool asserted
  // something, and its raw capture is permanent. Deleting the question does not unobserve
  // the answer.
  const after = await service.listFindings(c.id)
  assert.equal(after.length, 2, 'findings must survive the removal of the entity they were about')
  assert.deepEqual(
    after.map((f) => f.entityId).sort(),
    before.map((f) => f.entityId).sort(),
    'an orphan still points at the id it was about — that is what makes it findable'
  )
  const onDisk = await service.store.readFindings(c.id)
  assert.equal(onDisk.records.length, 2, 'findings.jsonl is the truth and must still hold them')

  // Raw captures are append-only and are never touched by a removal.
  const raws = await fsp.readdir(path.join(service.store.dir(c.id), 'raw'))
  assert.equal(raws.length, 2, 'raw captures are permanent, removal or not')

  // The tombstone is what lets an orphaned row still name what it was about.
  const tombs = await service.removedEntities(c.id)
  assert.equal(tombs.length, 1)
  assert.equal(tombs[0]?.kind, 'username')
  assert.equal(tombs[0]?.value, 'torvalds')
  assert.equal(tombs[0]?.reason, 'deleted')
  assert.equal(tombs[0]?.orphanedFindings, 2)

  await service.dispose()
})

test('removing an entity that produced nothing leaves nothing behind', async () => {
  const service = await OsintService.create(await scratch('removeclean'))
  const c = await service.createCase({ name: 'Clean', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvsalds' })

  const usage = await service.entityUsage(c.id, e.id)
  assert.equal(usage?.attached, false, 'nothing is attached, so nothing should be confirmed')

  const removal = await service.deleteEntity({ caseId: c.id, entityId: e.id })
  assert.equal(removal.orphanedFindings, 0)
  assert.equal(removal.tombstone, null, 'a clean removal writes no record that it happened')

  // Correcting a typo must not leave a permanent note that a typo was made.
  const tombstoneFile = path.join(service.store.dir(c.id), REMOVED_ENTITIES_FILE)
  await assert.rejects(() => fsp.readFile(tombstoneFile, 'utf8'), /ENOENT/)

  // And it is idempotent: a second click is not an error.
  const again = await service.deleteEntity({ caseId: c.id, entityId: e.id })
  assert.equal(again.orphanedFindings, 0)
  await service.dispose()
})

test('removing a promoted entity puts its discovery back in the review queue', async () => {
  const service = await OsintService.create(await scratch('removecand'))
  service.registry.register({
    ...speaker('cand-finder', ['username'], 'github.com'),
    produces: ['account'],
    propose: (raw) => {
      const { about } = JSON.parse(raw.stdout) as { about: string }
      return [
        {
          fromFindingId: makeFinding(raw, {
            source: 'github.com',
            claim: `cand-finder looked at ${about}`
          }).id,
          kind: 'account' as const,
          value: `github.com/${about}`,
          rationale: 'The sweep reported a profile at this URL.'
        }
      ]
    }
  })

  const c = await service.createCase({ name: 'Promotion', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'cand-finder' })

  const pending = await service.listCandidates(c.id, 'pending')
  assert.equal(pending.length, 1, 'the fixture should have proposed one account')
  const candidateId = pending[0]!.id

  const promoted = await service.promoteCandidate({ caseId: c.id, candidateId })
  assert.equal(promoted.seed, false)
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 0)

  const usage = await service.entityUsage(c.id, promoted.id)
  assert.equal(usage?.returnsCandidate, true, 'the confirmation has to warn that this is reversible')

  const removal = await service.deleteEntity({ caseId: c.id, entityId: promoted.id })
  assert.equal(removal.candidateReturned, true)

  // The deliberate exception to "a decided candidate stays decided": that rule stops a
  // *tool* overturning a human's decision. Here the human is reversing his own, and
  // without this the discovery would be unrecoverable.
  const back = await service.listCandidates(c.id, 'pending')
  assert.equal(back.length, 1, 'the discovery must return to the queue, not vanish')
  assert.equal(back[0]?.id, candidateId)
  await service.dispose()
})

test('removing an entity cuts the provenance root it was, and everything under it', async () => {
  const service = await OsintService.create(await scratch('removeprov'))
  service.registry.register(speaker('prov-a', ['username'], 'alpha.example'))

  // A stand-in for the investigation engine. The real one is joined to the service in
  // `ipc.ts` by this same call, and `ProvenancePruner` is the whole of what a removal uses
  // — which is why the service can require it without importing the engine and creating a
  // cycle back to itself.
  const cuts: { nodeId: string; reason: string; actor: string | undefined }[] = []
  pruneProvenanceOnRemoval(service, {
    prune: async (req, actor) => {
      cuts.push({ nodeId: req.nodeId, reason: req.reason, actor })
      // The node itself plus one lead that was only reachable through it.
      return { cut: [req.nodeId, 'ent_downstream'] }
    }
  })

  const c = await service.createCase({ name: 'Provenance', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'prov-a' })

  const removal = await service.deleteEntity({ caseId: c.id, entityId: e.id })
  assert.equal(cuts.length, 1, 'a removal must cut the provenance root, or the branch under it stays live')
  assert.equal(cuts[0]?.nodeId, e.id, 'the entity id is the node id — that is what makes the cut findable')
  assert.equal(cuts[0]?.actor, 'human', 'the operator asked for this; the record must not credit the engine')
  assert.match(cuts[0]?.reason ?? '', /restore/i, 'a cut has to say how to undo it')
  assert.equal(removal.provenanceCut, 2, 'the removal reports what went with it')

  // Removing something that is not there cuts nothing. Idempotence is not just about the
  // entity: a second click must not append a second prune record either.
  const again = await service.deleteEntity({ caseId: c.id, entityId: e.id })
  assert.equal(again.provenanceCut, 0)
  assert.equal(cuts.length, 1)
  await service.dispose()
})

test('a provenance cut that fails does not fail the removal', async () => {
  const service = await OsintService.create(await scratch('removeprovfail'))
  pruneProvenanceOnRemoval(service, {
    prune: async () => {
      throw new Error('provenance.jsonl is unreadable')
    }
  })

  const c = await service.createCase({ name: 'Provenance', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })

  // The entity is already out of the files by the time the hook runs, and the files are
  // the truth. A removal that threw here would report failure for something that happened.
  const removal = await service.deleteEntity({ caseId: c.id, entityId: e.id })
  assert.equal(removal.provenanceCut, 0)
  assert.equal(await service.store.getEntity(c.id, e.id), null, 'the removal itself must still have happened')
  await service.dispose()
})

test('a promoted candidate comes back to the queue even though the cut ran first', async () => {
  const service = await OsintService.create(await scratch('removeprovcand'))
  service.registry.register({
    ...speaker('prov-finder', ['username'], 'github.com'),
    produces: ['account'],
    propose: (raw) => {
      const { about } = JSON.parse(raw.stdout) as { about: string }
      return [
        {
          fromFindingId: makeFinding(raw, { source: 'github.com', claim: `prov-finder looked at ${about}` }).id,
          kind: 'account' as const,
          value: `github.com/${about}`,
          rationale: 'The sweep reported a profile at this URL.'
        }
      ]
    }
  })

  // A real prune dismisses every *pending* candidate under the cut. The candidate that was
  // promoted into the entity being removed is reopened by the removal itself, and the two
  // would fight: reopen first and the cut dismisses it again, leaving the discovery gone
  // with no way back. So the cut runs first, sees it as promoted, and leaves it alone.
  const statesAtCutTime: string[] = []
  pruneProvenanceOnRemoval(service, {
    prune: async (req) => {
      const all = await service.listCandidates(req.caseId, 'all')
      statesAtCutTime.push(...all.map((c) => c.state))
      return { cut: [req.nodeId] }
    }
  })

  const c = await service.createCase({ name: 'Order', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'prov-finder' })
  const candidateId = (await service.listCandidates(c.id, 'pending'))[0]!.id
  const promoted = await service.promoteCandidate({ caseId: c.id, candidateId })

  const removal = await service.deleteEntity({ caseId: c.id, entityId: promoted.id })
  assert.deepEqual(statesAtCutTime, ['promoted'], 'the cut must run before the candidate is reopened')
  assert.equal(removal.candidateReturned, true)
  assert.equal((await service.listCandidates(c.id, 'pending')).length, 1, 'the discovery must still come back')
  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * Correcting
 * ------------------------------------------------------------------ */

test('editing a value re-normalises it and moves the entity to the new id', async () => {
  const service = await OsintService.create(await scratch('edit'))
  const c = await service.createCase({ name: 'Edit', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'email', value: 'Torvsalds@Example.COM' })
  assert.equal(e.value, 'torvsalds@example.com')

  const edited = await service.editEntity({
    caseId: c.id,
    entityId: e.id,
    value: '  Torvalds@Example.COM  '
  })
  assert.equal(edited.renamed, true)
  // The stored value is a fixed point of the same normaliser the store uses, so a
  // correction lands exactly where the value would have landed had it been typed right.
  assert.equal(edited.entity.value, 'torvalds@example.com')
  assert.equal(edited.entity.seed, true, 'a corrected seed is still a seed')

  const live = await service.listEntities(c.id)
  assert.equal(live.length, 1, 'a rename is one entity afterwards, not two')
  assert.equal(live[0]?.id, edited.entity.id)
  assert.equal(await service.store.getEntity(c.id, e.id), null)

  // A rename always leaves a record, because the replacement is the thing it explains.
  const tombs = await service.removedEntities(c.id)
  assert.equal(tombs.length, 1)
  assert.equal(tombs[0]?.reason, 'renamed')
  assert.equal(tombs[0]?.replacedBy, edited.entity.id)
  await service.dispose()
})

test('an edit that normalises to the same value moves nothing and orphans nothing', async () => {
  const service = await OsintService.create(await scratch('editsame'))
  service.registry.register(speaker('relabel-a', ['username'], 'alpha.example'))

  const c = await service.createCase({ name: 'Relabel', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  await service.runJobAndWait({ caseId: c.id, entityId: e.id, adapterId: 'relabel-a' })

  const edited = await service.editEntity({ caseId: c.id, entityId: e.id, value: 'Torvalds' })
  assert.equal(edited.renamed, false, 'username normalisation folds case, so no id moved')
  assert.equal(edited.entity.id, e.id)
  assert.equal(edited.removal, null)
  assert.equal((await service.listFindings(c.id)).length, 1)
  assert.equal((await service.removedEntities(c.id)).length, 0)
  await service.dispose()
})

test('a composite value cannot be re-typed as free text', async () => {
  const service = await OsintService.create(await scratch('editaccount'))
  const c = await service.createCase({ name: 'Composite', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'account', value: 'github.com/torvalds' })
  await assert.rejects(
    () => service.editEntity({ caseId: c.id, entityId: e.id, value: 'nonsense' }),
    /built from its parts/
  )
  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * Running many
 * ------------------------------------------------------------------ */

test('a plan is the cross product of the selection, filtered by what each adapter accepts', async () => {
  const service = await OsintService.create(await scratch('plan'))
  service.registry.register(speaker('plan-handles', ['username'], 'alpha.example'))
  service.registry.register(speaker('plan-both', ['username', 'email'], 'beta.example'))
  service.registry.register(speaker('plan-domains', ['domain'], 'gamma.example'))

  const c = await service.createCase({ name: 'Fan out', basis: 'training' })
  const u = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  const d = await service.addEntity({ caseId: c.id, kind: 'domain', value: 'example.com' })
  const m = await service.addEntity({ caseId: c.id, kind: 'email', value: 'torvalds@example.com' })

  /*
   * Everything applicable: username x 2, domain x 1, email x 1.
   *
   * The registry is process-wide and holds the real adapters alongside this test's, so
   * the product is asserted over the three fixtures and the invariant — never an adapter
   * pointed at a kind it does not accept — is asserted over the whole plan. What is under
   * test is the shape of the fan-out, not which adapters this build happens to ship.
   */
  const mine = new Set(['plan-handles', 'plan-both', 'plan-domains'])
  const all = await service.planRuns({ caseId: c.id })
  assert.deepEqual(
    all.runs
      .filter((r) => mine.has(r.adapterId))
      .map((r) => `${r.adapterId}/${r.entityId}`)
      .sort(),
    [
      `plan-both/${m.id}`,
      `plan-both/${u.id}`,
      `plan-domains/${d.id}`,
      `plan-handles/${u.id}`
    ].sort()
  )
  const kindOf = new Map([
    [u.id, 'username'],
    [d.id, 'domain'],
    [m.id, 'email']
  ])
  const described = service.registry.describe(service.config, service.loaded.paths.toolkitRoot)
  for (const r of all.runs) {
    const a = described.find((x) => x.id === r.adapterId)
    assert.ok(a, `the plan named an adapter that is not registered: ${r.adapterId}`)
    assert.ok(
      a.accepts.includes(kindOf.get(r.entityId) as never),
      `${r.adapterId} was pointed at a ${kindOf.get(r.entityId)} it does not accept`
    )
  }
  // `echo` accepts every kind and is skipped by default, so the exclusion is stated
  // rather than silent — otherwise a missing run reads as a bug in the plan.
  assert.ok(
    all.excluded.some((x) => x.adapterId === 'echo'),
    'a default skip must be reported, not silently applied'
  )

  // Per-adapter fan-out: one tool across everything it accepts.
  const oneTool = await service.planRuns({ caseId: c.id, adapterIds: ['plan-both'] })
  assert.deepEqual(
    oneTool.runs.map((r) => r.entityId).sort(),
    [m.id, u.id].sort(),
    'picking one adapter must reach every entity it accepts'
  )
  assert.deepEqual(
    oneTool.idleEntities.map((e) => e.entityId),
    [d.id],
    'and must say which entity it could not answer about'
  )
  assert.match(
    oneTool.idleEntities[0]?.reason ?? '',
    /Nothing you selected accepts a domain/,
    'a kind other tools would take reads differently from one nothing takes'
  )

  // Per-entity fan-out: one entity across every tool that accepts it.
  const oneEntity = await service.planRuns({ caseId: c.id, entityIds: [u.id] })
  assert.deepEqual(
    oneEntity.runs.map((r) => r.adapterId).filter((id) => mine.has(id)).sort(),
    ['plan-both', 'plan-handles']
  )

  // The intersection of two hand-made selections.
  const both = await service.planRuns({
    caseId: c.id,
    entityIds: [u.id, d.id],
    adapterIds: ['plan-handles', 'plan-domains']
  })
  assert.deepEqual(both.runs.map((r) => `${r.adapterId}/${r.entityId}`).sort(), [
    `plan-domains/${d.id}`,
    `plan-handles/${u.id}`
  ])

  await service.dispose()
})

test('a plan that can run nothing says why, rather than coming back empty', async () => {
  const service = await OsintService.create(await scratch('planidle'))
  service.registry.register(speaker('idle-handles', ['username'], 'alpha.example'))

  const c = await service.createCase({ name: 'Attribution only', basis: 'training' })
  const loc = await service.addEntity({ caseId: c.id, kind: 'location', value: 'Sofia' })

  // The premise: `echo` is the only registered adapter that accepts a location, and it is
  // skipped by default. Stated as an assertion so a future adapter that takes a place
  // fails here with a readable reason instead of failing the count below with none.
  const takesAPlace = service.registry
    .describe(service.config, service.loaded.paths.toolkitRoot)
    .filter((a) => a.accepts.includes('location') && a.id !== 'echo')
  assert.deepEqual(takesAPlace.map((a) => a.id), [], 'this test assumes only echo takes a location')

  const plan = await service.planRuns({ caseId: c.id, entityIds: [loc.id] })
  assert.equal(plan.runs.length, 0)
  assert.equal(plan.idleEntities.length, 1)
  const reason = plan.idleEntities[0]?.reason ?? ''
  // The sentence the operator was missing: not a failure, a kind nothing queries.
  assert.match(reason, /No adapter in this build queries a location/)
  assert.match(reason, /attribution/i, 'and it must say what a location is actually for')

  // `echo` accepts every kind and is skipped by default, so the exclusion has to be
  // stated rather than silent — otherwise "nothing ran" looks like a bug in the plan.
  assert.ok(
    plan.excluded.some((x) => x.adapterId === 'echo'),
    'a default skip must be reported, not silently applied'
  )
  await service.dispose()
})

test('an idle kind reads as one of four different facts, in the right English', () => {
  // "queries a account" and "queries an username" both look like a bug in the tool
  // rather than a slip in a string, so the article rule is tested rather than trusted.
  assert.equal(kindWithArticle('account'), 'an account')
  assert.equal(kindWithArticle('email'), 'an email')
  assert.equal(kindWithArticle('domain'), 'a domain')
  // The one the letter rule gets wrong: a consonant sound behind a vowel letter.
  assert.equal(kindWithArticle('username'), 'a username')

  // Nothing in the build takes it, and the absence is the design.
  const byDesign = idleKindReason({ kind: 'location', runnable: [], available: [], named: false })
  assert.match(byDesign, /No adapter in this build queries a location/)
  assert.match(byDesign, /attribution/i)

  // Nothing takes it and the absence is simply a gap.
  assert.match(
    idleKindReason({ kind: 'phone', runnable: [], available: [], named: false }),
    /gap in the toolbelt, not a fault in this case/
  )

  // Something takes it, but not right now — that is a Settings problem, not a plan one.
  assert.match(
    idleKindReason({ kind: 'domain', runnable: ['subfinder'], available: [], named: false }),
    /subfinder accepts a domain, but it is not available/
  )

  // Something takes it and it was simply not selected.
  assert.match(
    idleKindReason({ kind: 'username', runnable: ['Maigret'], available: ['Maigret'], named: true }),
    /Nothing you selected accepts a username\. Maigret would\./
  )
})

test('a batch never carries a secret, even when the adapter is named explicitly', async () => {
  const service = await OsintService.create(await scratch('plansecret'))
  service.registry.register({
    ...speaker('needs-secret', ['username'], 'alpha.example'),
    secretOptions: ['password']
  })

  const c = await service.createCase({ name: 'Secrets', basis: 'training' })
  await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })

  const plan = await service.planRuns({ caseId: c.id, adapterIds: ['needs-secret'] })
  assert.equal(plan.runs.length, 0, 'there is nowhere in a batch to type a secret')
  assert.ok(plan.excluded.some((x) => x.adapterId === 'needs-secret'))
  assert.match(plan.excluded[0]?.reason ?? '', /typed at the moment of use/)
  await service.dispose()
})

test('running a plan queues exactly it, and every pair produces its finding', async () => {
  const service = await OsintService.create(await scratch('runplan'))
  service.registry.register(speaker('queue-a', ['username'], 'alpha.example'))
  service.registry.register(speaker('queue-b', ['username'], 'beta.example'))

  const c = await service.createCase({ name: 'Queue', basis: 'training' })
  const a = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  const b = await service.addEntity({ caseId: c.id, kind: 'username', value: 'gvanrossum' })

  // Named, so this queues the fixtures and not every real adapter that takes a username —
  // several of those reach the network, and a test suite does not get to do that.
  const request = { caseId: c.id, adapterIds: ['queue-a', 'queue-b'] }
  const plan = await service.planRuns(request)
  assert.equal(plan.runs.length, 4, 'two handles by two adapters')

  const jobs = await service.runPlan(request)
  assert.equal(jobs.length, 4)
  assert.deepEqual(
    jobs.map((j) => `${j.adapterId}/${j.entityId}`).sort(),
    plan.runs.map((r) => `${r.adapterId}/${r.entityId}`).sort(),
    'what was queued must be what the preview promised'
  )

  await settle(service, c.id)

  const findings = await service.listFindings(c.id)
  assert.equal(findings.length, 4, 'four runs, four claims')
  assert.deepEqual(
    findings.map((f) => f.entityId).sort(),
    [a.id, a.id, b.id, b.id].sort(),
    'each entity must have been reached by both adapters'
  )
  await service.dispose()
})

test('a pair already in flight is reported rather than queued a second time', async () => {
  const service = await OsintService.create(await scratch('planbusy'))
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const slow = speaker('busy-slow', ['username'], 'alpha.example')
  service.registry.register({
    ...slow,
    run: async (input, ctx) => {
      await gate
      return slow.run(input, ctx)
    }
  })

  const c = await service.createCase({ name: 'No flooding', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })

  await service.runPlan({ caseId: c.id, adapterIds: ['busy-slow'] })

  // Clicking the same button again while the first run is still going must not queue a
  // second one: a job carries no identity beyond its id, so the orchestrator would
  // happily run the same probe twice against the same site.
  const again = await service.planRuns({ caseId: c.id, adapterIds: ['busy-slow'] })
  assert.equal(again.runs.length, 0)
  assert.equal(again.alreadyQueued.length, 1)
  assert.equal(again.alreadyQueued[0]?.entityId, e.id)

  release()
  await settle(service, c.id)
  assert.equal((await service.listFindings(c.id)).length, 1, 'one run, one claim')
  await service.dispose()
})

test('a removal cancels the runs pointed at what it removed', async () => {
  const service = await OsintService.create(await scratch('removebusy'))
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const slow = speaker('cancel-slow', ['username'], 'alpha.example')
  service.registry.register({
    ...slow,
    // Honours `ctx.signal`, as the adapter contract requires. That is what makes the
    // outcome `cancelled` rather than a run that finished after nobody wanted it.
    run: async (input, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new Error('aborted'))
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        void gate.then(() => {
          ctx.signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
      return slow.run(input, ctx)
    }
  })

  const c = await service.createCase({ name: 'Cancel on removal', basis: 'training' })
  const e = await service.addEntity({ caseId: c.id, kind: 'username', value: 'torvalds' })
  await service.runPlan({ caseId: c.id, adapterIds: ['cancel-slow'] })

  const usage = await service.entityUsage(c.id, e.id)
  assert.equal(usage?.activeJobs, 1, 'the confirmation has to warn that a run is in flight')

  // Left alone, the orchestrator would fail this job seconds later with "entity is not in
  // case", which is true and reads as a bug.
  const removal = await service.deleteEntity({ caseId: c.id, entityId: e.id })
  assert.equal(removal.cancelledJobs, 1)
  release()
  await settle(service, c.id)
  assert.ok(
    service.orchestrator.listJobs(c.id).every((j) => j.state === 'cancelled'),
    'the run must end cancelled, not failed'
  )
  await service.dispose()
})

/** Wait for every job in a case to reach a terminal state. */
async function settle(service: OsintService, caseId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const jobs = service.orchestrator.listJobs(caseId)
      if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) {
        resolve()
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

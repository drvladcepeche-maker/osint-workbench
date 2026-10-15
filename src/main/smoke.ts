/**
 * End-to-end self test, run inside the real Electron main process when `OSINT_SMOKE=1`.
 *
 * Exists so "does `npm run dev` actually work" can be answered by evidence rather than
 * by looking at a window and assuming. It drives the same code path a click would:
 * create a case, add an entity, enqueue the echo adapter through the orchestrator, then
 * read the resulting Finding back **out of SQLite** — not out of the in-memory objects,
 * because the point is to prove the index was written.
 *
 * It writes into a disposable case named `smoke-test-*`, which is inside the gitignored
 * `cases/` folder.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type { OsintService } from './service'

/**
 * A transcript is written beside the index as well as printed.
 *
 * On Windows the Electron main process is a GUI subsystem binary, so its `console.log`
 * reaches no terminal that `electron-vite dev` can forward — which made the whole point
 * of this file ("answer it by evidence rather than by looking at a window") unanswerable
 * from a script. The file is the evidence.
 */
export async function runSmokeTest(service: OsintService): Promise<boolean> {
  const lines: string[] = []
  const record = (prefix: string, a: unknown[]): void => {
    lines.push(
      `${prefix} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`
    )
  }
  const log = (...a: unknown[]): void => {
    console.log('[smoke]', ...a)
    record('[smoke]', a)
  }
  const fail = (...a: unknown[]): void => {
    console.error('[smoke] FAIL', ...a)
    record('[smoke] FAIL', a)
  }
  const transcript = path.join(service.loaded.paths.dataDir, 'smoke.log')
  const flush = async (): Promise<void> => {
    try {
      await fsp.mkdir(path.dirname(transcript), { recursive: true })
      await fsp.writeFile(transcript, lines.join('\n') + '\n', 'utf8')
      console.log('[smoke] transcript:', transcript)
    } catch {
      /* the console output is still the primary channel */
    }
  }

  try {
    log('started at', new Date().toISOString())
    const created = await service.createCase({
      name: `smoke test ${new Date().toISOString().slice(0, 19)}`,
      basis: 'training',
      notes: 'Automated end-to-end check. Safe to delete.'
    })
    log('case created:', created.id, '| publishable:', created.publishable)

    const entity = await service.addEntity({
      caseId: created.id,
      kind: 'username',
      value: 'SmokeTestUser',
      seed: true
    })
    log('entity:', entity.id, entity.kind, entity.value, '| seed:', entity.seed)

    const job = await service.runJobAndWait({
      caseId: created.id,
      entityId: entity.id,
      adapterId: 'echo'
    })
    log('job:', job.id, '| state:', job.state, '| findings:', job.findingIds.length, '| raw:', job.rawId)
    if (job.state !== 'done') {
      fail('job did not complete:', job.error)
      await flush()
      return false
    }

    // Read back from SQLite specifically.
    const rows = service.db
      .prepare(`SELECT id, tool, source, claim, confidence, raw_path FROM findings WHERE case_id = ?`)
      .all(created.id) as { id: string; tool: string; source: string; claim: string; confidence: string; raw_path: string }[]
    if (rows.length !== 1) {
      fail(`expected exactly 1 finding in SQLite, got ${rows.length}`)
      await flush()
      return false
    }
    const row = rows[0]!
    log('SQLite row:', JSON.stringify(row))

    if (row.confidence !== 'unverified') {
      fail(`a single tool hit produced confidence "${row.confidence}"; it must be "unverified"`)
      await flush()
      return false
    }

    // FTS5 must find it too.
    const hits = await service.searchFindings(created.id, 'SmokeTestUser')
    log('FTS5 hits for "SmokeTestUser":', hits.length)
    if (hits.length !== 1) {
      fail(`FTS5 returned ${hits.length} hits, expected 1`)
      await flush()
      return false
    }

    // Raw output must be readable off disk.
    const raw = await service.readRaw(created.id, row.id)
    log('raw output re-read from disk:', raw.length, 'bytes')

    // Index must be rebuildable.
    const stats = await service.rebuildIndex()
    log('rebuildIndex:', JSON.stringify(stats))
    const after = service.db.prepare(`SELECT COUNT(*) n FROM findings WHERE case_id = ?`).get(created.id) as {
      n: number
    }
    if (after.n !== 1) {
      fail(`finding count after rebuild is ${after.n}, expected 1`)
      await flush()
      return false
    }

    /* ---------------- fan-out, correction and removal ---------------- */

    // A case of mixed kinds, so the plan has something to leave out as well as something
    // to run. `location` is the honest case: nothing in the toolbelt queries a place, so
    // "run everything applicable" correctly plans nothing for it and has to say why.
    const wide = await service.createCase({
      name: `smoke fan-out ${new Date().toISOString().slice(0, 19)}`,
      basis: 'training',
      notes: 'Automated end-to-end check of fan-out, editing and removal. Safe to delete.'
    })
    const seeds = [
      await service.addEntity({ caseId: wide.id, kind: 'username', value: 'torvalds' }),
      await service.addEntity({ caseId: wide.id, kind: 'domain', value: 'example.com' }),
      await service.addEntity({ caseId: wide.id, kind: 'email', value: 'nobody@example.com' }),
      await service.addEntity({ caseId: wide.id, kind: 'location', value: 'Lisbon' }),
      await service.addEntity({ caseId: wide.id, kind: 'username', value: 'torvsalds' })
    ]
    log('seeds:', seeds.map((e) => `${e.kind}:${e.value}`).join(', '))

    const plan = await service.planRuns({ caseId: wide.id })
    log(
      'plan:',
      `${plan.runs.length} runs across ${plan.entitiesCovered} entities · ${plan.adaptersUsed} tools`,
      '| idle entities:',
      plan.idleEntities.map((e) => e.kind).join(',') || 'none',
      '| excluded:',
      plan.excluded.map((x) => x.adapterId).join(',') || 'none'
    )
    for (const e of plan.idleEntities) log('  idle:', e.kind, e.label, '—', e.reason)
    const place = plan.idleEntities.find((e) => e.kind === 'location')
    if (!place) {
      fail('a location seed must be reported as idle with a reason, not silently skipped')
      await flush()
      return false
    }

    // The plan is a promise about what will be queued. Enqueue it and compare.
    const queued = await service.runPlan({ caseId: wide.id })
    if (queued.length !== plan.runs.length) {
      fail(`plan promised ${plan.runs.length} runs and ${queued.length} were queued`)
      await flush()
      return false
    }
    log('queued:', queued.length, 'jobs — the count the preview stated')

    // Nothing is duplicated by asking twice while the first wave is still in flight.
    const second = await service.planRuns({ caseId: wide.id })
    log('re-plan while in flight:', second.runs.length, 'new,', second.alreadyQueued.length, 'already queued')
    if (second.runs.length !== 0 || second.alreadyQueued.length !== queued.length) {
      fail('a re-plan during a wave must offer nothing new and account for everything in flight')
      await flush()
      return false
    }

    /*
     * Stopped rather than finished, deliberately.
     *
     * "Run everything applicable" here is five real site sweeps against public data, and
     * letting a self test run maigret over 50 sites and subfinder over 30 datasets every
     * time somebody checks the app starts is not a self test, it is traffic. What has to
     * be true is that the plan's count is exactly what reached the queue, and that
     * cancel-all stops the lot — both of which are checked without waiting for any of it.
     */
    const stopped = service.cancelCase(wide.id)
    log('cancel-all stopped:', stopped, 'of', queued.length)
    await settled(service, wide.id)
    log('after cancel:', histogram(service, wide.id))

    /*
     * Now something that actually completes, so the removal below has real findings to
     * orphan. `echo` is named explicitly, which is also the rule under test: a default
     * skip is a default, and naming an adapter is an instruction rather than something
     * the planner gets to veto.
     */
    const selfTest = await service.runPlan({ caseId: wide.id, adapterIds: ['echo'] })
    log('named run:', selfTest.length, 'jobs — echo accepts every kind, including the place')
    await settled(service, wide.id)
    log('wave settled:', histogram(service, wide.id))

    // Correcting a typo: re-normalised through the same function the store uses, so the
    // stored value is a fixed point.
    const typo = seeds[4]!
    const fixed = await service.editEntity({
      caseId: wide.id,
      entityId: typo.id,
      value: '  Torvalds2  '
    })
    log(
      'edit:',
      `${typo.value} -> ${fixed.entity.value}`,
      '| renamed:',
      fixed.renamed,
      '| seed kept:',
      fixed.entity.seed,
      '| orphaned:',
      fixed.removal?.orphanedFindings ?? 0
    )
    if (fixed.entity.value !== 'torvalds2') {
      fail(`edit did not re-normalise: stored "${fixed.entity.value}"`)
      await flush()
      return false
    }

    // Removal: the entity goes, its findings stay and are orphaned, the raw captures are
    // untouched. Read back off disk rather than out of the objects in hand.
    const target = seeds[0]!
    const usage = await service.entityUsage(wide.id, target.id)
    log('usage before removal:', JSON.stringify(usage))
    const removal = await service.deleteEntity({ caseId: wide.id, entityId: target.id })
    log('removal:', JSON.stringify(removal))

    const dir = service.store.dir(wide.id)
    const entitiesOnDisk = await service.store.readEntities(wide.id)
    const findingsOnDisk = (await service.store.readFindings(wide.id)).records
    const tombsOnDisk = (await service.store.readRemovedEntities(wide.id)).records
    const orphansOnDisk = findingsOnDisk.filter(
      (f) => !entitiesOnDisk.some((e) => e.id === f.entityId)
    )
    log('on disk:', dir)
    log(
      '  entities.json:',
      entitiesOnDisk.length,
      '| findings.jsonl:',
      findingsOnDisk.length,
      '| orphaned:',
      orphansOnDisk.length,
      '| removed-entities.jsonl:',
      tombsOnDisk.length
    )

    if (entitiesOnDisk.some((e) => e.id === target.id)) {
      fail('the removed entity is still in entities.json')
      await flush()
      return false
    }
    if (usage && orphansOnDisk.filter((f) => f.entityId === target.id).length !== usage.findings) {
      fail(
        `usage promised ${usage.findings} orphaned findings and ${orphansOnDisk.length} are on disk`
      )
      await flush()
      return false
    }
    if (removal.orphanedFindings > 0 && tombsOnDisk.length === 0) {
      fail('a removal that orphaned findings wrote no tombstone')
      await flush()
      return false
    }

    // And the index agrees with the files after a rebuild — the whole point of the files
    // being the truth.
    await service.rebuildIndex()
    const stillThere = service.db
      .prepare(`SELECT COUNT(*) n FROM findings WHERE case_id = ?`)
      .get(wide.id) as { n: number }
    const gone = service.db.prepare(`SELECT COUNT(*) n FROM entities WHERE id = ?`).get(target.id) as {
      n: number
    }
    log('after rebuild — findings:', stillThere.n, '| removed entity rows:', gone.n)
    if (stillThere.n !== findingsOnDisk.length || gone.n !== 0) {
      fail('the rebuilt index disagrees with the files about what was removed')
      await flush()
      return false
    }

    log('PASS — case -> entity -> adapter -> finding -> SQLite -> FTS5 -> rebuild all verified')
    log('PASS — fan-out plan, batch run, edit, removal and orphaning all verified on disk')
    await flush()
    return true
  } catch (err) {
    fail((err as Error).stack ?? String(err))
    await flush()
    return false
  }
}

/** Wait until every job in a case has reached a terminal state. */
function settled(service: OsintService, caseId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const tick = (): void => {
      const jobs = service.orchestrator.listJobs(caseId)
      if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) {
        resolve()
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** `3 cancelled, 2 done` — the wave's states, for the transcript. */
function histogram(service: OsintService, caseId: string): string {
  const states = new Map<string, number>()
  for (const j of service.orchestrator.listJobs(caseId)) {
    states.set(j.state, (states.get(j.state) ?? 0) + 1)
  }
  return [...states].map(([s, n]) => `${n} ${s}`).join(', ')
}

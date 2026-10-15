/**
 * The investigation engine.
 *
 * The tests are pointed at the four properties that make automation safe enough to run
 * unattended, in the order they matter:
 *
 *  1. **Nothing is promoted.** A full multi-hop run must leave `entities.json` exactly as
 *     it found it. This is the one failure that cannot be undone, so it is tested first
 *     and tested end to end rather than at a unit. Every path that can reach a node — an
 *     expansion, a probe, a re-scoring that changes its mind — is tested against it.
 *  2. **Provenance records the mechanism of every hop**, the *adapter* is what records it,
 *     and pruning a node takes everything descending from it — but not a node that had a
 *     second route. A page's own words can no longer choose how it was reached.
 *  3. **Corroboration steers, and it means two genuinely independent sources.** Two
 *     wrappers around one site do not corroborate; local analysis never counts; two weak
 *     matchers agreeing goes to the human. A link the subject published is *one* source and
 *     buys one run — it never counts as the second, and it never authorises the next hop.
 *     The far end linking back is a second operator, and that is corroboration.
 *  4. **A disposition survives contact with the evidence.** What the engine learns by
 *     reading a node can change what it decided about it, in both directions.
 *  5. **Every automatic decision states its reason**, and the stops actually fire — except
 *     contradiction density, which cuts a branch and never ends the run.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { OsintService } from '../src/main/service'
import { makeFinding, type Adapter, type EntityProposal, type RawResult } from '../src/main/adapters/types'
import {
  InvestigationEngine,
  ProvenanceGraph,
  YieldTable,
  branchDensities,
  contradictedBranches,
  corroborationOf,
  disposeLead,
  engineSourceKey,
  evaluateStops,
  independentSourcesOf,
  mechanismFor,
  planActions,
  ENGINE_LOG_FILE,
  PROVENANCE_FILE
} from '../src/main/engine'
import {
  DEFAULT_BUDGET,
  chainLine,
  type InvestigationRunState,
  type NodeRef,
  type ProvenanceHop
} from '../src/shared/engine'
import type { AdapterInfo, CandidateView, Finding } from '../src/shared/types'

export interface EngineTest {
  name: string
  fn: () => void | Promise<void>
}

export const engineTests: EngineTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  engineTests.push({ name, fn })
}

function doc(): Adapter['doc'] {
  return {
    what: 'A fixture adapter used only by the engine test suite.',
    how: 'It returns a constant shaped like a profile read, without touching the network or the filesystem.',
    why: 'Because the loop is what is under test here, not any particular mechanism for learning things.',
    betterAt: 'Being predictable across a multi-hop run with no network and no clock.',
    worseAt: 'Producing any information whatsoever about the real world.',
    falsePositives: 'It cannot produce false positives because every claim it makes is about itself.'
  }
}

async function scratch(prefix: string): Promise<string> {
  const base = path.join(process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test'), prefix)
  await fsp.mkdir(base, { recursive: true })
  return fsp.mkdtemp(path.join(base, 'run-'))
}

/* ------------------------------------------------------------------ *
 * Fixture adapters
 * ------------------------------------------------------------------ */

const SEED = 'github.example/quillferndev'
const MID = 'mid.example/quillfern-notes'
const DEEP = 'deep.example/quillfern-dumps'

interface Emission {
  source: string
  claim: string
  proposal?: {
    kind: EntityProposal['kind']
    value: string
    rationale: string
    /**
     * The route the fixture says it took, exactly as a real adapter now declares it.
     *
     * Omitted on purpose in some scripts: an adapter that declares nothing falls back to
     * its own default route, and a fixture adapter has none, so the hop reads `tool-claim`.
     * That is the honest answer and these tests rely on it — provenance is no longer
     * recoverable from the sentence, which is the whole point of the change.
     */
    mechanism?: EntityProposal['mechanism']
  }
  weakMatcher?: boolean
}

/**
 * A profile reader whose output depends on which account it was pointed at.
 *
 * That dependency is what makes a *chain* possible in a test: the seed yields a lead from
 * two independent sites (so corroboration authorises an automatic expansion), and the lead
 * yields a further one from a single site (so the engine has to stop and ask).
 */
function chainAdapter(id: string, script: Record<string, Emission[]>): Adapter {
  return {
    id,
    accepts: ['account', 'username'],
    produces: ['account', 'person'],
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
      return (script[about] ?? []).map((e) =>
        makeFinding(raw, {
          source: e.source,
          claim: e.claim,
          matcher: e.weakMatcher
            ? {
                strength: 'weak',
                label: 'weak matcher',
                why: 'The request does not name the handle, so a 200 is about the endpoint rather than about an account.',
                reasons: ['no handle in the request URL']
              }
            : null
        })
      )
    },
    propose: (raw) => {
      const { about } = JSON.parse(raw.stdout) as { about: string }
      const out: EntityProposal[] = []
      for (const e of script[about] ?? []) {
        if (!e.proposal) continue
        out.push({
          fromFindingId: makeFinding(raw, { source: e.source, claim: e.claim }).id,
          kind: e.proposal.kind,
          value: e.proposal.value,
          rationale: e.proposal.rationale,
          ...(e.proposal.mechanism ? { mechanism: e.proposal.mechanism } : {})
        })
      }
      return out
    }
  }
}

const SCRIPT: Record<string, Emission[]> = {
  [SEED]: [
    {
      source: 'github.example',
      claim: `The profile for quillferndev links out to https://${MID} with rel="me".`,
      proposal: {
        kind: 'account',
        value: MID,
        rationale: 'The account holder put that outbound link on their own profile, so it is their own assertion.',
        mechanism: 'declared-link'
      }
    },
    {
      source: 'mid.example',
      claim: `${MID} links back to https://${SEED}.`,
      proposal: {
        kind: 'account',
        value: MID,
        rationale: 'The profile links out to the seed, which is the reciprocal half of the same declared link.',
        mechanism: 'declared-link'
      }
    }
  ],
  [MID]: [
    {
      source: 'gamma.example',
      claim: `The profile for quillfern-notes mentions https://${DEEP} in its bio.`,
      proposal: {
        kind: 'account',
        value: DEEP,
        // A bio mention, and the adapter says so. Writing "the account holder put that link
        // there" over a URL that merely appeared in free text is how a mention became an
        // ownership claim; the mechanism is now declared from what was parsed rather than
        // inferred from the sentence.
        rationale: 'A second handle, mentioned in the profile text.',
        mechanism: 'profile-field'
      }
    }
  ]
}

/**
 * Every run in this file is pinned to the fixture adapter.
 *
 * Not tidiness: the built-in adapters are real, several of them reach the network, and the
 * planner would correctly rank `profile-enrich` above a fixture — so an unpinned test would
 * make live requests and would be testing the toolbelt rather than the loop.
 */
const ONLY = ['t-chain']

/**
 * The registry is process-wide, so a fixture adapter is registered once and reused. Its
 * id is written into every finding it produces, which is the reason ids are stable rather
 * than generated per test.
 */
function ensure(service: OsintService, adapter: Adapter): void {
  if (!service.registry.has(adapter.id)) service.registry.register(adapter)
}

async function seededService(prefix: string): Promise<{
  service: OsintService
  engine: InvestigationEngine
  caseId: string
  seedId: string
}> {
  const service = await OsintService.create(await scratch(prefix))
  ensure(service, chainAdapter('t-chain', SCRIPT))
  const c = await service.createCase({ name: 'Engine', basis: 'training' })
  const seed = await service.addEntity({ caseId: c.id, kind: 'account', value: SEED, seed: true })
  return { service, engine: new InvestigationEngine(service), caseId: c.id, seedId: seed.id }
}

/* ------------------------------------------------------------------ *
 * 1. Nothing is promoted
 * ------------------------------------------------------------------ */

test('a full multi-hop run promotes nothing: entities.json is untouched', async () => {
  const { service, engine, caseId } = await seededService('engine-nopromote')
  const before = await service.listEntities(caseId)

  const { whenFinished } = engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 8, maxWallClockMs: 60_000 } })
  const state = await whenFinished

  const after = await service.listEntities(caseId)
  assert.equal(after.length, before.length, 'the engine created an entity; automation must never promote')
  assert.deepEqual(
    after.map((e) => e.id).sort(),
    before.map((e) => e.id).sort()
  )

  const candidates = await service.listCandidates(caseId, 'all')
  assert.ok(candidates.length > 0, 'the run should have produced candidates')
  assert.ok(
    candidates.every((c) => c.state !== 'promoted'),
    'a candidate was promoted without a human'
  )

  const findings = await service.listFindings(caseId)
  assert.ok(
    findings.every((f) => f.confidence === 'unverified'),
    'the engine moved a finding up the confidence ladder'
  )
  assert.equal(state.phase, 'done')
  await service.dispose()
})

test('a corroborated lead is probed as a provisional subject, and its findings are orphaned until a human promotes it', async () => {
  const { service, engine, caseId } = await seededService('engine-provisional')
  await engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 8, maxWallClockMs: 60_000 } }).whenFinished

  const entities = new Set((await service.listEntities(caseId)).map((e) => e.id))
  const findings = await service.listFindings(caseId)
  const orphans = findings.filter((f) => !entities.has(f.entityId))
  assert.ok(orphans.length > 0, 'the engine never ran against anything outside the graph, so it never went past depth 1')

  // The candidate and the entity it would become share an id by construction, which is what
  // makes those orphans attach on promotion rather than being duplicated.
  const candidates = await service.listCandidates(caseId, 'pending')
  const mid = candidates.find((c) => c.value === MID)
  assert.ok(mid, 'the declared link should be a candidate')
  const promoted = await service.promoteCandidate({ caseId, candidateId: mid.id })
  assert.equal(promoted.id, mid.id, 'a promoted candidate must keep its id or the engine’s findings are lost')
  const stillOrphaned = (await service.listFindings(caseId)).filter((f) => f.entityId === mid.id)
  assert.ok(stillOrphaned.length > 0, 'the findings the engine wrote about the candidate should now belong to the entity')
  await service.dispose()
})

/**
 * A chain of single-source declared links, and nothing else in the case.
 *
 * Two regressions live here and they pull in opposite directions.
 *
 * The first cost a live run: whether a lead may be acted on depends on *how* it was
 * reached, so the hop has to be on disk before the state is re-read. Recording it
 * afterwards made every new lead look unreachable, the novelty counter ticked, and the loop
 * stopped one run after finding exactly the thing it was looking for.
 *
 * The second is the opposite failure, and this file used to assert it as desired: the
 * engine walked *both* declared links, two hops out, on one source with no human — and the
 * brief filed the result under a heading reading "two independent sources agree". A
 * declared link buys one run off ground the engine already stands on. The far end of that
 * run is a single-source lead like any other, and its own declared links are a question.
 */
const DECLARED_ONLY: Record<string, Emission[]> = {
  [SEED]: [
    {
      source: 'github.example',
      claim: `The profile for quillferndev links out to https://${MID} with rel="me".`,
      proposal: {
        kind: 'account',
        value: MID,
        rationale: 'The account holder put that outbound link on their own profile.',
        mechanism: 'declared-link'
      }
    }
  ],
  [MID]: [
    {
      source: 'mid.example',
      claim: `The profile for quillfern-notes links out to https://${DEEP} with rel="me".`,
      proposal: {
        kind: 'account',
        value: DEEP,
        rationale: 'The account holder put that outbound link on their own profile.',
        mechanism: 'declared-link'
      }
    }
  ]
}

/** The same chain, except the far end links back. That link back is a second source. */
const RECIPROCATED: Record<string, Emission[]> = {
  [SEED]: [
    {
      source: 'github.example',
      claim: `The profile for quillferndev links out to https://${MID} with rel="me".`,
      proposal: {
        kind: 'account',
        value: MID,
        rationale: 'The account holder put that outbound link on their own profile.',
        mechanism: 'declared-link'
      }
    }
  ],
  [MID]: [
    {
      source: 'mid.example',
      claim: `The profile for quillfern-notes links out to https://${SEED} with rel="me".`,
      proposal: {
        kind: 'account',
        value: SEED,
        rationale: 'The far end publishes the same connection back.',
        mechanism: 'declared-link'
      }
    },
    {
      source: 'mid.example',
      claim: `The profile for quillfern-notes links out to https://${DEEP} with rel="me".`,
      proposal: {
        kind: 'account',
        value: DEEP,
        rationale: 'The account holder put that outbound link on their own profile.',
        mechanism: 'declared-link'
      }
    }
  ]
}

async function runDeclared(
  prefix: string,
  adapterId: string,
  script: Record<string, Emission[]>
): Promise<{
  service: OsintService
  engine: InvestigationEngine
  caseId: string
  state: InvestigationRunState
}> {
  const service = await OsintService.create(await scratch(prefix))
  ensure(service, chainAdapter(adapterId, script))
  const c = await service.createCase({ name: prefix, basis: 'training' })
  await service.addEntity({ caseId: c.id, kind: 'account', value: SEED, seed: true })
  const engine = new InvestigationEngine(service)
  const state = await engine.start({
    caseId: c.id,
    adapterIds: [adapterId],
    budget: { maxRuns: 6, maxWallClockMs: 60_000 }
  }).whenFinished
  return { service, engine, caseId: c.id, state }
}

test('a link the subject declared buys one run and does not chain: the second one is a question', async () => {
  const { service, engine, caseId, state } = await runDeclared('engine-declared', 't-declared', DECLARED_ONLY)

  assert.equal(state.leads.probed, 1, `exactly one declared link should have been read, got ${state.leads.probed}`)
  assert.equal(state.leads.expanded, 0, 'nothing here has two independent sources, so nothing may be expanded')

  const brief = await engine.brief(caseId)
  // The lead the engine read is one source, and the source is the subject. Established is
  // captioned "two independent sources agree, or you confirmed it yourself"; this is
  // neither, so it must not be there.
  assert.ok(
    !brief.established.some((i) => i.node.value === MID),
    'a lead followed on one declared link must never be presented as Established'
  )
  assert.ok(brief.pending.some((i) => i.node.value === MID), 'a probed lead belongs under Pending, at one source')

  // The far end declares a link of its own. The engine read it; it does not get to follow it.
  const deep = (await engine.chains(caseId)).find((ch) => ch.node.value === DEEP)
  assert.ok(deep, 'the second declared link should still be reached and shown')
  assert.equal(deep.depth, 2, `the lead itself sits two hops out, got ${deep.depth}`)
  assert.ok(
    brief.questions.some((q) => q.node.value === DEEP),
    'the second declared link has to come back as a question rather than be walked'
  )

  assert.equal((await service.listEntities(caseId)).length, 1, 'reading a declared link must still promote nothing')
  const candidates = await service.listCandidates(caseId, 'all')
  assert.ok(candidates.every((c) => c.state !== 'promoted'), 'a probe must never promote a candidate')
  await service.dispose()
})

test('a probe result is one source: it cannot corroborate anything, including its own next hop', async () => {
  const { service, engine, caseId } = await runDeclared('engine-probe-source', 't-declared-b', DECLARED_ONLY)

  const brief = await engine.brief(caseId)
  const mid = brief.pending.find((i) => i.node.value === MID)
  assert.ok(mid, 'the probed lead should be in the brief')
  assert.equal(mid.independentSources, 1, `a probe result is one source; the brief said ${mid.independentSources}`)

  const deepItem = [...brief.pending, ...brief.established].find((i) => i.node.value === DEEP)
  assert.ok(deepItem, 'the lead behind the second declared link should be shown')
  assert.equal(deepItem.independentSources, 1, 'the far end being read does not add a source to what it names')
  assert.ok(
    !brief.established.some((i) => i.node.value === DEEP),
    'a lead reached through a probe result must not be established by it'
  )
  await service.dispose()
})

test('a reciprocal link is the second source, and the lead is then corroborated the ordinary way', async () => {
  const { service, engine, caseId, state } = await runDeclared('engine-reciprocal', 't-recip', RECIPROCATED)

  const brief = await engine.brief(caseId)
  const mid = [...brief.established, ...brief.pending].find((i) => i.node.value === MID)
  assert.ok(mid, 'the declared link should still be in the brief')
  assert.equal(mid.independentSources, 2, `the link back is the second source; got ${mid.independentSources}`)
  assert.ok(
    brief.established.some((i) => i.node.value === MID),
    'once the far end links back there are two independent site operators, which is corroboration'
  )
  assert.ok(state.leads.expanded >= 1, 'a reciprocated link is an expansion under the ordinary two-source rule')
  assert.equal((await service.listEntities(caseId)).length, 1, 'reciprocity is still not promotion')
  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * 2. Provenance
 * ------------------------------------------------------------------ */

test('every hop records how it was made, and the chain reads back as a route', async () => {
  const { service, engine, caseId } = await seededService('engine-chain')
  await engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 8, maxWallClockMs: 60_000 } }).whenFinished

  const chains = await engine.chains(caseId)
  const deep = chains.find((c) => c.node.value === DEEP)
  assert.ok(deep, 'the run never reached the second hop')
  assert.equal(deep.depth, 2, `expected a two-hop route, got ${deep.depth}`)
  assert.equal(deep.rootIsSeed, true)
  assert.equal(deep.rootIsAnchor, true, 'a seeded account is an anchor')
  assert.equal(deep.hops[0]?.mechanism, 'seed')
  assert.equal(deep.hops[1]?.mechanism, 'declared-link', 'a rel="me" link must not read as a handle sweep')
  assert.ok(deep.line.includes('→ declared link →'), `the rendered route lost its mechanism: ${deep.line}`)
  assert.ok(deep.hops.every((h) => h.detail.trim().length > 0), 'a hop with no detail is unauditable')
  await service.dispose()
})

test('the provenance file is append-only JSONL beside the case, not a table in the index', async () => {
  const { service, engine, caseId } = await seededService('engine-files')
  await engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 4, maxWallClockMs: 60_000 } }).whenFinished
  const dir = service.store.dir(caseId)
  const prov = await fsp.readFile(path.join(dir, PROVENANCE_FILE), 'utf8')
  const log = await fsp.readFile(path.join(dir, ENGINE_LOG_FILE), 'utf8')
  assert.ok(prov.trim().split('\n').every((l) => JSON.parse(l).record), 'every provenance line carries its record type')
  assert.ok(log.trim().split('\n').every((l) => (JSON.parse(l) as { reason: string }).reason.trim().length > 0))
  await service.dispose()
})

test('pruning a node cuts everything descending from it, and restoring puts it back', async () => {
  const { service, engine, caseId } = await seededService('engine-prune')
  await engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 8, maxWallClockMs: 60_000 } }).whenFinished

  const chains = await engine.chains(caseId)
  const mid = chains.find((c) => c.node.value === MID)
  const deep = chains.find((c) => c.node.value === DEEP)
  assert.ok(mid && deep, 'the fixture should have produced both hops')

  const result = await engine.prune({ caseId, nodeId: mid.node.id, reason: 'Testing that a cut takes its descendants.' })
  assert.ok(
    result.cut.some((n) => n.id === deep.node.id),
    'pruning the middle node left its descendant attached to nothing'
  )
  assert.ok(result.candidatesDismissed > 0, 'a cut candidate should be dismissed — recoverable, unlike a promotion')

  const after = await engine.chain(caseId, deep.node.id)
  assert.ok(!after || after.pruned, 'the descendant is still presented as reachable after its only route was cut')

  const restored = await engine.restore(caseId, mid.node.id)
  assert.ok(restored.cut.length >= 2, 'restore must bring back everything the cut took, not only the named node')
  const back = await engine.chain(caseId, deep.node.id)
  assert.ok(back && !back.pruned, 'restoring the branch did not bring the descendant back')
  await service.dispose()
})

test('a node with a second route survives the loss of the first', () => {
  const a: NodeRef = { id: 'ent_a', kind: 'account', value: 'a.example/x', label: 'a' }
  const b: NodeRef = { id: 'ent_b', kind: 'account', value: 'b.example/x', label: 'b' }
  const c: NodeRef = { id: 'ent_c', kind: 'account', value: 'c.example/x', label: 'c' }
  const hop = (to: NodeRef, from: NodeRef | null, mechanism: ProvenanceHop['mechanism']): ProvenanceHop => ({
    id: `hop_${to.id}_${from?.id ?? 'root'}`,
    caseId: 'case',
    to,
    from,
    mechanism,
    findingId: from ? `fnd_${to.id}_${from.id}` : null,
    tool: from ? 't' : null,
    source: from ? `${from.value.split('/')[0]}` : null,
    detail: 'fixture',
    at: '2026-09-03T00:00:00.000Z'
  })

  const graph = new ProvenanceGraph(
    [hop(a, null, 'seed'), hop(b, a, 'declared-link'), hop(c, b, 'profile-field'), hop(c, a, 'avatar-hash')],
    [],
    { seeds: new Set(['ent_a']), anchors: new Set(['ent_a']), inGraph: new Set(['ent_a']) }
  )

  assert.deepEqual(
    graph.descendantsOf('ent_b').map((n) => n.id),
    [],
    'c was reachable directly from the seed as well, so cutting b must not take it'
  )
  assert.equal(graph.chainFor('ent_c')?.alternates, 1, 'two routes to one node is better evidence and has to be counted')
})

test('chainLine renders the route the strategy document specifies', () => {
  const seed: NodeRef = { id: 'ent_s', kind: 'username', value: 'quillfern', label: 'quillfern' }
  const gh: NodeRef = { id: 'ent_g', kind: 'account', value: 'github.com/quillfern', label: 'github.com/quillfern' }
  const kb: NodeRef = { id: 'ent_k', kind: 'account', value: 'keybase.io/ark', label: 'keybase.io/ark' }
  const at = '2026-09-03T00:00:00.000Z'
  const line = chainLine([
    { id: '1', caseId: 'c', to: seed, from: null, mechanism: 'seed', findingId: null, tool: null, source: null, detail: '', at },
    { id: '2', caseId: 'c', to: gh, from: seed, mechanism: 'handle-sweep', findingId: null, tool: null, source: null, detail: '', at },
    { id: '3', caseId: 'c', to: kb, from: gh, mechanism: 'declared-link', findingId: null, tool: null, source: null, detail: '', at }
  ])
  assert.equal(line, 'seed:username(quillfern) → handle sweep → github.com/quillfern → declared link → keybase.io/ark')
})

test('a hop is classified by the adapter that made it, from structure rather than from prose', () => {
  // The adapter declares the route it took, per proposal, because it is the only thing that
  // knows: it parsed the `<a rel="me">`, or it did not.
  assert.equal(mechanismFor('profile-enrich', 'declared-link'), 'declared-link')
  // Undeclared falls back to what that adapter structurally is.
  assert.equal(mechanismFor('profile-enrich'), 'profile-field')
  assert.equal(mechanismFor('maigret'), 'handle-sweep')
  assert.equal(mechanismFor('pivot'), 'correlation')
  assert.equal(mechanismFor('something-new'), 'tool-claim', 'an unknown route must not borrow a stronger label')
  // Roots are minted by people, not by fetches. An adapter claiming one is ignored.
  assert.equal(mechanismFor('maigret', 'seed'), 'handle-sweep', 'no adapter may declare itself ground truth')
  assert.equal(mechanismFor('maigret', 'promotion'), 'handle-sweep')
  assert.equal(mechanismFor('maigret', 'not-a-mechanism' as never), 'handle-sweep')
})

test('a page cannot forge its own provenance by putting the right words on itself', () => {
  // `websearch` embeds a result's title and snippet verbatim in the claim it writes, and
  // `profile-enrich` quotes bios. The mechanism used to be pattern-matched over exactly
  // that text, so a stranger's page whose title said `rel=me` minted the strongest hop in
  // the system — enough on its own to authorise the engine to keep fetching.
  const hostile = 'Home — rel="me" outbound link, links out to everything, declared link'
  assert.equal(
    mechanismFor('websearch', undefined),
    'search-result',
    `page-controlled text must not be able to reclassify a hop: ${hostile}`
  )
  assert.notEqual(mechanismFor('websearch'), 'declared-link')
  assert.notEqual(mechanismFor('sherlock'), 'declared-link')
  assert.notEqual(mechanismFor('pivot'), 'avatar-hash', 'local correlation must not read as an observation')
})

/* ------------------------------------------------------------------ *
 * 3. Corroboration steers
 * ------------------------------------------------------------------ */

test('two wrappers around one site are one source, so they cannot corroborate each other', () => {
  const keys = independentSourcesOf([
    'https://api.github.com/users/torvalds',
    'https://www.github.com/torvalds',
    'github.com'
  ])
  assert.deepEqual(keys, ['github.com'], `three readings of one site folded to ${keys.length} sources`)
})

test('local analysis never counts toward corroboration', () => {
  assert.deepEqual(independentSourcesOf(['local:pivot', 'local:pattern-timezone', 'file:photo.jpg']), [])
  assert.deepEqual(independentSourcesOf(['local:pivot', 'github.com']), ['github.com'])
  assert.equal(engineSourceKey('local:pivot'), 'local:pivot', 'a derived source must keep its prefix and never fold to a host')
})

const NODE_X: NodeRef = { id: 'ent_x', kind: 'account', value: 'x.example/y', label: 'x' }

/** Everything a disposition needs, with the permissive answer to every question. */
function dispose(over: Partial<Parameters<typeof disposeLead>[0]>): ReturnType<typeof disposeLead> {
  return disposeLead({
    node: NODE_X,
    candidate: candidateWith(['github.com']),
    band: 'silent',
    depth: 1,
    withinDepth: true,
    declaredRoute: false,
    parentTrusted: true,
    reciprocalSources: [],
    ...over
  })
}

test('two independent sources expand automatically; one does not', () => {
  const two = dispose({ candidate: candidateWith(['github.com', 'keybase.io']) })
  assert.equal(two.disposition, 'expand')
  assert.equal(two.basis, 'corroborated')
  assert.equal(two.independentSources, 2)
  assert.ok(two.reason.includes('github.com'), 'an automatic expansion has to name which two sources agreed')

  const one = dispose({})
  assert.equal(one.disposition, 'ask')
  assert.equal(one.basis, 'single-source')
})

test('two weak matchers agreeing is not corroboration — it is the false-positive class, and it goes to the human', () => {
  const v = dispose({ candidate: candidateWith(['a.example', 'b.example'], 'weak') })
  assert.equal(v.disposition, 'ask')
  assert.equal(v.basis, 'weak-matchers')
  assert.ok(v.reason.includes('weak matcher'))
})

test('a link the subject wrote buys one run, is never an expansion, and says why that is not a loophole', () => {
  const v = dispose({ declaredRoute: true })
  assert.equal(v.disposition, 'probe', 'a declared link is permission to read, not permission to believe')
  assert.equal(v.basis, 'declared-link')
  assert.equal(v.independentSources, 1, 'it is still one source, and the verdict must not pretend otherwise')
  assert.ok(v.reason.includes('nothing believed'), 'a probe has to say out loud that it is a fetch and not a belief')
})

test('the declared-link permission does not chain: it needs a parent the engine already stands on', () => {
  const off = dispose({ declaredRoute: true, parentTrusted: false })
  assert.equal(off.disposition, 'ask', 'a probe result must not authorise the next probe')
  assert.equal(off.basis, 'declared-chain')
  assert.ok(off.reason.includes('ladder'), 'the refusal has to explain what it is preventing')

  // The depth cap binds it like everything else. This used to be skipped, so a declared
  // link past the cap incremented the expansion counter and reset novelty while the planner
  // quietly refused to run it.
  const deep = dispose({ declaredRoute: true, depth: 4, withinDepth: false })
  assert.notEqual(deep.disposition, 'probe', 'the depth cap applies to a probe as well')

  // And a weak matcher still sinks it.
  const weak = dispose({ declaredRoute: true, candidate: candidateWith(['a.example', 'b.example'], 'weak') })
  assert.notEqual(weak.disposition, 'probe')
})

test('a link the far end sends back is the second source, and corroboration is reached the ordinary way', () => {
  const v = dispose({ declaredRoute: true, reciprocalSources: ['mid.example'] })
  assert.equal(v.disposition, 'expand', 'two site operators publishing the same connection is corroboration')
  assert.equal(v.basis, 'reciprocated')
  assert.equal(v.independentSources, 2)

  // ...and it is still *independence* that decides. A far end folding to the same operator
  // as the declaring source is one site answering twice, which is what the whole fold exists
  // to stop, so it must not reach two.
  const same = dispose({ declaredRoute: true, reciprocalSources: ['https://api.github.com/users/x'] })
  assert.equal(same.independentSources, 1, 'a reciprocal link from the same site operator is not a second source')
  assert.equal(same.disposition, 'probe')

  // Local analysis is never a second opinion, reciprocal or not.
  const derived = dispose({ declaredRoute: true, reciprocalSources: ['local:pivot'] })
  assert.equal(derived.independentSources, 1, 'local analysis cannot become the second source by arriving late')
})

test('a contradicted lead is parked with its reason, never expanded and never probed', () => {
  const v = dispose({ candidate: candidateWith(['github.com', 'keybase.io']), band: 'contradicted', declaredRoute: true })
  assert.equal(v.disposition, 'park')
  assert.equal(v.basis, 'contradicted')
  assert.ok(v.reason.length > 40, 'a park has to explain itself')
})

test('corroborationOf recomputes independence rather than trusting the index count', () => {
  const c = candidateWith(['https://api.github.com/users/x', 'https://github.com/x'])
  const corr = corroborationOf(c)
  assert.equal(corr.count, 1)
  assert.equal(corr.corroborated, false)
  // The same fold applies to a source that arrived by linking back, so reciprocity cannot
  // be used to smuggle a second reading of one site past the rule.
  assert.equal(corroborationOf(c, ['api.github.com']).count, 1)
  assert.equal(corroborationOf(c, ['keybase.io']).count, 2)
})

/* ------------------------------------------------------------------ *
 * 3b. A removal cuts the branch, for every caller
 * ------------------------------------------------------------------ */

test('constructing the engine is what makes a removal cut its provenance root', async () => {
  const { service, engine, caseId, seedId } = await seededService('engine-removeroot')
  await engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 8, maxWallClockMs: 60_000 } }).whenFinished

  const before = await engine.chains(caseId)
  assert.ok(before.length > 1, 'the run should have produced a branch under the seed')
  assert.ok(before.every((c) => !c.pruned), 'nothing should be cut yet')

  // No wiring in this test, and that is the point. The hook used to be joined to the
  // service in `ipc.ts`, so every test that built an engine got one without it — the defect
  // it closes was invisible to exactly the code written to catch it.
  const removal = await service.deleteEntity({ caseId, entityId: seedId })
  assert.ok(removal.provenanceCut > 0, 'removing a root must cut it and everything under it')

  const after = await engine.chains(caseId)
  assert.ok(
    after.every((c) => c.pruned),
    'nothing may still be reachable from a seed the operator deleted'
  )
  const decisions = await engine.decisions(caseId)
  const cut = decisions.find((d) => d.kind === 'pruned')
  assert.ok(cut, 'the cut has to be in the engine log like any other prune')
  assert.match(cut.reason, /restore/i, 'and it has to say how to undo it')

  // Recorded, not destroyed: the whole reason automation is allowed to prune at all.
  const restored = await engine.restore(caseId, seedId)
  assert.ok(restored.cut.length > 0, 'the cut a removal makes is undoable like every other one')
  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * 4. The planner
 * ------------------------------------------------------------------ */

test('naming a root scopes the run to it, and says so about everything it leaves alone', async () => {
  const service = await OsintService.create(await scratch('engine-scope'))
  ensure(service, chainAdapter('t-chain', SCRIPT))
  const c = await service.createCase({ name: 'Scope', basis: 'training' })
  const wanted = await service.addEntity({ caseId: c.id, kind: 'account', value: SEED, seed: true })
  const other = await service.addEntity({ caseId: c.id, kind: 'account', value: 'other.example/someone', seed: true })
  const engine = new InvestigationEngine(service)

  const scoped = await engine.plan(c.id, { adapterIds: ONLY, rootEntityIds: [wanted.id] })
  assert.ok(
    scoped.actions.every((a) => a.node.id === wanted.id),
    '"follow this account and nothing else" has to mean the second half too'
  )
  const refused = scoped.blocked.find((a) => a.node.id === other.id)
  assert.ok(refused, 'the excluded root must be ranked and refused, never silently dropped')
  assert.match(refused.blocked ?? '', /scoped this investigation/i, 'and the refusal has to say why')

  // Unscoped, both seeds are fair game — the narrowing is the request's, not the case's.
  const open = await engine.plan(c.id, { adapterIds: ONLY })
  assert.ok(open.actions.some((a) => a.node.id === other.id), 'without named roots the whole case is in play')

  // And a run honours it: the excluded seed is never pointed at.
  await engine
    .start({ caseId: c.id, adapterIds: ONLY, rootEntityIds: [wanted.id], budget: { maxRuns: 8, maxWallClockMs: 60_000 } })
    .whenFinished
  const ran = (await engine.decisions(c.id)).filter((d) => d.kind === 'ran')
  assert.ok(ran.length > 0, 'the scoped run should still have done something')
  assert.ok(
    ran.every((d) => d.node?.id !== other.id),
    'a scoped run must not spend a single run on a root the operator left out'
  )
  await service.dispose()
})


test('the planner ranks, explains every action, and never silently drops one', async () => {
  const { service, engine, caseId } = await seededService('engine-plan')
  const ranking = await engine.plan(caseId, { adapterIds: ONLY })
  assert.ok(ranking.actions.length > 0, 'a case with a seed and an applicable adapter has something to do')
  for (const a of [...ranking.actions, ...ranking.blocked]) {
    assert.ok(a.reason.trim().length > 0, `${a.key} was ranked with no reason`)
    assert.ok(a.gain >= 0 && a.gain <= 100)
    assert.ok(a.basis === 'measured' || a.basis === 'prior')
  }
  for (const a of ranking.blocked) {
    assert.ok(a.blocked && a.blocked.trim().length > 0, `${a.key} was refused with no reason`)
  }
  await service.dispose()
})

test('an unread account with declared links outranks a sweep of a common handle', async () => {
  const service = await OsintService.create(await scratch('engine-rank'))
  ensure(service, chainAdapter('t-chain', SCRIPT))
  ensure(service, { ...chainAdapter('t-sweep', {}), accepts: ['username'], id: 't-sweep' })
  const c = await service.createCase({ name: 'Rank', basis: 'training' })
  const account = await service.addEntity({ caseId: c.id, kind: 'account', value: SEED, seed: true })
  const handle = await service.addEntity({ caseId: c.id, kind: 'username', value: 'max', seed: true })

  const engine = new InvestigationEngine(service)
  await engine.start({ caseId: c.id, adapterIds: ONLY, budget: { maxRuns: 2, maxWallClockMs: 30_000 } }).whenFinished
  const ranking = await engine.plan(c.id, { adapterIds: ONLY })

  const onAccount = ranking.actions.find((a) => a.node.id === account.id)
  const onHandle = ranking.actions.find((a) => a.node.id === handle.id)
  assert.ok(onAccount && onHandle, 'both seeds should have produced an action')
  assert.ok(
    onAccount.gain > onHandle.gain,
    `the declared-link account scored ${onAccount.gain} against ${onHandle.gain} for the three-letter handle`
  )
  assert.ok(
    onHandle.signals.some((s) => s.id === 'common-handle'),
    'a three-letter given name should fire the common-handle signal'
  )
  await service.dispose()
})

test('depth 3 is refused from an unconfirmed route, and allowed from an anchor', () => {
  // Built directly rather than through a run, because the rule is about a route that is
  // three hops long and the only honest way to have one in a test is to state it.
  const mk = (id: string, value: string, kind: NodeRef['kind'] = 'account'): NodeRef => ({
    id,
    kind,
    value,
    label: value
  })
  const seed = mk('ent_seed', 'quillferndev', 'username')
  const a = mk('ent_a', 'a.example/quillferndev')
  const b = mk('ent_b', 'b.example/quillferndev')
  const c = mk('ent_c', 'c.example/quillferndev')
  const at = '2026-09-03T00:00:00.000Z'
  const hop = (to: NodeRef, from: NodeRef | null, i: number): ProvenanceHop => ({
    id: `h${i}`,
    caseId: 'case',
    to,
    from,
    mechanism: from ? 'handle-sweep' : 'seed',
    findingId: from ? `f${i}` : null,
    tool: from ? 't' : null,
    source: from ? `${from.value.split('/')[0]}` : null,
    detail: 'fixture',
    at
  })
  const hops = [hop(seed, null, 0), hop(a, seed, 1), hop(b, a, 2), hop(c, b, 3)]

  const adapter = {
    id: 't-any',
    title: 'Fixture',
    version: '1',
    accepts: ['account' as const],
    produces: ['account' as const],
    requiresKey: false,
    requiresNetwork: false,
    doc: doc(),
    secretOptions: [],
    proposes: true,
    concurrency: 1,
    minIntervalMs: 0,
    defaultTimeoutMs: 1000,
    available: true,
    unavailableReason: null
  }

  const plan = (anchored: boolean) => {
    const graph = new ProvenanceGraph(hops, [], {
      seeds: new Set(['ent_seed']),
      anchors: anchored ? new Set(['ent_seed']) : new Set<string>(),
      inGraph: new Set(['ent_seed'])
    })
    const candidates = [a, b, c].map((n) => candidateNamed(n))
    const dispositions = new Map(
      candidates.map((cand) => [
        cand.id,
        {
          node: mk(cand.id, cand.value),
          disposition: 'expand' as const,
          basis: 'corroborated' as const,
          reason: 'fixture',
          independentSources: 2,
          sources: ['x.example', 'y.example'],
          band: 'silent' as const,
          depth: graph.chainFor(cand.id)?.depth ?? 0
        }
      ])
    )
    return planActions({
      caseId: 'case',
      entities: [],
      candidates,
      findings: [],
      adapters: [adapter],
      graph,
      yields: new YieldTable({ decisions: [], candidates: [], hops: [] }),
      budget: { ...DEFAULT_BUDGET, maxDepth: 2 },
      bands: new Map(),
      alreadyRun: new Set(),
      dispositions,
      contradictedBranches: new Set(),
      at
    })
  }

  const plain = plan(false)
  const deepAction = plain.blocked.find((x) => x.node.id === 'ent_c')
  assert.ok(deepAction, 'a three-hop node was not refused under a two-hop cap')
  assert.ok(deepAction.blocked?.includes('hops out'))
  assert.ok(
    deepAction.blocked?.includes('confirmed'),
    `the refusal has to say a confirmed anchor is what opens the next hop: ${deepAction.blocked}`
  )
  assert.ok(plain.actions.some((x) => x.node.id === 'ent_b'), 'two hops is inside the cap and must still run')

  const anchored = plan(true)
  assert.ok(
    anchored.actions.some((x) => x.node.id === 'ent_c'),
    'depth 3 must open once the route is rooted in an anchor a human stands behind'
  )
})

/* ------------------------------------------------------------------ *
 * 5. Stops
 * ------------------------------------------------------------------ */

/** Every stop input, with the answer that fires nothing. */
function stops(over: Partial<Parameters<typeof evaluateStops>[0]> = {}): ReturnType<typeof evaluateStops> {
  return evaluateStops({
    budget: DEFAULT_BUDGET,
    runsUsed: 0,
    elapsedMs: 1,
    depthReached: 1,
    quietExpansions: 0,
    branches: [],
    branchesPruned: 0,
    exhausted: false,
    blockedByDepth: 0,
    cancelled: false,
    failure: null,
    ...over
  })
}

test('the run budget fires and is reported as the reason', () => {
  const s = stops({ runsUsed: DEFAULT_BUDGET.maxRuns, elapsedMs: 1000 })
  assert.equal(s.fired?.id, 'budget-runs')
  assert.equal(s.conditions.length, 8, 'every condition is reported whether or not it fired')
})

test('contradiction density prunes a branch and never halts the run', () => {
  // The queue this describes is the one that used to stop an investigation at zero runs:
  // leftovers from an earlier manual sweep, mostly contradicted, sitting in the case before
  // the engine had done anything at all. It was measured case-wide, fired as a stop, and
  // explained itself in terms of a seed the run had not touched.
  const swamped = stops({
    branches: [{ branchId: 'b', branchLabel: 'x.example/max', leads: 8, contradicted: 5, share: 5 / 8 }]
  })
  assert.equal(swamped.fired, null, 'contradiction density must never end a run')
  const condition = swamped.conditions.find((c) => c.id === 'contradiction')
  assert.ok(condition, 'it is still reported, because headroom is worth showing')
  assert.equal(condition.fired, false)
  assert.equal(condition.pressure, 1, 'the pressure is the worst branch against the threshold, capped at 1')
  assert.ok(
    stops({ branches: [{ branchId: 'b', branchLabel: 'q', leads: 8, contradicted: 1, share: 1 / 8 }] }).conditions.find(
      (c) => c.id === 'contradiction'
    )!.pressure < 0.5,
    'a branch nowhere near the threshold has to read as headroom'
  )
  assert.ok(
    condition.detail.includes('x.example/max'),
    `the sentence has to name the branch it is about: ${condition.detail}`
  )
  assert.ok(
    condition.detail.includes('never stops the run') || condition.detail.includes('not the investigation'),
    `and has to say what it actually does: ${condition.detail}`
  )

  // The one thing that still ends a run on a queue full of nothing is having nothing to do.
  assert.equal(stops({ exhausted: true }).fired?.id, 'exhausted')
})

test('novelty decay fires after the window, and reports headroom before it', () => {
  const at = (quiet: number) => stops({ runsUsed: 1, quietExpansions: quiet })
  assert.equal(at(DEFAULT_BUDGET.noveltyWindow - 1).fired, null)
  assert.equal(at(DEFAULT_BUDGET.noveltyWindow).fired?.id, 'novelty')
  const near = at(DEFAULT_BUDGET.noveltyWindow - 1).conditions.find((c) => c.id === 'novelty')
  assert.ok((near?.pressure ?? 0) > 0.5, 'the brief has to be able to show how close the loop is to stopping')
})

test('a branch producing mostly contradicted leads is named for pruning, with the arithmetic in the reason', () => {
  const seed: NodeRef = { id: 'ent_seed', kind: 'username', value: 'max', label: 'max' }
  const branch: NodeRef = { id: 'ent_branch', kind: 'account', value: 'x.example/max', label: 'x.example/max' }
  const at = '2026-09-03T00:00:00.000Z'
  const hops: ProvenanceHop[] = [
    { id: '1', caseId: 'c', to: seed, from: null, mechanism: 'seed', findingId: null, tool: null, source: null, detail: 'seeded', at },
    { id: '2', caseId: 'c', to: branch, from: seed, mechanism: 'handle-sweep', findingId: 'f1', tool: 't', source: 'x.example', detail: 'taken', at }
  ]
  const leaves: CandidateView[] = []
  const bands = new Map<string, { band: 'contradicted' | 'silent'; score: number; signals: []; why: null; whyShort: null }>()
  for (let i = 0; i < 6; i++) {
    const node: NodeRef = { id: `ent_l${i}`, kind: 'person', value: `person ${i}`, label: `Person ${i}` }
    hops.push({
      id: `h${i}`,
      caseId: 'c',
      to: node,
      from: branch,
      mechanism: 'profile-field',
      findingId: `f${i}`,
      tool: 't',
      source: 'x.example',
      detail: 'name on the profile',
      at
    })
    leaves.push(candidateNamed(node))
    bands.set(node.id, { band: i < 5 ? 'contradicted' : 'silent', score: 10, signals: [], why: null, whyShort: null })
  }

  const graph = new ProvenanceGraph(hops, [], {
    seeds: new Set(['ent_seed']),
    anchors: new Set(),
    inGraph: new Set(['ent_seed'])
  })
  const verdicts = contradictedBranches({
    densities: branchDensities({ candidates: leaves, bands: bands as never, graph }),
    budget: DEFAULT_BUDGET
  })
  assert.equal(verdicts.length, 1)
  assert.equal(verdicts[0]?.branchId, 'ent_branch')
  assert.ok(verdicts[0]?.reason.includes('5 of 6'), `the reason has to carry the arithmetic: ${verdicts[0]?.reason}`)
})

test('a real run ends on a named stopping condition and logs a reason for it', async () => {
  const { service, engine, caseId } = await seededService('engine-stop')
  const state = await engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 3, maxWallClockMs: 60_000 } }).whenFinished
  assert.ok(state.stop, 'the run ended without naming a stopping condition')
  assert.ok(state.stop.detail.trim().length > 0)
  const decisions = await engine.decisions(caseId)
  assert.ok(decisions.some((d) => d.kind === 'stopped'), 'the stop was not written to the engine log')
  assert.ok(decisions.every((d) => d.reason.trim().length > 0), 'every automatic decision states its reason')
  assert.ok(decisions.some((d) => d.kind === 'ran' && d.gain !== null), 'a run has to record the gain it was chosen on')
  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * 6. Yield honesty
 * ------------------------------------------------------------------ */

test('an unmeasured estimate says it is a prior and names the reasoning', () => {
  const table = new YieldTable({ decisions: [], candidates: [], hops: [] })
  const est = table.estimate('profile-enrich', 'account')
  assert.equal(est.basis, 'prior')
  assert.equal(est.runs, 0)
  assert.ok(est.detail.includes('Estimated, not measured'))
  assert.ok(est.value > table.estimate('sherlock', 'username').value, 'reading a profile should outrank probing a site list')
})

test('measurement replaces the prior only once there are enough runs to be a rate', () => {
  const node: NodeRef = { id: 'ent_x', kind: 'account', value: 'x.example/y', label: 'x' }
  const ran = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      caseId: 'c',
      kind: 'ran' as const,
      at: '2026-09-03T00:00:00.000Z',
      reason: 'fixture',
      node,
      adapterId: 'profile-enrich',
      gain: 50
    }))
  assert.equal(new YieldTable({ decisions: ran(1), candidates: [], hops: [] }).estimate('profile-enrich', 'account').basis, 'prior')
  const measured = new YieldTable({ decisions: ran(4), candidates: [], hops: [] }).estimate('profile-enrich', 'account')
  assert.equal(measured.basis, 'measured')
  assert.equal(measured.runs, 4)
  assert.equal(measured.value, 0, 'four runs that produced no useful lead is a measured zero, not a comfortable prior')
})

test('measured yield counts one population: the engine credits itself only for what it reached', () => {
  const node: NodeRef = { id: 'ent_x', kind: 'account', value: 'x.example/y', label: 'x' }
  const at = '2026-09-03T00:00:00.000Z'
  const decisions = Array.from({ length: 2 }, (_, i) => ({
    id: `d${i}`,
    caseId: 'c',
    kind: 'ran' as const,
    at,
    reason: 'fixture',
    node,
    adapterId: 'profile-enrich',
    gain: 50
  }))

  // A corroborated candidate that the operator's own manual sweeps produced. It has no hop,
  // because only the engine writes hops — and it must therefore contribute nothing. The old
  // arithmetic counted it, so five manual sherlock runs and two engine runs measured 1.5
  // useful per run and called that "measured in this case".
  const manual = candidateWith(['github.com', 'keybase.io'])
  const byHand = new YieldTable({ decisions, candidates: [manual], hops: [] })
  const hand = byHand.estimate('profile-enrich', 'account')
  assert.equal(hand.value, 0, 'a lead the engine never reached must not be credited to the engine')
  assert.ok(
    hand.detail.includes('by hand'),
    `the estimate has to name the population it is over: ${hand.detail}`
  )

  // The same candidate, this time reached by an engine hop. Now it counts, and it counts for
  // the adapter named on the hop.
  // `from` is the node the run was pointed at, and its kind is the one the denominator
  // counts. A hop keyed on what was *found* instead would divide leads of one kind by runs
  // against another and call the quotient a measurement.
  const hop: ProvenanceHop = {
    id: 'h1',
    caseId: 'c',
    to: node,
    from: { id: 'ent_seed', kind: 'account', value: 'seed.example/s', label: 's' },
    mechanism: 'profile-field',
    findingId: 'f0',
    tool: 'profile-enrich',
    source: 'github.com',
    detail: 'fixture',
    at
  }
  const reached = new YieldTable({ decisions, candidates: [manual], hops: [hop] })
  assert.ok(reached.estimate('profile-enrich', 'account').value > 0, 'a lead the engine reached is its own yield')
  assert.equal(
    reached.estimate('profile-enrich', 'username').basis,
    'prior',
    'the credit belongs to the kind the run was pointed at, and nowhere else'
  )

  // A single declared link is a permission, not a result. Crediting it let profile-enrich
  // score itself on having read a page — every URL in every bio counted as a useful lead.
  const single = { ...candidateWith(['github.com']), id: node.id }
  const declaredHop: ProvenanceHop = { ...hop, mechanism: 'declared-link' }
  const declared = new YieldTable({ decisions, candidates: [single], hops: [declaredHop] })
  assert.equal(
    declared.estimate('profile-enrich', 'account').value,
    0,
    'one declared link is one source; it earns yield when the far end agrees, not before'
  )
  const answered = new YieldTable({
    decisions,
    candidates: [single],
    hops: [declaredHop],
    reciprocal: new Map([[node.id, ['mid.example']]])
  })
  assert.ok(
    answered.estimate('profile-enrich', 'account').value > 0,
    'a link the far end sent back is a second source, and that is a useful lead'
  )
})

/* ------------------------------------------------------------------ *
 * 6a. A refused run is not a finished one
 * ------------------------------------------------------------------ */

test('a tool that was blocked leaves the node unread, and the planner still ranks reading it', () => {
  const ref: NodeRef = { id: 'ent_x', kind: 'account', value: 'x.example/y', label: 'x.example/y' }
  const at = '2026-09-03T00:00:00.000Z'
  const graph = new ProvenanceGraph(
    [{ id: 'h0', caseId: 'c', to: ref, from: null, mechanism: 'seed', findingId: null, tool: null, source: null, detail: 'seeded', at }],
    [],
    { seeds: new Set([ref.id]), anchors: new Set([ref.id]), inGraph: new Set([ref.id]) }
  )
  const reader: AdapterInfo = {
    id: 'profile-enrich',
    title: 'Profile enrichment',
    version: '1',
    accepts: ['account'],
    produces: ['person'],
    requiresKey: false,
    requiresNetwork: true,
    doc: doc(),
    secretOptions: [],
    proposes: true,
    concurrency: 1,
    minIntervalMs: 0,
    defaultTimeoutMs: 1000,
    available: true,
    unavailableReason: null
  }
  const finding = (source: string, claim: string): Finding => ({
    id: `f_${source}`,
    caseId: 'c',
    entityId: ref.id,
    source,
    tool: 'profile-enrich',
    claim,
    confidence: 'unverified',
    evidenceRef: null,
    firstSeen: at,
    lastVerified: null,
    raw: { rawId: 'r', path: 'p', sha256: 's', bytes: 0, mediaType: 'text/plain', excerpt: '' }
  })
  const plan = (findings: Finding[]) =>
    planActions({
      caseId: 'c',
      entities: [
        {
          id: ref.id,
          caseId: 'c',
          kind: 'account',
          value: ref.value,
          label: ref.label,
          createdAt: at,
          seed: true,
          attrs: { platform: 'x.example', handle: 'y' }
        }
      ],
      candidates: [],
      findings,
      adapters: [reader],
      graph,
      yields: new YieldTable({ decisions: [], candidates: [], hops: [] }),
      budget: DEFAULT_BUDGET,
      bands: new Map(),
      alreadyRun: new Set(),
      dispositions: new Map(),
      contradictedBranches: new Set(),
      at
    })

  // `parse()` runs on failed runs now, so a blocked tool always leaves a `local:<adapter>`
  // record. Read as "profile-enrich has been over this node", it silently withdraws the
  // planner's second-largest positive — the app stops wanting to read a page *because*
  // reading it was refused, which is blocked-as-absent one level up.
  const refused = plan([finding('local:profile-enrich', 'Cloudflare served a challenge; nothing was read about this account.')])
  const onRefused = refused.actions.find((a) => a.node.id === ref.id)
  assert.ok(onRefused, 'a refused run must not take the node off the plan')
  assert.ok(
    onRefused.signals.some((sig) => sig.id === 'unenriched'),
    'a page nobody could read is still a page nobody has read'
  )
  assert.ok(
    !onRefused.signals.some((sig) => sig.id === 'never-probed'),
    'but something *was* pointed at it, and claiming otherwise would over-rank a node the app already bounced off'
  )

  // A run that actually answered does withdraw it, which is the signal working.
  const answered = plan([finding('x.example', 'x.example shows the display name "Y".')])
  const onAnswered = answered.actions.find((a) => a.node.id === ref.id)
  assert.ok(
    !onAnswered?.signals.some((sig) => sig.id === 'unenriched'),
    'once a source has answered about the node, the page has been read'
  )
})

/* ------------------------------------------------------------------ *
 * 6b. Evidence gathered after a disposition changes it
 * ------------------------------------------------------------------ */

/**
 * A lead two sources agree on, whose profile turns out to belong to somebody else.
 *
 * The seeded subject reads as masculine; the profile the engine opens states an
 * unmistakably feminine Bulgarian name. On the findings table that row already ranked
 * `contradicted`. The candidate did not move: its band was computed from the claims that
 * *proposed* it, all of which were written before anything had opened it, so the engine
 * expanded the lead, wrote the contradiction into the case, and carried on down the branch.
 */
const CONTRADICTED_AFTER: Record<string, Emission[]> = {
  [SEED]: [
    {
      source: 'github.example',
      claim: `The profile for quillferndev names ${MID}.`,
      proposal: { kind: 'account', value: MID, rationale: 'Named on the profile.' }
    },
    {
      source: 'other.example',
      claim: `A second site also names ${MID}.`,
      proposal: { kind: 'account', value: MID, rationale: 'Named again, by a different site.' }
    }
  ],
  [MID]: [
    {
      source: 'mid.example',
      claim: 'mid.example shows the display name "Мария Иванова".'
    }
  ]
}

test('a lead the engine reads and finds is somebody else is parked, with the reason recorded', async () => {
  const service = await OsintService.create(await scratch('engine-revise'))
  ensure(service, chainAdapter('t-revise', CONTRADICTED_AFTER))
  const c = await service.createCase({ name: 'Revise', basis: 'training' })
  await service.addEntity({ caseId: c.id, kind: 'account', value: SEED, seed: true })
  // The seeds the contradiction is measured against: a masculine personal name.
  await service.addEntity({ caseId: c.id, kind: 'person', value: 'Георги Илиянов', seed: true })
  const engine = new InvestigationEngine(service)

  await engine.start({ caseId: c.id, adapterIds: ['t-revise'], budget: { maxRuns: 6, maxWallClockMs: 60_000 } })
    .whenFinished

  const brief = await engine.brief(c.id)
  assert.ok(
    brief.contradicted.some((i) => i.node.value === MID),
    'a node whose own profile names a different person belongs under Contradicted, not Established'
  )
  assert.ok(
    !brief.established.some((i) => i.node.value === MID),
    'two sources agreeing on a handle does not survive reading the profile behind it'
  )

  const decisions = await engine.decisions(c.id)
  const parked = decisions.find((d) => d.kind === 'parked' && d.node?.value === MID)
  assert.ok(parked, 'the change of mind has to be in the engine log, not applied silently')
  assert.ok(
    parked.reason.includes('reading it'),
    `the reason has to say what changed: ${parked?.reason}`
  )
  assert.equal((await service.listEntities(c.id)).length, 2, 're-scoring is not promotion either')
  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * 7. The brief
 * ------------------------------------------------------------------ */

test('the brief separates established from pending from contradicted, and asks few questions', async () => {
  const { service, engine, caseId } = await seededService('engine-brief')
  await engine.start({ caseId, adapterIds: ONLY, budget: { maxRuns: 8, maxWallClockMs: 60_000 } }).whenFinished
  const brief = await engine.brief(caseId)

  assert.equal(brief.neverRun, false)
  assert.ok(brief.headline.trim().length > 0)
  assert.ok(brief.established.length > 0, 'the seed and its corroborated link should be established')
  assert.ok(brief.questions.length <= 3, 'the brief must not turn back into a review queue')
  assert.ok(brief.questionsTotal >= brief.questions.length)
  assert.ok(brief.chains.length > 0)
  assert.ok(
    brief.next.every((a) => a.reason.trim().length > 0),
    'the brief has to say why the engine wants to do what it wants to do'
  )
  for (const q of brief.questions) {
    assert.ok(q.question.endsWith('?'), `not a question: ${q.question}`)
    assert.ok(q.why.trim().length > 0)
    assert.ok(q.route.length > 0, 'a question about a lead has to show the route that reached it')
  }
  await service.dispose()
})

test('a case the engine has never touched gets a brief that explains itself rather than an empty one', async () => {
  const { service, engine, caseId } = await seededService('engine-brief-empty')
  const brief = await engine.brief(caseId)
  assert.equal(brief.neverRun, true)
  assert.ok(brief.headline.includes('has not run'))
  assert.equal(brief.questions.length, 0)
  await service.dispose()
})

/* ------------------------------------------------------------------ *
 * Fixtures for the unit tests
 * ------------------------------------------------------------------ */

function candidateWith(sources: string[], matcher?: 'weak'): CandidateView {
  return {
    id: 'ent_x',
    caseId: 'c',
    kind: 'account',
    value: 'x.example/y',
    label: 'x.example/y',
    attrs: {},
    proposals: sources.map((s, i) => ({
      findingId: `f${i}`,
      tool: `t${i}`,
      source: s,
      rationale: 'fixture',
      at: '2026-09-03T00:00:00.000Z'
    })),
    state: 'pending',
    firstProposedAt: '2026-09-03T00:00:00.000Z',
    decidedAt: null,
    bestConfidence: 'unverified',
    independentSources: sources.length,
    claims: sources.map((s, i) => ({
      findingId: `f${i}`,
      claim: 'fixture claim',
      confidence: 'unverified' as const,
      source: s,
      tool: `t${i}`,
      ...(matcher === 'weak'
        ? {
            matcher: {
              strength: 'weak' as const,
              label: 'weak matcher',
              why: 'The request does not name the handle.',
              reasons: ['no handle in the request URL']
            }
          }
        : {})
    }))
  }
}

function candidateNamed(node: NodeRef): CandidateView {
  return {
    id: node.id,
    caseId: 'c',
    kind: node.kind,
    value: node.value,
    label: node.label,
    attrs: {},
    proposals: [{ findingId: `f_${node.id}`, tool: 't', source: 'x.example', rationale: 'fixture', at: '2026-09-03T00:00:00.000Z' }],
    state: 'pending',
    firstProposedAt: '2026-09-03T00:00:00.000Z',
    decidedAt: null,
    bestConfidence: 'unverified',
    independentSources: 1,
    claims: [{ findingId: `f_${node.id}`, claim: 'fixture claim', confidence: 'unverified', source: 'x.example', tool: 't' }]
  }
}

/** Referenced so the planner import is exercised directly as well as through the engine. */
export const _planActions = planActions

/**
 * The export.
 *
 * Every assertion here is pointed at a way the document could lie to the person it is
 * handed to, and they are ordered by how badly a reader would be misled:
 *
 *  1. **A run that failed is a gap, never a question nobody asked.** The orchestrator
 *     returns before `parse()` whenever a run did not succeed, so a killed tool writes zero
 *     findings. Enumerating runs through findings therefore makes every failure invisible —
 *     and an invisible tool is then filed under a heading that says in as many words that
 *     it is *not* a gap. The capture is on disk either way, so the folder is the
 *     enumeration.
 *  2. **Nothing manufactures corroboration.** A `local:` note is this program describing its
 *     own run; it may never be one of the two independent sources. A substring collision in
 *     a hostname or a URL path may never become "you published this link yourself".
 *  3. **The top rung stays with the human.** Two hostnames agreeing is `corroborated` and
 *     says so; only a person who opened the page produces `confirmed`.
 *  4. **A ceiling on what is read off a row.** An identity line cannot be worth more than
 *     the accounts that published it, and advice is written only from rows that earned one.
 *  5. **Both formats say the same thing**, and neither hides what it left out.
 *
 * The fixtures are built through the real `CaseStore`, so the shapes are the shapes the app
 * writes: raw captures go through `writeRaw`, findings through `upsertFinding`, and the
 * failure captures are the orchestrator's own wrapper, byte for byte.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CaseStore } from '../src/main/store/caseStore'
import {
  buildExportBundle,
  renderHtml,
  renderMarkdown,
  writeExport,
  ExportPathError,
  type Band,
  type ExportBundle
} from '../src/main/export'
import type { CandidateProposal, EntityCandidate, RawPayload } from '../src/shared/types'

export interface ExportTest {
  name: string
  fn: () => void | Promise<void>
}

export const exportTests: ExportTest[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  exportTests.push({ name, fn })
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function scratch(prefix: string): Promise<string> {
  const base = path.join(process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test'), prefix)
  await fsp.mkdir(base, { recursive: true })
  return fsp.mkdtemp(path.join(base, `${os.EOL === '\n' ? 'run-' : 'run-'}`))
}

/** A successful run: the envelope itself, exactly as the orchestrator writes it verbatim. */
function envelope(adapter: string, target: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      adapter,
      adapterVersion: '1.0.0',
      entityId: 'ent_0',
      entityKind: 'username',
      target,
      startedAt: '2026-09-01T10:00:00.000Z',
      finishedAt: '2026-09-01T10:00:01.000Z',
      durationMs: 1000,
      command: null,
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      spawnError: null,
      stdout: '',
      stderr: '',
      artifacts: {},
      notes: [],
      ...extra
    },
    null,
    2
  )
}

/**
 * A run that did not succeed, in the orchestrator's own wrapper shape.
 *
 * Copied from `orchestrator.ts`'s persist block rather than invented: this is the exact
 * document a timed-out or cancelled run leaves behind, and the point of the test is that
 * the export can read it.
 */
function failureWrapper(adapterId: string, opts: { timedOut?: boolean; error: string; stderr?: string }): string {
  return JSON.stringify(
    {
      adapterId,
      caseId: 'c',
      entityId: 'ent_0',
      ok: false,
      exitCode: null,
      signal: opts.timedOut === true ? 'SIGKILL' : null,
      timedOut: opts.timedOut === true,
      truncated: false,
      command: null,
      error: opts.error,
      startedAt: '2026-09-01T10:00:00.000Z',
      finishedAt: '2026-09-01T10:02:00.000Z',
      durationMs: 120000,
      stdout: '',
      stderr: opts.stderr ?? ''
    },
    null,
    2
  )
}

interface ProfileSeed {
  platform: string
  handle: string
  ids: Record<string, unknown>
}

interface AvatarSeed {
  key: string
  platform: string
  handle: string
  sha256: string
  dhash: string
  phash: string
}

/** A `profile-enrich` capture, in the shape `readCapture` reads back. */
function enrichEnvelope(profiles: readonly ProfileSeed[], avatars: readonly AvatarSeed[]): string {
  return envelope('profile-enrich', 'alexdemo', {
    artifacts: {
      '_harvest.json': JSON.stringify({
        entries: profiles.map((p) => ({
          site: p.platform,
          url: `https://${p.platform}/${p.handle}`,
          username: p.handle,
          ids: p.ids,
          capture: 'raw/x.json'
        })),
        capturesRead: 1,
        capturesSkipped: []
      }),
      '_fetches.json': '[]',
      '_avatars.json': JSON.stringify(
        avatars.map((a) => ({
          key: a.key,
          platform: a.platform,
          handle: a.handle,
          url: `https://${a.platform}/avatar/${a.handle}.png`,
          isDefault: false,
          status: 200,
          mediaType: 'image/png',
          bytes: 128,
          sha256: a.sha256,
          hash: { dhash: a.dhash, phash: a.phash },
          reason: null,
          base64: null
        }))
      )
    }
  })
}

interface Fixture {
  store: CaseStore
  caseId: string
  bundle: ExportBundle
}

function candidate(input: {
  caseId: string
  value: string
  proposals: CandidateProposal[]
  state: EntityCandidate['state']
}): EntityCandidate {
  const [platform, handle] = [input.value.slice(0, input.value.indexOf('/')), input.value.slice(input.value.indexOf('/') + 1)]
  return {
    id: `cand_${input.value}`,
    caseId: input.caseId,
    kind: 'account',
    value: input.value,
    label: input.value,
    attrs: { platform, handle, url: `https://${platform}/${handle}` },
    proposals: input.proposals,
    state: input.state,
    firstProposedAt: '2026-09-01T10:00:00.000Z',
    decidedAt: input.state === 'pending' ? null : '2026-09-01T11:00:00.000Z'
  }
}

/**
 * The case every soundness test below is pointed at.
 *
 * It is deliberately built out of the situations the audit found: a refusal note beside a
 * real probe, two genuinely different sites, a weak matcher, a dismissed row whose avatar
 * is shared with a live one, a timed-out run, a cancelled run, and a run that finished and
 * found nothing.
 */
async function fixture(basis: 'consent' | 'self' | 'training' = 'consent'): Promise<Fixture> {
  const root = await scratch('export')
  const store = new CaseStore(path.join(root, 'cases'))
  await store.ensureRoot()
  const file = await store.createCase({
    name: 'Export fixture',
    basis,
    subjectConsent: basis === 'consent' ? true : undefined
  })
  const caseId = file.id

  await store.upsertEntity(caseId, { kind: 'username', value: 'alexdemo', seed: true })
  await store.upsertEntity(caseId, { kind: 'email', value: 'alex@demo.example', seed: true })

  /* ---- captures ---- */

  const sherlockRaw = await store.writeRaw(caseId, envelope('sherlock', 'alexdemo'), { mediaType: 'application/json' })
  // Deliberately another sherlock run rather than a second tool: `blackbird` is the control
  // for "never asked" below and must have neither a capture nor a finding anywhere.
  const twoRaw = await store.writeRaw(caseId, envelope('sherlock', 'alexdemo'), { mediaType: 'application/json' })

  // A run killed at its deadline. Zero findings, capture on disk. The whole of S1.
  await store.writeRaw(caseId, failureWrapper('holehe', { timedOut: true, error: 'Hit its deadline after 120s.' }), {
    mediaType: 'application/json'
  })
  // A run the operator cancelled.
  await store.writeRaw(caseId, failureWrapper('maigret', { error: 'Cancelled.' }), { mediaType: 'application/json' })
  // A run that finished, reported no error, and found nothing. A result, not a gap.
  await store.writeRaw(caseId, envelope('wayback', 'alexdemo'), { mediaType: 'application/json' })

  await store.writeRaw(
    caseId,
    enrichEnvelope(
      [
        { platform: 'alpha.example', handle: 'alexdemo', ids: { fullname: 'Alex Demo', location: 'Sofia', email: 'alex@demo.example' } },
        { platform: 'beta.example', handle: 'alexdemo', ids: { fullname: 'Alex Demo', location: 'Sofia' } }
      ],
      [
        {
          key: 'alpha.example/alexdemo',
          platform: 'alpha.example',
          handle: 'alexdemo',
          sha256: 'a'.repeat(64),
          dhash: '0f0f0f0f0f0f0f0f',
          phash: '1e1e1e1e1e1e1e1e'
        },
        {
          key: 'gone.example/alexdemo',
          platform: 'gone.example',
          handle: 'alexdemo',
          sha256: 'a'.repeat(64),
          dhash: '0f0f0f0f0f0f0f0f',
          phash: '1e1e1e1e1e1e1e1e'
        }
      ]
    ),
    { mediaType: 'application/json' }
  )

  /* ---- findings ---- */

  const add = async (input: {
    source: string
    tool: string
    claim: string
    raw: RawPayload
    matcher?: { strength: 'weak' | 'moderate' | 'strong'; label: string; why: string } | null
  }): Promise<string> => {
    const { finding } = await store.upsertFinding(caseId, {
      entityId: 'ent_subject',
      source: input.source,
      tool: input.tool,
      claim: input.claim,
      raw: input.raw,
      matcher: (input.matcher ?? null) as never
    })
    return finding.id
  }

  const probe = await add({
    source: 'alpha.example',
    tool: 'sherlock',
    claim: 'The handle "alexdemo" is taken on alpha.example.',
    raw: sherlockRaw
  })
  const refusal = await add({
    source: 'local:profile-enrich',
    tool: 'profile-enrich',
    claim: 'alpha.example answered HTTP 403. That is a refusal aimed at an unauthenticated client.',
    raw: sherlockRaw
  })
  const plain = await add({
    source: 'beta.example',
    tool: 'sherlock',
    claim: 'The handle "alexdemo" is taken on beta.example.',
    raw: sherlockRaw
  })
  const weak = await add({
    source: 'weak.example',
    tool: 'sherlock',
    claim: 'The handle "alexdemo" is taken on weak.example.',
    raw: sherlockRaw,
    matcher: { strength: 'weak', label: 'weak probe', why: 'The request it made did not mention the username.' }
  })
  const dismissedFinding = await add({
    source: 'gone.example',
    tool: 'sherlock',
    claim: 'The handle "alexdemo" is taken on gone.example.',
    raw: sherlockRaw
  })
  const twoA = await add({
    source: 'two.example',
    tool: 'sherlock',
    claim: 'The handle "alexdemo" is taken on two.example.',
    raw: twoRaw
  })
  const twoB = await add({
    source: 'other.example',
    tool: 'sherlock',
    claim: 'other.example lists an account for "alexdemo" on two.example.',
    raw: twoRaw
  })

  const proposal = (findingId: string, tool: string, source: string): CandidateProposal => ({
    findingId,
    tool,
    source,
    rationale: 'The site answered as though the account exists.',
    at: '2026-09-01T10:00:00.000Z'
  })

  const candidates: EntityCandidate[] = [
    candidate({
      caseId,
      value: 'alpha.example/alexdemo',
      state: 'pending',
      proposals: [proposal(probe, 'sherlock', 'alpha.example'), proposal(refusal, 'profile-enrich', 'local:profile-enrich')]
    }),
    candidate({ caseId, value: 'beta.example/alexdemo', state: 'pending', proposals: [proposal(plain, 'sherlock', 'beta.example')] }),
    candidate({ caseId, value: 'weak.example/alexdemo', state: 'pending', proposals: [proposal(weak, 'sherlock', 'weak.example')] }),
    candidate({
      caseId,
      value: 'gone.example/alexdemo',
      state: 'dismissed',
      proposals: [proposal(dismissedFinding, 'sherlock', 'gone.example')]
    }),
    candidate({
      caseId,
      value: 'two.example/alexdemo',
      state: 'pending',
      proposals: [proposal(twoA, 'sherlock', 'two.example'), proposal(twoB, 'blackbird', 'other.example')]
    })
  ]
  await fsp.writeFile(
    path.join(store.dir(caseId), 'candidates.jsonl'),
    candidates.map((c) => JSON.stringify(c)).join('\n') + '\n',
    'utf8'
  )

  const bundle = await buildExportBundle({ store, caseId, lang: 'en', subjectName: 'Alex', now: () => '2026-09-03T00:00:00.000Z' })
  return { store, caseId, bundle }
}

function row(bundle: ExportBundle, key: string): { band: Band; why: string[]; independentSources: number; sources: string[] } {
  const found = bundle.accounts.find((a) => a.key === key)
  assert.ok(found, `no row for ${key}; rows are ${bundle.accounts.map((a) => a.key).join(', ')}`)
  return found
}

/* ------------------------------------------------------------------ *
 * 1. A failed run is a gap, not a question nobody asked
 * ------------------------------------------------------------------ */

test('a run killed at its deadline is reported as a gap, and never as "never asked"', async () => {
  const { bundle } = await fixture()

  const timedOut = bundle.unchecked.find((u) => u.tool === 'holehe')
  assert.ok(timedOut, `holehe should be under "could not be checked"; got ${JSON.stringify(bundle.unchecked)}`)
  assert.match(timedOut.detail, /deadline/i, 'the reason has to say what happened to it')

  assert.equal(
    bundle.notAsked.some((n) => n.tool === 'holehe'),
    false,
    'a tool with a capture on disk was asked; filing it under "questions nobody put" is the inversion this section exists to prevent'
  )

  // The control: a tool that genuinely never ran, for a seed kind it accepts.
  assert.ok(
    bundle.notAsked.some((n) => n.tool === 'blackbird'),
    'blackbird accepts a username and an email, has no capture, and belongs in "never asked"'
  )
})

test('a cancelled run is also visible, and its tool is not listed as never asked', async () => {
  const { bundle } = await fixture()
  assert.ok(
    bundle.unchecked.some((u) => u.tool === 'maigret'),
    'a cancelled run concluded nothing and has to say so'
  )
  assert.equal(bundle.notAsked.some((n) => n.tool === 'maigret'), false)
})

test('Markdown does not claim every check answered when one was killed', async () => {
  const { bundle } = await fixture()
  const text = renderMarkdown(bundle, { lang: 'en', includeNoise: true })
  assert.equal(text.includes('_Every check that ran produced an answer._'), false)
  assert.match(text, /## Could not be checked[\s\S]*holehe/)
})

test('a clean negative is a result, not a gap', async () => {
  const { bundle } = await fixture()
  assert.ok(
    bundle.answeredNothing.some((u) => u.tool === 'wayback'),
    'a run that finished, errored on nothing and found nothing belongs in its own list'
  )
  assert.equal(
    bundle.unchecked.some((u) => u.outcome === 'answered-none'),
    false,
    '"answered — nothing there" under a heading captioned "everything here is a gap" is the self-audit bug the export inherited'
  )
})

/* ------------------------------------------------------------------ *
 * 2. Nothing manufactures corroboration
 * ------------------------------------------------------------------ */

test('a local: source never corroborates, anywhere', async () => {
  const { bundle } = await fixture()

  const alpha = row(bundle, 'alpha.example/alexdemo')
  assert.equal(alpha.independentSources, 1, 'one real probe plus one refusal note is one source')
  assert.deepEqual(alpha.sources, ['alpha.example'])
  assert.notEqual(alpha.band, 'corroborated')
  assert.notEqual(alpha.band, 'confirmed')

  for (const a of bundle.accounts) {
    for (const s of a.sources) {
      assert.equal(s.startsWith('local:'), false, `${a.key} counted ${s} as an independent source`)
      assert.equal(s.startsWith('file:'), false, `${a.key} counted ${s} as an independent source`)
    }
  }
  for (const i of bundle.identity) {
    for (const s of i.sources) assert.equal(s.startsWith('local:'), false)
  }
})

test('the refusal is still shown — it is just not counted', async () => {
  const { bundle } = await fixture()
  const alpha = row(bundle, 'alpha.example/alexdemo')
  assert.ok(
    alpha.why.some((w) => /not counted/i.test(w)),
    'the reader has to be able to see that something was excluded and why'
  )
})

test('a hostname suffix and a path substring do not publish a link', async () => {
  const root = await scratch('export-links')
  const store = new CaseStore(path.join(root, 'cases'))
  await store.ensureRoot()
  const file = await store.createCase({ name: 'Links', basis: 'training' })
  const caseId = file.id
  await store.upsertEntity(caseId, { kind: 'username', value: 'bob', seed: true })

  await store.writeRaw(
    caseId,
    enrichEnvelope(
      [
        {
          platform: 'gamma.example',
          handle: 'bob',
          ids: {
            fullname: 'Bob',
            // Both of these matched under the old rule: `notdelta.example` ends with
            // `delta.example`, and `/bobby` contains `bob`.
            website: 'https://delta.example/bobby',
            blog: 'https://notdelta.example/bob',
            external_url: 'https://epsilon.example/bob'
          }
        }
      ],
      []
    ),
    { mediaType: 'application/json' }
  )

  const raw = await store.writeRaw(caseId, envelope('sherlock', 'bob'), { mediaType: 'application/json' })
  const mk = async (source: string): Promise<string> =>
    (
      await store.upsertFinding(caseId, {
        entityId: 'ent_subject',
        source,
        tool: 'sherlock',
        claim: `The handle "bob" is taken on ${source}.`,
        raw
      })
    ).finding.id

  const delta = await mk('delta.example')
  const notdelta = await mk('notdelta.example')
  const epsilon = await mk('epsilon.example')
  const p = (id: string, source: string): CandidateProposal => ({
    findingId: id,
    tool: 'sherlock',
    source,
    rationale: 'The site answered as though the account exists.',
    at: '2026-09-01T10:00:00.000Z'
  })
  const candidates = [
    candidate({ caseId, value: 'delta.example/bob', state: 'pending', proposals: [p(delta, 'delta.example')] }),
    candidate({ caseId, value: 'notdelta.example/bob', state: 'pending', proposals: [p(notdelta, 'notdelta.example')] }),
    candidate({ caseId, value: 'epsilon.example/bob', state: 'pending', proposals: [p(epsilon, 'epsilon.example')] })
  ]
  await fsp.writeFile(
    path.join(store.dir(caseId), 'candidates.jsonl'),
    candidates.map((c) => JSON.stringify(c)).join('\n') + '\n',
    'utf8'
  )

  const bundle = await buildExportBundle({ store, caseId, lang: 'en', now: () => '2026-09-03T00:00:00.000Z' })

  // Neither of gamma's first two links names `delta.example/bob`, and under the old rule
  // both did: `notdelta.example`.endsWith(`delta.example`) and `/bobby`.includes(`bob`).
  const deltaRow = row(bundle, 'delta.example/bob')
  assert.equal(deltaRow.band, 'unverified', 'neither /bobby nor notdelta.example names delta.example/bob')
  assert.equal(
    deltaRow.why.some((w) => /links to this one/i.test(w)),
    false,
    'the document’s strongest sentence must not come out of a substring collision'
  )

  // The controls: the matcher still fires when a link really does name the account, on the
  // exact host and on a whole path segment.
  for (const key of ['notdelta.example/bob', 'epsilon.example/bob']) {
    const r = row(bundle, key)
    assert.equal(r.band, 'probable', `${key} is named by a link gamma published`)
    assert.ok(r.why.some((w) => /links to this one/i.test(w)))
  }
})

test('a profile-only row does not inherit a finding that merely shares its hostname', async () => {
  const root = await scratch('export-host')
  const store = new CaseStore(path.join(root, 'cases'))
  await store.ensureRoot()
  const file = await store.createCase({ name: 'Host', basis: 'training' })
  const caseId = file.id
  await store.upsertEntity(caseId, { kind: 'username', value: 'someone', seed: true })

  // A profile read off an enrichment capture, for an account nothing proposed.
  await store.writeRaw(
    caseId,
    enrichEnvelope([{ platform: 'zeta.example', handle: 'someone', ids: { fullname: 'Someone' } }], []),
    { mediaType: 'application/json' }
  )
  const raw = await store.writeRaw(caseId, envelope('sherlock', 'other'), { mediaType: 'application/json' })
  // A finding about a completely different account on the same host.
  await store.upsertFinding(caseId, {
    entityId: 'ent_someone_else',
    source: 'zeta.example',
    tool: 'sherlock',
    claim: 'The handle "someoneelse" is taken on zeta.example.',
    raw
  })

  const bundle = await buildExportBundle({ store, caseId, lang: 'en', now: () => '2026-09-03T00:00:00.000Z' })
  const zeta = row(bundle, 'zeta.example/someone')
  assert.deepEqual(zeta.sources, [], 'a finding about another account on the same site is not evidence about this one')
})

/* ------------------------------------------------------------------ *
 * 3. The top rung stays with the human
 * ------------------------------------------------------------------ */

test('two hostnames agreeing is corroborated, never confirmed, and says which it is', async () => {
  const { bundle } = await fixture()
  const two = row(bundle, 'two.example/alexdemo')
  assert.equal(two.band, 'corroborated')
  assert.ok(two.why.some((w) => /two machines agreeing/i.test(w)))

  assert.equal(
    bundle.accounts.some((a) => a.band === 'confirmed'),
    false,
    'nothing in this case was checked by a human, so nothing may be labelled as though it was'
  )

  const html = renderHtml(bundle, { lang: 'en', includeNoise: true })
  assert.ok(html.includes('band--corroborated'), 'the corroborated band has to render as itself')
  assert.equal(
    html.includes('opened and checked by hand'),
    false,
    'the confirmed wording must not be reachable by machine agreement'
  )
})

test('an unverified row never renders with confirmed markup', async () => {
  const { bundle } = await fixture()
  const html = renderHtml(bundle, { lang: 'en', includeNoise: true })

  for (const a of bundle.accounts.filter((x) => x.band === 'unverified')) {
    const card = html.slice(html.indexOf(`>${a.handle}<`) - 1200, html.indexOf(`>${a.handle}<`) + 400)
    assert.equal(card.includes('band--confirmed'), false, `${a.key} rendered inside confirmed markup`)
    assert.equal(card.includes('Definitely you'), false, `${a.key} rendered with the confirmed label`)
  }
})

/* ------------------------------------------------------------------ *
 * 4. A ceiling on what is read off a row
 * ------------------------------------------------------------------ */

test('an identity line cannot outrank the accounts that published it', async () => {
  const { bundle } = await fixture()
  const name = bundle.identity.find((i) => i.kind === 'name' && i.value === 'Alex Demo')
  assert.ok(name, 'the display name should be folded into one identity line')
  assert.equal(name.sources.length, 2, 'two different sites published it')
  assert.equal(name.backing, 'unverified', 'both of those accounts are unverified')
  assert.equal(
    name.band,
    'unverified',
    'two unverified handle collisions printing the same name is one guess made twice, not a confirmed fact'
  )

  for (const i of bundle.identity) {
    assert.ok(
      BAND_RANK[i.band] >= BAND_RANK[i.backing],
      `${i.kind} "${i.value}" is banded ${i.band} above its strongest backing row (${i.backing})`
    )
  }
})

const BAND_RANK: Record<Band, number> = { confirmed: 0, corroborated: 1, probable: 2, unverified: 3, noise: 4 }

test('advice is never written from an unverified row', async () => {
  const { bundle } = await fixture()
  const actions = bundle.advice.map((a) => a.action).join('\n')
  assert.equal(
    actions.includes('alex@demo.example'),
    false,
    'an address published only by unverified rows may belong to a stranger; telling the reader to strip it is an instruction about somebody else'
  )
  assert.equal(actions.includes('Sofia'), false, 'same rule for a location field')
})

test("a dismissed row's picture does not promote a live one", async () => {
  const { bundle } = await fixture()
  const alpha = row(bundle, 'alpha.example/alexdemo')
  assert.equal(alpha.band, 'unverified', 'the only other account with this picture was thrown away')
  assert.ok(bundle.accounts.find((a) => a.key === 'alpha.example/alexdemo')?.sharesPictureWith.length === 0)
  assert.equal(
    bundle.advice.some((a) => /share one/.test(a.action)),
    false,
    'a group whose only other member was dismissed is not two of your accounts sharing a picture'
  )
})

test('one site serving one image to two of its own accounts is not two sites agreeing', async () => {
  const root = await scratch('export-samesite')
  const store = new CaseStore(path.join(root, 'cases'))
  await store.ensureRoot()
  const file = await store.createCase({ name: 'Same site', basis: 'training' })
  const caseId = file.id
  await store.upsertEntity(caseId, { kind: 'username', value: 'sam', seed: true })

  const shot = (key: string, platform: string, handle: string, digest: string): AvatarSeed => ({
    key,
    platform,
    handle,
    sha256: digest.repeat(64).slice(0, 64),
    dhash: '3c3c3c3c3c3c3c3c',
    phash: '5a5a5a5a5a5a5a5a'
  })

  await store.writeRaw(
    caseId,
    enrichEnvelope(
      [
        { platform: 'one.example', handle: 'sam', ids: { fullname: 'Sam' } },
        { platform: 'one.example', handle: 'sam2', ids: { fullname: 'Sam' } },
        { platform: 'two.example', handle: 'sam', ids: { fullname: 'Sam' } },
        { platform: 'three.example', handle: 'sam', ids: { fullname: 'Sam' } }
      ],
      [
        // Same site, same picture: the shape of an undetected platform default.
        shot('one.example/sam', 'one.example', 'sam', 'b'),
        shot('one.example/sam2', 'one.example', 'sam2', 'b'),
        // Two different sites, same picture: the real signal.
        { ...shot('two.example/sam', 'two.example', 'sam', 'c'), dhash: '7e7e7e7e7e7e7e7e', phash: '2121212121212121' },
        { ...shot('three.example/sam', 'three.example', 'sam', 'c'), dhash: '7e7e7e7e7e7e7e7e', phash: '2121212121212121' }
      ]
    ),
    { mediaType: 'application/json' }
  )

  const bundle = await buildExportBundle({ store, caseId, lang: 'en', now: () => '2026-09-03T00:00:00.000Z' })

  const same = row(bundle, 'one.example/sam')
  assert.equal(same.band, 'unverified', 'a second account on the same site is not a second site')
  assert.ok(same.why.some((w) => /same website twice/i.test(w)), 'and the row has to say why it is weaker')

  assert.equal(row(bundle, 'two.example/sam').band, 'probable', 'two different sites serving one photograph is the real signal')

  const pictureAdvice = bundle.advice.filter((a) => /share one/.test(a.action))
  assert.equal(pictureAdvice.length, 1, 'only the cross-site group earns the advice')
  assert.ok(pictureAdvice[0].because.includes('two.example/sam'))
  assert.equal(pictureAdvice[0].because.includes('one.example/sam2'), false)
})

test('a picture group is captioned with the band of its weakest member', async () => {
  const { bundle } = await fixture()
  assert.equal(bundle.gallery.groups.length, 1, 'the fixture has exactly one shared picture')
  const html = renderHtml(bundle, { lang: 'en', includeNoise: true })
  const start = html.indexOf('class="card band band--')
  const section = html.slice(html.indexOf('Your pictures'))
  assert.ok(start >= 0)
  assert.equal(
    section.includes('<div class="card band band--confirmed">'),
    false,
    'every picture in the gallery used to be drawn in the heaviest band regardless of the row it came off'
  )
  assert.ok(section.includes('band--noise'), 'a group containing a dismissed account is a set-aside group')
})

/* ------------------------------------------------------------------ *
 * 5. Both formats say the same thing, and neither hides what it left out
 * ------------------------------------------------------------------ */

test('turning the noise section off still discloses how much was withheld', async () => {
  const { bundle } = await fixture()
  const withheld = bundle.accounts.filter((a) => a.band === 'noise').length
  assert.ok(withheld > 0, 'the fixture must have something to withhold')

  const html = renderHtml(bundle, { lang: 'en', includeNoise: false })
  assert.match(html, new RegExp(`${withheld} entr(y|ies)`), 'HTML must state the count it left out')

  const text = renderMarkdown(bundle, { lang: 'en', includeNoise: false })
  assert.match(text, new RegExp(`${withheld} set aside as noise`))
})

test('HTML and Markdown agree about the same case', async () => {
  const { bundle } = await fixture()
  const html = renderHtml(bundle, { lang: 'en', includeNoise: true })
  const text = renderMarkdown(bundle, { lang: 'en', includeNoise: true })

  for (const a of bundle.accounts) {
    assert.ok(html.includes(a.handle), `${a.key} missing from the HTML`)
    assert.ok(text.includes(a.handle), `${a.key} missing from the Markdown`)
    assert.ok(html.includes(a.platform), `${a.platform} missing from the HTML`)
    assert.ok(text.includes(a.platform), `${a.platform} missing from the Markdown`)
  }

  // The counts the two documents print have to be the same counts.
  assert.match(text, new RegExp(`${bundle.counts.corroborated} Corroborated`))
  assert.ok(html.includes(`Two sites agree — ${bundle.counts.corroborated}`))

  for (const u of bundle.unchecked) {
    assert.ok(html.includes(u.tool), `${u.tool} missing from the HTML gap list`)
    assert.ok(text.includes(u.tool), `${u.tool} missing from the Markdown gap list`)
  }
})

test('an empty gallery says nobody looked, in both formats', async () => {
  const root = await scratch('export-empty')
  const store = new CaseStore(path.join(root, 'cases'))
  await store.ensureRoot()
  const file = await store.createCase({ name: 'Empty', basis: 'training' })
  await store.upsertEntity(file.id, { kind: 'username', value: 'nobody', seed: true })

  const bundle = await buildExportBundle({ store, caseId: file.id, lang: 'en', now: () => '2026-09-03T00:00:00.000Z' })
  assert.match(bundle.gallery.note, /no picture has been fetched/i)

  const html = renderHtml(bundle, { lang: 'en', includeNoise: true })
  const text = renderMarkdown(bundle, { lang: 'en', includeNoise: true })
  assert.ok(html.includes('No profile has been enriched'), 'HTML never read the gallery note, so an empty gallery read as "no pictures exist"')
  assert.ok(text.includes('No profile has been enriched'))
})

/* ------------------------------------------------------------------ *
 * 6. What the document says about itself
 * ------------------------------------------------------------------ */

test('the non-publication line follows the basis, in both formats', async () => {
  const self = await fixture('self')
  assert.equal(self.bundle.publishable, false)
  assert.ok(renderHtml(self.bundle, { lang: 'en', includeNoise: true }).includes('not a document to publish'))
  assert.ok(renderMarkdown(self.bundle, { lang: 'en', includeNoise: true }).includes('not a document to publish'))

  const training = await fixture('training')
  assert.equal(training.bundle.publishable, true)
  assert.equal(
    renderHtml(training.bundle, { lang: 'en', includeNoise: true }).includes('not a document to publish'),
    false,
    'a training case is publishable; printing the sentence unconditionally makes it false'
  )
  assert.equal(
    renderMarkdown(training.bundle, { lang: 'en', includeNoise: true }).includes('not a document to publish'),
    false
  )
})

test('the headline count is backed by material the document actually shows', async () => {
  const { bundle } = await fixture()
  const shown = new Set(bundle.accounts.flatMap((a) => a.sources))
  assert.equal(bundle.counts.sources, shown.size)
  // Anything left over is named rather than folded into the headline.
  if (bundle.other.findings > 0) {
    const html = renderHtml(bundle, { lang: 'en', includeNoise: true })
    assert.ok(html.includes('Everything else this case holds'))
  }
})

test('an export refuses to write outside the case folder', async () => {
  const { store, caseId } = await fixture()
  await assert.rejects(
    () =>
      writeExport(store, {
        caseId,
        format: 'markdown',
        lang: 'en',
        outPath: path.join(os.tmpdir(), '..', 'osint-export-escape.md')
      }),
    (err: unknown) => err instanceof ExportPathError,
    'renderer-supplied text reaching writeFile with no confinement is the whole of R1'
  )

  const ok = await writeExport(store, { caseId, format: 'markdown', lang: 'en' })
  assert.ok(ok.path.startsWith(store.dir(caseId)), 'the default still lands beside the case')
  assert.ok(ok.bytes > 0)
})

test('a hostile bio cannot execute, and the redaction survives all of this', async () => {
  const root = await scratch('export-escape')
  const store = new CaseStore(path.join(root, 'cases'))
  await store.ensureRoot()
  const file = await store.createCase({ name: 'Escaping', basis: 'training' })
  await store.upsertEntity(file.id, { kind: 'username', value: 'victim', seed: true })
  await store.writeRaw(
    file.id,
    enrichEnvelope(
      [
        {
          platform: 'hostile.example',
          handle: 'victim',
          ids: {
            fullname: '<script>alert(1)</script>',
            bio: '"><img src=x onerror=alert(2)>',
            website: 'javascript:alert(3)'
          }
        }
      ],
      []
    ),
    { mediaType: 'application/json' }
  )

  const bundle = await buildExportBundle({ store, caseId: file.id, lang: 'en', now: () => '2026-09-03T00:00:00.000Z' })
  const html = renderHtml(bundle, { lang: 'en', includeNoise: true })
  // The tags are what must not survive; the words inside them are inert text once escaped.
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.equal(html.includes('<img src=x'), false)
  assert.equal(/<[a-z]+[^>]*onerror=/i.test(html), false, 'no element in the document carries an event handler')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'))
})

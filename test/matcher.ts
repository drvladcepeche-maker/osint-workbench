/**
 * Tests for the matcher-quality classifier.
 *
 * The thing under test is a judgement about a *probe*, not about a person, and the whole
 * value of it is that the judgement is legible: a badge nobody trusts is worse than no
 * badge, so every case here checks the sentence as well as the verdict.
 *
 * **Nothing here depends on `<toolkitRoot>` existing.** The catalogue entries are
 * built in memory from the shapes the real dataset actually contains — `Codeberg`'s
 * `/api/v1/users/{account}`, `Pikabu`'s `https://pikabu.ru/ajax.php`, `Roblox`'s
 * `?username={account}` — so the classifier is pinned to real structures without the suite
 * needing a hand-assembled toolbelt. One test does read the real file, and skips cleanly
 * when it is not there.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import os from 'node:os'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  buildWmnIndex,
  classifyWmnSite,
  emptyWmnIndex,
  isWeakProbe,
  loadWmnSites,
  matcherFor,
  readWmnTranscript,
  resetWmnCache,
  transcribeWmnIndex,
  UNKNOWN_MATCHER_LABEL,
  type WmnSiteRecord
} from '../src/main/adapters/support/matcher'
import { localSource } from '../src/main/adapters/support/sources'
import { CaseStore } from '../src/main/store/caseStore'
import { listFindings, openDatabase, rebuildIndex } from '../src/main/db'
import type { MatcherQuality } from '../src/shared/types'

type TestFn = (name: string, fn: () => void | Promise<void>) => void

/* ------------------------------------------------------------------ *
 * Catalogue fixtures, all copied from real WhatsMyName entries
 * ------------------------------------------------------------------ */

function record(over: Partial<WmnSiteRecord>): WmnSiteRecord {
  return { name: 'Example', uriCheck: '', uriPretty: '', eCode: 0, hasEString: false, protection: [], ...over }
}

/** Real entry: a user API, a status code and a marker inside the returned user object. */
const CODEBERG = record({
  name: 'Codeberg',
  uriCheck: 'https://codeberg.org/api/v1/users/{account}',
  uriPretty: 'https://codeberg.org/{account}',
  eCode: 200,
  hasEString: true
})

/** Real entry: the probed URL is a generic AJAX endpoint with no handle anywhere in it. */
const PIKABU = record({
  name: 'Pikabu',
  uriCheck: 'https://pikabu.ru/ajax.php',
  uriPretty: 'https://pikabu.ru/@{account}',
  eCode: 200,
  hasEString: true,
  protection: ['ddos-guard']
})

/** Real entry shape: a per-user page, behind an interception layer. */
const CHESS = record({
  name: 'Chess.com',
  uriCheck: 'https://www.chess.com/member/{account}',
  eCode: 200,
  hasEString: true,
  protection: ['cloudflare']
})

/** Real entry: the handle is a query parameter on a shared validation endpoint. */
const ROBLOX = record({
  name: 'Roblox',
  uriCheck: 'https://auth.roblox.com/v1/usernames/validate?username={account}&birthday=2019-12-31T23:00:00.000Z',
  uriPretty: 'https://www.roblox.com/search/users?keyword={account}',
  eCode: 200,
  hasEString: true
})

/** Real entry: `api.github.com`, flagged `user-agent`, which is a header requirement not a challenge. */
const GITHUB = record({
  name: 'GitHub (User)',
  uriCheck: 'https://api.github.com/users/{account}',
  uriPretty: 'https://github.com/{account}',
  eCode: 200,
  hasEString: true,
  protection: ['user-agent']
})

/** Real entry shape: a per-user page decided on the status code alone. */
const OSU = record({ name: 'osu!', uriCheck: 'https://osu.ppy.sh/users/{account}', eCode: 302 })

const CATALOGUE = [CODEBERG, PIKABU, CHESS, ROBLOX, GITHUB, OSU]

function tmpdir(prefix: string): Promise<string> {
  const base = path.join(process.env.OSINT_TEST_TMP ?? path.join(process.cwd(), '.tmp-test'), prefix)
  return fsp.mkdir(base, { recursive: true }).then(() => fsp.mkdtemp(path.join(base, 'run-')))
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

export function matcherTests(test: TestFn): void {
  test('a user API with a status code and a body marker is the strongest thing this class of tool has', () => {
    const q = classifyWmnSite(CODEBERG)
    assert.equal(q.strength, 'strong')
    assert.equal(q.label, 'strong matcher')
    assert.ok(/api/i.test(q.why), `the API mechanism must be named: ${q.why}`)
    assert.ok(/status code/i.test(q.why) && /(marker|user record)/i.test(q.why), q.why)
    assert.ok(
      q.reasons.some((r) => r.includes('/api/v1/users/{account}')),
      `the reasons must quote the actual probe URL: ${q.reasons.join(' | ')}`
    )
    assert.ok(q.reasons.some((r) => /HTTP 200/.test(r)))
    // A rendered page that requires both signals is strong too, just for a different reason.
    const page = classifyWmnSite(record({ name: 'Gitee', uriCheck: 'https://gitee.com/{account}', eCode: 200, hasEString: true }))
    assert.equal(page.strength, 'strong')
    assert.ok(/soft-404|two independent/i.test(page.why), page.why)
  })

  test('a probe URL with no handle in it is weak, and the sentence says the URL names no user', () => {
    const q = classifyWmnSite(PIKABU)
    assert.equal(q.strength, 'weak')
    assert.equal(q.label, 'weak matcher')
    assert.ok(/does not name a user/i.test(q.why), `the why must say the URL contains no user: ${q.why}`)
    assert.ok(/shared endpoint/i.test(q.why), q.why)
    assert.ok(
      q.reasons.some((r) => r.includes('https://pikabu.ru/ajax.php') && r.includes('{account}')),
      `the reasons must show the URL and the missing placeholder: ${q.reasons.join(' | ')}`
    )
    // Pikabu is behind ddos-guard as well, but the URL is the more fundamental defect and
    // is the sentence the operator needs; the protection is still recorded as a reason.
    assert.ok(q.reasons.some((r) => /ddos-guard/.test(r)))
    // And the pretty URL must not be mistaken for the probed one.
    assert.ok(q.reasons.some((r) => /only as the address to show a human/i.test(r)), q.reasons.join(' | '))
  })

  test('an interception layer makes a per-user URL weak anyway', () => {
    const q = classifyWmnSite(CHESS)
    assert.equal(q.strength, 'weak')
    assert.ok(/cloudflare/i.test(q.why), q.why)
    assert.ok(/200/.test(q.why), 'the why must name the mechanism: a challenge answering 200')
    // The URL itself is fine, and the reasons must still say so rather than hiding it.
    assert.ok(q.reasons.some((r) => /part of the requested address/i.test(r)), q.reasons.join(' | '))

    // `user-agent` is a header requirement, not an interceptor: it must NOT demote a probe,
    // or `api.github.com/users/{account}` would come out weak and the badge would be noise.
    const github = classifyWmnSite(GITHUB)
    assert.equal(github.strength, 'strong')
    assert.ok(github.reasons.some((r) => /user-agent/.test(r)), 'the flag must still be shown as a reason')
  })

  test('a handle in the query string is not a handle in the path', () => {
    const q = classifyWmnSite(ROBLOX)
    assert.equal(q.strength, 'weak')
    assert.ok(/query parameter/i.test(q.why), q.why)
    assert.ok(!/does not name a user/i.test(q.why), 'a query-string lookup is a different defect from a nameless URL')
    assert.ok(q.reasons.some((r) => /only as a query parameter/i.test(r)), q.reasons.join(' | '))
  })

  test('one signal instead of two is moderate, and the sentence says which signal is missing', () => {
    const q = classifyWmnSite(OSU)
    assert.equal(q.strength, 'moderate')
    assert.equal(q.label, 'moderate matcher')
    assert.ok(/only thing it reads is the status code/i.test(q.why), q.why)
    assert.ok(/302/.test(q.why), 'the code that would be read as an account must be in the sentence')

    const bodyOnly = classifyWmnSite(record({ name: 'Marker only', uriCheck: 'https://example.com/{account}', hasEString: true }))
    assert.equal(bodyOnly.strength, 'moderate')
    assert.ok(/string in the page body/i.test(bodyOnly.why), bodyOnly.why)

    // Neither signal is not "moderate but less so" — there is nothing to match on at all.
    const neither = classifyWmnSite(record({ name: 'Nothing', uriCheck: 'https://example.com/{account}' }))
    assert.equal(neither.strength, 'weak')
    assert.ok(/neither a status code nor a body marker/i.test(neither.why), neither.why)
  })

  test('a site the dataset does not describe reads as unknown, and unknown is not an accusation', () => {
    const index = buildWmnIndex(CATALOGUE, 'test://catalogue')
    const q = matcherFor(index, { site: 'Wickedly Obscure Forum', url: 'https://wickedly-obscure.example/u/exampleuser' })
    assert.ok(q, 'an unrecognised site must still produce a verdict rather than nothing')
    assert.equal(q.label, UNKNOWN_MATCHER_LABEL)
    assert.equal(q.strength, 'weak', 'unknown sits at the bottom, because assuming otherwise is the unrecoverable error')
    assert.ok(/not in the local WhatsMyName dataset/i.test(q.why), q.why)
    assert.ok(/not.*evidence either way/i.test(q.why), `the why must refuse to read as a criticism of the hit: ${q.why}`)
    // And it must not be written into a claim as though the probe were bad.
    assert.equal(isWeakProbe(q), false)
    assert.equal(isWeakProbe(classifyWmnSite(PIKABU)), true)
  })

  test('a missing dataset is an absent classification, never an exception', () => {
    resetWmnCache()
    const missing = loadWmnSites(path.join(os.tmpdir(), 'no', 'such', 'toolkit', 'root'))
    assert.equal(missing.sites.length, 0)
    assert.equal(missing.sourcePath, '')
    // And an empty index still answers, in words, rather than throwing or returning null.
    const q = matcherFor(missing, { site: 'GitHub', url: 'https://github.com/torvalds' })
    assert.equal(q?.label, UNKNOWN_MATCHER_LABEL)
    assert.ok(/No WhatsMyName dataset was available/i.test(q?.reasons.join(' ') ?? ''), q?.reasons.join(' | '))
    // Garbage on the way in is the same story.
    assert.equal(loadWmnSites('').sites.length, 0)
    assert.equal(readWmnTranscript('not json at all').sites.length, 0)
    assert.equal(readWmnTranscript(null).sites.length, 0)
    assert.equal(readWmnTranscript('{"rows":"not an array"}').sites.length, 0)
    resetWmnCache()
  })

  test('a derived claim gets no matcher at all, because it probed nothing', () => {
    const index = buildWmnIndex(CATALOGUE)
    assert.equal(matcherFor(index, { site: localSource('maigret') }), null)
    assert.equal(matcherFor(index, { site: 'file:IMG_0042.jpg' }), null)
    assert.equal(matcherFor(index, {}), null)
    assert.equal(matcherFor(index, { site: '', url: '' }), null)
  })

  test('all three tools name one site differently and still reach the same catalogue entry', () => {
    const index = buildWmnIndex(CATALOGUE)
    const found = [
      matcherFor(index, { site: 'GitHub', url: 'https://github.com/torvalds' }),
      matcherFor(index, { site: 'GitHub', url: 'https://www.github.com/torvalds' }),
      matcherFor(index, { site: 'GitHub (User)', url: 'https://api.github.com/users/torvalds' })
    ]
    for (const q of found) {
      assert.equal(q?.strength, 'strong')
      assert.ok(q?.reasons.some((r) => r.includes('GitHub (User)')), q?.reasons.join(' | '))
    }
    // The name alone is enough when the tool reports no URL.
    assert.equal(matcherFor(index, { site: 'Chess.com' })?.strength, 'weak')
  })

  test('the transcription survives the envelope round trip unchanged', () => {
    const index = buildWmnIndex(CATALOGUE, '<toolkitRoot>\\data\\wmn-data.json')
    const recovered = readWmnTranscript(transcribeWmnIndex(index))
    assert.deepEqual(recovered.sites, index.sites)
    assert.equal(recovered.sourcePath, index.sourcePath)
    for (const site of CATALOGUE) {
      assert.deepEqual(classifyWmnSite(site), classifyWmnSite(recovered.sites.find((s) => s.name === site.name) as WmnSiteRecord))
    }
    assert.equal(readWmnTranscript(transcribeWmnIndex(emptyWmnIndex())).sites.length, 0)
  })

  test('a matcher survives the file, the rebuild and the read back, unchanged', async () => {
    const dir = await tmpdir('matcher')
    const store = new CaseStore(path.join(dir, 'cases'))
    await store.ensureRoot()
    const c = await store.createCase({ name: 'Matcher round trip', basis: 'training' })
    const entity = await store.upsertEntity(c.id, { kind: 'username', value: 'exampleuser', seed: true })
    const raw = await store.writeRaw(c.id, JSON.stringify({ hit: true }), { mediaType: 'application/json' })

    const withMatcher = await store.upsertFinding(c.id, {
      entityId: entity.id,
      source: 'pikabu.ru',
      tool: 'maigret',
      claim: 'Maigret reports that an account named "exampleuser" exists on Pikabu.',
      raw
    })
    const plain = await store.upsertFinding(c.id, {
      entityId: entity.id,
      source: localSource('maigret'),
      tool: 'maigret',
      claim: 'Maigret probed 716 sites for the username "exampleuser".',
      raw
    })
    const matcher: MatcherQuality = classifyWmnSite(PIKABU)
    await store.replaceFinding(c.id, { ...withMatcher.finding, matcher })

    const db = openDatabase(path.join(dir, 'data', 'index.db'))
    const stats = await rebuildIndex(db, store)
    assert.equal(stats.findings, 2)

    const rows = listFindings(db, c.id)
    const back = rows.find((f) => f.id === withMatcher.finding.id)
    assert.deepEqual(back?.matcher, matcher, 'the whole object must come back byte-for-byte, reasons included')
    assert.equal(back?.id, withMatcher.finding.id, 'the matcher is not part of the id')

    // A finding that never had one must come back without the key at all, not with an
    // undefined one — the index is supposed to reproduce the file, not decorate it.
    const untouched = rows.find((f) => f.id === plain.finding.id)
    assert.ok(untouched)
    assert.equal('matcher' in untouched, false)
    db.close()
  })

  test('the real WhatsMyName dataset classifies the two entries this feature was built for', () => {
    resetWmnCache()
    const index = loadWmnSites('<toolkitRoot>')
    if (!index.sites.length) {
      // The toolbelt is hand-assembled and this suite must run on a machine without it.
      assert.ok(!existsSync(path.join(os.tmpdir(), 'no-such-toolkit', 'data', 'wmn-data.json')))
      return
    }
    assert.ok(index.sites.length > 500, `expected the full catalogue, got ${index.sites.length}`)

    const pikabu = matcherFor(index, { site: 'Pikabu', url: 'https://pikabu.ru/@exampleuser' })
    assert.equal(pikabu?.strength, 'weak', 'the entry that started this: a hit on a generic AJAX endpoint')
    assert.ok(/does not name a user/i.test(pikabu?.why ?? ''), pikabu?.why)

    for (const site of ['Codeberg', 'Gitea', 'Gitee']) {
      const q = matcherFor(index, { site })
      assert.equal(q?.strength, 'strong', `${site} should be as good as this class of tool gets`)
    }
    // The whole catalogue must classify without a single throw.
    for (const site of index.sites) {
      const q = classifyWmnSite(site)
      assert.ok(q.why.length > 40, `${site.name} produced a why too short to teach anything`)
      assert.ok(q.reasons.length > 0, `${site.name} produced no reasons`)
    }
    resetWmnCache()
  })
}

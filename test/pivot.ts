/**
 * Pivot search tests.
 *
 * Two things are being defended here, and they pull in opposite directions.
 *
 * **Precision.** Every pointer this extracts becomes a row the operator has to read and
 * decide about, and his complaint about that screen is already that there is too much of
 * it. So most of these tests are about what must *not* become a candidate: a link to a
 * page on a website, a directory URL, a Discord invite code, a YouTube channel id, a
 * display name that is simply somebody's first name. Every one of those was a real
 * candidate produced by the first version of this code on real captured output, and the
 * comments say which.
 *
 * **Honesty about what did not fire.** The other half asserts that a signal which could
 * not be evaluated is reported as unevaluated rather than as absent — a default avatar
 * matching a default avatar, a profile that could not be read, a JPEG in a process with no
 * decoder. A self-audit that renders "could not check" as "nothing there" gives false
 * comfort, which is worse than giving none.
 *
 * The maigret fixture is the real Phase 0 capture for `torvalds`; everything else is
 * synthetic, built here, and marked as such. No network, no personal data.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { pivotAdapter } from '../src/main/adapters/pivot'
import type { RunEnvelope } from '../src/main/adapters/support/envelope'
import type { RawResult } from '../src/main/adapters/types'
import {
  accountFromUrl,
  handlesAreVariants,
  pointersFrom,
  profilesFrom,
  sharedBioPhrase,
  type ObservedProfile
} from '../src/main/adapters/support/profiles'
import { hashImage } from '../src/main/adapters/support/image'
import type { PivotAssessment } from '../src/shared/pivot'

export function pivotTests(test: (name: string, fn: () => void | Promise<void>) => void): void {
  /* ---------------------------------------------------------------- URLs */

  test('pivot: a profile URL yields its handle, and a page URL yields nothing', () => {
    assert.deepEqual(accountFromUrl('https://github.com/torvalds'), {
      platform: 'github.com',
      handle: 'torvalds'
    })
    assert.deepEqual(accountFromUrl('https://www.twitch.tv/somestreamer'), {
      platform: 'twitch.tv',
      handle: 'somestreamer'
    })
    assert.deepEqual(accountFromUrl('https://www.youtube.com/@SomeChannel'), {
      platform: 'youtube.com',
      handle: 'SomeChannel'
    })
    assert.deepEqual(accountFromUrl('https://www.reddit.com/user/someone/'), {
      platform: 'reddit.com',
      handle: 'someone'
    })

    // Found by running this against a live capture: a SlideShare profile links to
    // http://www.nasa.gov/connect, and `connect` became a candidate account. It is a page.
    assert.equal(accountFromUrl('http://www.nasa.gov/connect'), null)
    // Also from a live capture: a link to the Stack Overflow user *directory*.
    assert.equal(accountFromUrl('https://stackoverflow.com/users'), null)
    // An invite code is not a person.
    assert.equal(accountFromUrl('https://discord.gg/AbCdEf12'), null)
    // An opaque channel id is not a handle anybody uses.
    assert.equal(accountFromUrl('https://www.youtube.com/channel/UCd3pOLbUrJ4qK_UwDL0ln4w'), null)
    assert.equal(accountFromUrl('https://github.com/about'), null)
    assert.equal(accountFromUrl('not a url at all'), null)
  })

  /* ------------------------------------------------------------ pointers */

  test('pivot: a profile names other handles through links, mentions and published ids', () => {
    const profile = makeProfile({
      platform: 'twitter.com',
      handle: 'primary',
      bio: 'streams at https://www.twitch.tv/secondhandle — also @third_handle on the other one',
      links: ['https://github.com/fourth-handle'],
      namedHandles: ['fifth_handle']
    })
    const pointers = pointersFrom(profile)
    const handles = pointers.map((p) => p.handle).sort()
    assert.deepEqual(handles, ['fifth_handle', 'fourth-handle', 'secondhandle', 'third_handle'])

    const twitch = pointers.find((p) => p.handle === 'secondhandle')!
    assert.equal(twitch.platform, 'twitch.tv')
    assert.equal(twitch.explicitLink, true, 'a URL the subject wrote is an assertion, not a guess')

    const mention = pointers.find((p) => p.handle === 'third_handle')!
    assert.equal(mention.explicitLink, false)
  })

  test('pivot: a display name is only a pointer when it is shaped like a handle', () => {
    // Both of these are real: a Substack profile with the handle `torvalds` shows the
    // display name "Nicolas", and a Dailymotion one shows "RCL". Different people who
    // happen to share a handle. Neither may become a candidate.
    for (const displayName of ['Nicolas', 'RCL', 'Torvalds']) {
      const pointers = pointersFrom(makeProfile({ handle: 'primary', displayName }))
      assert.deepEqual(pointers, [], `"${displayName}" is a name, not a handle`)
    }
    // A separator or a digit is what distinguishes a handle from a name.
    const real = pointersFrom(makeProfile({ handle: 'primary', displayName: 'some_handle99' }))
    assert.equal(real.length, 1)
    assert.equal(real[0]!.handle, 'some_handle99')
  })

  test('pivot: a profile never points at itself', () => {
    const pointers = pointersFrom(
      makeProfile({ handle: 'sameone', bio: 'find me at https://github.com/sameone', displayName: 'same_one' })
    )
    assert.deepEqual(pointers.map((p) => p.handle), [])
  })

  /* ----------------------------------------------------------- bio text */

  test('pivot: a shared bio phrase counts only when it is distinctive', () => {
    assert.equal(
      sharedBioPhrase('opinions are my own', 'opinions are my own, obviously'),
      null,
      'a bio cliche shared by millions of people is not evidence'
    )
    assert.equal(sharedBioPhrase('and the for you', 'and the for you'), null, 'stopwords only')
    assert.equal(sharedBioPhrase(null, 'anything'), null)
    assert.equal(sharedBioPhrase('too short', 'too short'), null, 'under the length floor')

    const phrase = sharedBioPhrase(
      'I collect antique barometers and repair mechanical calculators',
      'repair mechanical calculators, mostly Curta. also antique barometers'
    )
    assert.ok(phrase, 'a specific phrase in both bios must be found')
    assert.ok(phrase!.length >= 16, `the phrase must clear the rarity floor, got ${phrase!.length}`)
  })

  test('pivot: handle variants are recognised without matching everything', () => {
    assert.equal(handlesAreVariants('somehandle', 'some_handle'), true)
    assert.equal(handlesAreVariants('somehandle', 'somehandle_dev'), true)
    assert.equal(handlesAreVariants('somehandle', 'entirelyother'), false)
    assert.equal(handlesAreVariants('ab', 'abc'), false, 'short handles collide by accident')
  })

  /* ------------------------------------------------- reading real output */

  test('pivot: the real maigret capture reconstructs its profiles', () => {
    const report = fs.readFileSync(
      path.join(process.cwd(), 'test', 'fixtures', 'adapters', 'maigret-report.json'),
      'utf8'
    )
    const profiles = profilesFrom(
      envelope('maigret', { artifacts: { 'report_torvalds_simple.json': report } })
    )
    assert.ok(profiles.length >= 10, `expected the claimed sites, got ${profiles.length}`)
    assert.ok(
      profiles.some((p) => p.platform === 'github.com' && p.displayName === 'Linus Torvalds'),
      'the GitHub display name must survive the round trip'
    )
    assert.ok(
      profiles.some((p) => p.avatarUrl?.startsWith('https://avatars.githubusercontent.com/')),
      'the avatar URL must survive the round trip'
    )
    assert.ok(
      profiles.some((p) => p.location === 'Portland, OR'),
      'the profile location must survive the round trip'
    )
    // Every handle in this capture is a spelling of the one that was searched, so the
    // capture yields no pivots at all. That is the correct answer and it is worth pinning:
    // maigret run without extraction returns no bios and no links.
    const pointers = profiles.flatMap((p) => pointersFrom(p))
    assert.deepEqual(pointers, [], 'a non-extracting maigret capture names no other handles')
  })

  /* ------------------------------------------------------------- scoring */

  test('pivot: a reciprocal link is decisive, an outbound link is not', () => {
    const raw = pivotRun({
      profiles: [
        makeProfile({
          platform: 'github.com',
          handle: 'primary',
          url: 'https://github.com/primary',
          links: ['https://www.twitch.tv/otherone'],
          aboutHandle: 'primary'
        }),
        makeProfile({
          platform: 'twitch.tv',
          handle: 'otherone',
          url: 'https://twitch.tv/otherone',
          links: ['https://github.com/primary'],
          aboutHandle: 'otherone'
        })
      ],
      knownHandles: ['primary']
    })
    const a = assessmentFor(raw, 'twitch.tv/otherone')
    assert.equal(a.band, 'asserted')
    assert.ok(a.signals.some((s) => s.id === 'reciprocal-link'))

    const oneWay = pivotRun({
      profiles: [
        makeProfile({
          platform: 'github.com',
          handle: 'primary',
          url: 'https://github.com/primary',
          links: ['https://www.twitch.tv/otherone'],
          aboutHandle: 'primary'
        })
      ],
      knownHandles: ['primary']
    })
    const b = assessmentFor(oneWay, 'twitch.tv/otherone')
    assert.equal(b.band, 'moderate')
    assert.ok(b.signals.some((s) => s.id === 'outbound-link'))
    assert.ok(
      b.unevaluated.some((g) => g.id === 'reciprocal-link'),
      'an unreadable profile is reported as unchecked, never as a profile that did not link back'
    )
  })

  test('pivot: two accounts wearing the same picture score on it', () => {
    const big = pngHash(64)
    const small = pngHash(32)
    const raw = pivotRun({
      profiles: [
        makeProfile({
          platform: 'github.com',
          handle: 'primary',
          url: 'https://github.com/primary',
          links: ['https://www.twitch.tv/otherone'],
          avatarUrl: 'https://cdn.example.com/a.png',
          aboutHandle: 'primary'
        }),
        makeProfile({
          platform: 'twitch.tv',
          handle: 'otherone',
          avatarUrl: 'https://cdn.example.com/b.png',
          aboutHandle: 'otherone'
        })
      ],
      knownHandles: ['primary'],
      avatars: {
        'https://cdn.example.com/a.png': { sha256: 'aa', ...big, reason: null, handles: ['primary'] },
        'https://cdn.example.com/b.png': { sha256: 'bb', ...small, reason: null, handles: ['otherone'] }
      }
    })
    const a = assessmentFor(raw, 'twitch.tv/otherone')
    assert.ok(
      a.signals.some((s) => s.id === 'avatar-hash'),
      `the same picture at two sizes must match; signals were ${JSON.stringify(a.signals)}`
    )
    assert.equal(a.band, 'strong')
  })

  test('pivot: a platform default avatar is dropped rather than counted as a match', () => {
    const shared = pngHash(64)
    const raw = pivotRun({
      profiles: [
        makeProfile({
          platform: 'github.com',
          handle: 'primary',
          url: 'https://github.com/primary',
          links: ['https://www.twitch.tv/otherone'],
          avatarUrl: 'https://cdn.example.com/default_avatar.png',
          aboutHandle: 'primary'
        }),
        makeProfile({
          platform: 'twitch.tv',
          handle: 'otherone',
          avatarUrl: 'https://cdn.example.com/default_avatar.png',
          aboutHandle: 'otherone'
        })
      ],
      knownHandles: ['primary'],
      avatars: {
        'https://cdn.example.com/default_avatar.png': {
          sha256: 'cc',
          ...shared,
          reason: null,
          handles: ['primary', 'otherone', 'somebodyelse']
        }
      },
      defaultHashes: [shared.phash!]
    })
    const a = assessmentFor(raw, 'twitch.tv/otherone')
    assert.ok(
      !a.signals.some((s) => s.id === 'avatar-hash' || s.id === 'avatar-bytes'),
      'a default matching a default is the strongest signal firing on nothing'
    )
    assert.ok(a.unevaluated.some((g) => g.why.includes('platform default')))
  })

  test('pivot: a handle collision with nothing behind it scores zero and says so', () => {
    const raw = pivotRun({
      profiles: [
        makeProfile({
          platform: 'github.com',
          handle: 'primary',
          namedHandles: ['unrelated_one'],
          aboutHandle: 'primary'
        })
      ],
      knownHandles: ['primary']
    })
    const a = assessmentFor(raw, 'unrelated_one')
    assert.equal(a.score, 0)
    assert.equal(a.band, 'handle-only')
    assert.deepEqual(a.signals, [])
  })

  test('pivot: nothing above the hop cap is reported', () => {
    const profiles = [
      makeProfile({ platform: 'github.com', handle: 'primary', namedHandles: ['hop_one'], aboutHandle: 'primary' }),
      makeProfile({ platform: 'github.com', handle: 'hop_one', namedHandles: ['hop_two'], aboutHandle: 'hop_one' }),
      makeProfile({ platform: 'github.com', handle: 'hop_two', namedHandles: ['hop_three'], aboutHandle: 'hop_two' })
    ]
    const two = pivotRun({ profiles, knownHandles: ['primary'], maxHops: 2 })
    const reached = pivotAdapter
      .propose!(two)
      .map((p) => p.value)
    assert.ok(reached.includes('hop_one'), 'hop one is always reported')
    assert.ok(reached.includes('hop_two'), 'hop two is reported at the default cap')
    assert.ok(!reached.includes('hop_three'), 'hop three is where this explodes; it must be cut')

    const one = pivotRun({ profiles, knownHandles: ['primary'], maxHops: 1 })
    const shallow = pivotAdapter.propose!(one).map((p) => p.value)
    assert.deepEqual(shallow.filter((v) => v.startsWith('hop_')), ['hop_one'])
  })

  test('pivot: every proposal cites a finding this run produced, and none is an entity', () => {
    const raw = pivotRun({
      profiles: [
        makeProfile({
          platform: 'github.com',
          handle: 'primary',
          url: 'https://github.com/primary',
          links: ['https://www.twitch.tv/otherone'],
          aboutHandle: 'primary'
        })
      ],
      knownHandles: ['primary']
    })
    const findings = pivotAdapter.parse(raw)
    const proposals = pivotAdapter.propose!(raw)
    assert.ok(proposals.length > 0)
    const ids = new Set(findings.map((f) => f.id))
    for (const p of proposals) {
      assert.ok(ids.has(p.fromFindingId), 'a candidate without visible evidence cannot be reviewed')
      assert.ok(p.rationale.trim().length > 0)
    }
    // The observation is attributed to the site that carried the pointer; the judgement is
    // `local:` so analysis can never corroborate itself.
    assert.ok(findings.some((f) => f.source === 'github.com'))
    assert.ok(findings.some((f) => f.source === 'local:pivot'))
    for (const f of findings) assert.equal(f.confidence, 'unverified')
  })

  test('pivot: a malformed capture produces nothing rather than throwing', () => {
    for (const body of ['', 'not json', '{}', '{"artifacts":{"pivot.json":"["}}']) {
      const raw = rawResult('pivot', body)
      assert.deepEqual(pivotAdapter.parse(raw), [])
      assert.deepEqual(pivotAdapter.propose!(raw), [])
    }
  })
}

/* ------------------------------------------------------------------ *
 * Building the inputs
 * ------------------------------------------------------------------ */

function makeProfile(over: Partial<ObservedProfile>): ObservedProfile {
  const handle = over.handle ?? 'primary'
  const platform = over.platform ?? 'example.com'
  return {
    key: `${platform}/${handle.toLowerCase()}`,
    platform,
    handle,
    url: null,
    displayName: null,
    bio: null,
    avatarUrl: null,
    links: [],
    namedHandles: [],
    location: null,
    tool: 'maigret',
    aboutHandle: handle,
    ...over,
    // `key` has to follow whatever the overrides settled on.
    ...(over.platform || over.handle
      ? { key: `${over.platform ?? platform}/${(over.handle ?? handle).toLowerCase()}` }
      : {})
  }
}

interface PivotRunInput {
  profiles: ObservedProfile[]
  knownHandles: string[]
  maxHops?: number
  avatars?: Record<string, { sha256: string | null; dhash: string | null; phash: string | null; reason: string | null; handles: string[] }>
  defaultHashes?: string[]
  seededNames?: string[]
  seededCities?: string[]
}

/**
 * The capture a real run would have written, built by hand.
 *
 * `parse()` is pure and reads nothing but this, which is the property that makes a scoring
 * change a re-parse rather than a re-crawl — and it is what lets every scoring test here
 * run with no network, no filesystem and no tool.
 */
function pivotRun(input: PivotRunInput): RawResult {
  const hops: Record<string, number> = {}
  for (const h of input.knownHandles) hops[h.toLowerCase()] = 0
  const maxHops = input.maxHops ?? 2
  // The same fixed-point walk `run()` does, so the transcript is shaped like a real one.
  for (let hop = 0; hop < maxHops; hop++) {
    for (const profile of input.profiles) {
      if ((hops[profile.aboutHandle.toLowerCase()] ?? -1) !== hop) continue
      for (const pointer of pointersFrom(profile)) {
        const lower = pointer.handle.toLowerCase()
        if (hops[lower] === undefined) hops[lower] = hop + 1
      }
    }
  }

  const known = new Set(input.knownHandles.map((h) => h.toLowerCase()))
  const pivots: unknown[] = []
  for (const profile of input.profiles) {
    const hop = hops[profile.aboutHandle.toLowerCase()]
    if (hop === undefined || hop >= maxHops) continue
    for (const pointer of pointersFrom(profile)) {
      const lower = pointer.handle.toLowerCase()
      if (known.has(lower)) continue
      pivots.push({
        handle: pointer.handle,
        platform: pointer.platform,
        url: pointer.url,
        via: pointer.via,
        explicitLink: pointer.explicitLink,
        hops: hop + 1,
        from: profile.key,
        fromSource: profile.platform,
        targets: input.profiles.filter((p) => p.handle.toLowerCase() === lower)
      })
    }
  }

  const transcript = {
    maxHops,
    knownHandles: input.knownHandles.map((h) => h.toLowerCase()),
    seededNames: input.seededNames ?? [],
    seededCities: input.seededCities ?? [],
    profiles: input.profiles,
    hops,
    pivots,
    avatars: input.avatars ?? {},
    defaultHashes: input.defaultHashes ?? [],
    capturesRead: 1,
    capturesSkipped: [],
    fetched: 0,
    fetchNotes: []
  }
  return rawResult('pivot', JSON.stringify(envelope('pivot', { artifacts: { 'pivot.json': JSON.stringify(transcript) } })))
}

function envelope(adapter: string, over: Partial<RunEnvelope>): RunEnvelope {
  return {
    adapter,
    adapterVersion: '1.0.0',
    entityId: 'ent_test',
    entityKind: 'username',
    target: 'torvalds',
    startedAt: '2026-08-30T13:00:00.000Z',
    finishedAt: '2026-08-30T13:00:05.000Z',
    durationMs: 5000,
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
    ...over
  }
}

function rawResult(adapterId: string, stdout: string): RawResult {
  return {
    adapterId,
    caseId: 'c1',
    entityId: 'ent_test',
    ok: true,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    mediaType: 'application/json',
    startedAt: '2026-08-30T13:00:00.000Z',
    finishedAt: '2026-08-30T13:00:05.000Z',
    durationMs: 5000,
    truncated: false,
    timedOut: false,
    command: null,
    error: null,
    raw: {
      rawId: 'raw_test',
      path: 'raw/raw_test.json',
      sha256: 'deadbeef',
      bytes: 1,
      mediaType: 'application/json',
      excerpt: ''
    }
  }
}

function assessmentFor(raw: RawResult, target: string): PivotAssessment {
  const proposal = pivotAdapter
    .propose!(raw)
    .find((p) => (p.attrs?.['pivot'] as PivotAssessment | undefined)?.target === target)
  assert.ok(proposal, `no proposal for ${target}`)
  return proposal!.attrs!['pivot'] as PivotAssessment
}

/* ------------------------------------------------------------------ *
 * A real picture, at two sizes
 * ------------------------------------------------------------------ */

/**
 * Hash a generated gradient PNG at the given edge length.
 *
 * The point of doing it at two sizes is that this is the property the whole avatar signal
 * rests on: a platform re-encodes an uploaded picture at its own dimensions, so the same
 * photograph on two sites is never the same file. PNG is used because it is the one format
 * the decoder handles without Electron — which is also why the avatar signal reports itself
 * as unevaluated for a JPEG in a plain Node process rather than silently scoring zero.
 */
function pngHash(size: number): { dhash: string | null; phash: string | null } {
  const hash = hashImage(gradientPng(size))
  assert.ok(hash, `the generated ${size}px PNG must decode`)
  return hash!
}

function gradientPng(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1)
      const v = y / (size - 1)
      const value = Math.round(255 * (0.5 + 0.5 * Math.sin(6 * u) * Math.cos(4 * v)))
      raw[o++] = value
      raw[o++] = Math.round(255 * u)
      raw[o++] = Math.round(255 * v)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed) >>> 0, 0)
  return Buffer.concat([len, typed, crc])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return c ^ -1
}

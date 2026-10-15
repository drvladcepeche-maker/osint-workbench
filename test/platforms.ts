/**
 * The pasted-link parser.
 *
 * These tests exist because `shared/platforms.ts` is the one file in the app whose output
 * the operator *types into*: it turns a URL he copied into an account entity, and the
 * canonical value it produces is the entity's identity. Three properties are worth more
 * than any individual case, and each has a test that would fail loudly:
 *
 *  1. **Every platform in the table round-trips.** The URL a platform's own `profileUrl()`
 *     builds must parse back to the value the picker would have produced from the same
 *     handle. A new platform with a mistyped path shape fails here rather than in a case
 *     file six months later, and a table entry with no test at all fails the coverage
 *     assertion below.
 *  2. **Every parse is a fixed point of `normaliseEntityValue`.** The renderer previews
 *     the canonical value under the field before anything is added, and the store
 *     canonicalises again on the way in. If those two ever disagreed the preview would be
 *     a lie about what was written.
 *  3. **Every fold in the app answers identically.** "Are these the same source" was
 *     written three times — `siteOrigin()` here, a copy in `support/sources.ts`, and
 *     `independenceKey()` folding `www.` alone — and the engine added a fourth wrapper over
 *     them. Any disagreement means the same two findings corroborate in one part of the app
 *     and not in another. There is one implementation now, and the test below imports every
 *     entry point to it and asserts they answer identically, host by host: corroboration
 *     independence keys on `Finding.source`, and an account seeded from a pasted link keys
 *     on the same folded origin.
 *
 * Test data is public figures and invented handles only. Nothing here is the operator's.
 */

import assert from 'node:assert/strict'

import { siteOrigin as mainSiteOrigin } from '../src/main/adapters/support/sources'
import { engineSourceKey } from '../src/main/engine/corroboration'
import { independenceKey } from '../src/shared/confidence'
import {
  accountFromHandle,
  isParseFailure,
  parseTarget,
  siteOrigin,
  PLATFORMS,
  type ParsedTarget
} from '../src/shared/platforms'
import { normaliseEntityValue } from '../src/shared/normalise'
import { isEntityKind } from '../src/shared/types'

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** The parse, or a failure of the test naming the URL and the reason it was refused. */
function parsed(input: string): ParsedTarget {
  const r = parseTarget(input)
  if (isParseFailure(r)) assert.fail(`${input} was refused: ${r.error}`)
  return r
}

/** The refusal reason, or a failure of the test showing what it produced instead. */
function refusal(input: string): string {
  const r = parseTarget(input)
  if (!isParseFailure(r)) assert.fail(`${input} was accepted as ${r.kind} ${r.value}; a refusal was expected`)
  return r.error
}

/**
 * The four shapes the same link arrives in: bare host, `www.`, a trailing slash, and a
 * tracking query. All four must produce one value, because all four are one paste.
 */
function variants(url: string): string[] {
  const u = new URL(url)
  const path = u.pathname.replace(/\/$/, '')
  const q = u.search
  const bare = `${u.protocol}//${u.host}${path}${q}`
  return [
    bare,
    `${u.protocol}//www.${u.host}${path}${q}`,
    `${u.protocol}//${u.host}${path}/${q}`,
    `${u.protocol}//${u.host}${path}${q ? `${q}&utm_source=test` : '?utm_source=test'}`,
    `${u.host}${path}${q}`
  ]
}

/** One real URL per platform, and the value the whole app must agree it names. */
interface Sample {
  /** The `PLATFORMS` id it exercises. `null` for hosts that are not their own entry. */
  platform: string | null
  url: string
  value: string
}

const SAMPLES: readonly Sample[] = [
  { platform: 'github', url: 'https://github.com/torvalds', value: 'github.com/torvalds' },
  { platform: 'gitlab', url: 'https://gitlab.com/gitlab-org', value: 'gitlab.com/gitlab-org' },
  { platform: 'reddit', url: 'https://www.reddit.com/user/spez', value: 'reddit.com/spez' },
  { platform: null, url: 'https://www.reddit.com/u/spez', value: 'reddit.com/spez' },
  { platform: 'x', url: 'https://x.com/jack', value: 'x.com/jack' },
  // twitter.com IS folded into x.com. They are different registrable domains, but one
  // redirects to the other and it is one company answering: a link pasted from either
  // names the same account, and a finding from either names the same source. The fold
  // that decides this is the same one corroboration counts on, which is why the two can
  // no longer disagree.
  { platform: null, url: 'https://twitter.com/jack', value: 'x.com/jack' },
  { platform: 'instagram', url: 'https://www.instagram.com/nasa', value: 'instagram.com/nasa' },
  { platform: 'tiktok', url: 'https://www.tiktok.com/@khaby.lame', value: 'tiktok.com/khaby.lame' },
  { platform: 'youtube', url: 'https://www.youtube.com/@MKBHD', value: 'youtube.com/mkbhd' },
  { platform: null, url: 'https://www.youtube.com/c/PewDiePie', value: 'youtube.com/pewdiepie' },
  { platform: null, url: 'https://www.youtube.com/user/PewDiePie', value: 'youtube.com/pewdiepie' },
  { platform: 'twitch', url: 'https://www.twitch.tv/shroud', value: 'twitch.tv/shroud' },
  {
    platform: 'steam',
    url: 'https://steamcommunity.com/id/gabelogannewell',
    value: 'steamcommunity.com/gabelogannewell'
  },
  {
    platform: null,
    url: 'https://steamcommunity.com/profiles/76561197960287930',
    value: 'steamcommunity.com/76561197960287930'
  },
  { platform: 'telegram', url: 'https://t.me/durov', value: 't.me/durov' },
  {
    platform: 'discord',
    url: 'https://discord.com/users/123456789012345678',
    value: 'discord.com/123456789012345678'
  },
  {
    platform: 'linkedin',
    url: 'https://www.linkedin.com/in/williamhgates',
    value: 'linkedin.com/williamhgates'
  },
  { platform: 'mastodon', url: 'https://mastodon.social/@Gargron', value: 'mastodon.social/gargron' },
  { platform: 'bluesky', url: 'https://bsky.app/profile/jay.bsky.team', value: 'bsky.app/jay.bsky.team' },
  { platform: 'soundcloud', url: 'https://soundcloud.com/flume', value: 'soundcloud.com/flume' },
  { platform: 'medium', url: 'https://medium.com/@quincylarson', value: 'medium.com/quincylarson' },
  { platform: 'keybase', url: 'https://keybase.io/chris', value: 'keybase.io/chris' },
  { platform: 'pinterest', url: 'https://www.pinterest.com/nasa', value: 'pinterest.com/nasa' },
  { platform: 'facebook', url: 'https://www.facebook.com/zuck', value: 'facebook.com/zuck' },
  { platform: 'vk', url: 'https://vk.com/durov', value: 'vk.com/durov' },
  { platform: 'lastfm', url: 'https://www.last.fm/user/rj', value: 'last.fm/rj' },
  { platform: 'aboutme', url: 'https://about.me/nightowl', value: 'about.me/nightowl' },
  { platform: 'linktree', url: 'https://linktr.ee/nightowl', value: 'linktr.ee/nightowl' },
  { platform: 'gravatar', url: 'https://gravatar.com/nightowl', value: 'gravatar.com/nightowl' },
  {
    platform: 'stackoverflow',
    url: 'https://stackoverflow.com/users/22656/jon-skeet',
    value: 'stackoverflow.com/22656'
  }
]

/** A handle of the shape each platform actually uses, for the round-trip. */
const SAMPLE_HANDLE: Record<string, string> = {
  discord: '123456789012345678',
  stackoverflow: '22656',
  bluesky: 'nightowl.bsky.social'
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

export function platformTests(test: (name: string, fn: () => void | Promise<void>) => void): void {
  /* ---------------------------------------------------------- the table */

  test('every platform in the table parses a real profile URL, in all five shapes it is pasted in', () => {
    for (const s of SAMPLES) {
      for (const v of variants(s.url)) {
        const r = parseTarget(v)
        if (isParseFailure(r)) assert.fail(`${v} was refused: ${r.error}`)
        assert.equal(r.kind, 'account', v)
        assert.equal(r.value, s.value, v)
        assert.ok(r.note.length > 20, `${v} produced no explanation of how it was read`)
      }
    }
  })

  test('every entry in PLATFORMS has a sample URL — a new platform cannot arrive untested', () => {
    const covered = new Set(SAMPLES.map((s) => s.platform).filter(Boolean))
    const missing = PLATFORMS.filter((p) => !covered.has(p.id)).map((p) => p.id)
    assert.deepEqual(missing, [], `PLATFORMS entries with no sample URL: ${missing.join(', ')}`)
  })

  test("a platform's own profileUrl round-trips back to the value its picker produces", () => {
    for (const p of PLATFORMS) {
      const handle = SAMPLE_HANDLE[p.id] ?? 'nightowl'
      const built = accountFromHandle(p.id, handle)
      if (isParseFailure(built)) assert.fail(`${p.id} refused the handle ${handle}: ${built.error}`)
      const viaUrl = parsed(p.profileUrl(handle))
      assert.equal(viaUrl.value, built.value, `${p.id}: the URL and the handle disagree`)
      assert.equal(built.value, `${p.host}/${handle.toLowerCase()}`, p.id)
    }
  })

  test('every parse is a fixed point of normaliseEntityValue, so the preview is what gets stored', () => {
    const inputs = [
      ...SAMPLES.map((s) => s.url),
      'https://github.com/torvalds/linux',
      'https://twitter.com/jack/status/20',
      'mailto:someone@example.org',
      'someone@example.org',
      'example.com',
      '@kev@fosstodon.org',
      'https://forum.example.org/u/nightowl',
      'https://some-site.example.net/nightowl',
      'https://www.facebook.com/profile.php?id=100000123456789'
    ]
    for (const input of inputs) {
      const r = parsed(input)
      assert.ok(isEntityKind(r.kind), `${input} produced a kind that is not an EntityKind`)
      const again = normaliseEntityValue(r.kind, r.value)
      assert.equal(again.value, r.value, `${input}: ${r.value} normalises to ${again.value}`)
    }
  })

  /* ------------------------------------------------- the shapes that are not accounts */

  test('a mailto: link is an email, not an account', () => {
    const r = parsed('mailto:Someone@Example.ORG?subject=hi')
    assert.equal(r.kind, 'email')
    assert.equal(r.value, 'someone@example.org')
    assert.match(r.note, /mailto/i)
  })

  test('a bare address is an email; a URL with an @handle in it is not', () => {
    assert.equal(parsed('someone@example.org').kind, 'email')
    // `https://www.tiktok.com/@khaby.lame` has no spaces either, and matched a naive
    // address pattern before the scheme and the slash were checked first.
    assert.equal(parsed('https://www.tiktok.com/@khaby.lame').kind, 'account')
  })

  test('a bare domain is a domain, and a subdomain is not folded away', () => {
    for (const v of ['example.com', 'https://example.com/', 'https://www.example.com']) {
      const r = parsed(v)
      assert.equal(r.kind, 'domain', v)
      assert.equal(r.value, 'example.com', v)
    }
    // A subdomain is a different subject for subfinder, unlike the account case where the
    // platform operator is what matters.
    const sub = parsed('https://blog.example.com')
    assert.equal(sub.value, 'blog.example.com')
    assert.match(sub.note, /example\.com/)
  })

  test('an IP address is an ipaddr, and a path on one names a file rather than an account', () => {
    assert.equal(parsed('http://203.0.113.7').kind, 'ipaddr')
    assert.match(refusal('http://203.0.113.7/admin'), /IP address/)
  })

  test('a fediverse address names the instance as the platform', () => {
    const r = parsed('@kev@fosstodon.org')
    assert.equal(r.value, 'fosstodon.org/kev')
    assert.match(r.note, /instance/)
  })

  /* --------------------------------------------------------- the hard cases */

  test('a YouTube channel id is reported as an id, never mangled into a handle', () => {
    const why = refusal('https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw')
    assert.match(why, /channel id/i)
    assert.match(why, /UC_x5XG1OV2P6uZZ5FSM9Ttw/)
    assert.match(why, /@handle/)
  })

  test('a Discord invite is refused as a server invite, in both of its spellings', () => {
    for (const u of ['https://discord.gg/abcdef', 'https://discord.com/invite/abcdef']) {
      const why = refusal(u)
      assert.match(why, /invite/i)
      assert.match(why, /not a user/i)
      assert.match(why, /users\/<numeric id>/)
    }
    // The one Discord URL that does name somebody.
    const r = parsed('https://discord.com/users/123456789012345678')
    assert.equal(r.value, 'discord.com/123456789012345678')
    assert.match(r.note, /snowflake/)
  })

  test('a Stack Overflow slug is a display name, and the number is the identity', () => {
    const r = parsed('https://stackoverflow.com/users/22656/jon-skeet')
    assert.equal(r.value, 'stackoverflow.com/22656')
    assert.equal((r.attrs as { displayName?: string }).displayName, 'jon-skeet')
    assert.match(r.note, /display name/)
    // Without the slug, the same account.
    assert.equal(parsed('https://stackoverflow.com/users/22656').value, 'stackoverflow.com/22656')
  })

  test('a Steam vanity name and a SteamID64 are told apart and labelled', () => {
    const vanity = parsed('https://steamcommunity.com/id/gabelogannewell')
    assert.equal((vanity.attrs as { idKind?: string }).idKind, 'vanity')
    const id = parsed('https://steamcommunity.com/profiles/76561197960287930')
    assert.equal((id.attrs as { idKind?: string }).idKind, 'steamid64')
    assert.match(id.note, /never changes/)
  })

  test('a Facebook numeric profile is read out of the query string', () => {
    const r = parsed('https://www.facebook.com/profile.php?id=100000123456789')
    assert.equal(r.value, 'facebook.com/100000123456789')
    const people = parsed('https://www.facebook.com/people/Some-Name/100000123456789/')
    assert.equal(people.value, 'facebook.com/100000123456789')
    assert.equal((people.attrs as { displayName?: string }).displayName, 'Some-Name')
  })

  test('extra path after the handle is dropped, and the note says so', () => {
    const repo = parsed('https://github.com/torvalds/linux')
    assert.equal(repo.value, 'github.com/torvalds')
    assert.match(repo.note, /linux/)
    assert.equal(parsed('https://twitter.com/jack/status/20').value, 'x.com/jack')
    assert.equal(parsed('https://t.me/durov/123').value, 't.me/durov')
  })

  /* ---------------------------------------------------------- the unknown host */

  test('an unknown host guesses the first path segment, and says that it guessed', () => {
    const r = parsed('https://some-site.example.net/nightowl')
    assert.equal(r.value, 'example.net/nightowl')
    assert.match(r.note, /not in the platform table/)
    assert.match(r.note, /check it/i)
  })

  test('an unknown host reads /u/ and /profiles/ as the profile prefixes they usually are', () => {
    assert.equal(parsed('https://forum.example.org/u/nightowl').value, 'example.org/nightowl')
    assert.equal(parsed('https://forum.example.org/profiles/nightowl').value, 'example.org/nightowl')
    assert.match(refusal('https://forum.example.org/users'), /member list/)
  })

  /* --------------------------------------------------------------- refusals */

  test('a link that names no account is refused with a reason, never guessed at', () => {
    const cases: [string, RegExp][] = [
      ['https://www.reddit.com/r/osint', /subreddit/],
      ['https://t.me/+AbCdEfGhIj', /invite/],
      ['https://www.pinterest.com/pin/1234567890', /one pin/],
      ['https://www.linkedin.com/company/microsoft', /company page/],
      ['https://www.last.fm/music/Radiohead', /artist page/],
      ['https://steamcommunity.com/groups/nightowls', /group/],
      ['https://www.facebook.com/groups/1234567890', /group/],
      ['https://medium.com/better-programming', /publication/],
      ['https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster', /question/],
      ['https://gravatar.com/avatar/205e460b479e2e5b48aec07710c08d50', /avatar hash/],
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', /not where it puts an account/],
      ['https://forum.example.org/settings', /site page/],
      ['https://example.org/index.html', /is a file/],
      ['ftp://example.com/nightowl', /not a link this can read/],
      ['torvalds', /not a link/]
    ]
    for (const [input, expect] of cases) {
      assert.match(refusal(input), expect, input)
    }
  })

  test('a refusal points at the route that does not second-guess: the platform and handle fields', () => {
    assert.match(refusal('torvalds'), /platform and handle/)
    assert.match(refusal('https://forum.example.org/settings'), /platform and handle/)
    // And that route really does take what the parser refused.
    const forced = accountFromHandle('forum.example.org', 'settings')
    assert.ok(!isParseFailure(forced) && forced.value === 'example.org/settings')
  })

  /* ------------------------------------------------- the platform-and-handle route */

  test('the handle route never asks for the slash composite, and shows what it produced', () => {
    const r = accountFromHandle('github', '@torvalds')
    assert.ok(!isParseFailure(r))
    if (isParseFailure(r)) return
    assert.equal(r.value, 'github.com/torvalds')
    assert.equal(r.label, 'torvalds on github.com')
    assert.match(r.note, /github\.com\/torvalds/)
  })

  test('an unknown host typed by hand is built the same way as every other account', () => {
    const r = accountFromHandle('some-forum.co.uk', 'nightowl')
    assert.ok(!isParseFailure(r))
    if (isParseFailure(r)) return
    assert.equal(r.value, 'some-forum.co.uk/nightowl')
    assert.equal(normaliseEntityValue('account', r.value).value, r.value)
  })

  test('the handle route refuses what is really a link, a name, or the wrong shape of id', () => {
    assert.match(
      (accountFromHandle('github', 'https://github.com/torvalds') as { error: string }).error,
      /link rather than a handle/
    )
    assert.match((accountFromHandle('github', 'Linus Torvalds') as { error: string }).error, /no spaces/)
    assert.match((accountFromHandle('discord', 'nightowl') as { error: string }).error, /snowflake/)
    assert.match((accountFromHandle('stackoverflow', 'jon-skeet') as { error: string }).error, /number/)
    assert.match((accountFromHandle('bluesky', 'nightowl') as { error: string }).error, /domain name/)
    assert.match((accountFromHandle('not-a-host', 'nightowl') as { error: string }).error, /is not a host/)
  })

  /* ------------------------------------------------------- the folding agreement */

  test('every fold in the app answers identically, host by host', () => {
    const hosts = [
      ...PLATFORMS.map((p) => p.host),
      ...SAMPLES.map((s) => new URL(s.url).hostname),
      'www.github.com',
      'api.github.com',
      'https://api.github.com/users/torvalds',
      'https://www.github.com/torvalds',
      'm.facebook.com',
      'old.reddit.com',
      'web.telegram.org',
      'web.archive.org',
      'torvalds.wordpress.com',
      'www.habbo.es',
      'forum.example.co.uk',
      'some.deep.subdomain.example.com.bg',
      'api.pwnedpasswords.com',
      'otx.alienvault.com',
      'crt.sh',
      'HaveIBeenPwned',
      '203.0.113.7',
      'example.com.',
      ''
    ]
    for (const h of hosts) {
      const shared = siteOrigin(h)
      assert.equal(mainSiteOrigin(h), shared, `support/sources.ts disagrees about ${h || '(empty)'}`)
      assert.equal(independenceKey(h), shared, `independenceKey disagrees about ${h || '(empty)'}`)
      assert.equal(engineSourceKey(h), shared, `engineSourceKey disagrees about ${h || '(empty)'}`)
    }
  })

  /**
   * The three folds used to be three answers. This is what they disagreed about, kept as a
   * test so the unification cannot quietly come apart again: `independenceKey` stripped
   * `www.` and nothing else, so every service subdomain read as its own source, and any two
   * findings whose sources differed only by one would corroborate in the database view
   * while the engine — which folds to the site operator — correctly refused them.
   */
  test('a service subdomain is the same source as the site, everywhere', () => {
    for (const [a, b] of [
      ['api.github.com', 'github.com'],
      ['https://api.github.com/users/torvalds', 'https://github.com/torvalds'],
      ['m.facebook.com', 'www.facebook.com'],
      ['web.archive.org', 'archive.org'],
      ['torvalds.wordpress.com', 'wordpress.com']
    ] as const) {
      assert.equal(independenceKey(a), independenceKey(b), `${a} and ${b} are one site answering twice`)
      assert.equal(engineSourceKey(a), engineSourceKey(b))
    }
  })

  /**
   * The one thing the site fold must **not** do to a derived source. `siteOrigin` on its
   * own reads `local:maigret` as the host `local`, which would make every adapter's own
   * analysis one shared source — and a source that can be reached twice is a source that
   * can corroborate.
   */
  test('a derived source keeps its prefix and never folds to a host', () => {
    for (const s of ['local:maigret', 'local:pattern-timezone', 'local:dorks', 'file:holiday.jpg']) {
      assert.equal(independenceKey(s), s, `${s} was folded`)
      assert.equal(engineSourceKey(s), s, `${s} was folded by the engine`)
      assert.notEqual(independenceKey(s), 'local')
      assert.notEqual(independenceKey(s), 'file')
    }
    assert.notEqual(independenceKey('local:maigret'), independenceKey('local:dorks'))
  })

  test('an account value keys on the same folded origin a finding would name as its source', () => {
    // All three of these are one site answering, so all three are one account and one
    // independence key. This is the property `Finding.source` folding exists to protect.
    for (const u of [
      'https://github.com/torvalds',
      'https://www.github.com/torvalds',
      'https://api.github.com/users/torvalds'
    ]) {
      const r = parsed(u)
      assert.equal((r.attrs as { platform?: string }).platform, mainSiteOrigin(u))
    }
  })
}

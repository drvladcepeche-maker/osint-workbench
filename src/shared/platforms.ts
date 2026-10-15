/**
 * Turning a pasted link into an entity.
 *
 * This file exists because of a mismatch between what the data model wants and what the
 * operator actually has. An `account`'s canonical value is `platform/handle` — a composite
 * he would otherwise have to compose by hand, guessing whether the platform is `github`,
 * `GitHub` or `github.com`, and guessing again for Discord. What he has in front of him is
 * a URL he copied out of a browser. So the URL is the input, and the composite is derived.
 *
 * Three judgement calls run through the whole file:
 *
 *  1. **A refusal with a reason beats a mangled guess.** `youtube.com/channel/UC…` names a
 *     channel by opaque id, not by handle; `discord.gg/xyz` is an invite to a server and
 *     names nobody. Both are recognised and reported as what they are rather than being
 *     turned into an account whose handle is `UC_x5XG1OV2P6uZZ5FSM9Ttw`. A wrong entity is
 *     worse than no entity: adapters get pointed at it and the second generation of
 *     findings is about nothing.
 *  2. **The unknown-host fallback guesses, and says so.** Most of the web is not in the
 *     table below, and "the first path segment is the handle" is right far more often than
 *     it is wrong. It is applied, the `note` says it was a guess, and a reserved-word list
 *     stops `example.com/settings` from becoming an account named `settings`.
 *  3. **The canonical value is a fixed point.** Everything this returns for an `account`
 *     survives `normaliseAccount()` unchanged — that function delegates here — so the value
 *     previewed under the field is exactly the value written to `entities.json`. A preview
 *     that disagrees with the store is worse than no preview.
 *
 * ## Why the host fold lives here
 *
 * `siteOrigin()` used to exist twice: here, and again in
 * `src/main/adapters/support/sources.ts`, because the renderer cannot import from
 * `src/main` — separate bundles, `tsconfig.web.json` does not include `src/main`, and the
 * modules there reach for `node:fs` and `node:net`. The duplication was policed by a drift
 * test rather than removed, and a third fold (`independenceKey`, keyed on the same strings)
 * quietly disagreed with both.
 *
 * Main *can* import from `src/shared`, so the copy is gone: this file is the one
 * implementation, `support/sources.ts` re-exports it for the adapters, and
 * `shared/confidence.ts` builds `independenceKey()` on top of it. One fold, one set of
 * tests. That agreement is load-bearing rather than tidy — corroboration independence keys
 * on `Finding.source`, an account entity's platform is the same folded origin, and if the
 * two ever disagreed about what `github.com` is, an account seeded from a pasted link would
 * stop matching the findings about it.
 */

import type { EntityKind } from './types'

/* ------------------------------------------------------------------ *
 * Host folding — the single implementation. `support/sources.ts` re-exports it and
 * `shared/confidence.ts` keys corroboration on it.
 * ------------------------------------------------------------------ */

/**
 * Multi-label public suffixes common enough to matter here. Not a full PSL — that is a
 * ~200 kB dataset that changes weekly, and getting `foo.co.uk` right is worth far more
 * than getting `foo.compute.amazonaws.com` right for this use.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.cn',
  'com.tr',
  'com.mx',
  'com.ar',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'co.nz',
  'co.za',
  'co.in',
  'com.pl',
  'com.ua',
  'com.sg',
  'com.hk',
  'com.tw',
  'co.il',
  'com.ru',
  'org.ru',
  'net.ru',
  'com.bg',
  'org.bg'
])

/**
 * Host prefixes that identify the same operator as the bare domain. `api.github.com`
 * answering about a GitHub profile is GitHub answering.
 */
const SERVICE_PREFIXES = [
  'api.',
  'public-api.',
  'www.',
  'm.',
  'mobile.',
  'open.',
  'graph.',
  'gateway.',
  'rest.',
  'apis.',
  'v1.',
  'v2.',
  'web.'
]

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Strip a scheme/path/port and return the bare lowercase hostname, or `''`. */
export function hostOf(urlOrHost: string): string {
  const s = (urlOrHost ?? '').trim().toLowerCase()
  if (!s) return ''
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`
    const host = new URL(withScheme).hostname
    if (host) return host.replace(/\.+$/, '')
  } catch {
    /* not parseable as a URL */
  }
  return (
    s
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split('/')[0]
      ?.split('?')[0]
      ?.split(':')[0]
      ?.replace(/\.+$/, '') ?? ''
  )
}

/**
 * The site operator behind a profile URL — the same string `Finding.source` carries for
 * anything discovered by probing that site, and the key corroboration counts on.
 *
 * `https://api.github.com/users/torvalds` -> `github.com`
 * `https://torvalds.wordpress.com/`       -> `wordpress.com`
 * `https://www.habbo.es/api/...`          -> `habbo.es`
 *
 * Note the middle case: a user-controlled subdomain folds to the platform. That is
 * intentional. Two tools finding `torvalds.wordpress.com` are both being told so by
 * WordPress.com, and treating them as independent would be the exact lie this fold exists
 * to prevent.
 *
 * **The direction of the error is chosen deliberately.** Folding too little manufactures
 * corroboration that does not exist, which poisons the case file with confident nonsense;
 * folding too much costs a promotion a human can still make by hand. The first mistake is
 * unrecoverable, the second is recoverable by looking. So this errs towards folding.
 */
export function siteOrigin(urlOrHost: string): string {
  let host = hostOf(urlOrHost)
  if (!host) return ''
  // An IP address has no registrable domain to fold to.
  if (IPV4.test(host) || host.includes(':')) return host

  let changed = true
  while (changed) {
    changed = false
    for (const p of SERVICE_PREFIXES) {
      if (host.startsWith(p) && host.length > p.length) {
        host = host.slice(p.length)
        changed = true
      }
    }
  }

  const labels = host.split('.').filter(Boolean)
  const registrable =
    labels.length <= 2
      ? labels.join('.')
      : MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.'))
        ? labels.slice(-3).join('.')
        : labels.slice(-2).join('.')
  return operatorAlias(registrable)
}

/**
 * Second domains the same operator answers on, folded to the one the app names them by.
 *
 * `twitter.com` serves a 301 to `x.com`. Two tools reading the two hostnames are one
 * company answering twice, and counting them as two independent sources is the same
 * fabricated agreement `api.github.com` vs `github.com` was. The registrable-domain rule
 * above cannot see it — these genuinely are different domains — so it takes a table.
 *
 * The consequence is deliberate and worth stating: an account pasted from `twitter.com`
 * keys on `x.com`, so it is the **same entity** as one pasted from `x.com`. The rule this
 * replaces kept them apart on the grounds that folding "would make a seeded account stop
 * matching its own findings" — which was true only while the account value and the finding
 * source were folded by two different functions. They are one function now, so both move
 * together and the pair matches.
 *
 * Written out rather than read off the rules' own `hosts` lists, which was the first
 * attempt and was wrong: `hosts` means "this rule answers for that host too", which is not
 * the same claim. `discord.gg` is Discord's, but it is the **invite** domain, and the rule
 * recognises a `discord.gg` link precisely so it can refuse it as an invite that names
 * nobody. Folding it away deleted the distinction and produced the wrong refusal. So the
 * entries here are only the pairs where the second domain is a redirect to the first and
 * the two are interchangeable in every direction.
 */
const OPERATOR_ALIASES: Record<string, string> = {
  // A redirect to the first, operated by the same company.
  'twitter.com': 'x.com',
  'fb.com': 'facebook.com',
  'telegram.me': 't.me',
  // Official short domains. Each redirects to the long one and turns up in captures
  // because it is what people paste.
  'youtu.be': 'youtube.com',
  'redd.it': 'reddit.com',
  'instagr.am': 'instagram.com',
  'wp.me': 'wordpress.com'
}

function operatorAlias(host: string): string {
  return OPERATOR_ALIASES[host] ?? host
}

/* ------------------------------------------------------------------ *
 * The result
 * ------------------------------------------------------------------ */

export interface ParsedTarget {
  kind: EntityKind
  /** The canonical value. For an account, `platform/handle` — already a fixed point. */
  value: string
  label: string
  attrs?: Record<string, unknown>
  /** How it was recognised, shown under the field. One sentence, sometimes two. */
  note: string
}

export interface ParseFailure {
  /** Why nothing was produced, in the app's voice: what was looked for and not found. */
  error: string
}

export function isParseFailure(r: ParsedTarget | ParseFailure): r is ParseFailure {
  return typeof (r as ParseFailure).error === 'string'
}

/* ------------------------------------------------------------------ *
 * The platform table
 * ------------------------------------------------------------------ */

export interface Platform {
  id: string
  label: string
  /** The folded origin an account on this platform is keyed on. */
  host: string
  profileUrl: (handle: string) => string
  /**
   * What a handle looks like here, when it is not simply a name. Shown beside the handle
   * field, because "Discord" and "a Discord handle" are not the same question.
   */
  handleShape?: string
}

interface Ctx {
  url: URL
  /** `siteOrigin(url.hostname)` — what the account is keyed on, not `rule.host`. */
  origin: string
  /** Decoded, non-empty path segments. */
  segs: string[]
  rule: PlatformRule
  /** The generic reserved words plus the rule's own. */
  reserved: Set<string>
}

interface PlatformRule extends Platform {
  /** Other hosts this rule answers for. Each keeps *its own* folded origin in the value. */
  hosts?: readonly string[]
  /**
   * Where a handle sits in the path. `''` means the first segment is the handle; a name
   * means the handle is the segment after that name. Tried in order.
   */
  paths?: readonly string[]
  /** The handle segment must start with `@` (TikTok, Medium, the fediverse). */
  requireAt?: boolean
  /** Path segments that are never a handle here, beyond the generic list. */
  reserved?: readonly string[]
  /** Overrides the generic handle shape — Bluesky handles are dotted, ids are numeric. */
  handle?: RegExp
  /** Shapes the path rules cannot express: opaque ids, invites, display-name slugs. */
  special?: (ctx: Ctx) => ParsedTarget | ParseFailure | null
  /** Appended to the note when the path rule matched. */
  how?: string
}

/** A handle segment, in the shape most of the web agrees on. */
const HANDLE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
const DIGITS = /^[0-9]{1,25}$/

/**
 * Path segments that are site furniture on any host.
 *
 * Used by the unknown-host fallback and as the floor under every rule. It is deliberately
 * short: every word here is a handle somebody really owns on some site, so the list holds
 * only words whose *first-segment* use is overwhelmingly a page rather than a person. When
 * it refuses wrongly the operator still has the platform-and-handle route, which does not
 * consult it.
 */
const RESERVED = new Set([
  'about',
  'account',
  'accounts',
  'admin',
  'api',
  'assets',
  'auth',
  'blog',
  'careers',
  'cart',
  'categories',
  'category',
  'checkout',
  'contact',
  'cookies',
  'dashboard',
  'developer',
  'developers',
  'docs',
  'download',
  'downloads',
  'explore',
  'faq',
  'favicon.ico',
  'feed',
  'help',
  'home',
  'index',
  'jobs',
  'legal',
  'login',
  'logout',
  'messages',
  'news',
  'notifications',
  'password',
  'plans',
  'policies',
  'policy',
  'posts',
  'press',
  'pricing',
  'privacy',
  'register',
  'robots.txt',
  'search',
  'security',
  'settings',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'sitemap',
  'static',
  'status',
  'support',
  'terms',
  'tos',
  'upload',
  'welcome'
])

/**
 * Path segments that introduce a member on a site nobody wrote a rule for. Discourse,
 * phpBB, most CMSes and half the forums on the internet use one of these.
 */
const GENERIC_PROFILE_PATHS = new Set([
  'u',
  'user',
  'users',
  'profile',
  'profiles',
  'member',
  'members',
  'people',
  'author',
  'authors'
])

const refuse = (error: string): ParseFailure => ({ error })

/** Build an account. The value is `origin/handle`, lowercased — the identity of the thing. */
function account(
  origin: string,
  handle: string,
  note: string,
  extra: Record<string, unknown> = {},
  url?: string
): ParsedTarget {
  return {
    kind: 'account',
    value: `${origin}/${handle.toLowerCase()}`,
    label: `${handle} on ${origin}`,
    attrs: { platform: origin, handle, ...(url ? { url } : {}), ...extra },
    note
  }
}

/**
 * The platforms with a URL shape worth knowing. Ordered by how often the operator is
 * likely to reach for one, not alphabetically — this array is also the picker's option
 * list, and an alphabetical list buries GitHub under About.me.
 */
const RULES: readonly PlatformRule[] = [
  {
    id: 'github',
    label: 'GitHub',
    host: 'github.com',
    profileUrl: (h) => `https://github.com/${h}`,
    // `users` first: `api.github.com/users/torvalds` folds to `github.com` before the path
    // is read, and that is the shape blackbird hands over. Reading it as the root segment
    // would mint an account called `users`.
    paths: ['users', ''],
    reserved: ['orgs', 'organizations', 'topics', 'collections', 'sponsors', 'marketplace', 'trending', 'new', 'issues', 'pulls', 'codespaces', 'enterprise', 'features', 'readme', 'site'],
    how: 'GitHub puts an account at the root of the path.'
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    host: 'gitlab.com',
    profileUrl: (h) => `https://gitlab.com/${h}`,
    paths: [''],
    reserved: ['-', 'users', 'groups', 'projects', 'public'],
    how: 'GitLab puts an account at the root of the path. A group sits at the same depth and looks identical, so check this is a person.'
  },
  {
    id: 'reddit',
    label: 'Reddit',
    host: 'reddit.com',
    profileUrl: (h) => `https://www.reddit.com/user/${h}`,
    paths: ['u', 'user'],
    how: 'Reddit puts an account under /u/ or /user/.',
    special: ({ segs, origin }) => {
      if (segs[0] === 'r' && segs[1]) {
        return refuse(
          `r/${segs[1]} is a subreddit, not a user. Reddit user links are ${origin}/u/<name> or ${origin}/user/<name>.`
        )
      }
      return null
    }
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    host: 'x.com',
    hosts: ['twitter.com'],
    profileUrl: (h) => `https://x.com/${h}`,
    paths: [''],
    reserved: ['i', 'intent', 'share', 'hashtag', 'compose', 'messages', 'notifications'],
    // x.com and twitter.com ARE folded together, by `operatorAlias` reading the `hosts`
    // line above. They were kept apart until the fold was unified, on the grounds that
    // folding would make a seeded account stop matching its own findings — true while the
    // account value and `Finding.source` went through two different functions, and false
    // now that they go through this one. twitter.com redirects to x.com; two tools reading
    // the two hostnames are one company answering twice, and counting that as two
    // independent sources is exactly the fabricated agreement the fold exists to prevent.
    how: 'X puts an account at the root of the path. A twitter.com link is the same account as an x.com one — the domain redirects, so both are recorded as x.com.'
  },
  {
    id: 'instagram',
    label: 'Instagram',
    host: 'instagram.com',
    profileUrl: (h) => `https://www.instagram.com/${h}/`,
    paths: [''],
    reserved: ['p', 'reel', 'reels', 'stories', 'tv', 'direct', 'challenge'],
    how: 'Instagram puts an account at the root of the path.'
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    host: 'tiktok.com',
    profileUrl: (h) => `https://www.tiktok.com/@${h}`,
    paths: [''],
    requireAt: true,
    how: 'TikTok profile paths begin with @.'
  },
  {
    id: 'youtube',
    label: 'YouTube',
    host: 'youtube.com',
    profileUrl: (h) => `https://www.youtube.com/@${h}`,
    // Named paths first: `''` would otherwise read `/c/` as the handle. `fromPaths` guards
    // that as well, and both are kept because the ordering is what makes it readable.
    paths: ['c', 'user', ''],
    reserved: ['watch', 'shorts', 'playlist', 'results', 'embed', 'live', 'hashtag', 'gaming', 'premium', 'howyoutubeworks'],
    how: 'YouTube puts a handle at /@name, and legacy channels at /c/ or /user/.',
    special: ({ segs, origin, reserved }) => {
      if (segs[0] === 'channel') {
        const id = segs[1] ?? ''
        return refuse(
          id
            ? `${id} is a YouTube channel id, not a handle — it identifies the channel but no tool here takes it as a username. Open the channel and copy the /@handle link instead, or add the id as a username by hand if that is what you mean.`
            : `A /channel/ link with no id after it. Open the channel and copy its /@handle link.`
        )
      }
      if (segs[0]?.startsWith('@')) return null // handled by the path rules
      if (segs[0] === 'c' || segs[0] === 'user') return null
      if (segs[0] && !reserved.has(segs[0].toLowerCase())) {
        const h = segs[0]
        if (!HANDLE.test(h)) return null
        return account(
          origin,
          h,
          `A legacy YouTube custom URL. Current channels use /@${h}; both point at the same channel, and the handle recorded is ${h}.`,
          {},
          `https://www.youtube.com/${h}`
        )
      }
      return null
    }
  },
  {
    id: 'twitch',
    label: 'Twitch',
    host: 'twitch.tv',
    profileUrl: (h) => `https://www.twitch.tv/${h}`,
    paths: [''],
    reserved: ['directory', 'videos', 'subscriptions', 'p', 'team', 'products'],
    how: 'Twitch puts a channel at the root of the path.'
  },
  {
    id: 'discord',
    label: 'Discord',
    host: 'discord.com',
    hosts: ['discord.gg'],
    profileUrl: (h) => `https://discord.com/users/${h}`,
    handle: DIGITS,
    handleShape:
      'Discord has no public profile URL for a name. The identity is a numeric snowflake id — turn on Developer Mode in the client and copy it off the user.',
    how: 'Discord identifies a user by a numeric snowflake id under /users/.',
    special: ({ segs, origin, url }) => {
      const code = origin === 'discord.gg' ? segs[0] : segs[0] === 'invite' ? segs[1] : null
      if (code !== null) {
        return refuse(
          `${url.host}/${segs.join('/')} is a server invite, not a user. The code ${code ?? '(missing)'} names a server anyone can join; it says nothing about whose account posted it. Discord user links look like discord.com/users/<numeric id>.`
        )
      }
      if (segs[0] === 'users' && segs[1]) {
        const id = segs[1]
        if (!DIGITS.test(id)) {
          return refuse(`${id} is not a Discord user id. A user id is a snowflake — 17 to 20 digits.`)
        }
        return account(
          'discord.com',
          id,
          'A Discord user id (a snowflake). Discord has no public handle in a URL, so the id is the identity — the display name beside it can change at any time.',
          { idKind: 'snowflake' },
          `https://discord.com/users/${id}`
        )
      }
      if (origin === 'discord.gg') {
        return refuse('A discord.gg link with no invite code, and discord.gg only ever carries invites — never a user.')
      }
      return null
    }
  },
  {
    id: 'telegram',
    label: 'Telegram',
    host: 't.me',
    hosts: ['telegram.me'],
    profileUrl: (h) => `https://t.me/${h}`,
    paths: ['s', ''],
    how: 'Telegram puts a public username at the root of t.me.',
    special: ({ segs, origin }) => {
      const first = segs[0] ?? ''
      if (first.startsWith('+') || first === 'joinchat') {
        return refuse(
          'That is a Telegram invite link, not a public username. An invite code lets you into a chat and names nobody; a public username looks like t.me/<name>.'
        )
      }
      if (first === 'addstickers' || first === 'proxy' || first === 'socks') {
        return refuse(`t.me/${first} is a ${first === 'addstickers' ? 'sticker pack' : 'proxy'} link, not an account.`)
      }
      // t.me/<name>/<number> is one message in a channel; the channel is still the account.
      if (segs.length > 1 && first !== 's' && DIGITS.test(segs[1] ?? '')) {
        return account(
          origin,
          first,
          `A link to one message in t.me/${first}. The account recorded is the channel, not the message.`,
          {},
          `https://${origin}/${first}`
        )
      }
      return null
    }
  },
  {
    id: 'steam',
    label: 'Steam',
    host: 'steamcommunity.com',
    profileUrl: (h) => `https://steamcommunity.com/id/${h}`,
    handleShape: 'Either the vanity name from /id/, or the 17-digit SteamID64 from /profiles/.',
    how: 'Steam puts a chosen vanity name under /id/ and the permanent numeric account under /profiles/.',
    special: ({ segs, origin }) => {
      if (segs[0] === 'id' && segs[1]) {
        const h = segs[1]
        if (!HANDLE.test(h)) return refuse(`${h} is not a usable Steam vanity name.`)
        return account(
          origin,
          h,
          'A Steam vanity name. The owner chose it and can change it; the account it points at is a 64-bit id that cannot change.',
          { idKind: 'vanity' },
          `https://steamcommunity.com/id/${h}`
        )
      }
      if (segs[0] === 'profiles' && segs[1]) {
        const id = segs[1]
        if (!DIGITS.test(id)) return refuse(`${id} is not a SteamID64 — that form is 17 digits.`)
        return account(
          origin,
          id,
          'A SteamID64 — the permanent numeric account, not a name. It never changes, which makes it the better thing to record, but no username tool takes it as input.',
          { idKind: 'steamid64' },
          `https://steamcommunity.com/profiles/${id}`
        )
      }
      if (segs[0] === 'groups' && segs[1]) {
        return refuse(`steamcommunity.com/groups/${segs[1]} is a group, not a person.`)
      }
      return null
    }
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    host: 'linkedin.com',
    profileUrl: (h) => `https://www.linkedin.com/in/${h}`,
    paths: ['in'],
    how: 'LinkedIn puts a person under /in/. The slug is chosen by the owner and often has digits appended by LinkedIn itself.',
    special: ({ segs }) => {
      if (segs[0] === 'company' && segs[1]) {
        return refuse(
          `linkedin.com/company/${segs[1]} is a company page, not a person. Add it as an organisation, or as a domain if you want to run tools against it.`
        )
      }
      return null
    }
  },
  {
    id: 'mastodon',
    label: 'Mastodon / fediverse',
    host: 'mastodon.social',
    profileUrl: (h) => `https://mastodon.social/@${h}`,
    paths: [''],
    requireAt: true,
    how: 'A fediverse profile path begins with @. Any instance works the same way — the instance host is the platform.'
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    host: 'bsky.app',
    profileUrl: (h) => `https://bsky.app/profile/${h}`,
    paths: ['profile'],
    // A Bluesky handle is a domain name (`alice.bsky.social`, or a personal domain), and a
    // DID is the underlying identifier. Neither fits the generic shape.
    handle: /^(?:did:[a-z0-9]+:[A-Za-z0-9._%-]+|[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+)$/,
    handleShape: 'A Bluesky handle is a domain name — alice.bsky.social, or a domain the owner controls.',
    how: 'Bluesky puts a handle under /profile/. The handle is itself a domain name, which is why it has dots in it.'
  },
  {
    id: 'soundcloud',
    label: 'SoundCloud',
    host: 'soundcloud.com',
    profileUrl: (h) => `https://soundcloud.com/${h}`,
    paths: [''],
    reserved: ['discover', 'stream', 'charts', 'tags', 'you', 'pages', 'imprint'],
    how: 'SoundCloud puts an account at the root of the path; a track hangs off it as a second segment.'
  },
  {
    id: 'medium',
    label: 'Medium',
    host: 'medium.com',
    profileUrl: (h) => `https://medium.com/@${h}`,
    paths: [''],
    requireAt: true,
    how: 'Medium puts a person at /@name.',
    special: ({ segs, origin }) => {
      const first = segs[0] ?? ''
      if (first && !first.startsWith('@') && !RESERVED.has(first)) {
        return refuse(
          `${origin}/${first} is a publication or a story, not a person — Medium user paths begin with @. A personal Medium also lives at ${first}.medium.com, and that subdomain form is not read here.`
        )
      }
      return null
    }
  },
  {
    id: 'keybase',
    label: 'Keybase',
    host: 'keybase.io',
    profileUrl: (h) => `https://keybase.io/${h}`,
    paths: [''],
    how: 'Keybase puts an account at the root of the path.'
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    host: 'pinterest.com',
    profileUrl: (h) => `https://www.pinterest.com/${h}/`,
    paths: [''],
    reserved: ['ideas', 'today', 'discover'],
    how: 'Pinterest puts an account at the root of the path; a board hangs off it as a second segment.',
    special: ({ segs }) => {
      if (segs[0] === 'pin' && segs[1]) {
        return refuse(
          `pinterest.com/pin/${segs[1]} is one pin, not a profile. The account that saved it is not in this URL — open the pin and copy the profile link.`
        )
      }
      return null
    }
  },
  {
    id: 'facebook',
    label: 'Facebook',
    host: 'facebook.com',
    hosts: ['fb.com'],
    profileUrl: (h) => `https://www.facebook.com/${h}`,
    paths: [''],
    reserved: ['groups', 'pages', 'events', 'watch', 'marketplace', 'story.php', 'photo.php', 'sharer'],
    how: 'Facebook puts a vanity name at the root of the path.',
    special: ({ segs, origin, url }) => {
      if (segs[0] === 'profile.php') {
        const id = url.searchParams.get('id') ?? ''
        if (!DIGITS.test(id)) {
          return refuse('A profile.php link with no numeric id in the query, so it names nobody.')
        }
        return account(
          origin,
          id,
          'A numeric Facebook profile id. The account never chose a vanity name, so the number is the only stable identifier there is.',
          { idKind: 'numeric' },
          `https://www.facebook.com/profile.php?id=${id}`
        )
      }
      if (segs[0] === 'people' && segs[2]) {
        const id = segs[2]
        if (!DIGITS.test(id)) return null
        return account(
          origin,
          id,
          `A /people/ link: the numeric id is the identity and "${segs[1]}" is the display name Facebook put in the URL for readability.`,
          { idKind: 'numeric', displayName: segs[1] },
          `https://www.facebook.com/people/${segs[1]}/${id}`
        )
      }
      if (segs[0] === 'groups' && segs[1]) {
        return refuse(`facebook.com/groups/${segs[1]} is a group, not a person.`)
      }
      return null
    }
  },
  {
    id: 'vk',
    label: 'VK',
    host: 'vk.com',
    profileUrl: (h) => `https://vk.com/${h}`,
    paths: [''],
    reserved: ['wall', 'im', 'feed', 'video', 'audio', 'club', 'public', 'event', 'away.php'],
    how: 'VK puts an account at the root of the path. A name like id12345 is the numeric account with no vanity name set.'
  },
  {
    id: 'lastfm',
    label: 'Last.fm',
    host: 'last.fm',
    profileUrl: (h) => `https://www.last.fm/user/${h}`,
    paths: ['user'],
    how: 'Last.fm puts a listener under /user/.',
    special: ({ segs }) => {
      if (segs[0] === 'music' && segs[1]) {
        return refuse(`last.fm/music/${segs[1]} is an artist page, not a listener. A person sits under /user/.`)
      }
      return null
    }
  },
  {
    id: 'stackoverflow',
    label: 'Stack Overflow',
    host: 'stackoverflow.com',
    profileUrl: (h) => `https://stackoverflow.com/users/${h}`,
    handle: DIGITS,
    handleShape: 'The identity is the number in /users/<id>/, not the display name after it.',
    how: 'Stack Overflow identifies a user by number under /users/.',
    special: ({ segs, origin }) => {
      if (segs[0] !== 'users') {
        return segs[0] === 'questions'
          ? refuse('That is a question, not a profile. The asker is a link on the page; open it and copy that.')
          : null
      }
      const id = segs[1] ?? ''
      if (!DIGITS.test(id)) {
        return refuse(`${id || '(nothing)'} is not a Stack Overflow user id, and the id is the only identifier the site keys on.`)
      }
      const slug = segs[2]
      return account(
        origin,
        id,
        slug
          ? `The number is the identity; "${slug}" is the display name at the time the link was copied and changes whenever the owner renames. Recorded as ${id}.`
          : 'Stack Overflow keys a user on a number, so the number is what is recorded.',
        { idKind: 'numeric', ...(slug ? { displayName: slug } : {}) },
        `https://stackoverflow.com/users/${id}${slug ? `/${slug}` : ''}`
      )
    }
  },
  {
    id: 'aboutme',
    label: 'About.me',
    host: 'about.me',
    profileUrl: (h) => `https://about.me/${h}`,
    paths: [''],
    how: 'About.me puts an account at the root of the path.'
  },
  {
    id: 'linktree',
    label: 'Linktree',
    host: 'linktr.ee',
    profileUrl: (h) => `https://linktr.ee/${h}`,
    paths: [''],
    how: 'Linktree puts an account at the root of the path. The page itself is a list of the owner’s other accounts, which is usually why it is worth seeding.'
  },
  {
    id: 'gravatar',
    label: 'Gravatar',
    host: 'gravatar.com',
    profileUrl: (h) => `https://gravatar.com/${h}`,
    paths: [''],
    how: 'Gravatar puts an account at the root of the path.',
    special: ({ segs }) => {
      if (segs[0] === 'avatar' && segs[1]) {
        return refuse(
          `That is an avatar hash, not a profile name. Gravatar addresses an image by the MD5 of an email address, so ${segs[1].slice(0, 12)}… identifies an address you would have to already know. Add the address itself as an email instead.`
        )
      }
      return null
    }
  }
]

/** The picker's options, and the shapes they produce. */
export const PLATFORMS: readonly Platform[] = RULES

const BY_HOST = new Map<string, PlatformRule>()
for (const rule of RULES) {
  BY_HOST.set(rule.host, rule)
  for (const h of rule.hosts ?? []) BY_HOST.set(h, rule)
}

const BY_ID = new Map<string, PlatformRule>(RULES.map((r) => [r.id, r]))

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
/** `@user@instance` — the fediverse's own address form. The leading @ is what disambiguates it from an email. */
const FEDIVERSE = /^@([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/**
 * Read a pasted string as an entity.
 *
 * Returns the entity it recognised, or a reason it could not. It never guesses at a *kind*
 * it is not confident about: a URL that names no user comes back as a failure carrying the
 * sentence to show the operator, because "this link has no account in it" is information
 * and a silently-empty field is not.
 */
export function parseTarget(input: string): ParsedTarget | ParseFailure {
  const raw = (input ?? '').trim()
  if (!raw) return refuse('Paste a profile link — for example https://github.com/torvalds.')

  const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase()

  if (scheme === 'mailto') {
    const address = decodeURIComponent(raw.slice('mailto:'.length).split('?')[0] ?? '').trim()
    if (!EMAIL.test(address)) return refuse('A mailto: link with no address in it.')
    return {
      kind: 'email',
      value: address.toLowerCase(),
      label: address,
      attrs: { domain: address.split('@').pop()?.toLowerCase() },
      note: 'A mailto: link. Added as an email address, which holehe and blackbird can both take.'
    }
  }

  const fedi = FEDIVERSE.exec(raw)
  if (fedi) {
    const [, handle = '', host = ''] = fedi
    const origin = siteOrigin(host)
    return account(
      origin,
      handle,
      `A fediverse address: the part after the second @ is the instance, and the instance is the platform. The profile is at https://${origin}/@${handle}.`,
      {},
      `https://${origin}/@${handle}`
    )
  }

  // A bare address, and only that: `EMAIL` alone matches `https://tiktok.com/@khaby.lame`,
  // because a URL with an @handle in it has no spaces either.
  if (!scheme && !raw.includes('/') && EMAIL.test(raw)) {
    return {
      kind: 'email',
      value: raw.toLowerCase(),
      label: raw,
      attrs: { domain: raw.split('@').pop()?.toLowerCase() },
      note: 'An address rather than a link. Added as an email.'
    }
  }

  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return refuse(`${scheme}: is not a link this can read. Paste an http or https profile URL.`)
  }

  // No scheme and no dot before the first slash: this is a bare handle, not a link. Say so
  // and point at the route that takes one, rather than inventing a host for it.
  const firstToken = raw.split(/[/?#]/)[0] ?? ''
  if (!scheme && !firstToken.includes('.')) {
    return refuse(
      `"${raw}" is not a link — there is no host in it. If you have the handle but not the URL, use the platform and handle fields below.`
    )
  }

  let url: URL
  try {
    url = new URL(scheme ? raw : `https://${raw}`)
  } catch {
    return refuse('That is not a URL this can read. Copy the address bar of the profile page.')
  }

  const host = url.hostname.replace(/\.+$/, '').toLowerCase()
  if (!host.includes('.')) return refuse(`"${host}" is not a host — a host needs a dot in it.`)

  const segs = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })

  if (IPV4.test(host)) {
    if (segs.length) {
      return refuse(
        `${host} is an IP address, and a path on an IP address names a file rather than an account. Add ${host} as an ipaddr if the address itself is the subject.`
      )
    }
    return {
      kind: 'ipaddr',
      value: host,
      label: host,
      attrs: { version: 4 },
      note: 'An IP address rather than a profile.'
    }
  }

  const origin = siteOrigin(host)

  if (!segs.length) {
    // A bare host. `www.` is dropped and nothing else is: `blog.example.com` and
    // `example.com` are genuinely different subjects for a domain tool, unlike the
    // account case where the platform operator is what matters.
    const domain = host.replace(/^www\./, '')
    return {
      kind: 'domain',
      value: domain,
      label: domain,
      attrs: {},
      note: `No path, so there is no account in this link. Added as a domain — subfinder and theHarvester both take one.${
        domain !== origin ? ` The site operator is ${origin}.` : ''
      }`
    }
  }

  const rule = BY_HOST.get(origin) ?? BY_HOST.get(host)
  if (rule) {
    const ctx: Ctx = {
      url,
      origin,
      segs,
      rule,
      reserved: new Set([...RESERVED, ...(rule.reserved ?? [])])
    }
    const special = rule.special?.(ctx)
    if (special) return special
    const viaPath = fromPaths(ctx)
    if (viaPath) return viaPath
    return refuse(
      `${rule.label} was recognised, but "${segs.join('/')}" is not where it puts an account. ${rule.how ?? ''}`.trim()
    )
  }

  return fromUnknownHost(url, origin, segs)
}

/** Apply a rule's `paths`, in order. */
function fromPaths(ctx: Ctx): ParsedTarget | null {
  const { rule, segs, origin, url, reserved } = ctx
  const shape = rule.handle ?? HANDLE
  /** A rule's own prefixes are never handles at the root: `/c/` on YouTube is not a user. */
  const named = new Set((rule.paths ?? []).filter(Boolean))

  for (const p of rule.paths ?? []) {
    const at = p === '' ? 0 : segs[0] === p ? 1 : -1
    if (at < 0) continue
    let seg = segs[at]
    if (!seg) continue

    const hadAt = seg.startsWith('@')
    if (hadAt) seg = seg.slice(1)
    if (rule.requireAt && at === 0 && !hadAt) continue
    if (at === 0 && (reserved.has(seg.toLowerCase()) || named.has(seg))) continue
    if (!shape.test(seg)) continue

    const trailing = segs.slice(at + 1)
    const note =
      (rule.how ?? `The handle sits at ${['', ...(rule.paths ?? [])].filter(Boolean).join(' or ')}.`) +
      (trailing.length
        ? ` The rest of the path (${trailing.join('/')}) is not part of the identity and is dropped.`
        : '')
    return account(origin, seg, note, {}, url.toString())
  }
  return null
}

/**
 * A host that is not in the table.
 *
 * The guess is "the first path segment is the handle", which is what most of the web does,
 * and the note says out loud that it was a guess. The reserved list is the only thing
 * standing between that guess and an account named `settings`; when it refuses something
 * that really was a handle, the platform-and-handle route takes it without argument.
 */
function fromUnknownHost(url: URL, origin: string, segs: string[]): ParsedTarget | ParseFailure {
  let first = segs[0] ?? ''
  const hadAt = first.startsWith('@')
  if (hadAt) first = first.slice(1)

  if (!first) return refuse(`No path on ${origin}, so there is no account named in this link.`)

  // The handful of profile prefixes that are conventions rather than one site's choice:
  // Discourse and most forum software put a member at /u/ or /users/, and a CMS puts an
  // author at /author/. Reading the segment *after* one of these beats refusing it as a
  // reserved word and beats reading the prefix itself as a handle.
  if (!hadAt && GENERIC_PROFILE_PATHS.has(first.toLowerCase())) {
    const second = segs[1] ?? ''
    if (!second) {
      return refuse(
        `${origin}/${first} is a member list rather than one member — there is no name after it.`
      )
    }
    if (!HANDLE.test(second)) {
      return refuse(`"${second}" is not shaped like a handle, so this /${first}/ link names nobody usable.`)
    }
    return account(
      origin,
      second,
      `${origin} is not in the platform table, but /${first}/ is the usual place a site puts a member, so ${second} is read as the handle. Check it.`,
      {},
      url.toString()
    )
  }

  if (RESERVED.has(first.toLowerCase())) {
    return refuse(
      `"${first}" is a site page on ${origin}, not a handle. If that really is the account name, use the platform and handle fields below — they do not second-guess you.`
    )
  }
  if (/\.(html?|php|aspx?|jsp|json|xml|txt|pdf|jpe?g|png|gif|webp)$/i.test(first)) {
    return refuse(`"${first}" is a file on ${origin}, not an account.`)
  }
  if (!HANDLE.test(first)) {
    return refuse(`"${first}" is not shaped like a handle, and ${origin} is not a site this knows the URL shape of.`)
  }

  const trailing = segs.slice(1)
  return account(
    origin,
    first,
    hadAt
      ? `${origin} is not in the platform table, but an /@name path is the fediverse convention, so ${first} is read as the handle. Check it.`
      : `${origin} is not in the platform table. The first path segment is read as the handle, which is what most sites do — check it before running anything against it.${
          trailing.length ? ` The rest of the path (${trailing.join('/')}) is dropped.` : ''
        }`,
    {},
    url.toString()
  )
}

/* ------------------------------------------------------------------ *
 * The other way in: a platform and a handle
 * ------------------------------------------------------------------ */

/**
 * Build an account from a picked platform and a typed handle.
 *
 * `platform` is either a `PLATFORMS` id or a bare host for the "other" case. This is the
 * path for "I know their Discord, I do not have a link" — the composite value is derived
 * here rather than typed, which is the whole point of the field existing.
 */
export function accountFromHandle(platform: string, rawHandle: string): ParsedTarget | ParseFailure {
  const handle = (rawHandle ?? '').trim().replace(/^@+/, '')
  const rule = BY_ID.get(platform)

  // `://` rather than a bare scheme: a Bluesky handle can legitimately be `did:plc:…`.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(handle) || handle.includes('/')) {
    return refuse('That looks like a link rather than a handle. Paste it into the link field above and it will be read whole.')
  }

  const origin = rule ? rule.host : siteOrigin(platform)
  if (!origin || !origin.includes('.')) {
    return refuse(`"${platform}" is not a host. A platform is named by its site — github.com, mastodon.social, some-forum.co.uk.`)
  }
  if (!handle) return refuse('No handle yet.')
  if (/\s/.test(handle)) return refuse('A handle has no spaces in it. If this is a person’s name, add it as a person instead.')

  const shape = rule?.handle ?? HANDLE
  if (!shape.test(handle)) {
    return refuse(
      `"${handle}" is not shaped like a handle on ${origin}.${rule?.handleShape ? ` ${rule.handleShape}` : ''}`
    )
  }

  const url = rule ? rule.profileUrl(handle) : `https://${origin}/${handle}`
  return account(
    origin,
    handle,
    rule
      ? `${rule.label}: the same value a pasted ${rule.profileUrl(handle)} would produce.`
      : `${origin} is not in the platform table, so the value is built as ${origin}/${handle.toLowerCase()} — the same shape every other account uses.`,
    {},
    url
  )
}

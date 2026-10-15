/**
 * Reading profiles back out of captures that are already on disk, and mining them for the
 * next handle.
 *
 * The username tools do far more than answer "does this handle exist here". Maigret in
 * particular scrapes the page it lands on, and its report carries the display name, the
 * bio, the avatar URL, the profile location, per-platform handles the site itself
 * published, and — in two fields nothing in this app had ever read — `ids_usernames`, a
 * map of *other* handles it noticed, and `ids_links`, a list of URLs the profile points
 * at. A live capture in this repository has a Twitter profile whose `ids_links` is
 * `["https://www.twitch.tv/<handle>"]` and a TikTok bio containing a `linktr.ee` address.
 * All of that was being thrown away.
 *
 * So this module does two things, both pure and both re-derivable from bytes already in
 * the case folder:
 *
 *  1. **`profilesFrom(envelope)`** — turn one stored capture back into the profiles it
 *     observed, in a shape that does not care which tool produced it.
 *  2. **`pointersFrom(profile)`** — every *other* handle that profile names, with how it
 *     named it. A bio mention, a handle inside a linked URL, a display name that is itself
 *     shaped like a handle, or a per-platform id the site published.
 *
 * Extraction errs towards **fewer, better pointers**. A URL whose first path segment is
 * `about` or `status` is not a handle; a Discord invite code is not a handle; a YouTube
 * channel id is not a handle. Each of those would otherwise become a candidate the
 * operator has to read and dismiss, and a review queue nobody reads is the failure mode
 * the whole candidate design exists to avoid.
 */

import { parseJsonSafe, type RunEnvelope } from './envelope'
import { siteOrigin } from './sources'

/** One profile, as some tool observed it, flattened out of that tool's own shape. */
export interface ObservedProfile {
  /** `platform/handle`, the canonical account form. */
  key: string
  /** Site operator, folded by `siteOrigin` so two tools agree about one site. */
  platform: string
  handle: string
  url: string | null
  displayName: string | null
  bio: string | null
  avatarUrl: string | null
  /** Absolute URLs the profile itself points at. */
  links: string[]
  /** Handles the site or the tool named on this page, other than the profile's own. */
  namedHandles: string[]
  /** Free-text location field, when the profile published one. */
  location: string | null
  /** Adapter that observed it. */
  tool: string
  /** The handle the run was pointed at, which is how hop depth is counted. */
  aboutHandle: string
}

/** A handle one profile points at, and how. */
export interface PivotPointer {
  handle: string
  /** `''` when only a handle is known and no site was named. */
  platform: string
  url: string | null
  /** Human phrase for the claim: "in the bio", "in a linked URL", "as the display name". */
  via: string
  /** True when the profile published an explicit link to the other account. */
  explicitLink: boolean
}

/* ------------------------------------------------------------------ *
 * Reading captures
 * ------------------------------------------------------------------ */

/**
 * Every profile one stored envelope observed.
 *
 * Dispatches on `envelope.adapter` because the tools' report shapes have nothing in
 * common. An adapter this does not know contributes nothing rather than being guessed at:
 * a wrong extraction here becomes a wrong candidate downstream, and an empty result is
 * visible in the run summary while a fabricated one is not.
 */
export function profilesFrom(env: RunEnvelope): ObservedProfile[] {
  switch (env.adapter) {
    case 'maigret':
      return fromMaigret(env)
    case 'blackbird':
      return fromBlackbird(env)
    case 'reddit-profile':
      return fromReddit(env)
    default:
      return []
  }
}

/** Adapters `profilesFrom` can read. Named so the run summary can say what it skipped. */
export const PROFILE_SOURCES = ['maigret', 'blackbird', 'reddit-profile'] as const

interface MaigretIds {
  [key: string]: string | undefined
}

interface MaigretEntry {
  username?: string
  url_main?: string
  url_user?: string
  ids_usernames?: Record<string, string>
  ids_links?: string[]
  status?: { site_name?: string; url?: string; status?: string; ids?: MaigretIds }
}

/**
 * Maigret's report, which is the richest thing this app captures.
 *
 * `status.ids` is a flat bag of strings whose keys vary by site — `fullname` on GitHub,
 * `name` on SoundCloud, `bio` on YouTube and TikTok, `description` on Facebook. They are
 * folded here rather than at the call site so a new alias is one entry in a list.
 */
function fromMaigret(env: RunEnvelope): ObservedProfile[] {
  const name = Object.keys(env.artifacts).find((n) => /_simple\.json$/i.test(n))
  const report = parseJsonSafe<Record<string, MaigretEntry>>(name ? env.artifacts[name] : null)
  if (!report || typeof report !== 'object') return []

  const out: ObservedProfile[] = []
  for (const entry of Object.values(report)) {
    if (!entry || typeof entry !== 'object') continue
    if ((entry.status?.status ?? '').toLowerCase() !== 'claimed') continue
    const url = entry.status?.url || entry.url_user || entry.url_main || ''
    const platform = siteOrigin(url)
    if (!platform) continue
    const ids = entry.status?.ids ?? {}
    // `ids.username` is whatever the site called the field, and on Stack Overflow it is a
    // display name with a space in it. A handle with a space is not a handle, and letting
    // one through produced a profile keyed `stackoverflow.com/victor torvalds`.
    const handle = [ids['username'], entry.username, env.target]
      .map(clean)
      .find((h) => h && HANDLE_SHAPE.test(h))
    if (!handle) continue

    // Handles the site itself publishes for other services. These are the strongest kind
    // of pointer short of a link, because the platform is naming the account, not us.
    const named: string[] = []
    for (const key of PLATFORM_HANDLE_IDS) {
      const v = clean(ids[key])
      if (v) named.push(v)
    }
    for (const k of Object.keys(entry.ids_usernames ?? {})) {
      const v = clean(k)
      if (v) named.push(v)
    }

    const links: string[] = []
    for (const l of entry.ids_links ?? []) if (typeof l === 'string') links.push(l)
    // maigret writes some link lists as a Python repr rather than JSON, so
    // `"['https://www.twitch.tv/x']"` arrives as one string. Pull the URLs out of whatever
    // it is instead of trying to parse Python.
    for (const key of ['links', 'link', 'channel_url', 'website', 'url']) {
      const raw = ids[key]
      if (typeof raw === 'string') links.push(...absoluteUrls(raw))
    }

    out.push({
      key: `${platform}/${handle.toLowerCase()}`,
      platform,
      handle,
      url: url || null,
      displayName: firstOf(ids, DISPLAY_NAME_IDS),
      bio: firstOf(ids, BIO_IDS),
      avatarUrl: firstOf(ids, AVATAR_IDS),
      links: [...new Set(links)],
      namedHandles: [...new Set(named)],
      location: firstOf(ids, ['location', 'city']),
      tool: env.adapter,
      aboutHandle: clean(env.target)
    })
  }
  return out
}

/** Keys carrying a display name, in the order they should be preferred. */
const DISPLAY_NAME_IDS = ['fullname', 'name', 'full_name', 'display_name', 'nickname', 'title']
/** Keys carrying free-text profile prose. */
const BIO_IDS = ['bio', 'description', 'about', 'summary', 'status_text', 'keywords']
const AVATAR_IDS = ['image', 'avatar', 'picture', 'photo', 'imgur_profile_avatar_url', 'image_url']
/** Keys whose value is a handle on some *other* platform, published by this one. */
const PLATFORM_HANDLE_IDS = [
  'twitch_username',
  'tiktok_username',
  'imgur_username',
  'telegram_username',
  'instagram_username',
  'twitter_username',
  'github_username',
  'youtube_username'
]

interface BlackbirdHit {
  name?: string
  url?: string
  status?: string
  metadata?: unknown
}

/**
 * Blackbird, which contributes far less by design: five keys per hit, `metadata` null on
 * roughly nineteen of every twenty, and only three extractor names in existence across
 * every real capture in this repository — an avatar, a display name, and a course list.
 * It is included because the display name and the avatar it does occasionally return are
 * exactly the two things a pivot is scored on.
 */
function fromBlackbird(env: RunEnvelope): ObservedProfile[] {
  const name = Object.keys(env.artifacts).find((n) => /_blackbird\.json$/i.test(n))
  const hits = parseJsonSafe<BlackbirdHit[]>(name ? env.artifacts[name] : null)
  if (!Array.isArray(hits)) return []

  const out: ObservedProfile[] = []
  for (const hit of hits) {
    if (!hit || (hit.status ?? '').toUpperCase() !== 'FOUND') continue
    const platform = siteOrigin(hit.url || hit.name || '')
    if (!platform) continue
    const handle = clean(env.target)
    if (!handle) continue

    let displayName: string | null = null
    let avatarUrl: string | null = null
    if (Array.isArray(hit.metadata)) {
      for (const raw of hit.metadata) {
        const item = raw as { name?: string; type?: string; value?: unknown; prefix?: string }
        if (!item || typeof item.value !== 'string') continue
        const label = `${item.name ?? ''} ${item.type ?? ''}`.toLowerCase()
        const value = item.prefix && item.value.startsWith('//') ? item.prefix + item.value : item.value
        if (/\b(image|avatar|picture|photo)\b/.test(label) && /^https?:\/\//.test(value)) {
          avatarUrl ??= value
        } else if (/\bname\b/.test(label)) {
          displayName ??= value
        }
      }
    }

    out.push({
      key: `${platform}/${handle.toLowerCase()}`,
      platform,
      handle,
      url: hit.url ?? null,
      displayName,
      bio: null,
      avatarUrl,
      links: [],
      namedHandles: [],
      location: null,
      tool: env.adapter,
      aboutHandle: handle
    })
  }
  return out
}

interface RedditAbout {
  data?: {
    name?: string
    icon_img?: string
    subreddit?: { title?: string; public_description?: string }
  }
}

/** Reddit's own `about` document, when the endpoint answered rather than refusing us. */
function fromReddit(env: RunEnvelope): ObservedProfile[] {
  const name = Object.keys(env.artifacts).find((n) => /about/i.test(n) && /\.json$/i.test(n))
  const doc = parseJsonSafe<RedditAbout>(name ? env.artifacts[name] : null)
  const data = doc?.data
  if (!data) return []
  const handle = clean(data.name ?? env.target)
  if (!handle) return []
  return [
    {
      key: `reddit.com/${handle.toLowerCase()}`,
      platform: 'reddit.com',
      handle,
      url: `https://www.reddit.com/user/${handle}`,
      displayName: clean(data.subreddit?.title) || null,
      bio: clean(data.subreddit?.public_description) || null,
      // Reddit escapes its avatar URLs and hangs a cache-busting query on them.
      avatarUrl: data.icon_img ? data.icon_img.replace(/&amp;/g, '&').split('?')[0]! : null,
      links: [],
      namedHandles: [],
      location: null,
      tool: env.adapter,
      aboutHandle: clean(env.target)
    }
  ]
}

/* ------------------------------------------------------------------ *
 * Mining a profile for the next handle
 * ------------------------------------------------------------------ */

/**
 * Path segments that are never a handle. Every one of these produced a candidate in
 * testing that the operator would have had to read and throw away.
 */
const RESERVED_SEGMENTS = new Set([
  'about', 'help', 'home', 'login', 'signin', 'signup', 'register', 'search', 'explore',
  'settings', 'privacy', 'terms', 'legal', 'support', 'contact', 'blog', 'news', 'watch',
  'video', 'videos', 'status', 'statuses', 'posts', 'post', 'wiki', 'en', 'www', 'share',
  'download', 'downloads', 'pricing', 'docs', 'api', 'intent', 'hashtag', 'tag', 'tags',
  'i', 'p', 's', 'e', 'c', 'channel', 'playlist', 'invite', 'gift', 'store', 'shop',
  // The collection roots. `stackoverflow.com/users` is a link to the *directory*, and it
  // became a candidate account called "users" on the first real capture this ran against.
  'user', 'users', 'u', 'profile', 'profiles', 'people', 'member', 'members', 'in',
  'questions', 'answers', 'topics', 'trending', 'popular', 'discover', 'feed', 'null'
])

/** Sites whose first path segment is an opaque id rather than a handle. */
const NOT_A_HANDLE_HOST = /^(discord\.gg|discord\.com|bit\.ly|t\.co|tinyurl\.com|goo\.gl|lnk\.to)$/i

const HANDLE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/

/**
 * Hosts whose first path segment really is a handle.
 *
 * The generic rule — "take the first path segment of any link" — is what the first version
 * did, and a live run against a public target proved it wrong immediately: a SlideShare
 * profile links to `http://www.nasa.gov/connect`, and `connect` became a candidate account
 * called "connect on nasa.gov". It is a page on a website, not a person.
 *
 * So an unknown host now only yields a handle when the URL says so structurally — a
 * leading `@`, or a `/user/`-style prefix. Everything else has to be a site where the
 * convention is known. The list is short and deliberately so; missing a platform costs one
 * pivot that a later capture will find anyway, while guessing wrong costs a candidate the
 * operator has to read and throw away, and his complaint about this screen is already that
 * there is too much of that.
 *
 * `src/shared/platforms.ts` is growing a fuller table for the entity-adding form. These two
 * should be merged once it lands; they must not be allowed to disagree about what counts
 * as a profile URL.
 */
const HANDLE_AT_ROOT = new Set([
  'github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org', 'codeberg.org',
  'twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'twitch.tv', 'kick.com',
  't.me', 'telegram.me', 'soundcloud.com', 'medium.com', 'substack.com',
  'pinterest.com', 'vk.com', 'last.fm', 'about.me', 'linktr.ee', 'beacons.ai',
  'keybase.io', 'dev.to', 'hashnode.com', 'codepen.io', 'replit.com', 'kaggle.com',
  'dribbble.com', 'behance.net', 'flickr.com', 'deviantart.com', 'tumblr.com',
  'patreon.com', 'ko-fi.com', 'buymeacoffee.com', 'gumroad.com', 'itch.io',
  'bsky.app', 'mastodon.social', 'npmjs.com', 'imgur.com', 'gravatar.com',
  'letterboxd.com', 'myanimelist.net', 'wattpad.com', 'scribd.com', 'slideshare.net',
  'dailymotion.com', 'vimeo.com', 'producthunt.com', 'fiverr.com', 'chess.com'
])

/**
 * Turn a URL into the account it names, or nothing.
 *
 * The per-site table exists because the generic "first path segment" rule is wrong for
 * exactly the platforms that matter most: YouTube puts the handle behind `@`, Reddit
 * behind `user/`, and a YouTube `channel/UC…` id is not a handle at all.
 */
export function accountFromUrl(url: string): { platform: string; handle: string } | null {
  let parsed: URL
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const platform = siteOrigin(parsed.hostname)
  if (!platform || NOT_A_HANDLE_HOST.test(platform)) return null

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeSafe)
  if (segments.length === 0) return null

  let candidate = segments[0]!
  if (/^@/.test(candidate)) candidate = candidate.slice(1)
  else if (segments.length >= 2 && /^(user|users|u|profile|people|in|member|members|id)$/i.test(candidate)) {
    candidate = segments[1]!
  } else if (/^(channel|c)$/i.test(candidate)) {
    // youtube.com/channel/UC… is an opaque id; youtube.com/c/Name is a vanity name that is
    // not the handle the rest of the world uses. Neither is worth a candidate.
    return null
  } else if (!HANDLE_AT_ROOT.has(platform)) {
    // An unknown host with an ordinary path segment. That is a page, not a person.
    return null
  }

  if (RESERVED_SEGMENTS.has(candidate.toLowerCase())) return null
  if (!HANDLE_SHAPE.test(candidate)) return null
  if (!/[A-Za-z]/.test(candidate)) return null
  return { platform, handle: candidate }
}

const MENTION = /(?:^|[^\w@/])@([A-Za-z0-9][A-Za-z0-9._-]{2,31})\b/g
const ABSOLUTE_URL = /https?:\/\/[^\s<>"')\]]+/gi
/** `twitch.tv/name` with no scheme, which is how people actually write it in a bio. */
const BARE_URL = /\b((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,})\/([A-Za-z0-9@._-]{2,64})\b/gi

export function absoluteUrls(text: string): string[] {
  const out = [...(text.match(ABSOLUTE_URL) ?? [])].map((u) => u.replace(/[.,;:]+$/, ''))
  for (const m of text.matchAll(BARE_URL)) {
    if (/^https?:/i.test(m[0]!)) continue
    out.push(`https://${m[0]}`)
  }
  return [...new Set(out)]
}

/**
 * Every handle this profile points at, other than its own.
 *
 * The `explicitLink` flag is what separates the strongest signal in the set from the
 * others: a URL the subject put on his own profile is an assertion he made, where a
 * display name that happens to look like a handle is a guess we made.
 */
export function pointersFrom(profile: ObservedProfile): PivotPointer[] {
  const seen = new Map<string, PivotPointer>()
  const own = profile.handle.toLowerCase()
  /* Punctuation is not identity. A profile whose handle is `sameone` and whose display
     name is `same_one` was pointing at itself and proposing itself as a discovery. */
  const ownBare = bare(own)

  const add = (p: PivotPointer): void => {
    const handle = p.handle.trim()
    if (!HANDLE_SHAPE.test(handle)) return
    if (handle.toLowerCase() === own || bare(handle) === ownBare) return
    const key = `${p.platform}/${handle.toLowerCase()}`
    const existing = seen.get(key)
    // An explicit link outranks a guess about the same handle, so it wins the slot.
    if (!existing || (p.explicitLink && !existing.explicitLink)) seen.set(key, { ...p, handle })
  }

  const linkText = [...profile.links, ...absoluteUrls(profile.bio ?? '')]
  for (const url of linkText) {
    const account = accountFromUrl(url)
    if (!account) continue
    add({
      handle: account.handle,
      platform: account.platform,
      url,
      via: `a link on the profile to ${account.platform}`,
      explicitLink: true
    })
  }

  for (const m of (profile.bio ?? '').matchAll(MENTION)) {
    add({
      handle: m[1]!,
      platform: '',
      url: null,
      via: 'an @-mention in the profile text',
      explicitLink: false
    })
  }

  for (const named of profile.namedHandles) {
    add({
      handle: named,
      platform: '',
      url: null,
      via: `a handle ${profile.platform} publishes on this profile`,
      explicitLink: false
    })
  }

  /*
   * A display name is sometimes the person's handle on a platform with no separate
   * handle field. It is far more often just their name.
   *
   * The first real capture this ran against made the difference obvious: a Substack
   * profile with the handle `torvalds` shows the display name "Nicolas", and a Dailymotion
   * one shows "RCL". Both are different people who happen to share a handle, and both
   * became candidates that scored zero and cost the operator a decision. So a bare
   * capitalised word no longer qualifies: the name has to carry a digit or a separator —
   * the marks of a handle rather than a name — or be a recognisable variant of a handle
   * the case already holds, which the caller checks separately.
   */
  const display = (profile.displayName ?? '').trim()
  if (display && !/\s/.test(display) && HANDLE_SHAPE.test(display) && /[0-9._-]/.test(display)) {
    add({
      handle: display,
      platform: '',
      url: null,
      via: 'the display name, which is itself shaped like a handle',
      explicitLink: false
    })
  }

  return [...seen.values()]
}

/* ------------------------------------------------------------------ *
 * Bio text
 * ------------------------------------------------------------------ */

/**
 * Words too common to mean anything when two bios share them.
 *
 * Short and deliberately so. The rarity floor below does most of the work — a shared
 * three-word phrase of at least sixteen characters is already unusual — and a long stop
 * list starts throwing away the parts of a bio that are actually distinctive.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'with', 'that', 'this', 'from', 'have', 'has', 'not',
  'but', 'all', 'are', 'was', 'were', 'his', 'her', 'their', 'its', 'our', 'out', 'about',
  'into', 'over', 'just', 'now', 'new', 'here', 'there', 'more', 'most', 'some', 'any',
  'can', 'will', 'would', 'should', 'may', 'one', 'two', 'who', 'what', 'when', 'where',
  'how', 'why', 'made', 'make', 'like', 'love', 'life', 'work', 'time', 'day', 'days',
  'follow', 'following', 'followers', 'subscribe', 'check', 'link', 'bio', 'dm', 'dms',
  'business', 'inquiries', 'contact', 'email', 'opinions', 'own', 'views', 'my', 'me',
  'software', 'engineer', 'developer', 'student', 'content', 'creator', 'official',
  'he', 'him', 'she', 'they', 'them', 'his/him', 'she/her', 'they/them'
])

/** Phrases so common in bios that sharing one says nothing. */
const COMMON_PHRASES = [
  'opinions are my own',
  'views are my own',
  'views my own',
  'link in bio',
  'dm for business',
  'business inquiries',
  'all rights reserved',
  'content creator',
  'software engineer',
  'full stack developer',
  'just a guy',
  'living the dream'
]

/** Shortest shared phrase worth reporting, in characters. Three words rarely reach it. */
export const BIO_PHRASE_FLOOR = 16

function normaliseBio(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // URLs and @-mentions are handled by the link signal; leaving them here would let one
    // piece of evidence fire two signals and double its weight.
    .replace(ABSOLUTE_URL, ' ')
    .replace(/@[A-Za-z0-9._-]+/g, ' ')
    .replace(/[^a-z0-9']+/g, ' ')
    .split(' ')
    .filter(Boolean)
}

/**
 * The longest distinctive phrase two bios share, or null.
 *
 * Word n-grams rather than characters, with a length floor and a stop list, because
 * character overlap between any two English sentences is enormous and means nothing. The
 * phrase must be at least three words, must reach `BIO_PHRASE_FLOOR` characters, must not
 * consist only of stopwords, and must not be one of the bio clichés above.
 */
export function sharedBioPhrase(a: string | null, b: string | null): string | null {
  if (!a || !b) return null
  const wa = normaliseBio(a)
  const wb = normaliseBio(b)
  if (wa.length < 3 || wb.length < 3) return null

  const bGrams = new Set<string>()
  for (let n = 3; n <= 8; n++) {
    for (let i = 0; i + n <= wb.length; i++) bGrams.add(wb.slice(i, i + n).join(' '))
  }

  let best: string | null = null
  for (let n = 8; n >= 3; n--) {
    for (let i = 0; i + n <= wa.length; i++) {
      const words = wa.slice(i, i + n)
      const phrase = words.join(' ')
      if (!bGrams.has(phrase)) continue
      if (phrase.length < BIO_PHRASE_FLOOR) continue
      if (words.every((w) => STOPWORDS.has(w))) continue
      if (COMMON_PHRASES.includes(phrase)) continue
      // At least two words in the phrase have to be carrying meaning.
      if (words.filter((w) => !STOPWORDS.has(w) && w.length > 2).length < 2) continue
      if (!best || phrase.length > best.length) best = phrase
    }
    if (best) return best
  }
  return best
}

/**
 * Whether two handles are variants of one another: `foo` and `foo_dev`, `foo` and `xfoox`.
 *
 * The weakest signal in the set, and it is here only because its absence is informative —
 * a completely unrelated handle found through an explicit link is a *stronger* finding
 * than a similar one, since nobody reaches an unrelated handle by coincidence.
 */
export function handlesAreVariants(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[._-]/g, '')
  const y = b.toLowerCase().replace(/[._-]/g, '')
  if (x === y) return true
  if (x.length < 4 || y.length < 4) return false
  return x.includes(y) || y.includes(x)
}

/** A handle with its separators removed, for comparing one against itself. */
function bare(handle: string): string {
  return handle.toLowerCase().replace(/[._-]/g, '')
}

function clean(v: string | undefined | null): string {
  return (v ?? '').toString().trim()
}

function firstOf(ids: MaigretIds, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = clean(ids[k])
    if (v && v.toLowerCase() !== 'none' && v.toLowerCase() !== 'null') return v
  }
  return null
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

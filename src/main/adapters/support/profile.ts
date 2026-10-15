/**
 * Reading the page a person wrote about themselves.
 *
 * ## What this is, stated honestly
 *
 * Nothing in this file finds anybody's city. It reads **text the subject published on
 * their own profile** — a `location` field they filled in, a bio they wrote, a link they
 * added to their sidebar — and copies it into the case with the site's name attached.
 * "Portland, OR" on a GitHub profile is a **claim its owner typed**. It may be a former
 * city, a joke, a band, a lie told deliberately to poison exactly this kind of lookup, or
 * a place they have never been. It is a lead. It is never a fact, and the adapter that
 * uses this module emits every value at `unverified` like everything else in the app.
 *
 * The reason it is worth doing anyway is that a username sweep answers a much weaker
 * question than it appears to. "An account named `foo` exists on GitHub" is compatible
 * with `foo` being anybody. The profile *behind* that account is where the information
 * that discriminates lives: a display name, a city, a bio, a picture, and above all the
 * **outbound links the person put there themselves**, which are the only assertion of
 * "these two accounts are mine" that comes from the subject rather than from a guess.
 *
 * ## Two sources, one shape
 *
 *  1. **Captures the app already has.** Maigret's per-site `status.ids` block carries
 *     `fullname`, `location`, `image`, `created_at`, `follower_count`, `company` and more
 *     for every site whose extractor fired. That data is already on disk in
 *     `cases/<id>/raw/` and until now was flattened into one sentence per field and
 *     otherwise dropped. `fromMaigretIds` reads it back out.
 *  2. **A direct fetch of a public profile endpoint**, where a stable unauthenticated one
 *     exists — `api.github.com/users/<h>`, Steam's `?xml=1` profile, the Bluesky public
 *     appview. `PROFILE_PROVIDERS` is that table.
 *
 * Both land in one `ExtractedProfile`, so the adapter, the gallery and the export do not
 * care which route produced a given field.
 *
 * ## Rules this module keeps
 *
 * - **Public and unauthenticated only.** No cookie, no token, no logged-in scrape. That
 *   is a terms-of-service breach on every platform worth naming and a ban risk on the
 *   operator's own account, and it would also make the result a lie: the whole question a
 *   self-audit asks is what a stranger can see, and a logged-in view is not that.
 * - **One request per profile.** No crawling, no pagination, no following the links found.
 *   What a person sees when they open the page, and nothing further.
 * - **Extraction is pure.** Every `extract` here takes a string and returns fields. That
 *   is what lets `parse()` stay pure while `run()` does the fetching, and what makes a
 *   fixed extractor re-derivable from a capture made a year ago.
 * - **Nothing is inferred.** A city is copied out of a `location` field verbatim. No
 *   geocoding, no "Sofia is in Bulgaria", no parsing a bio for place names — a regex that
 *   decides a bio "mentions a city" is a fabrication engine, and the operator would have
 *   no way to see that the site never said it.
 */

/** A link the profile itself declares. `rel` records how it was declared, not what it is. */
export interface ProfileLink {
  url: string
  /**
   * - `website`  — the platform's own "website" field. The subject typed it into a box.
   * - `rel-me`   — an `<a rel="me">`, the IndieWeb identity-claim convention.
   * - `verified` — the platform says it checked the link (Keybase proofs, Mastodon
   *                verified links). Still the subject's claim; the platform only
   *                confirmed the far end links back.
   * - `bio`      — a URL that appeared inside the bio text.
   */
  rel: 'website' | 'rel-me' | 'verified' | 'bio'
}

/**
 * One profile, as one source described it.
 *
 * Every field is nullable and stays null when the site did not say. An empty string is
 * never used as "absent": "the site published an empty location" and "the site has no
 * location field" are different facts and the second one is the common one.
 */
export interface ExtractedProfile {
  /** Folded site origin — `github.com`. The `Finding.source` this profile's claims carry. */
  platform: string
  handle: string
  url: string | null
  displayName: string | null
  /**
   * A legal/real name where the platform has a *separate* field for one.
   *
   * Steam is the case that forces this: `steamID` is the persona everyone sees and
   * `realname` is a second, optional box. Folding them into one field would lose which of
   * the two the site actually called a real name, and that difference is the whole
   * distinction between a nickname and an identification.
   */
  realName: string | null
  /** Verbatim, as typed by the account holder. Never geocoded, never normalised. */
  location: string | null
  bio: string | null
  avatarUrl: string | null
  /** Whatever date string the site gave. Not re-formatted — the site's precision is data. */
  joinedAt: string | null
  followers: number | null
  following: number | null
  company: string | null
  email: string | null
  links: ProfileLink[]
  /** How this was read: `github-api`, `maigret:GitHub`, `html:opengraph`. */
  via: string
}

export function emptyProfile(platform: string, handle: string, via: string): ExtractedProfile {
  return {
    platform,
    handle,
    url: null,
    displayName: null,
    realName: null,
    location: null,
    bio: null,
    avatarUrl: null,
    joinedAt: null,
    followers: null,
    following: null,
    company: null,
    email: null,
    links: [],
    via
  }
}

/** True when the profile carries nothing beyond the identifiers it was built from. */
export function isEmptyProfile(p: ExtractedProfile): boolean {
  return (
    p.displayName === null &&
    p.realName === null &&
    p.location === null &&
    p.bio === null &&
    p.avatarUrl === null &&
    p.joinedAt === null &&
    p.followers === null &&
    p.following === null &&
    p.company === null &&
    p.email === null &&
    p.links.length === 0
  )
}

/* ------------------------------------------------------------------ *
 * Scrubbing values on the way in
 * ------------------------------------------------------------------ */

const MAX_BIO = 600
const MAX_FIELD = 200

/** Collapse whitespace, cut to a sane length, and return null for anything empty. */
export function clean(v: unknown, max = MAX_FIELD): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function cleanBio(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // Newlines survive as single spaces: a bio's line breaks are formatting, and the export
  // renders it as a quoted line rather than as the author's layout.
  return clean(v, MAX_BIO)
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^\d{1,12}$/.test(v.trim())) return Number(v.trim())
  return null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function email(v: unknown): string | null {
  const t = clean(v)
  return t !== null && EMAIL_RE.test(t) ? t.toLowerCase() : null
}

/**
 * Accept a URL only if it is a plain public http(s) one.
 *
 * These strings arrive inside third-party JSON, so they are attacker-influenced by
 * construction. Anything that is not http(s) is dropped rather than recorded: a
 * `javascript:` or `data:` "website" is not a lead, and the export inlines and renders
 * what it is given.
 */
export function cleanUrl(v: unknown): string | null {
  const t = clean(v, 500)
  if (t === null) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (!u.hostname.includes('.')) return null
    return u.toString()
  } catch {
    return null
  }
}

function addLink(p: ExtractedProfile, url: unknown, rel: ProfileLink['rel']): void {
  const clean = cleanUrl(url)
  if (clean === null) return
  if (p.links.some((l) => l.url === clean)) return
  if (p.links.length >= 24) return
  p.links.push({ url: clean, rel })
}

/* ------------------------------------------------------------------ *
 * Default avatars
 * ------------------------------------------------------------------ */

/**
 * Is this the platform's stock picture rather than this account's?
 *
 * The avatar gallery's whole claim is "two accounts sharing a picture are probably one
 * person". A default matching a default is the strongest possible signal fired on the
 * weakest possible evidence — every user of that platform has the identical file — so
 * defaults are excluded from grouping and shown separately.
 *
 * Detected from the URL, before anything is fetched, because that is where the evidence
 * actually is: Twitter answers `default_profile_images/default_profile.png`, Gravatar
 * serves a generated identicon when `d=identicon` is asked for, GitHub's fallback lives
 * under `/identicons/`. A hash-based rule would need a corpus of every platform's default
 * and would silently rot; a URL rule is legible and its misses are visible.
 *
 * The direction of the error is deliberate: an over-eager match costs one picture in the
 * gallery, a missed one manufactures a "match" between two strangers.
 */
export function isDefaultAvatar(url: string): boolean {
  const u = (url ?? '').trim()
  if (!u) return true
  let path = u
  let query = ''
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`)
    path = parsed.pathname
    query = parsed.search
    if (/(^|\.)gravatar\.com$/i.test(parsed.hostname) && /[?&]d=(identicon|monsterid|wavatar|retro|robohash|mp|mm|blank)/i.test(query)) {
      return true
    }
    if (/(^|\.)ui-avatars\.com$/i.test(parsed.hostname)) return true
    if (/(^|\.)gravatar\.com$/i.test(parsed.hostname) && /\/avatar\/0{16,}/.test(path)) return true
  } catch {
    /* fall through to the string tests */
  }
  if (/\/identicons?\//i.test(path)) return true
  if (/default_profile_images/i.test(path)) return true
  const last = path.split('/').filter(Boolean).pop() ?? ''
  return /^(default|blank|no[-_]?avatar|noavatar|placeholder|anonymous|mystery|avatar[-_]?default|user[-_]?default)[-_.a-z0-9]*$/i.test(
    last
  )
}

/* ------------------------------------------------------------------ *
 * Route 1 — the capture the app already has
 * ------------------------------------------------------------------ */

/**
 * Maigret's `status.ids` block, read back into a profile.
 *
 * This is the "already captured and thrown away" half of the feature. Maigret runs a
 * per-site extractor after a hit and puts everything it scraped in here; the adapter's own
 * parser turns each field into one English sentence and nothing keeps the structure. Field
 * names vary by extractor (`fullname` on GitHub, `name` on SoundCloud), so the aliases
 * below are read in order and the first present one wins.
 *
 * `_extractor` is carried into `via` because it is the honest provenance: `GitHub API` and
 * `Facebook user profile` are very different things to have read a name off.
 */
export function fromMaigretIds(
  platform: string,
  handle: string,
  siteLabel: string,
  ids: Record<string, unknown>,
  url: string | null
): ExtractedProfile {
  const extractor = clean(ids['_extractor']) ?? siteLabel
  const p = emptyProfile(platform, handle, `maigret:${extractor}`)
  p.url = cleanUrl(url)

  p.displayName = clean(ids['fullname'] ?? ids['name'] ?? ids['display_name'])
  p.realName = clean(ids['realname'] ?? ids['real_name'])
  p.location = clean(ids['location'] ?? ids['city'] ?? ids['country'] ?? ids['region'])
  p.bio = cleanBio(ids['bio'] ?? ids['description'] ?? ids['about'] ?? ids['summary'] ?? ids['status'])
  p.avatarUrl = cleanUrl(ids['image'] ?? ids['avatar'] ?? ids['image_url'] ?? ids['avatar_url'])
  p.joinedAt = clean(ids['created_at'] ?? ids['joined'] ?? ids['registered'] ?? ids['member_since'])
  p.followers = num(ids['follower_count'] ?? ids['followers'] ?? ids['followers_count'])
  p.following = num(ids['following_count'] ?? ids['following'] ?? ids['follows_count'])
  p.company = clean(ids['company'] ?? ids['organization'] ?? ids['organisation'] ?? ids['employer'])
  p.email = email(ids['email'])

  addLink(p, ids['website'], 'website')
  addLink(p, ids['url'], 'website')
  addLink(p, ids['blog'], 'website')
  addLink(p, ids['external_url'], 'website')
  // Maigret's own cross-platform hint: a handle it read off the page, which it then
  // recursively searches. Recorded as a bio-level claim, not as a verified link.
  const twitter = clean(ids['twitter_username'] ?? ids['twitter'])
  if (twitter !== null && /^[A-Za-z0-9_]{1,20}$/.test(twitter)) {
    addLink(p, `https://twitter.com/${twitter}`, 'bio')
  }
  return p
}

/**
 * Every `ids` block in a maigret `report_<user>_simple.json`, as profiles.
 *
 * Returns `[]` for anything unreadable rather than throwing: the caller is `parse()`, and
 * a malformed capture is an expected condition that must leave the raw file on disk to be
 * re-read once the reader is fixed.
 */
export function profilesFromMaigretReport(reportJson: unknown, foldHost: (u: string) => string): ExtractedProfile[] {
  if (!reportJson || typeof reportJson !== 'object' || Array.isArray(reportJson)) return []
  const out: ExtractedProfile[] = []
  for (const [siteName, value] of Object.entries(reportJson as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as {
      username?: unknown
      url_user?: unknown
      status?: { status?: unknown; ids?: unknown; url?: unknown; site_name?: unknown }
    }
    if (clean(entry.status?.status)?.toLowerCase() !== 'claimed') continue
    const ids = entry.status?.ids
    if (!ids || typeof ids !== 'object' || Array.isArray(ids)) continue
    const url = cleanUrl(entry.status?.url ?? entry.url_user)
    const platform = url !== null ? foldHost(url) : ''
    if (!platform) continue
    const handle = clean(entry.username) ?? ''
    const profile = fromMaigretIds(
      platform,
      handle,
      clean(entry.status?.site_name) ?? siteName,
      ids as Record<string, unknown>,
      url
    )
    if (!isEmptyProfile(profile)) out.push(profile)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Route 2 — a public endpoint, fetched directly
 * ------------------------------------------------------------------ */

export interface ProfileProvider {
  id: string
  /** Site origins, already folded by `siteOrigin`, that this provider answers for. */
  hosts: string[]
  /** One line for the claim and the doc panel: what is actually being requested. */
  what: string
  /** `Accept` header. Some of these serve HTML unless asked otherwise. */
  accept: string
  /** The public, unauthenticated URL for this handle, or null if the handle is unusable. */
  endpoint(handle: string): string | null
  /** Pure. Body in, fields out. Returns null when the body is not what was expected. */
  extract(body: string, handle: string): Partial<ExtractedProfile> | null
}

function json(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A handle safe to interpolate into a path segment. Anything else gets no request. */
function safeHandle(handle: string, re = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/): string | null {
  const h = (handle ?? '').trim().replace(/^@/, '')
  return re.test(h) ? h : null
}

const linksFrom = (p: Partial<ExtractedProfile>): ProfileLink[] => p.links ?? []

/**
 * The provider table.
 *
 * Every entry is a documented, public, keyless endpoint that answers about one handle.
 * Nothing here needs a session and nothing here is a scrape of a logged-in view. Sites
 * that only answer to an authenticated client are deliberately absent — Reddit answers
 * 403 to unauthenticated clients from this machine (DECISIONS.md records the measurement),
 * and an entry that always fails would read as "nothing there".
 */
export const PROFILE_PROVIDERS: ProfileProvider[] = [
  {
    id: 'github-api',
    hosts: ['github.com'],
    what: "GitHub's public REST user endpoint",
    accept: 'application/vnd.github+json',
    endpoint: (h) => {
      const s = safeHandle(h, /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/)
      return s === null ? null : `https://api.github.com/users/${encodeURIComponent(s)}`
    },
    extract(body) {
      const d = json(body)
      if (d === null || typeof d['login'] !== 'string') return null
      const out: Partial<ExtractedProfile> = {
        url: cleanUrl(d['html_url']),
        displayName: clean(d['name']),
        location: clean(d['location']),
        bio: cleanBio(d['bio']),
        avatarUrl: cleanUrl(d['avatar_url']),
        joinedAt: clean(d['created_at']),
        followers: num(d['followers']),
        following: num(d['following']),
        company: clean(d['company']),
        email: email(d['email']),
        links: []
      }
      const links = linksFrom(out)
      const blog = cleanUrl(d['blog'])
      if (blog !== null) links.push({ url: blog, rel: 'website' })
      const tw = clean(d['twitter_username'])
      if (tw !== null && /^[A-Za-z0-9_]{1,20}$/.test(tw)) {
        links.push({ url: `https://twitter.com/${tw}`, rel: 'website' })
      }
      return out
    }
  },
  {
    id: 'gitlab-api',
    hosts: ['gitlab.com'],
    what: "GitLab's public users API, queried by username",
    accept: 'application/json',
    endpoint: (h) => {
      const s = safeHandle(h)
      return s === null ? null : `https://gitlab.com/api/v4/users?username=${encodeURIComponent(s)}`
    },
    extract(body) {
      let arr: unknown
      try {
        arr = JSON.parse(body)
      } catch {
        return null
      }
      if (!Array.isArray(arr) || arr.length === 0) return null
      const d = arr[0] as Record<string, unknown>
      const out: Partial<ExtractedProfile> = {
        url: cleanUrl(d['web_url']),
        displayName: clean(d['name']),
        location: clean(d['location']),
        bio: cleanBio(d['bio']),
        avatarUrl: cleanUrl(d['avatar_url']),
        joinedAt: clean(d['created_at']),
        company: clean(d['organization'] ?? d['job_title']),
        links: []
      }
      const links = linksFrom(out)
      const site = cleanUrl(d['website_url'])
      if (site !== null) links.push({ url: site, rel: 'website' })
      return out
    }
  },
  {
    id: 'gitea-api',
    hosts: ['codeberg.org'],
    what: "Codeberg's Gitea user API",
    accept: 'application/json',
    endpoint: (h) => {
      const s = safeHandle(h)
      return s === null ? null : `https://codeberg.org/api/v1/users/${encodeURIComponent(s)}`
    },
    extract(body) {
      const d = json(body)
      if (d === null || typeof d['login'] !== 'string') return null
      const out: Partial<ExtractedProfile> = {
        url: cleanUrl(d['html_url']),
        displayName: clean(d['full_name']),
        location: clean(d['location']),
        bio: cleanBio(d['description']),
        avatarUrl: cleanUrl(d['avatar_url']),
        joinedAt: clean(d['created']),
        followers: num(d['followers_count']),
        following: num(d['following_count']),
        email: email(d['email']),
        links: []
      }
      const site = cleanUrl(d['website'])
      if (site !== null) linksFrom(out).push({ url: site, rel: 'website' })
      return out
    }
  },
  {
    id: 'steam-xml',
    hosts: ['steamcommunity.com'],
    what: "Steam's public community profile in its own XML form",
    accept: 'text/xml, application/xml',
    endpoint: (h) => {
      const s = safeHandle(h)
      return s === null ? null : `https://steamcommunity.com/id/${encodeURIComponent(s)}?xml=1`
    },
    extract(body, handle) {
      if (!/<profile\b/i.test(body)) return null
      const tag = (name: string): string | null => {
        const m = new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${name}>`, 'i').exec(body)
        return m === null ? null : clean(stripTags(m[1]), name === 'summary' ? MAX_BIO : MAX_FIELD)
      }
      return {
        url: `https://steamcommunity.com/id/${handle}`,
        displayName: tag('steamID'),
        location: tag('location'),
        bio: tag('summary'),
        avatarUrl: cleanUrl(tag('avatarFull') ?? tag('avatarMedium')),
        realName: tag('realname'),
        joinedAt: tag('memberSince'),
        links: []
      }
    }
  },
  {
    id: 'hn-api',
    // Both spellings: `siteOrigin` folds `news.ycombinator.com` to its registrable domain,
    // and the account's platform reaches this function already folded.
    hosts: ['ycombinator.com', 'news.ycombinator.com'],
    what: "Hacker News's public Firebase user record",
    accept: 'application/json',
    endpoint: (h) => {
      const s = safeHandle(h)
      return s === null ? null : `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(s)}.json`
    },
    extract(body, handle) {
      const d = json(body)
      if (d === null || typeof d['id'] !== 'string') return null
      const created = num(d['created'])
      const out: Partial<ExtractedProfile> = {
        url: `https://news.ycombinator.com/user?id=${handle}`,
        bio: cleanBio(stripTags(typeof d['about'] === 'string' ? d['about'] : '')),
        // The API gives a Unix second; the ISO form is a re-encoding of the site's own
        // number, not an inference about it.
        joinedAt: created === null ? null : new Date(created * 1000).toISOString(),
        links: []
      }
      for (const url of urlsIn(typeof d['about'] === 'string' ? d['about'] : '')) {
        linksFrom(out).push({ url, rel: 'bio' })
      }
      return out
    }
  },
  {
    id: 'keybase-api',
    hosts: ['keybase.io'],
    what: "Keybase's public user lookup, including the cryptographic proofs it holds",
    accept: 'application/json',
    endpoint: (h) => {
      const s = safeHandle(h)
      return s === null ? null : `https://keybase.io/_/api/1.0/user/lookup.json?username=${encodeURIComponent(s)}`
    },
    extract(body) {
      const d = json(body)
      const them = d?.['them']
      if (!them || typeof them !== 'object') return null
      const t = them as Record<string, unknown>
      const basics = (t['basics'] ?? {}) as Record<string, unknown>
      const profile = (t['profile'] ?? {}) as Record<string, unknown>
      const pictures = (t['pictures'] ?? {}) as Record<string, unknown>
      const primary = (pictures['primary'] ?? {}) as Record<string, unknown>
      const created = num(basics['ctime'])
      const out: Partial<ExtractedProfile> = {
        url: typeof basics['username'] === 'string' ? `https://keybase.io/${basics['username']}` : null,
        displayName: clean(profile['full_name']),
        location: clean(profile['location']),
        bio: cleanBio(profile['bio']),
        avatarUrl: cleanUrl(primary['url']),
        joinedAt: created === null ? null : new Date(created * 1000).toISOString(),
        links: []
      }
      // Keybase proofs are the strongest declared link in this table: the subject signed a
      // statement and the far end was checked. Still the subject's own claim of ownership.
      const proofs = (t['proofs_summary'] ?? {}) as Record<string, unknown>
      const all = Array.isArray(proofs['all']) ? (proofs['all'] as unknown[]) : []
      for (const proof of all.slice(0, 24)) {
        if (!proof || typeof proof !== 'object') continue
        const url = cleanUrl((proof as Record<string, unknown>)['service_url'])
        if (url !== null) linksFrom(out).push({ url, rel: 'verified' })
      }
      return out
    }
  },
  {
    id: 'bluesky-appview',
    hosts: ['bsky.app'],
    what: "Bluesky's public AppView profile endpoint",
    accept: 'application/json',
    endpoint: (h) => {
      const s = (h ?? '').trim().replace(/^@/, '')
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(s)) return null
      const actor = s.includes('.') ? s : `${s}.bsky.social`
      return `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
    },
    extract(body) {
      const d = json(body)
      if (d === null || typeof d['handle'] !== 'string') return null
      const out: Partial<ExtractedProfile> = {
        url: `https://bsky.app/profile/${d['handle']}`,
        displayName: clean(d['displayName']),
        bio: cleanBio(d['description']),
        avatarUrl: cleanUrl(d['avatar']),
        joinedAt: clean(d['createdAt']),
        followers: num(d['followersCount']),
        following: num(d['followsCount']),
        links: []
      }
      for (const url of urlsIn(typeof d['description'] === 'string' ? d['description'] : '')) {
        linksFrom(out).push({ url, rel: 'bio' })
      }
      return out
    }
  },
  {
    id: 'devto-api',
    hosts: ['dev.to'],
    what: "DEV's public user API",
    accept: 'application/json',
    endpoint: (h) => {
      const s = safeHandle(h)
      return s === null ? null : `https://dev.to/api/users/by_username?url=${encodeURIComponent(s)}`
    },
    extract(body) {
      const d = json(body)
      if (d === null || typeof d['username'] !== 'string') return null
      const out: Partial<ExtractedProfile> = {
        url: `https://dev.to/${d['username']}`,
        displayName: clean(d['name']),
        location: clean(d['location']),
        bio: cleanBio(d['summary']),
        avatarUrl: cleanUrl(d['profile_image']),
        joinedAt: clean(d['joined_at']),
        links: []
      }
      const links = linksFrom(out)
      const site = cleanUrl(d['website_url'])
      if (site !== null) links.push({ url: site, rel: 'website' })
      for (const key of ['github_username', 'twitter_username']) {
        const v = clean(d[key])
        if (v === null || !/^[A-Za-z0-9_-]{1,40}$/.test(v)) continue
        links.push({ url: key.startsWith('github') ? `https://github.com/${v}` : `https://twitter.com/${v}`, rel: 'website' })
      }
      return out
    }
  },
  {
    id: 'mastodon-api',
    hosts: ['mastodon.social', 'fosstodon.org', 'hachyderm.io', 'mstdn.social', 'infosec.exchange'],
    what: "the Mastodon instance's public account lookup",
    accept: 'application/json',
    endpoint: () => null, // filled in by `endpointFor`, which knows the instance host
    extract(body) {
      const d = json(body)
      if (d === null || typeof d['acct'] !== 'string') return null
      const out: Partial<ExtractedProfile> = {
        url: cleanUrl(d['url']),
        displayName: clean(d['display_name']),
        bio: cleanBio(stripTags(typeof d['note'] === 'string' ? d['note'] : '')),
        avatarUrl: cleanUrl(d['avatar_static'] ?? d['avatar']),
        joinedAt: clean(d['created_at']),
        followers: num(d['followers_count']),
        following: num(d['following_count']),
        links: []
      }
      const fields = Array.isArray(d['fields']) ? (d['fields'] as unknown[]) : []
      for (const field of fields.slice(0, 8)) {
        if (!field || typeof field !== 'object') continue
        const f = field as Record<string, unknown>
        for (const url of urlsIn(typeof f['value'] === 'string' ? f['value'] : '')) {
          // `verified_at` is Mastodon confirming the far end links back with rel="me".
          linksFrom(out).push({ url, rel: f['verified_at'] ? 'verified' : 'website' })
        }
      }
      return out
    }
  }
]

/** Every site origin the table above answers for. */
export const PROFILE_PROVIDER_HOSTS: readonly string[] = [...new Set(PROFILE_PROVIDERS.flatMap((p) => p.hosts))]

/**
 * The provider for a site, and the URL to ask it.
 *
 * Mastodon is the one entry whose endpoint depends on which host the account is on, so
 * the host is threaded in here rather than baked into the table.
 */
export function endpointFor(platform: string, handle: string): { provider: ProfileProvider; url: string } | null {
  const host = (platform ?? '').trim().toLowerCase()
  for (const provider of PROFILE_PROVIDERS) {
    if (!provider.hosts.includes(host)) continue
    if (provider.id === 'mastodon-api') {
      const s = (handle ?? '').trim().replace(/^@/, '')
      if (!/^[A-Za-z0-9_]{1,30}$/.test(s)) return null
      return { provider, url: `https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(s)}` }
    }
    const url = provider.endpoint(handle)
    if (url !== null) return { provider, url }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * The generic reader — Open Graph and rel="me"
 * ------------------------------------------------------------------ */

/** Strip tags and decode the five entities that actually appear in profile text. */
export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
}

/** Bare http(s) URLs inside a run of text. Used on bios and profile fields only. */
export function urlsIn(text: string): string[] {
  const out: string[] = []
  const re = /https?:\/\/[^\s<>"'()]{4,300}/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && out.length < 12) {
    const u = cleanUrl(m[0].replace(/[.,;:]+$/, ''))
    if (u !== null && !out.includes(u)) out.push(u)
  }
  return out
}

function metaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  const re = new RegExp(
    `<meta[^>]*\\b${attr}\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i'
  )
  const tag = re.exec(html)?.[0]
  if (!tag) return null
  const content = /\bcontent\s*=\s*["']([\s\S]*?)["']/i.exec(tag)?.[1]
  return content === undefined ? null : clean(stripTags(content), MAX_BIO)
}

/**
 * What a browser would show for a page nobody wrote a provider for.
 *
 * Open Graph tags are metadata the *site* publishes about the page, and `rel="me"` is the
 * IndieWeb convention for "this other URL is also me" — the closest thing on the open web
 * to a subject-asserted account link. Both are read from the page as served to a
 * logged-out client, which is exactly the view a self-audit is asking about.
 *
 * Deliberately conservative: no heuristic hunt for a `class="location"`, no guessing which
 * `<h1>` is a display name. A wrong field here would be indistinguishable from a real one
 * in the export, and the export is the document a person is going to believe.
 */
export function fromHtml(platform: string, handle: string, html: string, pageUrl: string): ExtractedProfile {
  const p = emptyProfile(platform, handle, 'html:opengraph')
  p.url = cleanUrl(metaContent(html, 'property', 'og:url') ?? pageUrl)

  const ogTitle = metaContent(html, 'property', 'og:title')
  const title = ogTitle ?? clean(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''))
  // A page title is the page's title, not a person's name. It is recorded as the display
  // name only when the site went to the trouble of an og:title, which on a profile page is
  // the account's own name far more often than not — and the export labels it as
  // "the name shown on the page", never as "their name".
  if (ogTitle !== null) p.displayName = ogTitle
  else if (title !== null && title.length <= 80) p.displayName = title

  p.bio = metaContent(html, 'property', 'og:description') ?? metaContent(html, 'name', 'description')
  p.avatarUrl = cleanUrl(metaContent(html, 'property', 'og:image') ?? metaContent(html, 'name', 'twitter:image'))

  const relMe = /<a[^>]*\brel\s*=\s*["'][^"']*\bme\b[^"']*["'][^>]*>/gi
  let tag: RegExpExecArray | null
  while ((tag = relMe.exec(html)) !== null && p.links.length < 24) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1]
    addLink(p, href, 'rel-me')
  }
  if (p.bio !== null) for (const url of urlsIn(p.bio)) addLink(p, url, 'bio')
  return p
}

/* ------------------------------------------------------------------ *
 * Merging
 * ------------------------------------------------------------------ */

/**
 * Fold several readings of one account into one profile.
 *
 * First non-null wins, so callers pass the more authoritative reading first — a direct
 * fetch of the site's own API before a maigret extractor's copy of it. Links union rather
 * than compete, because two readers finding different links both found real ones.
 *
 * `via` accumulates, so the export can always say which readings a value could have come
 * from instead of presenting a merged record with no provenance.
 */
export function mergeProfiles(profiles: readonly ExtractedProfile[]): ExtractedProfile | null {
  if (profiles.length === 0) return null
  const base = { ...profiles[0], links: [...profiles[0].links] }
  const vias = [profiles[0].via]
  for (const p of profiles.slice(1)) {
    vias.push(p.via)
    base.url ??= p.url
    base.displayName ??= p.displayName
    base.realName ??= p.realName
    base.location ??= p.location
    base.bio ??= p.bio
    base.avatarUrl ??= p.avatarUrl
    base.joinedAt ??= p.joinedAt
    base.followers ??= p.followers
    base.following ??= p.following
    base.company ??= p.company
    base.email ??= p.email
    for (const link of p.links) {
      if (!base.links.some((l) => l.url === link.url)) base.links.push(link)
    }
  }
  base.via = [...new Set(vias)].join(' + ')
  return base
}

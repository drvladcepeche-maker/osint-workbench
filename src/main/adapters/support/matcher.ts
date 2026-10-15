/**
 * Reading the WhatsMyName site definitions to decide how much a hit on a given site is
 * structurally capable of meaning.
 *
 * This file exists because of one observation from a real run. The operator searched a
 * handle and got hits on Russian sites he has never used, which is alarming until you look
 * at what was actually requested. In `<toolkitRoot>\data\wmn-data.json` — the 716-site
 * WhatsMyName catalogue that sherlock, maigret and blackbird all descend from — the
 * `Pikabu` entry probes `https://pikabu.ru/ajax.php`. There is no `{account}` in that URL
 * anywhere. It is a generic AJAX endpoint, and a 200 from it is a fact about the endpoint,
 * not about any particular person. Two entries down, `Codeberg` probes
 * `https://codeberg.org/api/v1/users/{account}` and requires the returned user object to
 * contain `"id":`. That is about as directly as a website can be asked whether an account
 * of that name exists.
 *
 * Both rendered identically in the findings table. That is the false confidence this file
 * removes: not by suppressing the weak row — the operator still wants to see it — but by
 * making the row say *why* it is weak, in a sentence, beside the claim.
 *
 * ## The trade-off encoded here
 *
 * The classification is read off the *structure of the catalogue entry*, never off the
 * response. That is a deliberate limit. It cannot tell you that a site's marker string
 * rotted last Tuesday, or that this particular request hit a rate limiter. It can only
 * tell you what the probe was built to be able to distinguish. That is a much weaker claim
 * than "this hit is true", and it is stated as such everywhere in the prose below.
 *
 * The direction of the error follows `sources.ts`: when the evidence is ambiguous the
 * verdict goes *down*, never up. Understating a probe costs a promotion the operator could
 * have had and can be recovered by opening the URL; overstating one manufactures
 * confidence, and nothing recovers that. Concretely: an unrecognised site is reported as
 * unknown rather than assumed fine, a site with several catalogue entries takes the
 * weakest of them, and any anti-bot layer in the entry's `protection` list demotes it
 * outright, because an interstitial answering 200 before the site ever sees the request is
 * precisely the failure mode that makes this family of tools lie.
 *
 * ## Why a transcription rather than a lookup at parse time
 *
 * `parse()` must stay pure — no filesystem — so that a parser fixed next year can be
 * re-run over a capture made today with nothing re-fetched. So `run()` reads the dataset
 * (see `loadWmnSites`) and transcribes it into the run envelope with
 * `transcribeWmnIndex()`; `parse()` recovers it with `readWmnTranscript()` and classifies.
 * `pattern-timezone` is the precedent: transcribe in `run()`, interpret in `parse()`.
 *
 * That also buys a correctness property worth more than the ~60 kB it costs per capture.
 * The WhatsMyName dataset self-updates — blackbird refreshes it on start unless told not
 * to — so a capture that did not carry its own snapshot of the catalogue would reclassify
 * differently every time the upstream file moved, and the finding beside it would drift
 * away from the reason recorded for it.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { MatcherQuality, MatcherStrength } from '../../../shared/types'
import { siteOrigin } from './sources'

/** Artifact name the three username adapters store the transcription under. */
export const WMN_ARTIFACT = 'wmn-matchers.json'

/**
 * Where the dataset lives under `AdapterContext.toolkitRoot`, in the order tried.
 *
 * Two copies exist on this machine: the standalone one, and the one inside the blackbird
 * clone, which blackbird itself refreshes. The standalone copy is preferred because
 * nothing rewrites it behind the app's back.
 */
export const WMN_RELATIVE_PATHS = ['data/wmn-data.json', 'blackbird/data/wmn-data.json'] as const

/** The label used when the dataset has no entry for a site at all. */
export const UNKNOWN_MATCHER_LABEL = 'unknown matcher'

/* ------------------------------------------------------------------ *
 * The transcribed dataset
 * ------------------------------------------------------------------ */

/**
 * One catalogue entry, reduced to the fields that decide the classification.
 *
 * `hasEString` rather than the string itself: the classifier only ever asks whether the
 * entry demands a body marker, and the marker strings are the bulkiest part of the file.
 * Everything else is carried verbatim so the reasons can quote the real URL.
 */
export interface WmnSiteRecord {
  name: string
  /** The URL actually requested. The `{account}` placeholder may or may not appear in it. */
  uriCheck: string
  /** The human-facing profile URL the catalogue records for display. Often empty. */
  uriPretty: string
  /** The status code the entry treats as "this account exists". `0` when it records none. */
  eCode: number
  /** Whether the entry also demands a marker string in the response body. */
  hasEString: boolean
  /** The catalogue's own note about what sits in front of the site: `cloudflare`, `captcha`, … */
  protection: string[]
}

/**
 * The dataset, indexed the three ways a tool might name a site.
 *
 * Three indexes rather than one because the tools disagree about names. WhatsMyName calls
 * it `GitHub (User)`, sherlock calls it `GitHub`, and the only thing all three tools
 * genuinely agree on is the URL they requested — which is why the origin index is the one
 * that carries most of the traffic.
 */
export interface WmnIndex {
  /** Absolute path the records were read from. `''` when the dataset was never found. */
  sourcePath: string
  sites: WmnSiteRecord[]
  /** Full display name, normalised. */
  byName: Map<string, WmnSiteRecord[]>
  /** Display name with a trailing parenthetical and punctuation removed: `GitHub (User)` -> `github`. */
  byBaseName: Map<string, WmnSiteRecord[]>
  /** `siteOrigin()` of the entry's own URLs — the same folding `Finding.source` uses. */
  byOrigin: Map<string, WmnSiteRecord[]>
}

export function emptyWmnIndex(): WmnIndex {
  return { sourcePath: '', sites: [], byName: new Map(), byBaseName: new Map(), byOrigin: new Map() }
}

function push(map: Map<string, WmnSiteRecord[]>, key: string, value: WmnSiteRecord): void {
  if (!key) return
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export function buildWmnIndex(records: readonly WmnSiteRecord[], sourcePath = ''): WmnIndex {
  const index: WmnIndex = { ...emptyWmnIndex(), sourcePath, sites: [...records] }
  for (const site of index.sites) {
    push(index.byName, nameKey(site.name), site)
    push(index.byBaseName, baseNameKey(site.name), site)
    for (const uri of [site.uriCheck, site.uriPretty]) {
      const origin = originOfTemplate(uri)
      if (origin && !(index.byOrigin.get(origin) ?? []).includes(site)) push(index.byOrigin, origin, site)
    }
  }
  return index
}

/* ------------------------------------------------------------------ *
 * Loading, once
 * ------------------------------------------------------------------ */

/**
 * The cache is keyed by toolkit root and holds the parsed index for the life of the
 * process. The file is a third of a megabyte and does not change while the app is open;
 * re-reading it for every one of a 716-hit sweep's findings would be absurd.
 */
const cache = new Map<string, WmnIndex>()

/** Test hook. Nothing in the app calls this — the dataset does not change under a run. */
export function resetWmnCache(): void {
  cache.clear()
}

/**
 * Read the WhatsMyName catalogue from the toolbelt.
 *
 * **Never throws, and a missing dataset is not an error.** The toolbelt is hand-assembled;
 * a machine without the file is a machine where hits carry no matcher badge, which is a
 * smaller loss than a run that fails. The same is true of a corrupt or restructured file:
 * an empty index means "not checked", and `matcherFor` says so in words.
 */
export function loadWmnSites(toolkitRoot: string): WmnIndex {
  const root = (toolkitRoot ?? '').trim()
  const cached = cache.get(root)
  if (cached) return cached

  let index = emptyWmnIndex()
  for (const rel of WMN_RELATIVE_PATHS) {
    const file = path.join(root || '.', ...rel.split('/'))
    try {
      if (!existsSync(file)) continue
      const records = readWmnDocument(readFileSync(file, 'utf8'))
      if (records.length) {
        index = buildWmnIndex(records, file)
        break
      }
    } catch {
      // Unreadable, unparseable, or a shape this code does not recognise. Try the next
      // location; an absent classification is the designed fallback.
    }
  }
  cache.set(root, index)
  return index
}

/** Read the upstream file's own shape: `{ license, authors, categories, sites: [...] }`. */
export function readWmnDocument(text: string): WmnSiteRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sites?: unknown }).sites)
      ? ((parsed as { sites: unknown[] }).sites as unknown[])
      : []
  const out: WmnSiteRecord[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const name = typeof e['name'] === 'string' ? e['name'].trim() : ''
    const uriCheck = typeof e['uri_check'] === 'string' ? e['uri_check'].trim() : ''
    if (!name && !uriCheck) continue
    out.push({
      name,
      uriCheck,
      uriPretty: typeof e['uri_pretty'] === 'string' ? e['uri_pretty'].trim() : '',
      eCode: typeof e['e_code'] === 'number' && Number.isInteger(e['e_code']) ? e['e_code'] : 0,
      hasEString: typeof e['e_string'] === 'string' && e['e_string'].trim().length > 0,
      protection: Array.isArray(e['protection'])
        ? (e['protection'] as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : []
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Carrying it through the envelope
 * ------------------------------------------------------------------ */

interface WmnTranscript {
  source: string
  count: number
  columns: string[]
  rows: unknown[][]
}

const TRANSCRIPT_COLUMNS = ['name', 'uriCheck', 'uriPretty', 'eCode', 'hasEString', 'protection'] as const

/**
 * Serialise the index for the run envelope.
 *
 * Columnar rather than an array of objects, and self-describing through `columns`. The
 * difference is about 40 kB per capture on a 716-site dataset, and raw captures are
 * permanent and append-only, so the saving is paid once and kept forever.
 */
export function transcribeWmnIndex(index: WmnIndex): string {
  const doc: WmnTranscript = {
    source: index.sourcePath,
    count: index.sites.length,
    columns: [...TRANSCRIPT_COLUMNS],
    rows: index.sites.map((s) => [s.name, s.uriCheck, s.uriPretty, s.eCode, s.hasEString ? 1 : 0, s.protection.join(',')])
  }
  return JSON.stringify(doc)
}

/**
 * Recover the index inside `parse()`. Pure, and never throws: anything unreadable becomes
 * an empty index, which reports as "not checked" rather than as a failure.
 */
export function readWmnTranscript(text: string | null | undefined): WmnIndex {
  if (typeof text !== 'string' || !text.trim()) return emptyWmnIndex()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyWmnIndex()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyWmnIndex()
  const doc = parsed as Partial<WmnTranscript>
  if (!Array.isArray(doc.rows)) return emptyWmnIndex()
  const records: WmnSiteRecord[] = []
  for (const row of doc.rows) {
    if (!Array.isArray(row)) continue
    const [name, uriCheck, uriPretty, eCode, hasEString, protection] = row
    records.push({
      name: typeof name === 'string' ? name : '',
      uriCheck: typeof uriCheck === 'string' ? uriCheck : '',
      uriPretty: typeof uriPretty === 'string' ? uriPretty : '',
      eCode: typeof eCode === 'number' ? eCode : 0,
      hasEString: hasEString === 1 || hasEString === true,
      protection: typeof protection === 'string' && protection ? protection.split(',').filter(Boolean) : []
    })
  }
  return buildWmnIndex(records, typeof doc.source === 'string' ? doc.source : '')
}

/* ------------------------------------------------------------------ *
 * Reading the structure of one entry
 * ------------------------------------------------------------------ */

/**
 * The placeholder, in both spellings.
 *
 * Every one of the 716 entries in the copy on this machine writes it `{account}`, but the
 * dataset is community-maintained and self-updating, so a spaced form is cheap to accept
 * and expensive to be surprised by.
 */
const PLACEHOLDER = /\{\s*account\s*\}/i

/** Where in the URL the handle appears — which is what decides whether it is a per-user request. */
export type PlaceholderPlacement = 'address' | 'query' | 'none'

/**
 * `address` covers the host as well as the path: 22 entries are of the form
 * `https://{account}.blogspot.com/`, and a per-user subdomain is every bit as much a
 * per-user address as a per-user path.
 */
export function placeholderPlacement(uri: string): PlaceholderPlacement {
  const s = uri ?? ''
  if (!PLACEHOLDER.test(s)) return 'none'
  let end = s.length
  for (const mark of ['?', '#']) {
    const at = s.indexOf(mark)
    if (at >= 0 && at < end) end = at
  }
  return PLACEHOLDER.test(s.slice(0, end)) ? 'address' : 'query'
}

/**
 * Does this probe call the site's own API rather than fetch a rendered page?
 *
 * It matters because an API answers the question directly: it returns a user object or it
 * returns an error, and there is no rendered "sorry, not found" page in between to be
 * served with a 200 by mistake.
 */
export function isApiProbe(uri: string): boolean {
  const s = (uri ?? '').toLowerCase()
  if (!s) return false
  const withoutQuery = s.split('?')[0] ?? s
  return /\/api[/.]/.test(withoutQuery) || /^https?:\/\/(?:api|apis|public-api|graph|rest)\./.test(withoutQuery)
}

/**
 * Protection labels that mean something other than the site itself may answer the request.
 *
 * The dataset uses `captcha`, `cloudflare`, `ddos-guard`, `anubis`, `multiple` and `other`
 * for layers that intercept — any of which can return 200 with an interstitial before the
 * site's own application ever sees the handle, which is the documented, unsolved
 * false-positive class of every tool in this family.
 *
 * `user-agent` and `cloudfront` are deliberately **not** here. `user-agent` says the entry
 * needs a browser header, which is a property of the request rather than an interceptor;
 * `cloudfront` is a cache serving the site's own bytes. Both are still recorded as reasons
 * so the detail panel shows the flag, but neither demotes a probe on its own. Without that
 * distinction `GitHub (User)` — `api.github.com/users/{account}`, flagged `user-agent` —
 * would come out weak, which would be plainly wrong and would teach the operator to
 * ignore the badge.
 */
const INTERCEPTING_PROTECTION = /captcha|cloudflare|bot|waf|multiple|ddos|anubis|other|akamai|datadome|perimeterx|incapsula|imperva/i

function isInterceptingLayer(label: string): boolean {
  return INTERCEPTING_PROTECTION.test(label)
}

function nameKey(name: string): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function baseNameKey(name: string): string {
  return nameKey(name)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[^a-z0-9]+/g, '')
}

/** `siteOrigin` of a URL template, with the placeholder stood in for so the URL parses. */
function originOfTemplate(uri: string): string {
  if (!uri) return ''
  return siteOrigin(uri.replace(/\{\s*account\s*\}/gi, 'account'))
}

/* ------------------------------------------------------------------ *
 * The classification
 * ------------------------------------------------------------------ */

const LABELS: Record<MatcherStrength, string> = {
  strong: 'strong matcher',
  moderate: 'moderate matcher',
  weak: 'weak matcher'
}

function protectionReason(site: WmnSiteRecord): string {
  return `The catalogue entry records that this site sits behind ${list(site.protection)}.`
}

/** `['a']` -> `a`; `['a','b']` -> `a and b`; `['a','b','c']` -> `a, b and c`. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Judge one catalogue entry.
 *
 * The order of the checks is load-bearing. "The URL does not name a user" is tested before
 * "the site is behind Cloudflare" because it is the more fundamental defect and the one
 * the operator most needs the sentence for: Pikabu is both, and the sentence he needs to
 * read is the one about the URL.
 */
export function classifyWmnSite(site: WmnSiteRecord): MatcherQuality {
  const reasons: string[] = []
  const uri = site.uriCheck
  const shown = uri || '(the entry records no request URL)'
  const placement = placeholderPlacement(uri)
  const intercepting = site.protection.filter(isInterceptingLayer)

  if (placement === 'none') {
    reasons.push(`The URL this entry requests is ${shown}, which contains no {account} placeholder at all.`)
    if (site.uriPretty) {
      reasons.push(`${site.uriPretty} is recorded only as the address to show a human; it is not what was requested.`)
    }
    if (site.protection.length) reasons.push(protectionReason(site))
    return {
      strength: 'weak',
      label: LABELS.weak,
      why: 'The URL this probe requests does not name a user anywhere — it is one shared endpoint the site answers for everybody — so what came back is evidence about that endpoint and not about an account with this name.',
      reasons
    }
  }

  if (placement === 'query') {
    reasons.push(`The handle reaches ${shown} only as a query parameter, not as part of a per-user address.`)
    if (site.uriPretty) reasons.push(`The per-user address ${site.uriPretty} is recorded for display but is not the URL that was probed.`)
    if (site.protection.length) reasons.push(protectionReason(site))
    return {
      strength: 'weak',
      label: LABELS.weak,
      why: 'The handle reaches this site only as a query parameter on a shared lookup endpoint rather than as a per-user address, so what came back is that endpoint answering a question, not a profile page that exists because somebody created it.',
      reasons
    }
  }

  reasons.push(`The handle is part of the requested address itself (${shown}), so the request is about this account and no other.`)
  const api = isApiProbe(uri)
  if (api) reasons.push('The request goes to the site\'s own API, which returns a structured user record rather than a rendered page.')

  if (intercepting.length) {
    reasons.push(protectionReason(site))
    return {
      strength: 'weak',
      label: LABELS.weak,
      why: `The catalogue records an interception layer in front of this site (${list(intercepting)}), and a challenge page answering 200 before the site itself sees the request is exactly the mechanism that makes username tools report accounts that were never there.`,
      reasons
    }
  }
  if (site.protection.length) reasons.push(protectionReason(site))

  const hasCode = site.eCode >= 100 && site.eCode < 600
  if (hasCode) reasons.push(`The entry treats HTTP ${site.eCode} as meaning the account exists.`)
  else reasons.push('The entry records no status code to check the response against.')
  if (site.hasEString) reasons.push('The entry also requires a marker string in the response body, so a status code on its own is not enough.')
  else reasons.push('The entry records no body marker, so the status code is the only signal read.')

  if (hasCode && site.hasEString) {
    return {
      strength: 'strong',
      label: LABELS.strong,
      why: api
        ? 'This probe asks the site\'s own user API for the handle and accepts the answer only when the expected status code and a marker inside the returned user record agree, which is about as directly as a website can be asked whether an account of that name exists.'
        : 'This probe requests a URL containing the handle and accepts the answer only when two independent things agree — the expected status code and a marker string that only a real profile page carries — which is what rules out most of the soft-404 pages a status-code-only check reads as accounts.',
      reasons
    }
  }
  if (hasCode || site.hasEString) {
    return {
      strength: 'moderate',
      label: LABELS.moderate,
      why: hasCode
        ? `This probe requests a URL containing the handle, but the only thing it reads is the status code, so anything that answers ${site.eCode} for every handle — a catch-all profile route, a login wall, a styled "no such user" page served with a 200 — reads here as an account.`
        : 'This probe requests a URL containing the handle, but the only thing it reads is a string in the page body, so a marker that has drifted into the site\'s ordinary furniture matches everybody and a marker the site has since renamed matches nobody.',
      reasons
    }
  }
  return {
    strength: 'weak',
    label: LABELS.weak,
    why: 'This probe requests a URL containing the handle but records neither a status code nor a body marker to check the answer against, so nothing in it distinguishes an existing account from any other response the site might give.',
    reasons
  }
}

/** The verdict for a site the dataset does not describe. Weak, and honest about which kind of weak. */
function unknownMatcher(reasons: string[]): MatcherQuality {
  return {
    strength: 'weak',
    label: UNKNOWN_MATCHER_LABEL,
    why: 'This site is not in the local WhatsMyName dataset, so the structure of the probe behind this hit could not be checked; that is an absence of the check rather than evidence either way about the account.',
    reasons
  }
}

/**
 * Is this a probe whose weakness the operator should be told about in the claim itself?
 *
 * True for a weak matcher that was actually examined; false for one that was never
 * checked, because "not in the dataset" is not a criticism of the hit and must not be
 * worded as one.
 */
export function isWeakProbe(matcher: MatcherQuality | null | undefined): boolean {
  return !!matcher && matcher.strength === 'weak' && matcher.label !== UNKNOWN_MATCHER_LABEL
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

const STRENGTH_ORDER: Record<MatcherStrength, number> = { weak: 0, moderate: 1, strong: 2 }

/**
 * A stand-in for `{account}` that survives `new URL()` untouched.
 *
 * It has to be lowercase and alphanumeric: `URL` lowercases the hostname, and 22 entries
 * put the placeholder *in* the hostname (`https://{account}.blogspot.com/`). A control
 * character comes back percent-encoded and a brace does not parse at all.
 */
const URL_SENTINEL = 'xaccountplaceholderx'

/**
 * Turn a URL template into a matcher for a concrete probed URL: folded origin plus path
 * shape.
 *
 * Both sides go through `siteOrigin` before being compared, for the same reason
 * `Finding.source` does. The three tools report three different hostnames for one site —
 * maigret `github.com/torvalds`, sherlock `www.github.com/torvalds`, blackbird
 * `api.github.com/users/torvalds` — and a template match on the raw hostname would
 * recognise the catalogue entry for exactly one of them.
 */
function templateMatches(template: string, probed: URL): boolean {
  if (!template || !PLACEHOLDER.test(template)) return false
  let parsed: URL
  try {
    parsed = new URL(template.replace(/\{\s*account\s*\}/gi, URL_SENTINEL))
  } catch {
    return false
  }
  const origin = siteOrigin(parsed.hostname)
  if (!origin || origin !== siteOrigin(probed.hostname)) return false
  const shape = trimPath(`${origin}${parsed.pathname}`)
    .split(URL_SENTINEL)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  return new RegExp(`^${shape}$`, 'i').test(trimPath(`${siteOrigin(probed.hostname)}${probed.pathname}`))
}

function trimPath(s: string): string {
  return s.replace(/\/+$/, '')
}

/**
 * Find the catalogue entry behind a hit, and judge it.
 *
 * Returns `null` when the tool did not probe a website at all — a `local:` or `file:`
 * source is a derived claim or a local file, and hanging a probe badge on one would be a
 * category error.
 *
 * Four lookups, most precise first: the probed URL against the entry's own URL templates,
 * then the exact display name, then the folded site origin, then the display name with a
 * parenthetical qualifier removed (WhatsMyName says `GitHub (User)` where sherlock says
 * `GitHub`). When more than one entry survives, the **weakest** is reported and the
 * ambiguity is named in the reasons.
 */
export function matcherFor(index: WmnIndex, opts: { site?: string; url?: string }): MatcherQuality | null {
  const site = (opts.site ?? '').trim()
  const url = (opts.url ?? '').trim()
  if (!site && !url) return null
  if (/^(?:local|file):/i.test(site) || /^(?:local|file):/i.test(url)) return null

  const probed = parseUrl(url)
  const origin = url ? siteOrigin(url) : ''
  const described = site || origin || url

  if (!index.sites.length) {
    return unknownMatcher([
      `No WhatsMyName dataset was available when this run was captured, so the probe behind the hit on ${described} was never examined.`
    ])
  }

  let candidates: WmnSiteRecord[] = []
  let how = ''

  if (probed) {
    candidates = index.sites.filter(
      (s) => templateMatches(s.uriCheck, probed) || templateMatches(s.uriPretty, probed)
    )
    how = 'its URL template'
  }
  if (!candidates.length && site) {
    candidates = index.byName.get(nameKey(site)) ?? []
    how = 'its name'
  }
  if (!candidates.length && origin) {
    candidates = index.byOrigin.get(origin) ?? []
    how = 'its site origin'
  }
  if (!candidates.length && site) {
    candidates = index.byBaseName.get(baseNameKey(site)) ?? []
    how = 'its name'
  }
  if (!candidates.length) {
    return unknownMatcher([
      `Neither the name "${described}" nor its address appears among the ${index.sites.length} sites in the WhatsMyName dataset this run carried.`,
      'The tools do not all take their site lists from that dataset, so an unlisted site is unremarkable; it just means the probe could not be inspected.'
    ])
  }

  const judged = candidates.map((s) => ({ site: s, quality: classifyWmnSite(s) }))
  judged.sort((a, b) => STRENGTH_ORDER[a.quality.strength] - STRENGTH_ORDER[b.quality.strength])
  const chosen = judged[0] as { site: WmnSiteRecord; quality: MatcherQuality }
  const reasons = [`Matched to the WhatsMyName entry "${chosen.site.name}" by ${how}.`, ...chosen.quality.reasons]
  if (judged.length > 1) {
    reasons.push(
      `The dataset holds ${judged.length} entries that could be this site (${judged.map((j) => j.site.name).join(', ')}); the weakest is reported, because overstating a probe is the error this app cannot take back.`
    )
  }
  return { ...chosen.quality, reasons }
}

function parseUrl(url: string): URL | null {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

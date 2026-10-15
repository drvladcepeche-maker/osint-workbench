/**
 * Turning a tool's idea of "where this came from" into a `Finding.source` that means the
 * same thing across tools.
 *
 * This file exists because of one rule in `src/shared/confidence.ts`: corroboration is
 * keyed on `Finding.source`, never on `Finding.tool`. Sherlock and Maigret both probing
 * GitHub is **one** source. That rule is the app's defence against its own worst failure
 * mode — two wrappers around the same site list "corroborating" the same false positive.
 *
 * The rule only works if the three username tools actually emit the same string for the
 * same site, and out of the box they do not:
 *
 *   maigret    "https://github.com/torvalds"        -> github.com
 *   sherlock   "https://www.github.com/torvalds"    -> www.github.com
 *   blackbird  "https://api.github.com/users/torvalds" -> api.github.com
 *
 * So the source is folded to the *operator* of the site at emit time, by `siteOrigin()`.
 *
 * **The fold itself is no longer written here.** It lived here and again in
 * `src/shared/platforms.ts` — the renderer cannot import from `src/main`, so the copy was
 * policed by a drift test instead of removed — while `independenceKey()` in
 * `shared/confidence.ts` folded the same strings a third, more permissive way. Three folds
 * over one key is three chances for the same two findings to corroborate in one part of
 * the app and not in another. Main can import from `src/shared`, so the implementation now
 * lives in `shared/platforms.ts` alone and this module re-exports it: the adapters keep the
 * import path they have always used, `independenceKey()` is built on the same function, and
 * there is one set of tests for one fold.
 */

export { hostOf, siteOrigin } from '../../../shared/platforms'

/**
 * Passive-DNS and certificate-transparency aggregators, as their tools name them, mapped
 * to the host that actually served the data.
 *
 * This matters for real corroboration: subfinder's `crtsh` and theHarvester's `crtsh` are
 * the same certificate log frontend, and must not corroborate each other. Two *different*
 * aggregators reporting the same subdomain genuinely is two sources — that is a promotion
 * the operator should be offered.
 */
const DATA_SOURCE_HOSTS: Record<string, string> = {
  crtsh: 'crt.sh',
  certspotter: 'certspotter.com',
  anubis: 'jldc.me',
  alienvault: 'otx.alienvault.com',
  otx: 'otx.alienvault.com',
  hackertarget: 'hackertarget.com',
  rapiddns: 'rapiddns.io',
  urlscan: 'urlscan.io',
  virustotal: 'virustotal.com',
  securitytrails: 'securitytrails.com',
  shodan: 'shodan.io',
  censys: 'censys.io',
  github: 'github.com',
  gitlab: 'gitlab.com',
  bufferover: 'tls.bufferover.run',
  commoncrawl: 'commoncrawl.org',
  waybackarchive: 'web.archive.org',
  wayback: 'web.archive.org',
  duckduckgo: 'duckduckgo.com',
  bing: 'bing.com',
  baidu: 'baidu.com',
  yahoo: 'search.yahoo.com',
  threatcrowd: 'threatcrowd.org',
  threatminer: 'threatminer.org',
  dnsdumpster: 'dnsdumpster.com',
  digitorus: 'certificatedetails.com',
  sitedossier: 'sitedossier.com',
  robtex: 'robtex.com',
  leakix: 'leakix.net',
  netlas: 'netlas.io',
  fullhunt: 'fullhunt.io',
  hunter: 'hunter.io',
  intelx: 'intelx.io',
  chaos: 'chaos.projectdiscovery.io',
  fofa: 'fofa.info',
  quake: 'quake.360.net',
  zoomeye: 'zoomeye.org',
  hudsonrock: 'hudsonrock.com',
  pugrecon: 'pugrecon.cyberpunk.sh',
  submd: 'submd.com',
  digitalyama: 'digitalyama.com',
  redhuntlabs: 'redhuntlabs.com',
  whoisxmlapi: 'whoisxmlapi.com',
  builtwith: 'builtwith.com',
  criminalip: 'criminalip.io',
  facebook: 'facebook.com',
  brave: 'search.brave.com',
  pentesttools: 'pentest-tools.com',
  subdomaincenter: 'api.subdomain.center',
  sitemap: 'sitemap'
}

/**
 * Map a tool's internal source name to the host that served the data.
 *
 * Unknown names pass through unchanged rather than being guessed at. An unmapped name is
 * still a usable independence key — it just will not collide with another tool's name for
 * the same service, so the worst case is a missed corroboration, never a fabricated one.
 */
export function dataSourceOrigin(name: string): string {
  const key = (name ?? '').trim().toLowerCase()
  if (!key) return ''
  return DATA_SOURCE_HOSTS[key] ?? key
}

/**
 * Source string for a claim that is *derived*, not observed: a run summary, a statistic,
 * an inference over data already in the case.
 *
 * The `local:` prefix is not decoration. `independenceKey()` leaves it intact, so a
 * derived claim can never collide with a real hostname and therefore can never be counted
 * as one of the two independent sources required for corroboration. Analysis must not be
 * able to promote itself.
 */
export function localSource(adapterId: string): string {
  return `local:${adapterId}`
}

/** Source string for a claim read out of a file's own bytes (EXIF, container metadata). */
export function fileSource(fileName: string): string {
  return `file:${(fileName || 'unknown').replace(/\\/g, '/').split('/').pop()}`
}

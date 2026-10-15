/**
 * Reading a country off a row.
 *
 * ## Why this is a separate file
 *
 * `relevance.ts` asks one question of a result — *does anything here conflict with what
 * the operator already knows?* — and one of the things he knows is where the subject
 * lives. Answering that means turning four unrelated kinds of evidence into the same
 * two-letter code:
 *
 *  1. a **self-declared location field** scraped off a profile ("Sofia", "София,
 *     Bulgaria", "Rio de Janeiro");
 *  2. the **ccTLD** of the site that answered — `.bg`, `.ru`, `.br`;
 *  3. the **platform** itself, when it is one people use in one country;
 *  4. the **script** the text is written in, which is the weakest of the four and is
 *     treated as such.
 *
 * ## The rule this file exists to enforce
 *
 * **A location never sinks a row on its own.** That is not caution, it is a measured
 * result: in the operator's first real run the single most valuable hit — a Steam profile
 * that was genuinely his, with a real finding attached — carried a location field naming
 * a city he has never lived in. Location fields are stale, aspirational, ironic, or
 * deliberately poisoned, and a privacy-aware person poisons them on purpose. So everything
 * here produces a **weak** signal by construction, and `relevance.ts` refuses to let a
 * weak conflict alone put a row in the contradicted band.
 *
 * ## Country names come from ICU, not from a table here
 *
 * `Intl.DisplayNames` already holds every ISO 3166-1 name in the runtime, in a form that
 * is maintained by somebody else and will not go stale in this repository. Copying 249
 * of them into a literal would be a table that is wrong the first time a country is
 * renamed. What *is* written out by hand is the part ICU does not supply and English
 * writes in a dozen ways anyway: the aliases (`UK`, `Britain`, `USA`, `Holland`), the
 * demonyms (`Bulgarian`, `Brazilian`), and the ccTLDs whose country is not their code.
 *
 * If `Intl.DisplayNames` is ever unavailable the module degrades to the hand-written
 * aliases alone and says nothing about the rest, rather than throwing. A missing signal is
 * a missing signal; a crash in a scorer would take the table with it.
 */

import { fold, hasCyrillic } from './names'

/** ISO 3166-1 alpha-2, uppercase. The only representation of a country in this app. */
export type CountryCode = string

/**
 * ccTLDs whose two letters are not the country's ISO code, plus the ones that are not
 * countries at all.
 *
 * `.uk` is the famous one — the ISO code is `GB`. `.eu`, `.su` and `.tv`-as-a-brand are
 * the other direction: a suffix that looks like a country signal and is not one, so they
 * map to null and stop the rule rather than answering it wrongly.
 */
const CCTLD_OVERRIDES: Readonly<Record<string, CountryCode | null>> = {
  uk: 'GB',
  ac: null,
  eu: null,
  su: null,
  tv: null,
  cc: null,
  io: null,
  me: null,
  co: null,
  ai: null,
  fm: null,
  gg: null,
  to: null,
  ws: null,
  la: null,
  am: null,
  st: null,
  sh: null
}

/**
 * Sites whose users are overwhelmingly in one country.
 *
 * A short list on purpose. The claim being made is only "this platform is a signal about
 * where its users are", and that is true of a national social network and false of almost
 * everything global. A wrong entry here would fire a country conflict on a site that has
 * users everywhere, so nothing goes in without the platform being genuinely national.
 */
const PLATFORM_COUNTRY: Readonly<Record<string, CountryCode>> = {
  'vk.com': 'RU',
  'ok.ru': 'RU',
  'mail.ru': 'RU',
  'livejournal.com': 'RU',
  'rutube.ru': 'RU',
  'weibo.com': 'CN',
  'zhihu.com': 'CN',
  'douban.com': 'CN',
  'bilibili.com': 'CN',
  'nicovideo.jp': 'JP',
  'pixiv.net': 'JP',
  'ameblo.jp': 'JP',
  'naver.com': 'KR',
  'tistory.com': 'KR',
  'wykop.pl': 'PL',
  'nk.pl': 'PL',
  'vc.ru': 'RU',
  'habr.com': 'RU',
  'dev.by': 'BY',
  'bg-mamma.com': 'BG',
  'dir.bg': 'BG',
  'abv.bg': 'BG'
}

/** Alternative English spellings ICU does not return. */
const ALIASES: Readonly<Record<string, CountryCode>> = {
  uk: 'GB',
  'u.k.': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  'united states of america': 'US',
  holland: 'NL',
  'the netherlands': 'NL',
  uae: 'AE',
  'south korea': 'KR',
  'north korea': 'KP',
  'czech republic': 'CZ',
  czechia: 'CZ',
  russia: 'RU',
  'russian federation': 'RU',
  'south africa': 'ZA',
  vietnam: 'VN',
  'ivory coast': 'CI',
  turkey: 'TR',
  türkiye: 'TR',
  macedonia: 'MK',
  'north macedonia': 'MK',
  // Bulgarian spellings of the countries this operator's material actually contains.
  българия: 'BG',
  русия: 'RU',
  германия: 'DE',
  сърбия: 'RS',
  румъния: 'RO',
  гърция: 'GR',
  турция: 'TR'
}

/** Demonyms, for the countries a profile is most likely to name that way. */
const DEMONYMS: Readonly<Record<string, CountryCode>> = {
  bulgarian: 'BG',
  българин: 'BG',
  българка: 'BG',
  russian: 'RU',
  ukrainian: 'UA',
  serbian: 'RS',
  romanian: 'RO',
  greek: 'GR',
  turkish: 'TR',
  german: 'DE',
  french: 'FR',
  italian: 'IT',
  spanish: 'ES',
  portuguese: 'PT',
  brazilian: 'BR',
  american: 'US',
  british: 'GB',
  dutch: 'NL',
  polish: 'PL',
  swedish: 'SE',
  norwegian: 'NO',
  danish: 'DK',
  finnish: 'FI',
  japanese: 'JP',
  chinese: 'CN',
  korean: 'KR',
  indian: 'IN',
  canadian: 'CA',
  australian: 'AU',
  mexican: 'MX',
  argentine: 'AR'
}

/**
 * Countries whose everyday written language uses Cyrillic.
 *
 * Used only to say that Cyrillic text is *not* a conflict with a Cyrillic-writing seed.
 * It is never used to assert a country — Cyrillic narrows the world to a dozen states,
 * which is a fact about the alphabet and not about the person.
 */
export const CYRILLIC_COUNTRIES: readonly CountryCode[] = [
  'BG',
  'RU',
  'UA',
  'BY',
  'RS',
  'MK',
  'ME',
  'KZ',
  'KG',
  'TJ',
  'MN'
]

/* ------------------------------------------------------------------ *
 * The name index
 * ------------------------------------------------------------------ */

/** folded country name -> code. Built once, from ICU plus the hand-written tables. */
const BY_NAME = new Map<string, CountryCode>()
/** code -> the display name to show the operator. */
const NAME_OF = new Map<CountryCode, string>()

const A = 'A'.charCodeAt(0)

function buildIndex(): void {
  let display: Intl.DisplayNames | null = null
  try {
    display = new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    display = null
  }
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j)
      let name: string | undefined
      try {
        name = display?.of(code)
      } catch {
        name = undefined
      }
      // ICU echoes the code back for a region it does not know. That is not a name.
      if (!name || name === code) continue
      NAME_OF.set(code, name)
      BY_NAME.set(fold(name), code)
    }
  }
  for (const [alias, code] of Object.entries(ALIASES)) {
    BY_NAME.set(fold(alias), code)
    if (!NAME_OF.has(code)) NAME_OF.set(code, alias)
  }
  for (const [demonym, code] of Object.entries(DEMONYMS)) {
    BY_NAME.set(fold(demonym), code)
    if (!NAME_OF.has(code)) NAME_OF.set(code, demonym)
  }
}

buildIndex()

/** The English name of a country code, or the code itself when nothing knows it. */
export function countryName(code: CountryCode): string {
  return NAME_OF.get(code.toUpperCase()) ?? code.toUpperCase()
}

/** True when a string is a plausible ISO 3166-1 alpha-2 code this app has a name for. */
export function isCountryCode(x: string): boolean {
  return /^[A-Za-z]{2}$/.test(x) && NAME_OF.has(x.toUpperCase())
}

/** Every country this app can name, sorted by name — the picker's option list. */
export function allCountries(): { code: CountryCode; name: string }[] {
  return [...NAME_OF.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Turn one written place into a country code, or null.
 *
 * Matches whole comma- or slash-separated parts rather than substrings, so `Rusk` does not
 * find `Russia` and the `IN` in `Indianapolis` is not India. A bare two-letter part is
 * accepted as a code only when it is uppercase in the original, because `in`, `is` and
 * `it` are ordinary English words and `IT` is not.
 */
export function countryOfPlace(place: string): CountryCode | null {
  const parts = place.split(/[,/|·•]| - |\s+—\s+/)
  for (const part of parts) {
    const raw = part.trim()
    if (!raw) continue
    const hit = BY_NAME.get(fold(raw))
    if (hit) return hit
    if (/^[A-Z]{2}$/.test(raw) && NAME_OF.has(raw)) return raw
  }
  // Last resort: a country named inside a longer phrase, on a word boundary.
  const folded = fold(place)
  for (const [name, code] of BY_NAME) {
    if (name.length < 5) continue
    const at = folded.indexOf(name)
    if (at < 0) continue
    const before = at > 0 ? folded[at - 1] : undefined
    const after = folded[at + name.length]
    const boundary = (c: string | undefined): boolean => c === undefined || !/[\p{L}\p{N}]/u.test(c)
    if (boundary(before) && boundary(after)) return code
  }
  return null
}

/**
 * The country a hostname's suffix implies, or null.
 *
 * Two letters only, and only when the suffix is a real region ICU names — so `.com`,
 * `.dev` and `.xyz` say nothing, and the overrides above stop `.io` and `.me` from being
 * read as the Indian Ocean and Montenegro when they are in fact generic.
 */
export function countryOfHost(host: string): CountryCode | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  const dot = h.lastIndexOf('.')
  if (dot < 0) return null
  const tld = h.slice(dot + 1)
  if (!/^[a-z]{2}$/.test(tld)) return null
  if (tld in CCTLD_OVERRIDES) return CCTLD_OVERRIDES[tld] ?? null
  const code = tld.toUpperCase()
  return NAME_OF.has(code) ? code : null
}

/** The country a platform implies, when the platform is a national one. Otherwise null. */
export function countryOfPlatform(platform: string): CountryCode | null {
  const p = platform.trim().toLowerCase().replace(/^www\./, '')
  return PLATFORM_COUNTRY[p] ?? null
}

/** True when the text is written in Cyrillic — a hint about the region, never a country. */
export function looksCyrillic(text: string): boolean {
  return hasCyrillic(text)
}

/** True when every seeded country writes in Cyrillic. */
export function allCyrillicCountries(codes: readonly CountryCode[]): boolean {
  return codes.length > 0 && codes.every((c) => CYRILLIC_COUNTRIES.includes(c.toUpperCase()))
}

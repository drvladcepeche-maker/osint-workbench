/**
 * The Range's rules: tiers, scoring, sampling, hints.
 *
 * This is a port of `spikes/geoint/index.html`, not a redesign of it. Everything here
 * was derived, argued and measured in the original geoint prototype notes — the scoring rule
 * against five belief distributions, the country weighting over 3,000 draws, the tier
 * scales, the 60 m signal wording. Where a constant looks arbitrary it is not, and the
 * comment says which section settled it.
 *
 * Kept deliberately free of React so the arithmetic can be read, and checked, on its own.
 */

import type { AtlasData, CuratedData, RangeFrame, RangeIndex } from '../../../../shared/ipc'

/* ------------------------------------------------------------------- tiers */

export type GuessMode = 'country' | 'pin'

export interface Scale {
  /** Distance decay, km. Bigger = a gentler penalty for being far out. */
  D: number
  /** Calibration reference radius, km. */
  Rref: number
  center: [number, number]
  /** Half-width of the initial map view, in degrees of longitude. */
  span: number
  /** Slider position, not km — see `sliderToKm`. */
  radiusDefault: number
}

/**
 * Scoring geography for pin mode, sized to each tier's actual geographic scope.
 *
 * L3 is Bulgaria-only on purpose (§5.2): home ground is where recognition is learned
 * fastest, and it is the only scale at which a 20 km radius is a meaningful statement.
 * At world scale every honest radius is hundreds of km and the calibration lesson blurs.
 */
export const SCALES: Record<string, Scale> = {
  bulgaria: { D: 250, Rref: 300, center: [25.5, 42.7], span: 4.2, radiusDefault: 560 }, // ~90 km
  global: { D: 1200, Rref: 2000, center: [11, 45], span: 95, radiusDefault: 748 } // ~400 km
}

export interface Level {
  key: 1 | 2 | 3 | 4
  name: string
  sub: string
  source: 'curated' | 'index' | 'live'
  index: 'bulgaria' | 'countries' | null
  mode: GuessMode
  scale?: keyof typeof SCALES
  /** Points deducted per hint tier, in order. */
  hintCost: [number, number, number]
  curated?: boolean
  noHints?: boolean
  /** What the tier is for, shown under the picker rather than left to be discovered. */
  about: string
}

export const LEVELS: Record<number, Level> = {
  1: {
    key: 1,
    name: 'Curated',
    sub: 'country · free hints',
    source: 'curated',
    index: 'countries',
    mode: 'country',
    hintCost: [0, 0, 0],
    curated: true,
    about:
      '20 frames a human opened and looked at, in difficulty order, each with a written lesson. The first three should be impossible to get wrong — the ramp is what teaches. Hints cost nothing here.'
  },
  2: {
    key: 2,
    name: 'Filtered',
    sub: 'country · hints cost',
    source: 'index',
    index: 'countries',
    mode: 'country',
    hintCost: [150, 300, 200],
    about:
      'The full signal-filtered index, 18 countries. Nobody has checked these frames by eye, so roughly half are less readable than their OSM signal suggests. That is the honest state of the data.'
  },
  3: {
    key: 3,
    name: 'Home pin',
    sub: 'Bulgaria · radius',
    source: 'index',
    index: 'bulgaria',
    mode: 'pin',
    scale: 'bulgaria',
    hintCost: [300, 600, 400],
    about:
      'Bulgaria only, and a pin instead of a country. This is where the radius starts to mean something: at 300 km reference scale, a 20 km claim is a real statement about how sure you are.'
  },
  4: {
    key: 4,
    name: 'Wild',
    sub: 'worldwide · expert',
    source: 'live',
    index: null,
    mode: 'pin',
    scale: 'global',
    hintCost: [0, 0, 0],
    noHints: true,
    about:
      'Live, unfiltered, anywhere Panoramax has been. No signal filtering and no hints, which means most frames are genuinely featureless. This is the expert tier, not the default.'
  }
}

/* ----------------------------------------------------------------- scoring */

export const DIST_MAX = 5000
export const CALIB_K = 3000
export const ALPHA = 0.5
/** Winkler's overconfidence multiplier. */
export const PEN = 2 / ALPHA // 4
/** The percentile an honest radius should be. */
export const CONF_PCT = Math.round((1 - ALPHA / 2) * 100) // 75
export const COUNTRY_POINTS = 1000

export interface PinScore {
  distance: number
  calibration: number
  /** The Winkler interval score, km, lower is better. */
  W: number
  total: number
  hit: boolean
}

/**
 * ```
 * TOTAL = DIST_MAX·exp(−d/D) + CALIB_K·(1 − W/Rref),   W = r + PEN·max(0, d−r)
 * ```
 *
 * `W` is the standard Winkler interval score. `E[W]` is minimised at the
 * (1 − ALPHA/2) percentile of the player's own belief about `d`, and the distance term
 * contains no `r`, so stating your genuine uncertainty is the optimal play — a strictly
 * proper rule in `r`. Verified by Monte-Carlo against five belief distributions in
 * geoint spike notes §3.2.
 *
 * **The calibration term is unbounded below, deliberately.** Clamping it caps the
 * overconfidence penalty, which makes understating the radius cheap: under a clamp the
 * optimal radius collapsed to 191 km for a player whose honest percentile was 360 km
 * (§3.3a). Exactly the uncertain players this is meant to teach were being pushed to
 * lie. A round can therefore score deeply negative, and that is the teaching signal.
 */
export function scorePin(d: number, r: number, scale: Scale): PinScore {
  const distance = DIST_MAX * Math.exp(-d / scale.D)
  const W = r + PEN * Math.max(0, d - r)
  const calibration = CALIB_K * (1 - W / scale.Rref)
  return { distance, calibration, W, total: distance + calibration, hit: d <= r }
}

/* ---------------------------------------------------------------- geometry */

const R_EARTH = 6371.0088
export const rad = (d: number): number => (d * Math.PI) / 180
export const deg = (r: number): number => (r * 180) / Math.PI

export function haversine(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1])
  const dLon = rad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** A true geodesic circle, not a screen-space one — 10 lines instead of a Turf dependency. */
export function circleRing(center: [number, number], km: number, steps = 96): [number, number][] {
  const [lon, lat] = center
  const d = km / R_EARTH
  const la1 = rad(lat)
  const lo1 = rad(lon)
  const ring: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const b = rad((i * 360) / steps)
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b))
    const lo2 =
      lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2))
    ring.push([deg(lo2), deg(la2)])
  }
  return ring
}

/** The slider is logarithmic: 0 → 10 km, 1000 → 3000 km, so both ends are usable. */
export const sliderToKm = (v: number): number => Math.round(Math.exp((v / 1000) * Math.log(3000)) * 10) / 10
export const fmtKm = (k: number): string =>
  k >= 100 ? `${Math.round(k)} km` : `${k.toFixed(1).replace(/\.0$/, '')} km`

/* --------------------------------------------------------------- the sun */

/**
 * Solar position at the moment of capture.
 *
 * The spike used SunCalc 1.9.0 from a CDN, which this app cannot load. The algorithm is
 * the standard low-precision solar position calculation and is reproduced here rather
 * than depended on — about forty lines against a network fetch the CSP forbids.
 *
 * Returned azimuths are compass bearings from north, which is what a photograph is read
 * against; SunCalc's own convention is south-origin and the spike converted it at the
 * call site.
 */
export function sunAt(when: Date, lat: number, lon: number): { altitude: number; azimuth: number } {
  const days = when.getTime() / 86400000 - 10957.5 // days since J2000.0
  const M = rad(357.5291 + 0.98560028 * days) // mean anomaly
  const C = rad(1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M))
  const L = M + C + rad(102.9372) + Math.PI // ecliptic longitude
  const e = rad(23.4397) // obliquity
  const dec = Math.asin(Math.sin(e) * Math.sin(L))
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L))
  const sidereal = rad(280.16 + 360.9856235 * days) - rad(-lon)
  const H = sidereal - ra // hour angle
  const phi = rad(lat)

  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H))
  // atan2 here is south-origin; +180 turns it into a compass bearing.
  const azimuth = (deg(Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi))) + 180) % 360
  return { altitude: deg(altitude), azimuth }
}

/* ------------------------------------------------------------ signal wording */

/**
 * Hint tier 1, phrased from the OSM features that caused this frame to be kept.
 *
 * That provenance is the point: because the wording is generated from the frame's own
 * `kinds`, the hint is **always true for this specific image** rather than a generic
 * platitude — and it points without reading the answer out.
 */
export const KIND_HINT: Record<string, [string, string]> = {
  shop_named: [
    'a named shop within 60 m',
    'Find the shopfront and read the sign — the script and the words are your strongest clue.'
  ],
  amenity_named: [
    'a named business or public building within 60 m',
    'Look for a facade sign, a pharmacy cross, a bank logo or a school name board.'
  ],
  bus_stop: [
    'a bus stop within 60 m',
    'Bus stop flags carry route numbers, operator names and often the settlement name.'
  ],
  place: [
    'a settlement centre within 60 m',
    'Look for a place-name sign, a war memorial, or a municipal building.'
  ],
  route_ref: [
    'a numbered road within 60 m',
    'Road number signs give you the country immediately — shape, colour and prefix letter all encode it.'
  ],
  tourism_info: [
    'a tourist information board within 60 m',
    'Information boards are dense with place names and often a map.'
  ],
  traffic_sign: [
    'a mapped traffic sign within 60 m',
    'Sign shape, colour and typeface are country-specific even when there is no text.'
  ],
  border: [
    'a border crossing within 60 m',
    'You are within sight of a national border — expect two sets of conventions.'
  ]
}

/* ---------------------------------------------------------------- sampling */

/** Below this a country is a trap on the answer grid, not an option. */
export const MIN_FRAMES_PER_COUNTRY = 20
const HOME_COUNTRY = 'Bulgaria'
const HOME_SHARE = 0.25

/**
 * The countries a player may be asked about — and therefore exactly the countries the
 * grid offers.
 *
 * One definition, used by both the picker and the sampler. They used to differ, and the
 * gap was a live bug: the UK survives filtering with six frames, below this threshold,
 * so it was never on the answer board but nothing stopped the sampler serving it.
 * Uniform sampling made that vanishingly rare; country weighting would have made it
 * about one round in sixty (geoint spike notes §8.4).
 */
export function answerableCountries(index: RangeIndex | null, curated: CuratedData | null): Set<string> {
  const counts: Record<string, number> = {}
  for (const c of index?.candidates ?? []) {
    if (c.country) counts[c.country] = (counts[c.country] ?? 0) + 1
  }
  const keep = new Set(Object.keys(counts).filter((c) => counts[c] >= MIN_FRAMES_PER_COUNTRY))
  // A reviewed answer is always on the board, however thin that country is in the index.
  for (const r of curated?.rounds ?? []) if (r.country) keep.add(r.country)
  return keep
}

/**
 * Pick a country first, then a frame inside it.
 *
 * Bulgaria is 4.1% of the country index, so sampling uniformly over frames buries home
 * ground under France and Croatia — which have more coverage, not more teaching value.
 * Bulgaria gets a fixed 25% share and the rest split the remainder evenly. Equal shares
 * for the others is also deliberate: how many frames a country has reflects who went out
 * with a camera, not how much it deserves to be asked about. Measured over 3,000 draws:
 * Bulgaria 25.4%, every other country 4.1–5.2% (§8.3).
 */
export function pickWeightedCountry(pool: RangeFrame[], answerable: Set<string> | null): RangeFrame[] | null {
  const byCountry = new Map<string, RangeFrame[]>()
  for (const c of pool) {
    if (!c.country || (answerable && !answerable.has(c.country))) continue
    const bucket = byCountry.get(c.country)
    if (bucket) bucket.push(c)
    else byCountry.set(c.country, [c])
  }
  if (byCountry.size < 2) return null
  const others = [...byCountry.keys()].filter((k) => k !== HOME_COUNTRY)
  const home = byCountry.get(HOME_COUNTRY)
  // If home ground has nothing left in the pool, its share goes back to the others.
  const homeP = home?.length ? HOME_SHARE : 0
  const r = Math.random()
  if (r < homeP) return home ?? null
  const i = Math.floor(((r - homeP) / (1 - homeP)) * others.length)
  return byCountry.get(others[Math.min(i, others.length - 1)]) ?? null
}

/** One frame from an index, respecting the tier's rules and what has already been seen. */
export function pickFromIndex(
  index: RangeIndex,
  level: Level,
  seen: Set<string>,
  curated: CuratedData | null
): RangeFrame {
  let pool = index.candidates.filter((c) => !seen.has(c.id))
  if (!pool.length) {
    seen.clear()
    pool = index.candidates
  }
  /* Fallback path only: L1 reaches here when the reviewed set is unavailable. Keep the
     pre-curation behaviour of serving only the strongest-signal frames rather than
     silently degrading the beginner tier into L2. */
  if (level.curated) {
    const strong = pool.filter((c) => (c.signal ?? 0) >= 8)
    if (strong.length >= 12) pool = strong
  }
  if (level.mode === 'country') {
    const answerable = answerableCountries(index, curated)
    const eligible = pool.filter((c) => c.country && answerable.has(c.country))
    if (eligible.length) pool = eligible
    const bucket = pickWeightedCountry(pool, answerable)
    if (bucket?.length) pool = bucket
  }
  const frame = pool[Math.floor(Math.random() * pool.length)]
  seen.add(frame.id)
  return frame
}

/* -------------------------------------------------------------------- hints */

/**
 * Which atlas page actually decides the current frame.
 *
 * The fallback used to point at `script`, which is not a category id — so hint tier 3's
 * deep link opened the atlas on nothing. The id is `writing-system` (§8.4).
 */
export function atlasTargetForRound(frame: RangeFrame | null): [string, string] {
  const pick = frame?.lesson?.atlas?.[0]
  if (pick) return [pick.key, pick.label]
  const road = frame?.kinds?.includes('route_ref') || frame?.kinds?.includes('traffic_sign')
  return road
    ? ['road-signs', 'Road signs — shape, colour, font']
    : ['writing-system', 'Writing system and diacritics']
}

export interface HintPart {
  /** Emphasised. On its own it is a standalone line; before a body it is a label. */
  lead?: string
  body?: string
}

/** The three tiers, in the spike's own words. Tier 2 never names the country. */
export function hintText(tier: 1 | 2 | 3, frame: RangeFrame, atlas: AtlasData | null): HintPart[] {
  if (tier === 1) {
    /* On a reviewed frame the honest first hint is WHERE to look — a human confirmed
       that this spot in this image carries the clue. It points; it does not read. */
    const where = frame.lesson?.firstWhere
    if (where) {
      return [
        { lead: `Look here: ${where}.` },
        { body: 'Something in that part of the frame names the place. Read it before you guess.' }
      ]
    }
    if (!frame.kinds?.length) {
      return [
        {
          body: 'No mapped signal for this frame — this is the wild tier. Start with the basics: driving side, road markings, script on any text, vegetation.'
        }
      ]
    }
    const parts = frame.kinds.map((k) => KIND_HINT[k]).filter(Boolean)
    return [
      { lead: `There is ${parts.map((p) => p[0]).join(', and ')}.` },
      ...parts.map((p) => ({ body: p[1] }))
    ]
  }
  if (tier === 2) {
    const rec = atlas?.countries.find((x) => x.name === frame.country)
    if (!rec) {
      return [
        {
          body: 'Narrowing: check the writing system first — Latin, Cyrillic or Greek splits Europe into three big blocks straight away. Then driving side, then plate colour.'
        }
      ]
    }
    const bits: HintPart[] = []
    if (rec.script) bits.push({ lead: 'Script:', body: rec.script })
    if (rec.roadLines) bits.push({ lead: 'Road markings:', body: rec.roadLines })
    if (rec.plate) bits.push({ lead: 'Plates:', body: rec.plate })
    if (rec.bollard) bits.push({ lead: 'Bollards:', body: rec.bollard })
    /* The spike framed this tier as narrowing "without naming the country", and the
       implementation does not achieve that — it quotes the atlas record for the true
       country verbatim, and several of those records name it outright ("Cyrillic
       (Bulgarian)") or list its own cities. Redacting them reliably would mean editing
       atlas content, which is a separate job. So the wording says what the tier actually
       is rather than what it was meant to be; on L2 and L3 it is priced accordingly. */
    return [
      { body: 'The atlas record for what you are looking at. It narrows hard, and for some countries the wording gives it away outright:' },
      ...bits.slice(0, 3)
    ]
  }
  return []
}

/** `HintPart.lead` with no body is a standalone emphasised line. */
export const partText = (p: HintPart): string => [p.lead, p.body].filter(Boolean).join(' ')

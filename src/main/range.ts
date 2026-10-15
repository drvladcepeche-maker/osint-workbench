/**
 * The Range's back end: bundled reference data, and the one hole in the renderer's
 * "no remote loads" rule — imagery.
 *
 * **Data.** The clue atlas, the 20 hand-reviewed rounds, the two signal-filtered frame
 * indexes and the world outline all ship as app resources under `resources/geoint/` and
 * are read from disk, not fetched. That is what makes the Range work offline apart from
 * the photographs themselves. They are lazily read and cached, because the country index
 * is 4.4 MB and most sessions never open the Range at all.
 *
 * **Imagery.** The spike fetched Panoramax straight from the page, which cost it a real
 * bug: Panoramax is federated, its instances are hosted independently, and one of them
 * sends no `Access-Control-Allow-Origin` at all — 7% of the index. Worse, a CORS
 * rejection does not fire an error event, so the viewer sat on a spinner forever
 * (geoint spike notes §6).
 *
 * Fetching in the main process removes that class of failure entirely: there is no
 * origin here, so there is nothing for CORS to refuse. It also keeps the page's CSP
 * honest — the renderer still cannot reach any remote host; it can only ask for a
 * `pano:` URL, and this module decides whether that resolves to anything. The host
 * allowlist below is the whole of what the app will fetch.
 *
 * The spike's 12 s failover is kept regardless, in the renderer where it belongs. CORS
 * is no longer the reason it exists; a dead link or a stalled transfer still is.
 */

import { net, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PANO_SCHEME, type RangeData, type RangeFrame, type RangeIndex } from '../shared/ipc'

/**
 * Every host the Range is permitted to reach.
 *
 * The image hosts are the eleven Panoramax instances measured in geoint spike notes §6 plus
 * the Taiwanese instance that appeared in §8.1, minus the Backblaze bucket serving the
 * Welsh instance — the index builder already drops that one, and repeating the exclusion
 * here means a stale index cannot reintroduce it.
 *
 * Federation membership changes. A frame on a host that is not listed fails to load and
 * the renderer's failover moves to another candidate, which is the correct outcome: an
 * unknown host is a thing to add deliberately, not to trust because a JSON file said so.
 */
const ALLOWED_HOSTS = new Set([
  'api.panoramax.xyz',
  'panoramax.openstreetmap.fr',
  'panoramax.ign.fr',
  'panoramax.osm-hr.org',
  'panoramax.osm.tw',
  'nl.panoramax.xyz',
  'panoramax.bustikiller.com',
  'panorama.osm-fulda.de',
  'images.panoramax.osm.be',
  'panoramax.mapcomplete.org',
  'panoramax.multimob.be',
  'api.pano.locus.sbs',
  'pano.locus.sbs'
])

const API = 'https://api.panoramax.xyz/api'
/** L4's sampling box. Antarctica and the high Arctic hold nothing worth guessing at. */
const WILD_BBOX = [-180, -60, 180, 78]

export function isAllowedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

/**
 * Must be called before `app.whenReady()`.
 *
 * `standard` gives the scheme a parseable origin; `supportFetchAPI` and `corsEnabled`
 * are what let a WebGL panorama upload the image as a texture — an image the browser
 * considers cross-origin and untainted-unknown throws `SecurityError` on `texImage2D`,
 * which is the same dead end by a different route.
 */
export function registerPanoScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PANO_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

export function handlePanoProtocol(): void {
  protocol.handle(PANO_SCHEME, async (request) => {
    let target: string | null = null
    try {
      target = new URL(request.url).searchParams.get('u')
    } catch {
      /* falls through to the 400 below */
    }
    if (!target || !isAllowedImageUrl(target)) {
      return new Response('not an allowed imagery host', { status: 400 })
    }
    try {
      const upstream = await net.fetch(target)
      if (!upstream.ok) return new Response(`upstream ${upstream.status}`, { status: upstream.status })
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
          // The renderer is the only consumer, and the panorama viewer needs this to
          // read the image into a texture at all.
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        }
      })
    } catch (err) {
      return new Response(`fetch failed: ${(err as Error).message}`, { status: 502 })
    }
  })
}

/* ------------------------------------------------------------------ the data */

/** Absolute paths to the five bundled files, supplied by the caller that imported them. */
export interface RangeResources {
  atlas: string
  curated: string
  basemap: string
  indexBulgaria: string
  indexCountries: string
}

export class RangeStore {
  private data: RangeData | null = null
  private readonly indexes = new Map<string, RangeIndex>()
  private liveCollections: { bbox: number[] }[] | null = null
  /** Frames already served this session, so a run does not repeat itself. */
  private readonly seen = new Set<string>()

  constructor(private readonly files: RangeResources) {}

  private async json<T>(file: string): Promise<T> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T
    } catch (err) {
      throw new Error(
        `The Range's bundled data could not be read from ${path.basename(file)}: ${(err as Error).message}. ` +
          `Regenerate it with \`node scripts/build-range-resources.mjs\`.`
      )
    }
  }

  async load(): Promise<RangeData> {
    if (!this.data) {
      const [atlas, curated, basemap] = await Promise.all([
        this.json<RangeData['atlas']>(this.files.atlas),
        this.json<RangeData['curated']>(this.files.curated),
        this.json<RangeData['basemap']>(this.files.basemap)
      ])
      this.data = { atlas, curated, basemap }
    }
    return this.data
  }

  async index(region: 'bulgaria' | 'countries'): Promise<RangeIndex> {
    const cached = this.indexes.get(region)
    if (cached) return cached
    const idx = await this.json<RangeIndex>(
      region === 'bulgaria' ? this.files.indexBulgaria : this.files.indexCountries
    )
    this.indexes.set(region, idx)
    return idx
  }

  /**
   * L4 — the expert tier, and the only one that samples live.
   *
   * Naive `search?bbox=<whole world>` returns results in a fixed order, so it serves the
   * same cluster every time. The working shape, verified in the spike at 8/8 distinct
   * locations: enumerate sequences once, throw away the ones whose bounding box spans
   * more than 0.6 degrees — those are broken GPS tracks, one of which runs from Paris to
   * Georgia — then search inside a single random sequence's own footprint.
   */
  async live(): Promise<RangeFrame | null> {
    if (!this.liveCollections) {
      const res = await net.fetch(`${API}/collections?bbox=${WILD_BBOX.join(',')}&limit=1000`)
      if (!res.ok) throw new Error(`Panoramax answered HTTP ${res.status} when listing sequences.`)
      const body = (await res.json()) as {
        collections?: { extent?: { spatial?: { bbox?: number[][] } }; 'stats:items'?: { count?: number } }[]
      }
      this.liveCollections = (body.collections ?? [])
        .map((c) => ({ bbox: c.extent?.spatial?.bbox?.[0] ?? [], count: c['stats:items']?.count ?? 0 }))
        .filter((c) => c.bbox.length === 4 && c.count > 0)
        .filter((c) => c.bbox[2] - c.bbox[0] <= 0.6 && c.bbox[3] - c.bbox[1] <= 0.6)
    }
    const cols = this.liveCollections
    if (!cols.length) return null

    for (let attempt = 0; attempt < 12; attempt++) {
      const b = cols[Math.floor(Math.random() * cols.length)].bbox
      const pad = 0.002
      const bbox = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad].map((n) => n.toFixed(6)).join(',')
      let features: RawFeature[]
      try {
        const res = await net.fetch(`${API}/search?bbox=${bbox}&limit=200`)
        if (!res.ok) continue
        features = ((await res.json()) as { features?: RawFeature[] }).features ?? []
      } catch {
        continue
      }
      const fresh = features.filter(
        (f) => !this.seen.has(f.id) && (f.assets?.hd?.href || f.assets?.sd?.href) && isAllowedImageUrl(f.assets?.hd?.href ?? f.assets?.sd?.href ?? '')
      )
      if (!fresh.length) continue
      const f = fresh[Math.floor(Math.random() * fresh.length)]
      this.seen.add(f.id)
      const io = f.properties?.['pers:interior_orientation'] ?? {}
      const dims = io.sensor_array_dimensions
      return {
        id: f.id,
        c: f.geometry.coordinates as [number, number],
        url: (f.assets?.hd?.href ?? f.assets?.sd?.href) as string,
        // 360 is asserted per item; the 2:1 aspect check is the fallback for an
        // instance that does not fill in the field of view.
        pano: io.field_of_view === 360 || !!(dims && Math.abs(dims[0] / dims[1] - 2) < 0.02),
        t: f.properties?.datetime ?? null,
        kinds: [],
        signal: 0,
        country: null,
        area: null
      }
    }
    return null
  }
}

interface RawFeature {
  id: string
  geometry: { coordinates: number[] }
  assets?: { hd?: { href?: string }; sd?: { href?: string } }
  properties?: {
    datetime?: string
    'pers:interior_orientation'?: { field_of_view?: number; sensor_array_dimensions?: number[] }
  }
}

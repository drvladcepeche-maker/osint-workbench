#!/usr/bin/env node
/**
 * Turns the GEOINT spike's browser-shaped data files into bundled app resources.
 *
 * The spike at `spikes/geoint/` is a standalone HTML page: its data ships as classic
 * scripts that assign `window.ATLAS` and `window.CURATED`, and its indexes are fetched
 * over HTTP from the folder they sit in. Neither works inside the app — the renderer has
 * no HTTP origin and no `window` globals to lean on — so this converts all four into
 * plain JSON under `resources/geoint/`, which the main process reads and hands over IPC.
 *
 * Nothing here re-derives anything. The indexes are copied byte-for-byte; the two script
 * files are evaluated once in a sandbox and their single global is serialised. Rebuilding
 * the index itself is `spikes/geoint/build-index.mjs`, still the only thing that talks to
 * Overpass, and it is deliberately not run from here.
 *
 *   node scripts/build-range-resources.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const SPIKE = join(ROOT, 'spikes', 'geoint')
const OUT = join(ROOT, 'resources', 'geoint')

mkdirSync(OUT, { recursive: true })
mkdirSync(join(ROOT, 'scripts', '.cache'), { recursive: true })

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`

/** Evaluate a `window.X = {...}` classic script and return X, without a browser. */
function globalFromScript(file, name) {
  const window = {}
  runInNewContext(readFileSync(file, 'utf8'), { window })
  const value = window[name]
  if (!value) throw new Error(`${file} did not define window.${name}`)
  return value
}

function emit(name, value) {
  const path = join(OUT, name)
  writeFileSync(path, JSON.stringify(value))
  return path
}

/* The clue atlas: 15 categories, 151 clues, 20 countries. */
const atlas = globalFromScript(join(SPIKE, 'atlas-data.js'), 'ATLAS')
const atlasPath = emit('atlas.json', atlas)
const clues = atlas.categories.reduce((s, c) => s + (c.clues?.length ?? 0), 0)

/* The hand-reviewed L1 set: 20 rounds, each with a written lesson. */
const curated = globalFromScript(join(SPIKE, 'curated-data.js'), 'CURATED')
const curatedPath = emit('curated.json', curated)

/* The signal-filtered frame indexes, copied verbatim. */
const copies = []
for (const [src, dst] of [
  ['candidates.bulgaria.json', 'index.bulgaria.json'],
  ['candidates.countries.json', 'index.countries.json']
]) {
  const j = JSON.parse(readFileSync(join(SPIKE, src), 'utf8'))
  copies.push([dst, emit(dst, j), j.candidates.length])
}

/* Cross-check the two things the Range depends on being consistent: every atlas
   deep-link in a curated lesson has to resolve, or hint tier 3 opens on nothing. */
const catIds = new Set(atlas.categories.map((c) => c.id))
const countryNames = new Set(atlas.countries.map((c) => c.name))
let links = 0
const broken = []
for (const r of curated.rounds) {
  for (const a of r.lesson?.atlas ?? []) {
    links++
    const key = a.key
    const ok = key.startsWith('n:')
      ? countryNames.has(key.slice(2))
      : catIds.has(key.replace(/^c:/, ''))
    if (!ok) broken.push(`${r.n}: ${key}`)
  }
}
if (broken.length) {
  console.error(`\n  ${broken.length} unresolved atlas deep-link(s):\n   ${broken.join('\n   ')}\n`)
  process.exit(1)
}

/* ------------------------------------------------------------------ basemap */
/*
 * The pin tiers (L3 Bulgaria, L4 worldwide) need a map to click on, and the spike got
 * one from MapLibre + OpenFreeMap over the network. Neither survives the port: the
 * renderer's CSP blocks remote loads by design, and geoint spike notes §2.1 rules out OSM's
 * raster tiles outright — its policy forbids offline use, which is exactly what a
 * bundled desktop app is. §2.2's own recommendation for that case is a local extract.
 *
 * So the basemap is vector, bundled, and drawn by hand in an SVG: Natural Earth's 110m
 * admin-0 boundaries, which are public domain. The TopoJSON is decoded here and written
 * out as flat rings at 0.01 degree quantisation, so the app ships plain coordinate
 * arrays and needs no decoder, no projection library and no network.
 *
 * The source file is cached beside the output, so this script re-runs offline.
 */
const CACHE = join(ROOT, 'scripts', '.cache', 'natural-earth-110m.topo.json')
const SOURCE = 'https://unpkg.com/world-atlas@2.0.2/countries-110m.json'

if (!existsSync(CACHE)) {
  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`${SOURCE} -> HTTP ${res.status}`)
  const text = await res.text()
  JSON.parse(text) // it is data, never executed; fail here if it is not JSON
  writeFileSync(CACHE, text)
  console.log(`  fetched ${SOURCE} -> ${CACHE} (${(text.length / 1024).toFixed(0)} KB)`)
}

const topo = JSON.parse(readFileSync(CACHE, 'utf8'))

/** TopoJSON delta-decode: quantised integer deltas back to absolute lon/lat. */
function decodeArc(arc) {
  const [sx, sy] = topo.transform.scale
  const [tx, ty] = topo.transform.translate
  let x = 0
  let y = 0
  return arc.map(([dx, dy]) => {
    x += dx
    y += dy
    return [x * sx + tx, y * sy + ty]
  })
}
const arcs = topo.arcs.map(decodeArc)

/** An arc index is a ring of points; a negative index means walk that arc backwards. */
function ring(indexes) {
  const out = []
  for (const i of indexes) {
    const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i]
    // Adjacent arcs share an endpoint; dropping the duplicate keeps the path clean.
    out.push(...(out.length ? a.slice(1) : a))
  }
  return out
}

const round = (n) => Math.round(n * 100) / 100 // 0.01 degrees, near the source's own 0.0036

/** Drop consecutive duplicates left behind by quantisation, and rings too small to see. */
function simplify(points) {
  const out = []
  for (const [lon, lat] of points) {
    const p = [round(lon), round(lat)]
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  return out.length >= 4 ? out : null
}

const shapes = []
for (const geom of topo.objects.countries.geometries) {
  const polygons = geom.type === 'Polygon' ? [geom.arcs] : geom.arcs
  for (const poly of polygons) {
    const outer = simplify(ring(poly[0])) // holes are not worth the bytes at this scale
    if (outer) shapes.push(outer.flat())
  }
}
const basemapPath = emit('basemap.json', {
  source: 'Natural Earth 110m admin-0 (public domain), via world-atlas 2.0.2',
  quantised: 0.01,
  shapes
})

console.log(`
  basemap.json  ${shapes.length} boundary rings · Natural Earth 110m, public domain   ${kb(basemapPath)}
  atlas.json    ${atlas.categories.length} categories · ${clues} clues · ${atlas.countries.length} countries   ${kb(atlasPath)}
  curated.json  ${curated.rounds.length} reviewed rounds · ${links} atlas deep-links, all resolving   ${kb(curatedPath)}
${copies.map(([n, p, c]) => `  ${n.padEnd(21)} ${String(c).padStart(6)} frames   ${kb(p)}`).join('\n')}
`)

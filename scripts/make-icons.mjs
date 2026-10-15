#!/usr/bin/env node
/**
 * Generates every icon the packaged app needs, from one hand-written geometry.
 *
 *   node scripts/make-icons.mjs [--preview]
 *
 * ## Why this is a script and not a PNG somebody exported
 *
 * The mark is a **camera aperture** — six blades closing on a hexagonal opening. It is
 * the Darkroom theme stated as a shape, and it is deliberately *not* a magnifying glass:
 * every OSINT tool on earth uses a magnifying glass, and a tool you recognise by its icon
 * has to not look like the other forty.
 *
 * The geometry below is written out by hand in normalised units. Both the SVG (the human
 * -readable source, `build/icon.svg`) and every raster come out of that same table, so
 * they cannot drift — which is the failure mode of committing an SVG and a set of PNGs
 * exported from it once.
 *
 * ## The 16px constraint
 *
 * 16px is the hard case: the tray, Explorer's small-icon view, the window's own title
 * bar. Three things follow, and they are the reason `SMALL` exists as a separate row:
 *
 *  - **The opening is proportionally bigger at small sizes.** At 16px the amber opening
 *    is the only high-contrast element in the mark; oxblood on near-black is ~2:1 and
 *    carries nothing on its own. Below 24px the opening grows from 0.168 to 0.205 of the
 *    canvas so it survives as a legible shape rather than a smudge.
 *  - **Blade seams and the housing ring are dropped below 24px.** At 16px a seam is 0.3px
 *    wide; drawn, it is grey mud spread over the whole ring. Detail that cannot resolve
 *    does not degrade gracefully, it degrades into noise. What survives at 16px is the
 *    silhouette — dark tile, oxblood ring, amber centre — and that is the whole design
 *    brief for that size.
 *  - **The rim stays at every size.** The ground is near-black, so on a dark taskbar the
 *    tile has no silhouette at all without it.
 *
 * ## No dependencies
 *
 * A polygon scan-converter, a PNG writer and an ICO packer are about 150 lines between
 * them. `sharp` is 40 MB and would be, per byte delivered, the most expensive dependency
 * in the project. Everything here is `node:zlib` and arithmetic.
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ------------------------------------------------------------------ colour *
 * OKLCH -> sRGB, Björn Ottosson's matrices. Identical maths to
 * `scripts/contrast.mjs`; duplicated rather than shared because that script is a
 * measuring instrument and must keep depending on nothing.
 * -------------------------------------------------------------------------- */

function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
  const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
  const clamp01 = (x) => Math.min(1, Math.max(0, x))
  return lin.map((v) => Math.round(clamp01(enc(clamp01(v))) * 255))
}

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')

/** The five DESIGN.md tokens the mark is allowed to use. */
const C_GROUND = oklchToRgb(0.16, 0.008, 20) //  --bg
const C_RIM = oklchToRgb(0.3, 0.008, 20) //      --border
const C_BLADE = oklchToRgb(0.4, 0.13, 20) //     --primary, oxblood
const C_SEAM = oklchToRgb(0.13, 0.008, 20) //    --bg-sunken
const C_OPENING = oklchToRgb(0.76, 0.14, 65) //  --accent, safelight amber

/**
 * Per-blade lighting: the same oxblood, lit from the upper left.
 *
 * The amplitude is capped at 0.05 and biased upward. At 0.075 the darkest blade lands
 * at L 0.325, which is close enough to the L 0.16 ground that it stops being a blade and
 * becomes a bite taken out of the ring.
 */
const bladeShade = (angleDeg) =>
  oklchToRgb(0.425 + 0.05 * Math.cos(((angleDeg - 135) * Math.PI) / 180), 0.13, 20)

/* ---------------------------------------------------------------- geometry *
 * Normalised to a unit canvas; multiply by size. Angles in degrees, CCW, with
 * dir(a) = (cos a, -sin a) so "up" is 90 and the numbers read like a protractor
 * laid on the screen.
 * -------------------------------------------------------------------------- */

const LARGE = {
  R: 0.415, //     blade housing, outer radius
  r: 0.168, //     opening, circumradius of the hexagon
  phi: 12, //      opening rotation — off-axis so it is not a flat-topped hexagon
  beta: 22, //     leading-edge sweep: how far the blade's outer corner runs ahead of
  gamma: 26, //    its inner one. This offset is the whole mechanism read; with beta =
  //               gamma = 0 the six blades collapse into a plain hexagonal ring.
  corner: 0.2, //  ground tile corner radius
  glow: 0.11, //   safelight spill onto the inner blade edges. Restrained on purpose:
  //               at 0.3 it fogs the whole ring into one orange blob and the blades
  //               stop existing. It is a hint of light, not a bloom.
  seams: true,
  housing: true
}

const SMALL = { ...LARGE, R: 0.435, r: 0.205, corner: 0.22, glow: 0.07, seams: false, housing: false }

/** Below this the seams and housing ring cannot resolve. See the header. */
const SMALL_BELOW = 24

const dir = (deg) => {
  const a = (deg * Math.PI) / 180
  return [Math.cos(a), -Math.sin(a)]
}

/** The six blades, plus the opening they close on, in pixel coordinates. */
function aperture(size, g) {
  const c = size / 2
  const at = (radius, deg) => {
    const [dx, dy] = dir(deg)
    return [c + radius * size * dx, c + radius * size * dy]
  }

  const hexAngle = (k) => 60 * k + g.phi
  const opening = [0, 1, 2, 3, 4, 5].map((k) => at(g.r, hexAngle(k)))

  const blades = []
  for (let k = 0; k < 6; k++) {
    const a0 = hexAngle(k)
    const a1 = hexAngle(k + 1)
    const pts = [at(g.r, a0), at(g.r, a1)]
    // Outer arc, swept forward of the inner edge, walked back down to the leading
    // corner. 6-degree steps are below a pixel at 512 and exact enough below that.
    for (let a = a1 + g.gamma; a >= a0 + g.beta - 0.001; a -= 6) pts.push(at(g.R, a))
    pts.push(at(g.R, a0 + g.beta))
    blades.push({ pts, lit: a0 + 30, leading: [at(g.R, a0 + g.beta), at(g.r, a0)] })
  }
  return { c, opening, blades, at }
}

/* -------------------------------------------------------------- rasteriser */

/** RGBA8 canvas with source-over compositing and 4x4 supersampled coverage. */
function canvas(size) {
  const px = new Float64Array(size * size * 4) // premultiplied, 0..1
  const blend = (x, y, [r, g, b], alpha) => {
    if (alpha <= 0 || x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    const a = Math.min(1, alpha)
    const inv = 1 - a
    px[i] = (r / 255) * a + px[i] * inv
    px[i + 1] = (g / 255) * a + px[i + 1] * inv
    px[i + 2] = (b / 255) * a + px[i + 2] * inv
    px[i + 3] = a + px[i + 3] * inv
  }
  return { size, px, blend }
}

const SS = 4 // subsamples per axis

/**
 * Fills whatever `inside(x, y)` returns true for, antialiased.
 * `bbox` keeps this from being O(canvas) per shape at 512.
 */
function fillWhere(cv, bbox, inside, colour, alpha = 1) {
  const x0 = Math.max(0, Math.floor(bbox[0]))
  const y0 = Math.max(0, Math.floor(bbox[1]))
  const x1 = Math.min(cv.size - 1, Math.ceil(bbox[2]))
  const y1 = Math.min(cv.size - 1, Math.ceil(bbox[3]))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++
        }
      }
      if (hits) {
        const cover = hits / (SS * SS)
        const col = typeof colour === 'function' ? colour(x, y) : colour
        cv.blend(x, y, col, alpha * cover)
      }
    }
  }
}

function polyBBox(pts) {
  let a = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of pts) {
    a = [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)]
  }
  return [a[0] - 1, a[1] - 1, a[2] + 1, a[3] + 1]
}

/** Even-odd point-in-polygon. Every shape here is simple, so the rule is moot. */
function pointInPoly(pts, x, y) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const fillPoly = (cv, pts, colour, alpha = 1) =>
  fillWhere(cv, polyBBox(pts), (x, y) => pointInPoly(pts, x, y), colour, alpha)

/** A capsule — used for the blade seams, which must not have square ends. */
function fillLine(cv, [ax, ay], [bx, by], w, colour, alpha = 1) {
  const h = w / 2
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  const bbox = [
    Math.min(ax, bx) - w,
    Math.min(ay, by) - w,
    Math.max(ax, bx) + w,
    Math.max(ay, by) + w
  ]
  fillWhere(
    cv,
    bbox,
    (x, y) => {
      let t = ((x - ax) * dx + (y - ay) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= h
    },
    colour,
    alpha
  )
}

function fillRoundRect(cv, size, radius, colour, alpha = 1) {
  const inset = 0
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, inset + radius), size - inset - radius)
    const cy = Math.min(Math.max(y, inset + radius), size - inset - radius)
    if (x < inset || y < inset || x > size - inset || y > size - inset) return false
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= radius * radius
  }
  fillWhere(cv, [0, 0, size, size], inside, colour, alpha)
}

/** The rim: the tile, minus the tile inset by `w`. */
function strokeRoundRect(cv, size, radius, w, colour, alpha = 1) {
  const inTile = (x, y, pad) => {
    const r = Math.max(0.5, radius - pad)
    const cx = Math.min(Math.max(x, pad + r), size - pad - r)
    const cy = Math.min(Math.max(y, pad + r), size - pad - r)
    if (x < pad || y < pad || x > size - pad || y > size - pad) return false
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  fillWhere(cv, [0, 0, size, size], (x, y) => inTile(x, y, 0) && !inTile(x, y, w), colour, alpha)
}

/* ------------------------------------------------------------------ render */

function renderIcon(size, { ground = true } = {}) {
  const g = size < SMALL_BELOW ? SMALL : LARGE
  const cv = canvas(size)
  const A = aperture(size, g)

  if (ground) {
    fillRoundRect(cv, size, g.corner * size, C_GROUND)
    // The rim is what gives the tile a silhouette on a dark taskbar. Never dropped.
    strokeRoundRect(cv, size, g.corner * size, Math.max(1, size * 0.02), C_RIM, 0.85)
  }

  // Base disc first: the union of six blades leaves hairline gaps at the leading
  // corners, and a gap of ground colour inside the housing reads as damage.
  const cx = size / 2
  const R = g.R * size
  fillWhere(cv, [cx - R - 1, cx - R - 1, cx + R + 1, cx + R + 1], (x, y) => Math.hypot(x - cx, y - cx) <= R, C_BLADE)

  for (const b of A.blades) fillPoly(cv, b.pts, bladeShade(b.lit))

  // The safelight spilling onto the inner blade edges. Painted before the seams so
  // the seams stay the darkest thing in the ring, and clipped to a tight radius: the
  // opening is a hexagon, and a wide circular bloom rounds it back off.
  const rIn = g.r * size
  const rGlow = Math.min(R, rIn * 1.55)
  const STEPS = Math.max(5, Math.round(size / 10))
  for (let i = STEPS; i >= 1; i--) {
    const t = i / STEPS
    const rr = rIn + (rGlow - rIn) * t
    const a = g.glow * (1 - t) ** 1.4
    if (a < 0.004) continue
    fillWhere(
      cv,
      [cx - rr - 1, cx - rr - 1, cx + rr + 1, cx + rr + 1],
      (x, y) => Math.hypot(x - cx, y - cx) <= rr,
      C_OPENING,
      a
    )
  }

  if (g.seams) {
    for (const b of A.blades) {
      fillLine(cv, b.leading[0], b.leading[1], Math.max(1, size * 0.02), C_SEAM, 0.92)
    }
  }

  if (g.housing) {
    const w = Math.max(1, size * 0.02)
    fillWhere(
      cv,
      [cx - R - w - 2, cx - R - w - 2, cx + R + w + 2, cx + R + w + 2],
      (x, y) => {
        const d = Math.hypot(x - cx, y - cx)
        return d >= R - w * 0.35 && d <= R + w * 0.65
      },
      C_SEAM,
      0.6
    )
  }

  // The opening goes on last and hard-edged. It is the only element that carries at
  // 16px, so nothing is allowed to soften it.
  fillPoly(cv, A.opening, C_OPENING)

  return cv
}

/* --------------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Premultiplied float canvas -> straight-alpha RGBA bytes. */
function toRgba(cv) {
  const out = Buffer.alloc(cv.size * cv.size * 4)
  for (let i = 0; i < cv.size * cv.size; i++) {
    const a = cv.px[i * 4 + 3]
    const s = a > 0 ? 1 / a : 0
    out[i * 4] = Math.round(Math.min(1, cv.px[i * 4] * s) * 255)
    out[i * 4 + 1] = Math.round(Math.min(1, cv.px[i * 4 + 1] * s) * 255)
    out[i * 4 + 2] = Math.round(Math.min(1, cv.px[i * 4 + 2] * s) * 255)
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255)
  }
  return out
}

function encodePng(cv) {
  const S = cv.size
  const rgba = toRgba(cv)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const rows = Buffer.alloc(S * (S * 4 + 1))
  for (let y = 0; y < S; y++) {
    rows[y * (S * 4 + 1)] = 0 // filter: none
    rgba.copy(rows, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* --------------------------------------------------------------------- ICO *
 * 16..128 go in as BITMAPINFOHEADER DIBs and 256 as an embedded PNG — the exact
 * layout Windows' own shell icons use. All-PNG works on Vista+ but some icon
 * readers (including a few that sit between here and the NSIS installer) still
 * only understand the DIB form at small sizes.
 * -------------------------------------------------------------------------- */

function dibEntry(cv) {
  const S = cv.size
  const rgba = toRgba(cv)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(S, 4)
  header.writeInt32LE(S * 2, 8) // height doubled: XOR image + AND mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  const xor = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) {
    const src = (S - 1 - y) * S * 4 // DIB rows are bottom-up
    for (let x = 0; x < S; x++) {
      xor[(y * S + x) * 4] = rgba[src + x * 4 + 2] // B
      xor[(y * S + x) * 4 + 1] = rgba[src + x * 4 + 1] // G
      xor[(y * S + x) * 4 + 2] = rgba[src + x * 4] // R
      xor[(y * S + x) * 4 + 3] = rgba[src + x * 4 + 3] // A
    }
  }
  // 1bpp AND mask, rows padded to 4 bytes. Zeroed: the 32bpp alpha is the mask.
  const maskStride = Math.ceil(S / 32) * 4
  const mask = Buffer.alloc(maskStride * S)
  return Buffer.concat([header, xor, mask])
}

function encodeIco(canvases) {
  const images = canvases.map((cv) => (cv.size >= 256 ? encodePng(cv) : dibEntry(cv)))
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(canvases.length, 4)
  const dir = Buffer.alloc(16 * canvases.length)
  let offset = 6 + dir.length
  canvases.forEach((cv, i) => {
    const o = i * 16
    dir[o] = cv.size >= 256 ? 0 : cv.size // 0 means 256
    dir[o + 1] = cv.size >= 256 ? 0 : cv.size
    dir[o + 2] = 0 // palette
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(images[i].length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += images[i].length
  })
  return Buffer.concat([head, dir, ...images])
}

/* --------------------------------------------------------------------- SVG *
 * Emitted from the same geometry table, so `build/icon.svg` is the readable source
 * of the mark rather than a second, drifting copy of it.
 * -------------------------------------------------------------------------- */

function svg(size = 512) {
  const g = LARGE
  const A = aperture(size, g)
  const n = (v) => Number(v.toFixed(2))
  const poly = (pts) => pts.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')
  const R = g.R * size
  const c = size / 2
  const rim = Math.max(1, size * 0.02)
  const hw = size * 0.02

  const blades = A.blades
    .map((b) => `    <polygon points="${poly(b.pts)}" fill="${hex(bladeShade(b.lit))}"/>`)
    .join('\n')
  const seams = A.blades
    .map(
      (b) =>
        `    <line x1="${n(b.leading[0][0])}" y1="${n(b.leading[0][1])}" x2="${n(b.leading[1][0])}" y2="${n(
          b.leading[1][1]
        )}" stroke="${hex(C_SEAM)}" stroke-opacity="0.92" stroke-width="${n(size * 0.02)}" stroke-linecap="round"/>`
    )
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="OSINT Workbench">
  <title>OSINT Workbench — aperture</title>
  <!-- Generated by scripts/make-icons.mjs from the geometry table in that file.
       Edit the table, not this file. -->
  <defs>
    <radialGradient id="safelight" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${hex(C_OPENING)}" stop-opacity="${g.glow}"/>
      <stop offset="100%" stop-color="${hex(C_OPENING)}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="tile">
      <rect x="0" y="0" width="${size}" height="${size}" rx="${n(g.corner * size)}" ry="${n(g.corner * size)}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect x="0" y="0" width="${size}" height="${size}" fill="${hex(C_GROUND)}"/>
    <circle cx="${n(c)}" cy="${n(c)}" r="${n(R)}" fill="${hex(C_BLADE)}"/>
${blades}
    <circle cx="${n(c)}" cy="${n(c)}" r="${n(Math.min(R, g.r * size * 1.55))}" fill="url(#safelight)"/>
${seams}
    <circle cx="${n(c)}" cy="${n(c)}" r="${n(R + hw * 0.15)}" fill="none" stroke="${hex(
      C_SEAM
    )}" stroke-opacity="0.6" stroke-width="${n(hw)}"/>
    <polygon points="${poly(A.opening)}" fill="${hex(C_OPENING)}"/>
  </g>
  <rect x="${n(rim / 2)}" y="${n(rim / 2)}" width="${n(size - rim)}" height="${n(size - rim)}" rx="${n(
    g.corner * size - rim / 2
  )}" ry="${n(g.corner * size - rim / 2)}" fill="none" stroke="${hex(C_RIM)}" stroke-opacity="0.85" stroke-width="${n(
    rim
  )}"/>
</svg>
`
}

/* ------------------------------------------------------------------ output */

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const TRAY_SIZES = [16, 20, 24, 32, 40, 48] // 100/125/150/200/250/300% DPI

function write(rel, buf) {
  const abs = path.join(ROOT, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, buf)
  console.log(`  ${rel.padEnd(34)} ${String(buf.length).padStart(8)} bytes`)
}

/**
 * A magnified, hard-pixel preview on both taskbar greys, so the 16px render can be
 * *looked at* rather than asserted about. Written only with --preview; not committed.
 */
function previewSheet(sizes, scale = 14) {
  const grounds = [
    [32, 32, 32], // Windows 11 dark taskbar
    [243, 243, 243] // Windows 11 light taskbar
  ]
  const pad = 8
  const cellW = sizes.map((s) => s * scale + pad * 2)
  const width = cellW.reduce((a, b) => a + b, 0)
  const rowH = Math.max(...sizes) * scale + pad * 2
  const height = rowH * grounds.length
  // canvas() is square; the sheet is not, so build a raw opaque buffer instead.
  const px = Buffer.alloc(width * height * 4)
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = 255
  }
  const rendered = sizes.map((s) => ({ s, rgba: toRgba(renderIcon(s)) }))
  grounds.forEach((bg, gi) => {
    for (let y = 0; y < rowH; y++) for (let x = 0; x < width; x++) put(x, gi * rowH + y, ...bg)
    let ox = 0
    rendered.forEach(({ s, rgba }, i) => {
      const oy = gi * rowH + pad
      for (let y = 0; y < s * scale; y++) {
        for (let x = 0; x < s * scale; x++) {
          const sx = Math.floor(x / scale)
          const sy = Math.floor(y / scale)
          const j = (sy * s + sx) * 4
          const a = rgba[j + 3] / 255
          put(
            ox + pad + x,
            oy + y,
            Math.round(rgba[j] * a + bg[0] * (1 - a)),
            Math.round(rgba[j + 1] * a + bg[1] * (1 - a)),
            Math.round(rgba[j + 2] * a + bg[2] * (1 - a))
          )
        }
      }
      ox += cellW[i]
    })
  })

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0
    px.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

console.log('aperture mark —', {
  ground: hex(C_GROUND),
  blade: hex(C_BLADE),
  opening: hex(C_OPENING),
  rim: hex(C_RIM)
})

write('build/icon.svg', Buffer.from(svg(512), 'utf8'))
write('build/icon.png', encodePng(renderIcon(512)))
write('build/icon.ico', encodeIco(ICO_SIZES.map((s) => renderIcon(s))))
write('build/installer-icon.ico', encodeIco(ICO_SIZES.map((s) => renderIcon(s))))

// The tray gets its own .ico so Windows picks the right size per DPI instead of
// smearing one bitmap. The tile keeps its ground and rim at every size: a
// transparent glyph would need to be light for the dark taskbar and dark for the
// light one, and there is no single colour that is both.
write('resources/tray.ico', encodeIco(TRAY_SIZES.map((s) => renderIcon(s))))
write('resources/tray.png', encodePng(renderIcon(32)))
write('resources/tray@2x.png', encodePng(renderIcon(64)))

if (process.argv.includes('--preview')) {
  write('build/preview/sizes.png', previewSheet([16, 20, 24, 32, 48]))
  for (const s of [16, 24, 32, 48, 256]) write(`build/preview/icon-${s}.png`, encodePng(renderIcon(s)))
}

#!/usr/bin/env node
/**
 * Measured contrast for the Darkroom palette.
 *
 * DESIGN.md states target ratios next to several tokens. Those are claims; this script
 * is the measurement. It parses the OKLCH declarations straight out of
 * `src/renderer/src/styles/tokens.css` — so it cannot drift from what actually ships —
 * converts them through OKLab to sRGB, and reports WCAG 2.1 contrast ratios.
 *
 * It also reports the greyscale separation of the confidence ramp, because the ramp's
 * whole promise is that it survives desaturation.
 *
 *   node scripts/contrast.mjs          # table + pass/fail, exit 1 on any failure
 *   node scripts/contrast.mjs --json   # machine-readable
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const TOKENS = resolve(here, '../src/renderer/src/styles/tokens.css')

/* -------------------------------------------------------------- colour math */

/** OKLCH -> linear sRGB. Björn Ottosson's matrices. */
function oklchToLinearRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
const decode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const clamp01 = (x) => Math.min(1, Math.max(0, x))

/**
 * The sRGB a display actually shows, plus whether we had to clip to get there.
 * Clipping matters: an out-of-gamut token measures differently from what it declares.
 */
function toSrgb(L, C, h) {
  const lin = oklchToLinearRgb(L, C, h)
  const clipped = lin.some((v) => v < -1e-6 || v > 1 + 1e-6)
  const rgb = lin.map((v) => clamp01(encode(clamp01(v))))
  return { rgb, clipped }
}

/** WCAG 2.1 relative luminance, computed from the on-screen (clipped) sRGB. */
function luminance([r, g, b]) {
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b)
}

function contrast(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const hex = ([r, g, b]) =>
  '#' +
  [r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')

/* ------------------------------------------------------------ token parsing */

const css = readFileSync(TOKENS, 'utf8')
const tokens = new Map()
const re = /--([a-z0-9-]+)\s*:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/gi
for (let m; (m = re.exec(css)); ) {
  const [, name, L, C, h] = m
  const { rgb, clipped } = toSrgb(Number(L), Number(C), Number(h))
  tokens.set(name, { name, L: Number(L), C: Number(C), h: Number(h), rgb, clipped })
}

const get = (n) => {
  const t = tokens.get(n)
  if (!t) throw new Error(`token --${n} is not declared in tokens.css`)
  return t
}

/* ------------------------------------------------------------------- pairs */

/** [foreground, background, minimum, what it is]. 4.5 = body text, 3 = UI/large. */
const PAIRS = [
  // Text on every surface it can land on.
  ['ink', 'bg', 4.5, 'primary text on canvas'],
  ['ink', 'surface', 4.5, 'primary text on panel'],
  ['ink', 'surface-raised', 4.5, 'primary text on popover'],
  ['ink', 'bg-sunken', 4.5, 'primary text in a well'],
  ['ink-muted', 'bg', 4.5, 'secondary text on canvas'],
  ['ink-muted', 'surface', 4.5, 'secondary text on panel'],
  ['ink-muted', 'surface-raised', 4.5, 'secondary text on popover'],
  ['ink-muted', 'bg-sunken', 4.5, 'secondary text in a well'],
  ['ink-subtle', 'bg', 4.5, 'metadata / placeholder on canvas'],
  ['ink-subtle', 'bg-sunken', 4.5, 'metadata in a well'],

  // The confidence ramp, on every background a finding row can sit on.
  ['ink-latent', 'bg', 4.5, 'unverified on canvas'],
  ['ink-latent', 'surface', 4.5, 'unverified on panel'],
  ['ink-latent', 'row-hover', 4.5, 'unverified on hovered row'],
  ['ink-latent', 'row-selected', 4.5, 'unverified on selected row'],
  ['ink-developing', 'bg', 4.5, 'corroborated on canvas'],
  ['ink-developing', 'surface', 4.5, 'corroborated on panel'],
  ['ink-developing', 'row-hover', 4.5, 'corroborated on hovered row'],
  ['ink-developing', 'row-selected', 4.5, 'corroborated on selected row'],
  ['ink-developed', 'bg', 4.5, 'confirmed on canvas'],
  ['ink-developed', 'surface', 4.5, 'confirmed on panel'],
  ['ink-developed', 'row-hover', 4.5, 'confirmed on hovered row'],
  ['ink-developed', 'row-selected', 4.5, 'confirmed on selected row'],
  ['ink-fixed', 'bg', 4.5, 'refuted on canvas'],
  ['ink-fixed', 'surface', 4.5, 'refuted on panel'],
  ['ink-fixed', 'row-hover', 4.5, 'refuted on hovered row'],
  ['ink-fixed', 'row-selected', 4.5, 'refuted on selected row'],
  ['ink-fixed', 'row-refuted', 4.5, 'refuted on its own sunken row'],
  ['ink-muted', 'row-refuted', 4.5, 'metadata on a refuted row'],

  // Semantic states carry text, so they are held to the text bar too.
  ['danger', 'bg', 4.5, 'error text on canvas'],
  ['danger', 'surface', 4.5, 'error text on panel'],
  ['danger', 'danger-wash', 4.5, 'error text on its own wash'],
  ['warning', 'bg', 4.5, 'warning text on canvas'],
  ['warning', 'surface', 4.5, 'warning text on panel'],
  ['success', 'bg', 4.5, 'success text on canvas'],
  ['success', 'surface', 4.5, 'success text on panel'],
  ['info', 'bg', 4.5, 'info text on canvas'],
  ['info', 'surface', 4.5, 'info text on panel'],
  ['accent', 'bg', 4.5, 'live text on canvas'],
  ['accent', 'surface', 4.5, 'live text on panel'],
  ['accent', 'sweep-peak', 4.5, 'live text at the brightest point of the sweep'],
  ['accent-dim', 'bg', 3, 'live marker rule on canvas'],

  // Buttons.
  ['primary-ink', 'primary', 4.5, 'label on a primary button'],
  ['primary-ink', 'primary-hover', 4.5, 'label on a hovered primary button'],
  ['ink', 'control', 4.5, 'label on a secondary button'],
  ['ink', 'control-hover', 4.5, 'label on a hovered secondary button'],
  ['ink-muted', 'control', 4.5, 'disabled-adjacent label on a control'],
  ['ink-subtle', 'bg-sunken', 4.5, 'label on a disabled control'],

  // Non-text UI: 3:1. The focus ring must clear it against BOTH the surface it sits on
  // and whatever it sits next to, which is why every neighbour is listed.
  ['focus', 'bg', 3, 'focus ring vs canvas'],
  ['focus', 'surface', 3, 'focus ring vs panel'],
  ['focus', 'surface-raised', 3, 'focus ring vs popover'],
  ['focus', 'bg-sunken', 3, 'focus ring vs well'],
  ['focus', 'control', 3, 'focus ring vs control fill'],
  ['focus', 'primary', 3, 'focus ring vs primary fill'],
  ['focus', 'row-selected', 3, 'focus ring vs selected row'],
  ['focus', 'nav-active', 3, 'focus ring vs active nav item'],
  ['focus', 'surface-hover', 3, 'focus ring vs hovered nav item'],
  ['ink', 'nav-active', 4.5, 'label on the active nav item'],
  ['ink', 'surface-hover', 4.5, 'label on a hovered nav item'],
  ['ink-muted', 'surface-hover', 4.5, 'secondary label on a hovered nav item'],
  ['border-control', 'bg', 3, 'input / checkbox edge vs canvas'],
  ['border-control', 'surface', 3, 'input / checkbox edge vs panel'],
  ['border-control', 'surface-raised', 3, 'input / checkbox edge vs popover'],
  ['border-control', 'control', 3, 'input edge vs its own fill']
]

/**
 * Pairs that must NOT be used, asserted as failures so the constraint is measured rather
 * than remembered. If one of these ever starts passing, the token moved and the usage
 * rule in tokens.css can be relaxed — deliberately, not by accident.
 */
const FORBIDDEN = [
  ['ink-subtle', 'surface', 4.5, '--ink-subtle is canvas-only; panels use --ink-muted'],
  ['ink-subtle', 'surface-raised', 4.5, '--ink-subtle is canvas-only; popovers use --ink-muted'],
  [
    'border-strong',
    'bg',
    3,
    '--border-strong is a supplementary edge, never the sole carrier of focus or selection'
  ]
]

/* ------------------------------------------------------------------ report */

const rows = PAIRS.map(([fg, bg, min, what]) => {
  const F = get(fg)
  const B = get(bg)
  const ratio = contrast(F.rgb, B.rgb)
  return { fg, bg, what, min, ratio: Math.round(ratio * 100) / 100, pass: ratio >= min }
})

// Greyscale separation of the ramp. Hue contributes nothing here by construction, so
// this is really a check that the four L values are far enough apart to be told apart.
const RAMP = ['ink-latent', 'ink-developing', 'ink-developed', 'ink-fixed']
const grey = RAMP.map((n) => {
  const t = get(n)
  const Y = luminance(t.rgb)
  return { name: n, L: t.L, luminance: Math.round(Y * 10000) / 10000, grey: Math.round(encode(Y) * 255) }
})
const ordered = ['ink-fixed', 'ink-latent', 'ink-developing', 'ink-developed'].map((n) =>
  grey.find((g) => g.name === n)
)
const steps = ordered.slice(1).map((g, i) => ({
  from: ordered[i].name,
  to: g.name,
  ratio: Math.round(contrast(get(ordered[i].name).rgb, get(g.name).rgb) * 100) / 100,
  greyDelta: g.grey - ordered[i].grey
}))

const forbidden = FORBIDDEN.map(([fg, bg, min, why]) => {
  const ratio = contrast(get(fg).rgb, get(bg).rgb)
  return { fg, bg, why, min, ratio: Math.round(ratio * 100) / 100, stillForbidden: ratio < min }
})

const clippedTokens = [...tokens.values()].filter((t) => t.clipped).map((t) => t.name)
const failures = rows.filter((r) => !r.pass)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, forbidden, grey, steps, clipped: clippedTokens }, null, 2))
} else {
  const w = Math.max(...rows.map((r) => `${r.fg} on ${r.bg}`.length))
  console.log(`\n  ${tokens.size} OKLCH tokens parsed from styles/tokens.css\n`)
  console.log('  CONTRAST')
  for (const r of rows) {
    const pair = `${r.fg} on ${r.bg}`.padEnd(w)
    const mark = r.pass ? 'ok  ' : 'FAIL'
    console.log(
      `  ${mark} ${pair}  ${String(r.ratio).padStart(6)}:1  (min ${r.min})   ${r.what}`
    )
  }

  console.log('\n  USAGE CONSTRAINTS  (these pairs must fail — the rule is the measurement)')
  for (const f of forbidden) {
    console.log(
      `  ${f.stillForbidden ? 'held' : 'STALE'} ${`${f.fg} on ${f.bg}`.padEnd(w)}  ${String(f.ratio).padStart(6)}:1  (would need ${f.min})   ${f.why}`
    )
  }

  console.log('\n  CONFIDENCE RAMP IN GREYSCALE  (0-255 after sRGB encode)')
  for (const g of ordered) {
    console.log(`       --${g.name.padEnd(15)} L ${g.L.toFixed(2)}   grey ${String(g.grey).padStart(3)}`)
  }
  for (const s of steps) {
    console.log(
      `       ${s.from} -> ${s.to}: ${s.ratio}:1, ${s.greyDelta} grey levels apart`
    )
  }

  console.log('\n  SWATCHES')
  for (const t of [...tokens.values()]) {
    console.log(`       --${t.name.padEnd(16)} ${hex(t.rgb)}${t.clipped ? '  (clipped to gamut)' : ''}`)
  }

  console.log(
    `\n  ${rows.length - failures.length}/${rows.length} pairs pass.` +
      (clippedTokens.length ? `  Out of gamut: ${clippedTokens.join(', ')}.` : '') +
      '\n'
  )
}

process.exit(failures.length ? 1 : 0)

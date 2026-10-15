#!/usr/bin/env node
/**
 * Design-system lint for src/renderer.
 *
 * Three things in DESIGN.md are rules rather than preferences, and all three decay
 * silently unless something checks them:
 *
 *   1. **No literal colours outside tokens.css.** "If you need a value that isn't a
 *      token, add a token" is only true if a literal is an error rather than a shortcut.
 *   2. **The monospace ration.** Mono is rationed to data — hashes, coordinates,
 *      usernames, timestamps, domains, paths, raw output — and never headings, buttons,
 *      labels or body copy. Because it is rationed it means something. Every rule that
 *      applies `--font-mono` has to be listed in MONO_SELECTORS below, so a new one is a
 *      deliberate edit to this file and not an accident in a component.
 *   3. **The bans.** Terminal cosplay, glassmorphism, gradient text, side-stripe
 *      accents, pill radii, arbitrary z-index.
 *
 *   node scripts/design-lint.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const RENDERER = resolve(ROOT, 'src/renderer')
const TOKENS = 'src/renderer/src/styles/tokens.css'
const FONTS = 'src/renderer/src/styles/fonts.css'

/** Selectors permitted to apply `--font-mono`. Every one names data. */
const MONO_SELECTORS = new Set([
  '.data', // the <Data> component and every mono cell in a table
  '.input--data', // typing a literal a tool will probe
  '.entity__value', // an entity's canonical value
  '.run__line', // probing 247 / 3000 · 11 hits · 0:42
  '.run__target', // the site being hit right now
  '.empty__example-body', // the worked example in an empty state
  '.raw', // unparsed tool output
  '.copy' // the copy affordance wraps a literal value
])

const BANS = [
  [/backdrop-filter\s*:/i, 'glassmorphism (backdrop-filter)'],
  [/-webkit-background-clip\s*:\s*text|background-clip\s*:\s*text/i, 'gradient text'],
  [/\bscanline|\bglitch|\bmatrix-rain|\bcrt\b/i, 'terminal cosplay'],
  [/animation[^;]*\bblink\b/i, 'blinking cursor'],
  [/border-left\s*:\s*(?!var\(--hairline)[^;]*var\(--(?:primary|accent|danger|warning|success|info)/i,
    'side-stripe border accent'],
  [/border-radius\s*:\s*9999px|border-radius\s*:\s*50rem|border-radius\s*:\s*999px/i, 'pill radius'],
  [/text-transform\s*:\s*uppercase/i, 'uppercase tracked eyebrow (11px micro labels do not need it)'],
  [/!important/i, '!important'],
  [/z-index\s*:\s*(?!var\(--z-)-?\d/i, 'arbitrary z-index (use the --z-* tokens)']
]

/** Literal colours. `oklch(` is allowed only in tokens.css. */
const LITERAL_COLOUR =
  /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\boklch\s*\(|\boklab\s*\(|\bcolor-mix\s*\(/i

/** Named colours that slip past the hex check. */
const NAMED_COLOUR =
  /(?:^|[\s:,(])(?:red|green|blue|orange|purple|yellow|pink|cyan|magenta|teal|lime|navy|maroon|olive|silver|gray|grey|white|black)(?:\s*[;,)]|$)/i

const files = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(css|tsx|ts|html)$/.test(name)) files.push(p)
  }
})(RENDERER)

const problems = []
const monoRules = []

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/')
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')

  // Collect the selectors that apply --font-mono, so the ration can be checked as a set.
  // Comments are stripped first: this file explains the rule in prose, and the prose is
  // not a selector.
  if (rel.endsWith('.css')) {
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '')
    const ruleRe = /([^{}]+)\{([^}]*)\}/g
    for (let m; (m = ruleRe.exec(stripped)); ) {
      const [, selector, body] = m
      if (/font-family\s*:\s*var\(--font-mono\)/.test(body)) {
        for (const s of selector.split(',')) monoRules.push({ rel, selector: s.trim() })
      }
    }
  }

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    const code = line.replace(/\/\*.*?\*\//g, '')
    // Skip comment-only lines; the rules are about what ships, not what is explained.
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line)
    if (isComment) return

    if (rel !== TOKENS && LITERAL_COLOUR.test(code)) {
      problems.push(`${at}  literal colour — add a token in tokens.css instead\n      ${line.trim()}`)
    }
    if (rel !== TOKENS && rel !== FONTS && NAMED_COLOUR.test(code) && /(?:color|background|border|fill|stroke)\s*:/i.test(code)) {
      problems.push(`${at}  named colour — add a token in tokens.css instead\n      ${line.trim()}`)
    }
    for (const [re, what] of BANS) {
      if (re.test(code)) problems.push(`${at}  banned: ${what}\n      ${line.trim()}`)
    }
    // Fonts may only be *named* in fonts.css and tokens.css. Everywhere else a
    // font-family must be one of the two tokens — checked on the captured value, because
    // a negative lookahead after `\s*` backtracks and passes anything.
    if (rel !== FONTS && rel !== TOKENS) {
      const fam = /font-family\s*:\s*([^;]+)/i.exec(code)
      if (fam && !/^var\(--font-(?:sans|mono)\)$/.test((fam[1] ?? '').trim())) {
        problems.push(`${at}  a font stack outside fonts.css / tokens.css\n      ${line.trim()}`)
      }
    }
  })
}

/*
 * Every view has exactly one scrollport, and it is `.view__scroll`.
 *
 * This is a lint rather than a convention because forgetting it fails **silently and
 * totally**: `.view__body` used to be the only element with `overflow-y: auto`, so a view
 * that put panels above it as siblings gave those panels the height they wanted and left
 * the body with whatever remained. On Self-Audit at 1280x800 that measured zero — the body
 * sat 594px below the fold and was still the only thing the wheel could move, so the page
 * did not scroll at all. Nothing about that is visible in a diff, and the operator's only
 * symptom was "it's only scrolling the bottom part".
 *
 * So: a component that renders `.view__body` must also render `.view__scroll`. The
 * `--pad` modifier is exempt on purpose — `view__body--pad` is used on its own as a
 * padding utility inside a scrollport a parent already established.
 */
const VIEW_BODY = /className="[^"]*\bview__body(?![-\w])/
const VIEW_SCROLL = /className="[^"]*\bview__scroll\b/
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/')
  if (!rel.endsWith('.tsx')) continue
  const text = readFileSync(file, 'utf8')
  if (VIEW_BODY.test(text) && !VIEW_SCROLL.test(text)) {
    problems.push(
      `${rel}  renders .view__body without a .view__scroll wrapper.\n` +
        `      .view__body grows and does not scroll; .view__scroll is the scrollport.\n` +
        `      Without it the panels above the body take the height and the page cannot scroll.`
    )
  }
}

for (const { rel, selector } of monoRules) {
  if (rel === TOKENS || rel === FONTS) continue
  const base = selector.replace(/\s*[,>+~].*$/, '').trim()
  if (!MONO_SELECTORS.has(base) && !MONO_SELECTORS.has(selector)) {
    problems.push(
      `${rel}  \`${selector}\` applies --font-mono but is not in MONO_SELECTORS.\n` +
        `      Monospace is rationed to data. If this selector really marks a literal value,\n` +
        `      add it to scripts/design-lint.mjs deliberately.`
    )
  }
}

if (problems.length) {
  console.error(`\n  ${problems.length} design-system violation(s):\n`)
  for (const p of problems) console.error(`  ${p}\n`)
  process.exit(1)
}

console.log(
  `\n  design-lint: ${files.length} files clean.` +
    `\n  ${monoRules.length} monospace rules, all rationed to data.\n`
)

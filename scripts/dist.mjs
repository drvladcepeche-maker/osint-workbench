#!/usr/bin/env node
/**
 * `npm run dist` — the one command that produces the installer.
 *
 * This exists instead of putting `electron-builder --win` straight in package.json for
 * one reason: **cache locations have to hold regardless of which shell ran npm.**
 *
 * electron-builder caches ~200 MB of Electron zips, NSIS binaries and winCodeSign tools.
 * Left alone it puts all of it in `%LOCALAPPDATA%\electron-builder\Cache` on the system drive, which is
 * the drive that is chronically full. Those locations are settable only by environment
 * variable — `.npmrc` cannot do it (npm 11 rejects unknown keys with a warning and moves
 * on, which is how you end up with a full system drive and no error), and a `set VAR=...` prefix in
 * a package.json script is cmd.exe syntax that breaks the moment npm runs under bash.
 *
 * Setting them here, in the process that spawns the builder, is the only version that is
 * true in every shell.
 *
 *   node scripts/dist.mjs              nsis + portable
 *   node scripts/dist.mjs --dir        unpacked only, no installer — fast
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Optional: redirect the heavy caches (for example onto a bigger disk) by exporting
// OSINT_CACHE_DIR before running. Unset, the tools use their normal defaults.
const CACHE_ROOT = process.env.OSINT_CACHE_DIR
const CACHES = CACHE_ROOT
  ? {
      ELECTRON_BUILDER_CACHE: path.join(CACHE_ROOT, 'electron-builder-cache'),
      ELECTRON_CACHE: path.join(CACHE_ROOT, 'electron-cache'),
      npm_config_cache: path.join(CACHE_ROOT, 'npm-cache')
    }
  : {}

for (const dir of Object.values(CACHES)) mkdirSync(dir, { recursive: true })

const env = { ...process.env, ...CACHES }

const run = (cmd, args) => {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`\n${cmd} failed with exit code ${r.status}`)
    process.exit(r.status ?? 1)
  }
}

console.log(CACHE_ROOT ? 'cache targets (from OSINT_CACHE_DIR):' : 'cache targets: tool defaults (set OSINT_CACHE_DIR to redirect)')
for (const [k, v] of Object.entries(CACHES)) console.log(`  ${k.padEnd(24)} ${v}`)

run('node', ['scripts/make-icons.mjs'])
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--win', ...process.argv.slice(2)])

console.log('\nartifacts are in release/')

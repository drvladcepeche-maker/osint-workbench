/**
 * Bundles test/index.ts into a single CJS file that plain Node can run.
 *
 * esbuild rather than a test runner: the whole suite is one entry point, better-sqlite3
 * is the only native dependency and it stays external, and this keeps the dependency
 * count (and therefore the disk footprint) down.
 */

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [path.join(root, 'test', 'index.ts')],
  outfile: path.join(root, 'out', 'test', 'tests.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'inline',
  // Native module; must be required at runtime, not inlined.
  external: ['better-sqlite3', 'electron'],
  logLevel: 'warning'
})

console.log('built out/test/tests.cjs')

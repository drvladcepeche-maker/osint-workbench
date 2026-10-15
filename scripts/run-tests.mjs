/**
 * Runs the bundled test suite and cleans up its scratch directory.
 *
 * Test temp files land in `.tmp-test/` inside the repo, never in the
 * system temp directory.
 */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = path.join(root, '.tmp-test')

rmSync(tmp, { recursive: true, force: true })

const res = spawnSync(process.execPath, [path.join(root, 'out', 'test', 'tests.cjs')], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, OSINT_TEST_TMP: tmp }
})

rmSync(tmp, { recursive: true, force: true })
process.exit(res.status ?? 1)

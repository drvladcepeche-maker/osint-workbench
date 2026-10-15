/**
 * Properties of the repository itself, rather than of anything it does at runtime.
 *
 * There is one so far, and it earned its place by happening twice.
 *
 * **A literal NUL byte in a source file.** Two of them sat inside template strings in
 * `service.ts` — `` `${adapterId}\u0000${entityId}` `` written with the raw byte instead of
 * the escape — and an earlier one sat in `theharvester.ts`. They are invisible in every
 * editor, they cannot be typed, `grep` gives up on the file and calls it binary, and git
 * stops normalising its line endings because a NUL is how git decides a blob is not text.
 * None of that announces itself: the code compiles and the tests pass, and the file quietly
 * stops behaving like source.
 *
 * The separator itself is legitimate — `ids.ts` joins the parts of a content-addressed id
 * with `\u0000` precisely so that `('a','bc')` and `('ab','c')` cannot collide, and every
 * entity and finding id in every case file depends on that byte being there. So the rule is
 * not "no NUL in a string", it is "no NUL **in the file**": write the escape, which produces
 * exactly the same string and leaves the source readable by everything that reads source.
 *
 * Scanned as bytes rather than as text, because a decoder is free to replace what it cannot
 * make sense of and that is exactly the failure being tested for.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/** Directories that hold source. Everything else in the repo is output or captured bytes. */
const SOURCE_DIRS = ['src', 'test', 'scripts', 'config']

/**
 * Extensions a person edits by hand. Deliberately an allowlist: `raw/`, `phase0-samples/`
 * and the icon PNGs are full of NUL bytes and are supposed to be.
 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.md', '.yml'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (SOURCE_EXTENSIONS.has(path.extname(e.name))) out.push(p)
  }
  return out
}

export function repoTests(test: (name: string, fn: () => void | Promise<void>) => void): void {
  test('no source file contains a literal NUL byte', () => {
    const root = process.cwd()
    const files = SOURCE_DIRS.flatMap((d) => sourceFiles(path.join(root, d)))
    assert.ok(files.length > 100, `only ${files.length} source files found — the scan is looking in the wrong place`)

    const offenders: string[] = []
    for (const file of files) {
      const bytes = fs.readFileSync(file)
      const at = bytes.indexOf(0)
      if (at < 0) continue
      // Name the line, because "somewhere in a 900-line file" is not actionable for a
      // character nothing renders.
      const line = bytes.subarray(0, at).toString('latin1').split('\n').length
      offenders.push(`${path.relative(root, file)}:${line}`)
    }

    assert.deepEqual(
      offenders,
      [],
      `literal NUL byte(s) in source. Write \\u0000 in the string instead — it produces the ` +
        `same value and leaves the file readable by grep, git and every editor. Found at: ${offenders.join(', ')}`
    )
  })
}

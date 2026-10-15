/**
 * Finding a Python interpreter, and saying something useful when there isn't one.
 *
 * The scrubber is a Python program (the opsec-kit checkout) that this app drives; it is
 * deliberately not reimplemented in TypeScript, because it already handles three things
 * correctly that are easy to get wrong and expensive to rediscover: Cyrillic filenames
 * via a UTF-8 ExifTool argfile, the `--icc_profile:all` exclusion that keeps a colour
 * profile alive through `-all=`, and PDF residue scanning for values ExifTool "deleted"
 * but left in the bytes.
 *
 * The interpreter version matters. opsec-kit is documented against **3.12** and the
 * machine's default `py` is 3.14, which is missing the packages `watch.py` needs. So the
 * search is ordered, not opportunistic, and every failure produces a sentence the
 * operator can act on rather than a spawn error.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface PythonResolution {
  /** The executable to spawn, plus any leading args (`py` needs `-3.12`). */
  command: string | null
  args: string[]
  version: string | null
  /** How it was found, for the UI: "config", "py -3.12", "PATH", … */
  how: string
  error: string | null
}

/** Ask an interpreter what it is. A candidate that will not answer is not a candidate. */
function probe(command: string, args: string[]): string | null {
  try {
    const r = spawnSync(command, [...args, '-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000
    })
    if (r.status !== 0) return null
    const v = (r.stdout ?? '').trim()
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null
  } catch {
    return null
  }
}

const major = (v: string): number => Number(v.split('.')[0])
const minor = (v: string): number => Number(v.split('.')[1])

/**
 * @param configured An explicit interpreter path from `config/local.config.json`, which
 *                   always wins and, when it is wrong, says so instead of silently
 *                   falling through to a different Python than the one asked for.
 */
export function findPython(configured?: string | null): PythonResolution {
  if (configured) {
    if (!existsSync(configured)) {
      return {
        command: null,
        args: [],
        version: null,
        how: 'config',
        error: `config/local.config.json sets pythonPath to ${configured}, and there is no file there. Correct the path or remove the key to let the app search for a 3.12 interpreter.`
      }
    }
    const version = probe(configured, [])
    if (!version) {
      return {
        command: null,
        args: [],
        version: null,
        how: 'config',
        error: `${configured} exists but did not answer a version query, so it is not a working Python interpreter.`
      }
    }
    return { command: configured, args: [], version, how: 'config', error: null }
  }

  /* Ordered: the launcher asked for 3.12 explicitly, then the path that launcher
     resolves to on this machine, then whatever is on PATH. `py` and `py -3` are
     deliberately absent — they select the newest interpreter, which is the one
     opsec-kit's README says breaks things. */
  const candidates: { command: string; args: string[]; how: string }[] = [
    { command: 'py', args: ['-3.12'], how: 'py -3.12' },
    { command: 'C:\\Python312\\python.exe', args: [], how: 'C:\\Python312' },
    { command: 'python3.12', args: [], how: 'PATH (python3.12)' },
    { command: 'python', args: [], how: 'PATH (python)' }
  ]

  const found: PythonResolution[] = []
  for (const c of candidates) {
    const version = probe(c.command, c.args)
    if (version) found.push({ ...c, version, error: null })
  }

  /* Prefer an interpreter opsec-kit is actually tested against. A 3.14 on PATH will run
     scrub.py and audit.py — both are pure stdlib — so it is accepted rather than
     rejected, but only after 3.12 has been looked for properly. */
  const preferred =
    found.find((p) => p.version && major(p.version) === 3 && minor(p.version) === 12) ??
    found.find((p) => p.version && major(p.version) === 3 && minor(p.version) >= 9) ??
    null

  if (!preferred) {
    return {
      command: null,
      args: [],
      version: null,
      how: 'not found',
      error:
        'No Python interpreter was found. The scrubber is a Python program and cannot run without one. ' +
        'Install Python 3.12 and check that `py -3.12 --version` answers in a terminal, or set "pythonPath" ' +
        'in config/local.config.json to the interpreter you want used.'
    }
  }
  return preferred
}

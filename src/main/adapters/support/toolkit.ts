/**
 * The bits every spawned-tool adapter needs and none of them should reinvent.
 *
 * Three jobs:
 *
 *  1. **The environment.** `PYTHONIOENCODING=utf-8` on every Python spawn. This is not a
 *     nicety. Windows' console codepage is cp1252; maigret prints a donation banner
 *     containing `♥` (U+2665) *before it does any work*, and without the variable it dies
 *     with `UnicodeEncodeError` in `notify.py` having probed nothing. Setting it costs
 *     the tools that do not need it exactly nothing.
 *  2. **Finding the binary.** Every tool is either an `.exe` shim in a venv or a
 *     standalone binary under `bin/`. The path is `config.adapters[<id>].bin` when the
 *     operator set one, otherwise the first candidate under `toolkitRoot` that exists.
 *     When nothing exists we still return a path, so the failure surfaces as a normal
 *     spawn error with the path in it rather than as a thrown exception.
 *  3. **Scratch space.** Five of the eight CLI tools write their structured output to a
 *     *file* whose name they choose (timestamps, date stamps, the username), relative to
 *     the current working directory. The only reliable way to collect that is to give
 *     each run its own empty directory and look at what appeared in it.
 *
 * Scratch directories live at `<caseDir>/.work/<adapter>-<ulid>` and are deleted when the
 * run finishes. They are inside the case folder because that is the only absolute path an
 * adapter is handed, and because it is guaranteed to be on the same drive as the
 * rest of the case — never the system temp directory.
 */

import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AppConfig } from '../../../shared/types'
import { ulid } from '../../../shared/ids'

/**
 * Environment applied to every child process an adapter starts.
 *
 * `PYTHONIOENCODING` / `PYTHONUTF8` are the load-bearing pair — see the file header.
 * The cache redirects exist so that nothing a tool decides to download at runtime lands
 * on the system drive.
 */
export function osintEnv(toolkitRoot: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    // Line-buffered output, so progress parsing sees lines as they happen rather than in
    // one lump when the pipe closes.
    PYTHONUNBUFFERED: '1',
    PIP_CACHE_DIR: path.join(toolkitRoot, 'pip_cache'),
    HF_HOME: path.join(toolkitRoot, 'hf_cache'),
    // theHarvester pulls in Playwright. If a source ever asks for a browser, the download
    // must not go to %USERPROFILE%.
    PLAYWRIGHT_BROWSERS_PATH: path.join(toolkitRoot, 'playwright-browsers'),
    ...extra
  }
}

/* ------------------------------------------------------------------ *
 * Binaries
 * ------------------------------------------------------------------ */

export interface BinaryLookup {
  /** Absolute path we will hand to `spawn`. */
  file: string
  /** True when that path exists right now. */
  exists: boolean
  /** Where the path came from, for the Settings panel. */
  origin: 'config' | 'toolkit' | 'fallback'
}

/**
 * Resolve a tool's executable.
 *
 * `candidates` are paths relative to `toolkitRoot`, most-preferred first. An explicit
 * `config.adapters[<id>].bin` always wins, even if it does not exist — the operator
 * pointing at a wrong path should see that path in the error, not have it silently
 * overridden.
 */
export function resolveBinary(
  config: AppConfig,
  toolkitRoot: string,
  adapterId: string,
  candidates: readonly string[]
): BinaryLookup {
  const configured = config.adapters[adapterId]?.bin
  if (typeof configured === 'string' && configured.trim()) {
    const file = path.normalize(configured.trim())
    return { file, exists: existsSync(file), origin: 'config' }
  }
  for (const rel of candidates) {
    const file = path.join(toolkitRoot, rel)
    if (existsSync(file)) return { file, exists: true, origin: 'toolkit' }
  }
  const first = candidates[0] ?? adapterId
  return { file: path.join(toolkitRoot, first), exists: false, origin: 'fallback' }
}

/** The standard `check()` body: "is the binary where we expect it to be?" */
export function checkBinary(
  config: AppConfig,
  toolkitRoot: string,
  adapterId: string,
  candidates: readonly string[],
  hint: string
): string | null {
  const found = resolveBinary(config, toolkitRoot, adapterId, candidates)
  if (found.exists) return null
  return `${adapterId}: not found at ${found.file}. ${hint.replaceAll('<toolkitRoot>', toolkitRoot)}`
}

/** Read an adapter option, falling back to config then to a default. Never throws. */
export function optionNumber(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds?: { min?: number; max?: number }
): number {
  const raw = options[key]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return fallback
  const min = bounds?.min ?? -Infinity
  const max = bounds?.max ?? Infinity
  return Math.min(max, Math.max(min, n))
}

export function optionString(options: Record<string, unknown>, key: string, fallback: string): string {
  const raw = options[key]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
}

export function optionBoolean(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = options[key]
  return typeof raw === 'boolean' ? raw : fallback
}

/** Accepts an array, or a comma-separated string, because config files get hand-edited. */
export function optionList(options: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const raw = options[key]
  if (Array.isArray(raw)) {
    const list = raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    return list.length ? list : fallback
  }
  if (typeof raw === 'string' && raw.trim()) {
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return list.length ? list : fallback
  }
  return fallback
}

/**
 * Merge the operator's per-adapter `options` with whatever the caller passed for this
 * one run. The run-specific values win.
 */
export function mergedOptions(
  config: AppConfig,
  adapterId: string,
  runOptions: Record<string, unknown>
): Record<string, unknown> {
  return { ...(config.adapters[adapterId]?.options ?? {}), ...runOptions }
}

/* ------------------------------------------------------------------ *
 * Scratch directories
 * ------------------------------------------------------------------ */

export const WORK_DIR = '.work'

/** A fresh, empty directory for one run. Named so a leftover is obviously a leftover. */
export async function makeWorkdir(caseDir: string, adapterId: string): Promise<string> {
  const dir = path.join(caseDir, WORK_DIR, `${adapterId}-${ulid()}`)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/**
 * Best-effort removal. A scratch directory that survives a crash is untidy; a run that
 * fails *because* cleanup failed would be much worse, so this never throws.
 */
export async function removeWorkdir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export interface FoundFile {
  path: string
  name: string
  mtimeMs: number
  size: number
}

/**
 * Walk a directory and return the files matching `match`, newest first.
 *
 * Needed because sherlock, holehe and blackbird all choose their own output filename —
 * embedding a timestamp, a date, or the target — so the only robust strategy is "look at
 * what appeared", not "predict the name".
 */
export async function findFiles(
  root: string,
  match: (name: string, full: string) => boolean,
  depth = 4
): Promise<FoundFile[]> {
  const out: FoundFile[] = []
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (left > 0) await walk(full, left - 1)
        continue
      }
      if (!match(e.name, full)) continue
      try {
        const st = await fsp.stat(full)
        out.push({ path: full, name: e.name, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  await walk(root, depth)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Ensure a directory exists. Used for tool config directories we redirect away from the OS profile. */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined)
}

/**
 * Create an empty file if it is not there, leaving an existing one untouched.
 *
 * subfinder is the reason this exists. It auto-creates its config only at the *default*
 * location under `%APPDATA%`; pointed at a path with `-config` it refuses to start with
 * `FTL Could not read config: ... The system cannot find the file specified`. An empty
 * YAML file is a valid config, so touching the two paths first is what makes redirecting
 * them away from the OS profile actually work.
 */
export async function ensureFile(file: string): Promise<void> {
  await ensureDir(path.dirname(file))
  try {
    await fsp.writeFile(file, '', { flag: 'wx' })
  } catch {
    /* already exists, or unwritable — the spawn will report the real problem */
  }
}

/**
 * The string to hand the tool.
 *
 * `Entity.value` is the canonical, lowercased form used for identity; `Entity.label` is
 * what the operator actually typed. For a username those differ, and the difference
 * matters: a handful of sites are case-sensitive in their URLs, and probing `AliceExample`
 * as `aliceexample` can turn a hit into a miss. Identity stays folded, the probe does not.
 */
export function subjectValue(entity: { kind: string; value: string; label: string }): string {
  if (entity.kind === 'username' || entity.kind === 'person') {
    const label = entity.label?.trim()
    return label || entity.value
  }
  return entity.value
}

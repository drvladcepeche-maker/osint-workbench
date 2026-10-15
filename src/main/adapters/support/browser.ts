/**
 * Finding Playwright, launching it as a child process, and reading back what it saw.
 *
 * The counterpart to `browser-driver.ts`: that file is the script, this one is everything
 * around it. Three jobs, in the order they can fail:
 *
 *  1. **Locate the module and the browsers.** Neither is inside this project. Playwright
 *     is looked up via `OSINT_PLAYWRIGHT_MODULE`, then `~/osint-kit/playwright/node_modules`,
 *     then a plain `require('playwright')`; its Chromium builds via `PLAYWRIGHT_BROWSERS_PATH`
 *     (a directory of `chromium-*` folders), then `~/osint-kit/playwright-browsers`, then
 *     Playwright's stock cache. Either can be repointed from `config/local.config.json`.
 *  2. **Keep the child's scratch inside the run's own directory.** This is not cosmetic. `chromium.launch()` makes a
 *     throwaway profile directory under the OS temp path, which on Windows is
 *     `%LOCALAPPDATA%\Temp`, a shared location that never gets cleaned. Setting
 *     `TEMP`/`TMP` on the child pins it into the run's own scratch directory instead, and
 *     that directory is deleted when the run ends.
 *  3. **Hand the whole thing to `spawn.ts`.** The deadline, the `taskkill /T` that reaps a
 *     Chromium and its renderer children, and the operator's cancel button are already
 *     implemented there and are exactly what browser automation needs most.
 *
 * The `check()` here is a file-existence probe and nothing else — it never launches a
 * browser and never touches the network, because the registry calls it to render the
 * Settings panel.
 */

import { existsSync, readdirSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AppConfig } from '../../../shared/types'
import type { AdapterContext } from '../types'
import { BROWSER_DRIVER_SOURCE, DRIVER_VERSION } from './browser-driver'

export { DRIVER_VERSION }

/**
 * Where Playwright is looked for, most-preferred first.
 *
 * Absolute because the project has no `playwright` dependency of its own and must not grow
 * one — see the header of `browser-driver.ts`. The bare specifier is last so that a future
 * project-local install would still be found without changing this list.
 */
export const PLAYWRIGHT_MODULE_CANDIDATES: readonly string[] = [
  ...(process.env.OSINT_PLAYWRIGHT_MODULE ? [process.env.OSINT_PLAYWRIGHT_MODULE] : []),
  path.join(os.homedir(), 'osint-kit', 'playwright', 'node_modules', 'playwright'),
  path.join(os.homedir(), 'osint-kit', 'playwright', 'node_modules', 'playwright-core'),
  'playwright'
]

/**
 * The `PLAYWRIGHT_BROWSERS_PATH` to use: the environment variable if set, otherwise the
 * first existing of `~/osint-kit/playwright-browsers` and Playwright's own default cache.
 */
export const DEFAULT_BROWSERS_PATH = ((): string => {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  const own = path.join(os.homedir(), 'osint-kit', 'playwright-browsers')
  const stock =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright')
  return [own, stock].find((p) => existsSync(p)) ?? own
})()

export interface BrowserToolchain {
  /** What the driver will `require()`. */
  modulePath: string
  /** `PLAYWRIGHT_BROWSERS_PATH` for the child. */
  browsersPath: string
  /** Null when everything needed is present; otherwise the reason it is not. */
  problem: string | null
}

function moduleExists(spec: string): boolean {
  if (spec === 'playwright' || spec === 'playwright-core') {
    try {
      // Resolution only. Nothing is loaded into this process.
      require.resolve(spec)
      return true
    } catch {
      return false
    }
  }
  return existsSync(path.join(spec, 'package.json'))
}

/** True when the browsers directory holds at least one Chromium build. */
function hasChromium(browsersPath: string): boolean {
  try {
    return readdirSync(browsersPath).some((name) => name.startsWith('chromium'))
  } catch {
    return false
  }
}

/**
 * Resolve the toolchain from config, falling back to the known locations on this machine.
 *
 * `options.playwrightModule` and `options.browsersPath` are the escape hatches. An explicit
 * value wins even when it does not exist, so an operator who typed a wrong path sees that
 * path in the error instead of silently getting the default — the same rule
 * `resolveBinary()` follows for the CLI tools.
 */
export function resolveBrowserToolchain(config: AppConfig, adapterId: string): BrowserToolchain {
  const options = (config.adapters[adapterId]?.options ?? {}) as Record<string, unknown>
  const configuredModule = typeof options['playwrightModule'] === 'string' ? options['playwrightModule'].trim() : ''
  const configuredBrowsers = typeof options['browsersPath'] === 'string' ? options['browsersPath'].trim() : ''

  let modulePath = configuredModule
  if (!modulePath) {
    modulePath = PLAYWRIGHT_MODULE_CANDIDATES.find(moduleExists) ?? PLAYWRIGHT_MODULE_CANDIDATES[0]
  }
  const browsersPath = configuredBrowsers || DEFAULT_BROWSERS_PATH

  let problem: string | null = null
  if (!moduleExists(modulePath)) {
    problem =
      `Playwright was not found at ${modulePath}. Reverse image search drives a real browser because ` +
      `no free API exists for any of these engines. Install it outside this project — ` +
      `\`mkdir <toolkitRoot>/playwright && cd <toolkitRoot>/playwright && npm i playwright\` — or set ` +
      `adapters['${adapterId}'].options.playwrightModule to wherever it already is.`
  } else if (!hasChromium(browsersPath)) {
    problem =
      `No Chromium build was found under ${browsersPath}. Download one with ` +
      `\`PLAYWRIGHT_BROWSERS_PATH=${browsersPath} npx playwright install chromium\`, or point ` +
      `adapters['${adapterId}'].options.browsersPath at the directory that holds your chromium-* folders.`
  }

  return { modulePath, browsersPath, problem }
}

/* ------------------------------------------------------------------ *
 * The task the driver is handed
 * ------------------------------------------------------------------ */

/** One instruction in an engine's flow. Serialisable, because it travels as JSON. */
export type BrowserStep =
  | { do: 'goto'; url: string }
  | { do: 'gotoCurrentWith'; params: Record<string, string> }
  | { do: 'upload'; selector: string; click?: string }
  | { do: 'click'; selector: string; optional?: boolean }
  | { do: 'waitFor'; selector: string; ms?: number }
  /** Poll until the page's URL contains this substring. For a client-side navigation. */
  | { do: 'waitForUrl'; contains: string; ms?: number }
  | { do: 'wait'; ms: number }

export interface BrowserResultGroup {
  /**
   * `same` — the engine presents this list as pages that carry *this* image.
   * `similar` — the engine presents it as pictures that merely look alike.
   *
   * Only `same` is allowed to become an entity candidate. See `reverse-image.ts`.
   */
  kind: 'same' | 'similar'
  /** Tried in order; the first that yields rows wins. Put the structural fallback last. */
  selectors: string[]
}

export interface BrowserEngineSpec {
  id: string
  /** The `Finding.source` for anything this engine says. Always the site, never the tool. */
  site: string
  /** Hosts belonging to the engine itself, so its own navigation is not read as a result. */
  selfHosts: string[]
  /** The URL a human should open to run this search by hand. `{IMAGE_URL_ENC}` is filled in. */
  handoffUrl: string
  steps: BrowserStep[]
  results: BrowserResultGroup[]
  /** Selectors whose presence proves the engine answered, even with zero rows. */
  readySelectors?: string[]
  /** Phrases that prove the same thing. */
  readyText?: string[]
  /** The engine's own count line, for the summary claim. */
  summarySelectors?: string[]
  block?: {
    urlContains?: string[]
    selectors?: string[]
    textContains?: string[]
  }
}

export interface BrowserTask {
  playwrightModule: string
  headless: boolean
  userAgent: string | null
  locale: string
  viewport: { width: number; height: number }
  navigationTimeoutMs: number
  settleMs: number
  engineGapMs: number
  htmlLimit: number
  textLimit: number
  maxResults: number
  imageUrl: string | null
  imageFile: string | null
  engines: BrowserEngineSpec[]
}

/* ------------------------------------------------------------------ *
 * What comes back
 * ------------------------------------------------------------------ */

export type EngineStatus = 'ok' | 'blocked' | 'unclear' | 'error' | 'skipped'

export interface BrowserResultRow {
  kind: 'same' | 'similar'
  url: string
  host: string
  text: string
  imageUrl: string
}

export interface BrowserEngineResult {
  id: string
  site: string
  status: EngineStatus
  requestedUrl: string
  handoffUrl: string
  finalUrl: string
  httpStatus: number | null
  title: string
  block: { kind: 'captcha' | 'consent' | 'ratelimit' | 'login' | 'unknown'; marker: string } | null
  error: string | null
  summary: string
  /** What proved the engine answered. Empty on `unclear`. */
  readyMarker: string
  results: BrowserResultRow[]
  notes: string[]
  html: string
  text: string
  htmlTruncated: boolean
  durationMs: number
  /** Set by the adapter, not the driver: this record came from the on-disk cache. */
  cachedFrom?: string
  /** Set by the adapter for an engine it chose not to run, with the reason in `error`. */
  skipReason?: string
}

export interface BrowserRunResult {
  driverVersion: string
  startedAt: string
  finishedAt: string
  browser: { name: string; version: string; userAgent: string; headless: boolean }
  engines: BrowserEngineResult[]
  /** Set when the browser never started. Nothing was searched at all. */
  fatal?: string
  /**
   * What was submitted, stamped on by the adapter rather than the driver.
   *
   * `parse()` needs it because several engines echo the query image back inside their own
   * result list — TinEye's first row is the URL you handed it — and a run that proposed the
   * picture's own host as a discovery would be reporting its input as a finding.
   */
  subject?: { url: string | null; path: string | null; fingerprint: string }
}

/* ------------------------------------------------------------------ *
 * Running it
 * ------------------------------------------------------------------ */

export interface BrowserRunOutcome {
  result: BrowserRunResult | null
  /** Exactly what was executed, for the "what did it actually run" disclosure. */
  command: { file: string; args: string[] }
  stdout: string
  stderr: string
  exitCode: number | null
  spawnError: string | null
  timedOut: boolean
  truncated: boolean
  notes: string[]
}

/**
 * The interpreter to run the driver with.
 *
 * Inside Electron `process.execPath` is `electron.exe`, which becomes an ordinary Node when
 * `ELECTRON_RUN_AS_NODE` is set — so the app never needs a separate Node installation and
 * never has to guess where one is. Outside Electron (the test suite) `process.execPath` is
 * already Node and the variable is ignored.
 */
export function driverInterpreter(config: AppConfig, adapterId: string): string {
  const configured = config.adapters[adapterId]?.bin
  if (typeof configured === 'string' && configured.trim()) return path.normalize(configured.trim())
  return process.execPath
}

/**
 * Write the driver and the task into `workdir`, run them, and parse the one JSON document
 * that comes back.
 *
 * Never throws. Every failure lands in the returned outcome with the child's stdout and
 * stderr intact, because "Chromium exited immediately with a GPU error" is a fact worth
 * keeping in the case file.
 */
export async function runBrowserTask(
  ctx: AdapterContext,
  adapterId: string,
  workdir: string,
  toolchain: BrowserToolchain,
  task: BrowserTask,
  timeoutMs: number
): Promise<BrowserRunOutcome> {
  const notes: string[] = []
  const driverPath = path.join(workdir, 'reverse-image-driver.cjs')
  const taskPath = path.join(workdir, 'task.json')
  // Chromium's throwaway profile goes here rather than into the shared system temp directory.
  const tempDir = path.join(workdir, 'chromium-temp')

  await fsp.writeFile(driverPath, BROWSER_DRIVER_SOURCE, 'utf8')
  await fsp.writeFile(taskPath, JSON.stringify(task, null, 2), 'utf8')
  await fsp.mkdir(tempDir, { recursive: true })

  const file = driverInterpreter(ctx.config, adapterId)
  const args = [driverPath, taskPath]

  const res = await ctx.spawn(file, {
    args,
    cwd: workdir,
    timeoutMs,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: toolchain.browsersPath,
      // Both spellings; Chromium reads TMP first on Windows and TMPDIR on POSIX.
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir,
      // Nothing here should ever reach for a browser it does not have.
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
    },
    onStderr: (chunk) => {
      const m = /engine (\d+)\/(\d+) (\S+)/.exec(chunk)
      if (m) {
        const done = Number(m[1]) - 1
        const total = Number(m[2])
        ctx.progress({
          pct: total > 0 ? Math.round((done / total) * 100) : undefined,
          note: `searching ${m[3]} (${m[1]} of ${m[2]})`
        })
      }
    }
  })

  let parsed: BrowserRunResult | null = null
  if (res.stdout.trim()) {
    try {
      parsed = JSON.parse(res.stdout) as BrowserRunResult
    } catch {
      notes.push('the driver wrote something that was not JSON; the bytes are preserved verbatim')
    }
  }
  if (res.truncated) notes.push('the driver output hit the size cap and was cut')

  return {
    result: parsed,
    command: { file, args },
    stdout: res.stdout,
    stderr: res.stderr,
    exitCode: res.exitCode,
    spawnError: res.spawnError,
    timedOut: res.timedOut,
    truncated: res.truncated,
    notes
  }
}

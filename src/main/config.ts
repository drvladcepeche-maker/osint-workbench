/**
 * Config loading.
 *
 * `config/local.config.json` is optional; every key falls back to a default, so a fresh
 * clone runs with no configuration at all. Unknown keys are ignored rather than
 * rejected, and `$comment` keys are stripped, so `example.config.json` stays
 * self-documenting without needing a second format.
 *
 * There is deliberately no `.env` support anywhere in this project — see DECISIONS.md.
 */

import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppConfig } from '../shared/types'

export const DEFAULT_CONFIG: AppConfig = {
  casesDir: 'cases',
  dataDir: 'data',
  // Empty string = auto-detect (see detectToolkitRoot).
  toolkitRoot: '',
  opsecKitRoot: '',
  pythonPath: null,
  orchestrator: {
    globalConcurrency: 4,
    defaultConcurrencyPerAdapter: 2,
    defaultTimeoutMs: 120_000,
    maxOutputBytes: 8 * 1024 * 1024
  },
  adapters: {},
  ui: {
    startHiddenInTray: false
  }
}

/**
 * Where the external OSINT tools live. Resolution order:
 *  1. `toolkitRoot` in config/local.config.json (relative paths resolve against the repo root)
 *  2. the OSINT_TOOLKIT_ROOT environment variable
 *  3. the first existing of `<repo>/osint-kit`, `<repo>/tools/osint-kit`, `~/osint-kit`
 *  4. `~/osint-kit` (it may not exist yet; the adapters then report what to install)
 */
export function detectToolkitRoot(root: string, configured?: string | null): string {
  const given = configured?.trim() || process.env.OSINT_TOOLKIT_ROOT?.trim()
  if (given) return path.isAbsolute(given) ? path.normalize(given) : path.resolve(root, given)
  const home = path.join(os.homedir(), 'osint-kit')
  const candidates = [path.join(root, 'osint-kit'), path.join(root, 'tools', 'osint-kit'), home]
  return candidates.find((c) => existsSync(c)) ?? home
}

/** Optional metadata-scrubber checkout. Same idea: config, then OSINT_OPSEC_KIT_ROOT, then a sibling folder. */
export function detectOpsecKitRoot(root: string, configured?: string | null): string {
  const given = configured?.trim() || process.env.OSINT_OPSEC_KIT_ROOT?.trim()
  if (given) return path.isAbsolute(given) ? path.normalize(given) : path.resolve(root, given)
  const candidates = [path.join(root, 'opsec-kit'), path.resolve(root, '..', 'opsec-kit'), path.join(os.homedir(), 'opsec-kit')]
  return candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1]
}

function stripComments<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripComments) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '$comment') continue
      out[k] = stripComments(v)
    }
    return out as T
  }
  return value
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

export interface LoadedConfig {
  config: AppConfig
  /** Absolute paths, resolved once so nothing downstream has to think about cwd. */
  paths: {
    root: string
    casesDir: string
    dataDir: string
    dbFile: string
    toolkitRoot: string
    opsecKitRoot: string
    configFile: string
  }
  /** Non-fatal complaints about the config file, surfaced in Settings. */
  warnings: string[]
  source: 'defaults' | 'file'
}

/**
 * @param root  Repository root. In dev this is the project directory; in a packaged app
 *              it is the directory holding the app resources.
 */
export function loadConfig(root: string): LoadedConfig {
  const configFile = path.join(root, 'config', 'local.config.json')
  const warnings: string[] = []
  let merged: AppConfig = structuredClone(DEFAULT_CONFIG)
  let source: 'defaults' | 'file' = 'defaults'

  if (existsSync(configFile)) {
    try {
      const parsed = stripComments(JSON.parse(readFileSync(configFile, 'utf8')) as unknown)
      if (!isRecord(parsed)) throw new Error('top level of the config must be an object')
      merged = {
        ...merged,
        ...(parsed as Partial<AppConfig>),
        orchestrator: { ...merged.orchestrator, ...(isRecord(parsed.orchestrator) ? parsed.orchestrator : {}) },
        adapters: { ...merged.adapters, ...(isRecord(parsed.adapters) ? parsed.adapters : {}) },
        ui: { ...merged.ui, ...(isRecord(parsed.ui) ? parsed.ui : {}) }
      } as AppConfig
      source = 'file'
    } catch (err) {
      // A broken config must never stop the app from starting — you would then have no
      // UI in which to fix it.
      warnings.push(
        `config/local.config.json could not be parsed and was ignored: ${(err as Error).message}`
      )
    }
  }

  const o = merged.orchestrator
  if (o.globalConcurrency < 1) {
    warnings.push('orchestrator.globalConcurrency must be >= 1; using 1.')
    o.globalConcurrency = 1
  }
  if (o.defaultConcurrencyPerAdapter < 1) {
    warnings.push('orchestrator.defaultConcurrencyPerAdapter must be >= 1; using 1.')
    o.defaultConcurrencyPerAdapter = 1
  }
  if (o.defaultTimeoutMs < 1000) {
    warnings.push('orchestrator.defaultTimeoutMs below 1000 ms is almost certainly a mistake; using 1000.')
    o.defaultTimeoutMs = 1000
  }

  const resolve = (p: string): string => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p))
  const dataDir = resolve(merged.dataDir)

  return {
    config: merged,
    paths: {
      root,
      casesDir: resolve(merged.casesDir),
      dataDir,
      dbFile: path.join(dataDir, 'index.db'),
      toolkitRoot: detectToolkitRoot(root, merged.toolkitRoot),
      opsecKitRoot: detectOpsecKitRoot(root, merged.opsecKitRoot),
      configFile
    },
    warnings,
    source
  }
}

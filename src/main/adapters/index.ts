/**
 * Adapter registration.
 *
 * Every adapter the app knows about is listed here and nowhere else. Registration runs
 * at startup and throws on a malformed adapter — including one with an incomplete `doc`
 * — so a bad adapter is a boot failure with a precise message rather than a mystery at
 * click time.
 *
 * The set divides into three:
 *
 *  - **`echo`** — the reference implementation. Not an OSINT tool; it proves the plumbing.
 *  - **Spawned CLI tools** — wrappers around the Phase 0 toolbelt at `<toolkitRoot>`.
 *    Each has a `check()` that reports the missing binary rather than failing at click
 *    time, and each is unavailable-but-registered when its tool is not installed.
 *  - **Native adapters** — no external tool at all. `wayback`, `reddit-profile` and
 *    `hibp-passwords` speak to free keyless APIs directly; `pattern-timezone` makes no
 *    requests whatsoever and re-analyses captures the others already made. These are the
 *    most durable things in the app precisely because there is no third-party package
 *    between us and the endpoint.
 */

import { archiveTodayAdapter } from './archive-today'
import { blackbirdAdapter } from './blackbird'
import { dorksAdapter } from './dorks'
import { echoAdapter } from './echo'
import { exiftoolAdapter } from './exiftool'
import { galleryDlAdapter } from './gallery-dl'
import { hibpPasswordsAdapter } from './hibp-passwords'
import { holeheAdapter } from './holehe'
import { maigretAdapter } from './maigret'
import { patternTimezoneAdapter } from './pattern-timezone'
import { pivotAdapter } from './pivot'
import { profileEnrichAdapter } from './profile-enrich'
import { redditProfileAdapter } from './reddit-profile'
import { reverseImageAdapter } from './reverse-image'
import { sherlockAdapter } from './sherlock'
import { subfinderAdapter } from './subfinder'
import { theHarvesterAdapter } from './theharvester'
import { waybackAdapter } from './wayback'
import { websearchAdapter } from './websearch'
import { registry, type Adapter, type AdapterRegistry } from './types'

export * from './types'

/** Wrappers around the CLI tools installed by Phase 0. */
export const SPAWNED_ADAPTERS: Adapter[] = [
  blackbirdAdapter,
  exiftoolAdapter,
  galleryDlAdapter,
  holeheAdapter,
  maigretAdapter,
  sherlockAdapter,
  subfinderAdapter,
  theHarvesterAdapter
]

/** No external tool required. Free, keyless, and nothing that can rot. */
export const NATIVE_ADAPTERS: Adapter[] = [
  // The other archive. Wayback crawls and archive.today saves on demand, so the two hold
  // different things and a URL missing from one is routinely present in the other.
  archiveTodayAdapter,
  // Search operators, prepared and explained. Shares the engine chain with `websearch`;
  // asks what shape of page exists rather than who a person is.
  dorksAdapter,
  hibpPasswordsAdapter,
  patternTimezoneAdapter,
  // `pivot` is native in the sense that matters here: it needs no third-party tool. It is
  // the second correlator rather than a collector, and like `pattern-timezone` its input is
  // the case folder — every other adapter that runs makes it better.
  pivotAdapter,
  // Enriches an account the sweeps already found: the public profile behind it, and the
  // avatar bytes the export inlines. Native for the same reason — no third-party tool.
  profileEnrichAdapter,
  redditProfileAdapter,
  // Native in the same sense: no tool from the Phase 0 toolbelt. It does drive a Chromium
  // through Playwright, because PLAN-v0 §5 established that no free API exists for any
  // reverse image engine — but the browser is spawned as a child process, so the app's
  // module graph stays free of it and `spawn.ts` owns the timeout and the tree kill.
  reverseImageAdapter,
  waybackAdapter,
  // The one adapter that can act on a name. Everything else here takes a username, an
  // address, a domain or a file, which is why a person seed used to change nothing about
  // what got queried — see STRATEGY.md.
  websearchAdapter
]

const BUILT_IN: Adapter[] = [echoAdapter, ...SPAWNED_ADAPTERS, ...NATIVE_ADAPTERS]

/** Idempotent, so a hot reload in dev does not throw on duplicate ids. */
export function registerBuiltInAdapters(target: AdapterRegistry = registry): AdapterRegistry {
  for (const adapter of BUILT_IN) {
    if (!target.has(adapter.id)) target.register(adapter)
  }
  return target
}

/** Every adapter this build ships, registered or not. Used by the doc-quality test. */
export function builtInAdapters(): Adapter[] {
  return [...BUILT_IN]
}

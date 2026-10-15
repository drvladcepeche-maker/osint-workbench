/**
 * `reverse-image` — a picture in, other places that picture lives out.
 *
 * This is the adapter STRATEGY.md names as the missing input: an avatar is one of the
 * strongest identity links available and until now there was no path from a picture to
 * another account. `pivot` can already tell you that two accounts you have found share an
 * avatar; nothing could tell you that an avatar you have exists somewhere you have not
 * found.
 *
 * ## Why this one drives a browser when nothing else in the app does
 *
 * PLAN-v0 §5 settled it and the answer is the bad one. There is no free or open API for
 * Google Lens, Yandex Images or PimEyes, and TinEye's real API starts at $200/month, which
 * DECISIONS.md rules out along with every other paid service. Browser automation is not a
 * shortcut here, it is the only path, and that has consequences the rest of the toolbelt
 * does not have to live with: the search can be refused by a captcha, the refusal looks
 * nothing like an empty result, and hammering the endpoint costs the operator the
 * capability permanently rather than costing him a rate-limit window.
 *
 * ## The three rules this adapter is built around
 *
 * **A block and an absence are different facts, and the app rests on not confusing them.**
 * Every engine ends in one of five states — `ok`, `blocked`, `unclear`, `error`, `skipped`
 * — and only `ok` with zero rows is ever rendered as "found nothing". A captcha produces a
 * finding that says so, names what was seen, and hands back a URL to open by hand. An
 * `unclear` — the page loaded, nothing was recognisable on it — is its own state precisely
 * so that selector rot cannot masquerade as an empty result.
 *
 * **Never solve a challenge, never accept terms.** No stealth patching, no captcha
 * services, no clicking "Accept all" on a consent wall. Google's EU consent page is
 * classed as a block exactly like a captcha is. The one cosmetic thing the driver does is
 * present a User-Agent built from the version of the Chromium that is genuinely running,
 * which removes the word "Headless" that the headless shell inserts; `navigator.webdriver`
 * is left alone.
 *
 * **Spend the resource once.** One engine at a time, a jittered gap between them, a
 * 30-second floor between runs of the whole adapter, and a cache keyed on a perceptual
 * hash so the same avatar arriving from six different accounts is submitted once.
 *
 * ## What the operator gets, per engine
 *
 * TinEye finds exact copies and the date the file was first indexed. Yandex finds the pages
 * that carry the picture. Bing names what the picture is of. Google Lens has not answered
 * from this network at all. Measured behaviour, not reputation — see `reverse-engines.ts`.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { Finding } from '../../shared/types'
import {
  makeFinding,
  type Adapter,
  type AdapterContext,
  type AdapterInput,
  type EntityProposal,
  type RawResult
} from './types'
import { beginEnvelope, finishEnvelope, group, parseJsonSafe, readEnvelope } from './support/envelope'
import { hostOf, localSource } from './support/sources'
import { accountFromUrl } from './support/profiles'
import { checkImageUrl, hashImage } from './support/image'
import { httpGetBinary, DEFAULT_USER_AGENT } from './support/net'
import { makeWorkdir, mergedOptions, optionBoolean, optionList, optionNumber, optionString, removeWorkdir } from './support/toolkit'
import {
  runBrowserTask,
  resolveBrowserToolchain,
  DRIVER_VERSION,
  type BrowserEngineResult,
  type BrowserEngineSpec,
  type BrowserRunResult,
  type BrowserTask
} from './support/browser'
import {
  DEFAULT_ENGINES,
  GOOGLE_LENS_NOTE,
  REVERSE_ENGINES,
  engineById,
  specFor,
  type ReverseEngine
} from './support/reverse-engines'
import {
  DEFAULT_CACHE_TTL_MS,
  describeFingerprint,
  phashFingerprint,
  readCache,
  sha256Fingerprint,
  urlFingerprint,
  writeCache,
  type Fingerprint
} from './support/reverse-cache'

const ID = 'reverse-image'
const VERSION = '1.0.0'

/** Per-engine result rows turned into their own findings. The rest stay in the raw capture. */
const MAX_RESULT_FINDINGS = 25
/** Per-engine rows allowed to become entity candidates. Deliberately tighter. */
const MAX_PROPOSALS = 12

export const reverseImageAdapter: Adapter = {
  id: ID,
  title: 'Reverse image search (picture → where else it appears)',
  version: VERSION,

  accepts: ['image'],
  produces: ['account', 'domain', 'image'],

  requiresKey: false,
  requiresNetwork: true,

  // One search at a time, and a floor of half a minute between runs. These numbers are the
  // capability's insurance policy: there is no quota to top up and no key to rotate, so a
  // burst that gets the IP challenged costs the operator the engine outright.
  concurrency: 1,
  minIntervalMs: 30_000,
  defaultTimeoutMs: 300_000,

  doc: {
    what: 'Submits a picture to TinEye, Yandex Images, Bing Visual Search or Google Lens through a real, logged-out browser and reports the pages each engine says carry that image — or reports, separately and loudly, that it was refused.',

    how: 'None of these engines has a free API, so the only mechanism available is the one a person uses: open the page, hand over the image, read the results. A child process launches Chromium through Playwright with an in-memory browser context — no profile directory, no cookies, no session, discarded between engines — and either navigates to the engine\'s by-URL entry point or sets the file on the page\'s upload input. TinEye keeps a permanently hidden `input[type=file]`, so a local avatar can be uploaded without clicking anything; Yandex answers an upload with a Yandex-hosted copy of the picture at a URL nobody can predict, so its list of carrying pages is reached by re-navigating to whatever the upload landed on with `cbir_page=sites` appended. After the page settles, the result rows are read out of the DOM, the whole HTML and visible text are kept verbatim, and the page is checked against a list of refusal markers: the URL it was redirected to, challenge frames, and phrases like "unusual traffic". A marker in the URL is conclusive on its own; a marker merely present on the page counts only when nothing was extracted, because Bing and TinEye both draw a cookie banner over perfectly good results.',

    why: 'People re-use pictures far more than they re-use words. The same avatar is uploaded to a forum in 2014, a Steam profile in 2019 and a GitHub account last year, and the account holder has no idea those three uploads are linkable, because to them the picture is decoration rather than an identifier. A search engine that has indexed any of those pages has done the linking already and will hand it over for the price of one query. It is also the only technique here that works when the handle, the display name and the email are all different — the file is the same file regardless of what the account calls itself, which is exactly the case where username enumeration finds nothing at all. TinEye adds a second question nothing else in this toolbelt can answer: the date it first indexed the image, which orders the copies in time and tells you which account had it first.',

    betterAt: 'Crossing platforms that share no text. It needs no handle, no name and no email, so it is the technique to reach for when a sweep has produced one confirmed account and nothing else. TinEye is the strongest tool available for finding exact copies of a file and dating the earliest one, and Yandex has the widest index of pages carrying a given picture and is the engine practitioners rate highest for photographs of people. All of it is free and keyless.',

    worseAt: 'Anything a crawler never reached. Instagram, Facebook, Discord, most Telegram channels and every private or login-walled profile are absent from all four indexes, which is where a great many avatars actually live. Small, heavily cropped or low-detail pictures match poorly. Yandex reads the picture, not the person, so a different photograph of the same face is usually a miss. Bing does not answer this question at all: verified from this machine, it resolves the image to a text label and then runs an ordinary web search for that label, so it identifies stock art and recognisable objects and finds almost nothing about where a file appears. Google Lens refused every attempt from this network, headless and headed alike.',

    falsePositives: 'The single largest one is structural: these engines find images that look alike, which is not the same claim as "the same person". A hit only ever means "this picture appears here", and the step from there to "this account is your subject" is a human inference the app never makes for you. Whole categories of picture make that inference worthless. A stock photograph, a meme, a game screenshot, a band logo, an anime frame, a generated face or a platform default avatar will each return hundreds of unrelated pages, and the more of them there are the more convincing the pile looks; a default Gravatar identicon or a bare grey silhouette will "match" every account that never set one. Cropped and re-encoded copies drift far enough that a genuine match is missed while a different picture with the same composition is returned. Yandex mixes pages that carry the file with pages that merely carry something similar, so its rows are treated as claims about the picture and never as claims about a person, and Bing\'s rows are about a label it guessed and are never allowed to propose an entity at all. And selector rot is a false negative that reads like a real answer, which is why an unreadable page is reported as unclear rather than as zero results.'
  },

  check(ctx): string | null {
    return resolveBrowserToolchain(ctx.config, ID).problem
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const startedMs = Date.now()
    const options = mergedOptions(ctx.config, ID, input.options)

    const subject = resolveImage(input, options)
    const env = beginEnvelope({ adapterId: ID, adapterVersion: VERSION, input, target: subject.label, startedAt })

    if (subject.problem) {
      env.notes.push(subject.problem)
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: subject.problem,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    const toolchain = resolveBrowserToolchain(ctx.config, ID)
    if (toolchain.problem) {
      env.notes.push(toolchain.problem)
      return finishEnvelope(env, {
        caseId: input.caseId,
        ok: false,
        error: toolchain.problem,
        finishedAt: ctx.now(),
        startedMs
      })
    }

    // The fingerprint decides what the cache is keyed on, and `support/image.ts` is the one
    // hasher in this app. A JPEG only decodes through Electron's `nativeImage`, so outside
    // the packaged app this falls through to the sha256 branch — which still prevents a
    // duplicate submission of byte-identical input, just not of a re-encoded copy.
    const fingerprint = await fingerprintOf(subject, ctx, options, env.notes)

    const requested = optionList(options, 'engines', [...DEFAULT_ENGINES])
    const mode: 'url' | 'file' = subject.imageUrl ? 'url' : 'file'
    const chosen: { engine: ReverseEngine; spec: BrowserEngineSpec }[] = []
    const skipped: BrowserEngineResult[] = []

    for (const name of requested) {
      const engine = engineById(name)
      if (!engine) {
        env.notes.push(`Unknown engine "${name}" was requested and ignored. Known: ${REVERSE_ENGINES.map((e) => e.id).join(', ')}.`)
        continue
      }
      const spec = specFor(engine, mode)
      if (!spec) {
        skipped.push(
          skipRecord(
            engine,
            mode === 'file'
              ? `${engine.title} has no upload path wired here, and this image is a local file with no public URL to hand it instead.`
              : `${engine.title} cannot be given a URL by this adapter.`
          )
        )
        continue
      }
      chosen.push({ engine, spec })
    }

    if (chosen.length === 0 && skipped.length === 0) {
      const why = 'No usable engine was selected.'
      env.notes.push(why)
      return finishEnvelope(env, { caseId: input.caseId, ok: false, error: why, finishedAt: ctx.now(), startedMs })
    }

    const ttlMs = optionNumber(options, 'cacheTtlMs', DEFAULT_CACHE_TTL_MS, { min: 0, max: 365 * 24 * 3600_000 })
    const useCache = optionBoolean(options, 'cache', true)

    // A cache hit is a search that never happens, so the lookup comes before the browser is
    // even considered.
    const cached: BrowserEngineResult[] = []
    const toRun: { engine: ReverseEngine; spec: BrowserEngineSpec }[] = []
    for (const item of chosen) {
      if (useCache) {
        const hit = await readCache(ctx.caseDir, fingerprint, item.engine.id, DRIVER_VERSION, ttlMs)
        if (hit) {
          cached.push({ ...hit.result, cachedFrom: hit.capturedAt })
          continue
        }
      }
      toRun.push(item)
    }

    const summary: BrowserRunResult = {
      driverVersion: DRIVER_VERSION,
      startedAt,
      finishedAt: startedAt,
      browser: { name: 'chromium', version: '', userAgent: '', headless: true },
      engines: [],
      subject: { url: subject.imageUrl, path: subject.imagePath, fingerprint }
    }

    if (toRun.length > 0) {
      const workdir = await makeWorkdir(ctx.caseDir, ID)
      try {
        const task: BrowserTask = {
          playwrightModule: toolchain.modulePath,
          headless: optionBoolean(options, 'headless', true),
          userAgent: optionString(options, 'userAgent', '') || null,
          locale: optionString(options, 'locale', 'en-US'),
          viewport: {
            width: optionNumber(options, 'viewportWidth', 1366, { min: 800, max: 2560 }),
            height: optionNumber(options, 'viewportHeight', 900, { min: 600, max: 2000 })
          },
          navigationTimeoutMs: optionNumber(options, 'navigationTimeoutMs', 45_000, { min: 5_000, max: 180_000 }),
          settleMs: optionNumber(options, 'settleMs', 6_000, { min: 0, max: 60_000 }),
          engineGapMs: optionNumber(options, 'engineGapMs', 8_000, { min: 2_000, max: 120_000 }),
          htmlLimit: optionNumber(options, 'htmlLimit', 300_000, { min: 0, max: 2_000_000 }),
          textLimit: optionNumber(options, 'textLimit', 20_000, { min: 0, max: 500_000 }),
          maxResults: optionNumber(options, 'maxResults', 60, { min: 1, max: 200 }),
          imageUrl: subject.imageUrl,
          imageFile: subject.imagePath,
          engines: toRun.map((t) => t.spec)
        }

        ctx.progress({ pct: 5, note: `launching an isolated browser for ${toRun.length} engine${toRun.length === 1 ? '' : 's'}` })
        const outcome = await runBrowserTask(ctx, ID, workdir, toolchain, task, ctx.timeoutMs)

        env.command = outcome.command
        env.exitCode = outcome.exitCode
        env.stderr = outcome.stderr
        env.timedOut = outcome.timedOut
        env.truncated = outcome.truncated
        env.spawnError = outcome.spawnError
        for (const note of outcome.notes) env.notes.push(note)

        if (outcome.result) {
          summary.browser = outcome.result.browser ?? summary.browser
          summary.finishedAt = outcome.result.finishedAt || ctx.now()
          if (outcome.result.fatal) summary.fatal = outcome.result.fatal
          for (const record of outcome.result.engines ?? []) summary.engines.push(record)
        } else {
          // The driver produced nothing readable. Every engine it was asked to run is an
          // error with the same reason, so no engine silently disappears from the report.
          const why =
            outcome.spawnError ??
            (outcome.timedOut ? `The browser run exceeded ${ctx.timeoutMs} ms and was killed.` : 'The browser driver produced no readable output.')
          summary.fatal = why
          for (const item of toRun) summary.engines.push(errorRecord(item.engine, why))
        }
      } finally {
        await removeWorkdir(workdir)
      }
    }

    // Page bytes are bulky and belong beside the run, not inside the structured summary the
    // parser reads. They are moved into the envelope's artifacts verbatim, which is where
    // every other adapter keeps a tool's own files.
    const capturedAt = ctx.now()
    for (const record of summary.engines) {
      if (record.html) env.artifacts[`${record.id}.html`] = record.html
      if (record.text) env.artifacts[`${record.id}.txt`] = record.text
      record.html = ''
      record.text = ''
      if (useCache && record.status === 'ok') {
        const stored = await writeCache(ctx.caseDir, fingerprint, DRIVER_VERSION, record, capturedAt)
        if (!stored) env.notes.push(`The ${record.id} result could not be written to the cache; it will be searched again next time.`)
      }
    }

    // Cached and skipped engines join the report in the order they were requested, so the
    // parser sees one list and the operator sees one table.
    summary.engines.push(...cached, ...skipped)
    summary.engines.sort((a, b) => requested.indexOf(a.id) - requested.indexOf(b.id))
    summary.finishedAt = capturedAt

    env.notes.push(`Fingerprint ${fingerprint} — ${describeFingerprint(fingerprint)}.`)
    env.notes.push(`Input mode: ${mode === 'url' ? `public URL (${subject.imageUrl})` : `local file (${subject.imagePath})`}.`)
    if (cached.length > 0) env.notes.push(`${cached.length} engine result(s) came from the on-disk cache and were not submitted again.`)
    if (requested.includes('google')) env.notes.push(GOOGLE_LENS_NOTE)

    env.stdout = JSON.stringify(summary)

    // There is always something worth parsing once the driver has been asked to run: a
    // blocked engine is a finding about the world. `ok: false` is reserved for the cases
    // where no engine reached a verdict at all.
    const reached = summary.engines.length > 0
    return finishEnvelope(env, {
      caseId: input.caseId,
      ok: reached,
      error: summary.fatal ?? 'No engine produced a verdict.',
      finishedAt: capturedAt,
      startedMs
    })
  },

  parse(raw: RawResult): Finding[] {
    return interpret(raw).findings
  },

  /**
   * Accounts and hosts implied by a hit, and only from a list the engine itself presents as
   * "pages carrying this image".
   *
   * A `similar` row never becomes a candidate. Bing's rows are about a label it guessed for
   * the picture and Yandex's similar-images panel is a likeness rather than a file, and
   * either one promoted into the graph would put a stranger in the case for looking like
   * somebody. Even a `same` row is only ever a candidate: the picture appearing on a page
   * proves the picture appeared on that page, and nothing whatsoever about who put it there.
   */
  propose(raw: RawResult): EntityProposal[] {
    return interpret(raw).proposals
  }
}

/* ------------------------------------------------------------------ *
 * Resolving the picture
 * ------------------------------------------------------------------ */

interface Subject {
  /** For the envelope target and the claims. */
  label: string
  /** A public https URL an engine can fetch for itself, or null. */
  imageUrl: string | null
  /** An absolute local path to upload, or null. */
  imagePath: string | null
  /** Already known, from a previous run that hashed it. */
  knownPhash: string | null
  knownDhash: string | null
  knownSha256: string | null
  problem: string | null
}

/**
 * Work out what to submit, preferring a public URL over an upload.
 *
 * A URL costs no bytes and no upload flow, and every engine here takes one; an upload is
 * the fallback for a file that exists only on disk, and it is what restricts the run to the
 * two engines that accept one.
 */
function resolveImage(input: AdapterInput, options: Record<string, unknown>): Subject {
  const attrs = (input.entity.attrs ?? {}) as {
    path?: string
    sourceUrl?: string
    sha256?: string
    phash?: string
    dhash?: string
  }

  const optionUrl = optionString(options, 'imageUrl', '')
  const optionPath = optionString(options, 'imagePath', '')
  const value = input.entity.value ?? ''
  const label = input.entity.label ?? value

  let imageUrl: string | null = null
  const urlCandidate = optionUrl || attrs.sourceUrl || (/^https?:\/\//i.test(value) ? value : '')
  let urlProblem: string | null = null
  if (urlCandidate) {
    const refused = checkImageUrl(urlCandidate)
    if (refused === null) {
      imageUrl = urlCandidate
    } else {
      // The same gate `support/image.ts` applies before fetching an avatar. A search engine
      // fetching a private address would achieve nothing, and a `file:` or credentialed URL
      // has no business being handed to a third party at all.
      urlProblem = `The image URL was refused by the URL gate (${refused}), so it was not handed to any engine.`
    }
  }

  let imagePath: string | null = null
  const pathCandidate = optionPath || attrs.path || (!urlCandidate && value ? value : '')
  if (pathCandidate && !/^[a-z][a-z0-9+.-]*:\/\//i.test(pathCandidate)) {
    const resolved = path.resolve(pathCandidate)
    if (existsSync(resolved)) imagePath = resolved
  }

  let problem: string | null = null
  if (!imageUrl && !imagePath) {
    problem =
      urlProblem ??
      `This image entity carries neither a readable local file nor a public https URL, so there is nothing to submit. ` +
        `Set attrs.path to a file on disk, attrs.sourceUrl to a public URL, or pass options.imageUrl / options.imagePath.`
  }

  return {
    label: label || 'the image',
    imageUrl,
    imagePath,
    knownPhash: typeof attrs.phash === 'string' && attrs.phash ? attrs.phash : null,
    knownDhash: typeof attrs.dhash === 'string' && attrs.dhash ? attrs.dhash : null,
    knownSha256: typeof attrs.sha256 === 'string' && attrs.sha256 ? attrs.sha256 : null,
    problem
  }
}

/**
 * The cache key for this picture.
 *
 * Cheapest first: a hash the entity already carries, then the bytes we have or can get, then
 * the URL string. Every fallback is recorded in `notes`, because a `url:` fingerprint is a
 * materially weaker cache — it will submit a second time for the same picture served from a
 * different CDN path — and the operator should be able to see that that is what happened.
 */
async function fingerprintOf(
  subject: Subject,
  ctx: AdapterContext,
  options: Record<string, unknown>,
  notes: string[]
): Promise<Fingerprint> {
  if (subject.knownPhash && subject.knownDhash) return phashFingerprint(subject.knownPhash, subject.knownDhash)

  let bytes: Buffer | null = null
  if (subject.imagePath) {
    try {
      bytes = await fsp.readFile(subject.imagePath)
    } catch (err) {
      notes.push(`The local file could not be read for hashing: ${(err as Error).message}`)
    }
  } else if (subject.imageUrl && optionBoolean(options, 'hashRemote', true)) {
    const res = await httpGetBinary({
      url: subject.imageUrl,
      timeoutMs: Math.min(ctx.timeoutMs, 20_000),
      signal: ctx.signal,
      maxBytes: 16 * 1024 * 1024,
      userAgent: optionString(options, 'fetchUserAgent', DEFAULT_USER_AGENT),
      accept: 'image/*'
    })
    if (res.error === null && res.ok && res.body.byteLength > 0 && !res.truncated) bytes = res.body
    else notes.push(`The image could not be fetched for hashing (${res.error ?? `HTTP ${res.status}`}); the cache key falls back to the URL.`)
  }

  if (bytes) {
    const hash = hashImage(bytes)
    if (hash) return phashFingerprint(hash.phash, hash.dhash)
    notes.push(
      'The picture could not be decoded, so no perceptual hash was available and the cache key is a SHA-256 of the bytes. ' +
        'Outside the packaged app this is expected for JPEG: `support/image.ts` decodes PNG itself and everything else through ' +
        "Electron's nativeImage, which does not exist in plain Node."
    )
    return sha256Fingerprint(sha256Of(bytes))
  }
  if (subject.knownSha256) return sha256Fingerprint(subject.knownSha256)
  return urlFingerprint(subject.imageUrl ?? subject.imagePath ?? subject.label)
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function skipRecord(engine: ReverseEngine, why: string): BrowserEngineResult {
  return {
    id: engine.id,
    site: engine.site,
    status: 'skipped',
    requestedUrl: '',
    handoffUrl: engine.handoffUrl,
    finalUrl: '',
    httpStatus: null,
    title: '',
    block: null,
    error: why,
    summary: '',
    readyMarker: '',
    results: [],
    notes: [],
    html: '',
    text: '',
    htmlTruncated: false,
    durationMs: 0,
    skipReason: why
  }
}

function errorRecord(engine: ReverseEngine, why: string): BrowserEngineResult {
  return { ...skipRecord(engine, why), status: 'error', skipReason: undefined }
}

/* ------------------------------------------------------------------ *
 * Interpretation
 * ------------------------------------------------------------------ */

/** The standing caveat, attached to every run. It is the thing most likely to be forgotten. */
const SIMILARITY_CAVEAT =
  'A reverse image hit means this picture appears on that page. It does not mean the person is the same person: ' +
  'stock photographs, memes, game art, generated faces and platform default avatars all return large numbers of ' +
  'unrelated pages, and a big pile of them looks more convincing than a small one rather than less.'

function interpret(raw: RawResult): { findings: Finding[]; proposals: EntityProposal[] } {
  const env = readEnvelope(raw)
  if (!env) return { findings: [], proposals: [] }

  const run = parseJsonSafe<BrowserRunResult>(env.stdout)
  if (!run || !Array.isArray(run.engines)) {
    // The notes carry the reason when the run stopped before the browser — no image to
    // submit, no Playwright installed — and that reason is far more use than a generic
    // "nothing was readable".
    const reason = env.spawnError || env.notes[0] || env.stderr.split('\n')[0] || ''
    return {
      findings: [
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `No reverse image search was performed for ${env.target || 'this image'}, so nothing here is a statement about the picture. ` +
            (reason ? `${reason} ` : '') +
            `The raw capture is on disk and can be re-parsed once the cause is fixed.`
        })
      ],
      proposals: []
    }
  }

  const findings: Finding[] = []
  const proposals: EntityProposal[] = []
  // One entity is one candidate however many engines and rows named it. Without this, a
  // site that appears on four TinEye rows arrives in the review queue four times and the
  // operator does four times the work for the same fact.
  const proposedAlready = new Set<string>()
  const counts = { ok: 0, blocked: 0, unclear: 0, error: 0, skipped: 0, cached: 0, rows: 0, echoed: 0 }

  const submitted = run.subject?.url ?? ''
  const submittedHost = submitted ? hostOf(submitted) : ''

  for (const engine of run.engines) {
    if (!engine || typeof engine !== 'object') continue
    const title = engineById(engine.id)?.title ?? engine.id
    const site = engine.site || engine.id
    const rows = Array.isArray(engine.results) ? engine.results : []
    if (engine.cachedFrom) counts.cached++

    if (engine.status === 'blocked') {
      counts.blocked++
      findings.push(
        makeFinding(raw, {
          source: site,
          claim:
            `${title} refused this search rather than answering it: ${blockPhrase(engine)}. ` +
            `Nothing was found and nothing was ruled out — this is a refusal aimed at us and says nothing about whether matches exist. ` +
            `Run it by hand at ${engine.handoffUrl || engine.finalUrl || engine.requestedUrl}` +
            (engine.finalUrl && engine.finalUrl !== engine.handoffUrl ? ` (the browser was sent to ${engine.finalUrl})` : '') +
            '.'
        })
      )
      continue
    }

    if (engine.status === 'unclear') {
      counts.unclear++
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `${title} loaded a page for this image but nothing recognisable as a result list or an empty-state message was on it, ` +
            `so the outcome is unknown rather than empty. This is what selector rot looks like: the page is preserved in the raw ` +
            `capture as ${engine.id}.html and can be re-read once the selectors are updated. Open ${engine.handoffUrl || engine.finalUrl} to check by hand.`
        })
      )
      continue
    }

    if (engine.status === 'skipped') {
      counts.skipped++
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: `${title} was not run for this image. ${engine.skipReason ?? engine.error ?? 'No reason was recorded.'}`
        })
      )
      continue
    }

    if (engine.status === 'error') {
      counts.error++
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim:
            `${title} could not be searched: ${engine.error ?? 'the browser step failed without a message'}. ` +
            `This is a failure of this app, not an answer from ${site}. Try ${engine.handoffUrl} by hand.`
        })
      )
      continue
    }

    // status === 'ok'
    counts.ok++

    // Facts the engine states in prose rather than in a row. TinEye's first-indexed date is
    // the one that matters and it is a sentence, not a list item.
    for (const highlight of engineById(engine.id)?.textHighlights ?? []) {
      const captured = firstMatch(env.artifacts[`${engine.id}.txt`] ?? '', highlight.pattern)
      if (captured === null) continue
      findings.push(makeFinding(raw, { source: site, claim: highlight.claim.replace('{0}', captured) }))
    }

    // The query image echoed back inside the result list is the input, not a discovery.
    // TinEye puts the exact URL it was handed at the top of its own result list, and a run
    // that proposed the picture's own host would be reporting its own input as a finding.
    const echoed = rows.filter((r) => sameResource(r.url, submitted))
    const kept = rows.filter((r) => !sameResource(r.url, submitted))
    counts.echoed += echoed.length
    counts.rows += kept.length
    const provenance = engine.cachedFrom
      ? ` This result was served from the local cache, captured ${engine.cachedFrom}; the image was not submitted again.`
      : ''

    if (kept.length === 0) {
      findings.push(
        makeFinding(raw, {
          source: site,
          claim:
            `${title} answered for this image and returned no matches${engine.summary ? ` (${engine.summary})` : ''}` +
            (echoed.length > 0 ? ', beyond echoing back the copy it was given' : '') +
            `. This is a genuine empty result — the page carried ${engine.readyMarker || 'its own result furniture'} — and not a block. ` +
            `An absence here means the engine has not indexed a page carrying this picture, not that none exists.${provenance}`
        })
      )
      continue
    }

    const same = kept.filter((r) => r.kind === 'same')
    const similar = kept.filter((r) => r.kind === 'similar')
    const hosts = new Set(kept.map((r) => r.host).filter(Boolean))
    const overview = makeFinding(raw, {
      source: site,
      claim:
        `${title} returned ${group(kept.length)} result${kept.length === 1 ? '' : 's'} for this image across ${group(hosts.size)} ` +
        `distinct host${hosts.size === 1 ? '' : 's'}` +
        (engine.summary ? `; the engine's own count line reads "${engine.summary}"` : '') +
        `. ${same.length} of them are presented as pages carrying this picture and ${similar.length} as merely resembling it.${provenance}`
    })
    findings.push(overview)

    const shown = [...same, ...similar].slice(0, MAX_RESULT_FINDINGS)
    let proposed = 0
    for (const row of shown) {
      const label = row.text ? row.text.slice(0, 200) : ''
      // A row whose URL is the picture file itself is a *copy*; a row whose URL is a page
      // is somewhere the picture is *used*. Both are worth having and they are different
      // facts, and a CDN path like `miro.medium.com/v2/resize:fit:265/...` is emphatically
      // not a website anyone should be adding to the case as a domain.
      const isFile = looksLikeImageFile(row.url)
      const finding = makeFinding(raw, {
        source: site,
        claim:
          (isFile
            ? `${title} found a copy of this image hosted at ${row.url}`
            : `${title} places this image on ${row.host} at ${row.url}`) +
          (label ? ` — "${label}"` : '') +
          `. ${
            row.kind === 'same'
              ? isFile
                ? 'The engine presents this as the same picture, stored under a different URL.'
                : 'The engine presents this as a page carrying the picture.'
              : 'The engine presents this only as visually similar, which is a weaker claim.'
          }`
      })
      findings.push(finding)

      // Only a list the engine itself calls "pages carrying this image" is allowed to grow
      // the graph. A `similar` row is a likeness, and a likeness is not an identity.
      if (row.kind !== 'same' || proposed >= MAX_PROPOSALS) continue

      const proposal = proposalFor(row.url, isFile, title, finding.id, submittedHost)
      if (!proposal) continue
      const key = `${proposal.kind}|${proposal.value}`
      if (proposedAlready.has(key)) continue
      proposedAlready.add(key)
      proposed++
      proposals.push(proposal)
    }

    if (kept.length > shown.length) {
      findings.push(
        makeFinding(raw, {
          source: localSource(ID),
          claim: `${group(kept.length - shown.length)} further ${title} results were not turned into findings; all of them are in the raw capture for this run.`
        })
      )
    }
  }

  if (run.fatal) {
    findings.push(
      makeFinding(raw, {
        source: localSource(ID),
        claim: `The browser never got as far as searching: ${run.fatal}. No engine was asked anything, so nothing here is a statement about the image.`
      })
    )
  }

  findings.push(
    makeFinding(raw, {
      source: localSource(ID),
      claim:
        `Reverse image search over ${group(run.engines.length)} engine${run.engines.length === 1 ? '' : 's'}: ` +
        `${counts.ok} answered, ${counts.blocked} refused with a challenge or a wall, ${counts.unclear} were unreadable, ` +
        `${counts.error} failed, ${counts.skipped} were not applicable` +
        (counts.cached ? `, ${counts.cached} came from the cache` : '') +
        `. ${counts.rows} result rows in total` +
        (counts.echoed ? `, after discarding ${counts.echoed} row(s) that were the submitted image echoed back` : '') +
        '. ' +
        `A refusal and an empty result are different outcomes and are recorded separately above. ${SIMILARITY_CAVEAT}`
    })
  )

  return { findings, proposals }
}

/**
 * Capture group 1 of the first match, or `null`.
 *
 * The pattern arrives as a string from the engine table, so a bad one is a possibility; a
 * regex that will not compile is a missing highlight rather than a thrown parser.
 */
function firstMatch(text: string, pattern: string): string | null {
  if (!text) return null
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return null
  }
  const m = re.exec(text)
  return m && m[1] ? m[1].trim() : null
}

/** File extensions that mean the URL is the picture rather than a page showing it. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif|svg|tiff?)$/i

/**
 * Is this URL the picture itself rather than a page that shows it?
 *
 * The extension is necessary and not sufficient, and the counter-example is common enough
 * to have turned up in the first live run: `en.wikipedia.org/wiki/File:Tux.png` ends in
 * `.png` and is a *page about* the file. MediaWiki namespaces put a colon in the last
 * segment and live under `/wiki/`, so both are excluded. This is a heuristic and it will be
 * wrong somewhere; being wrong only costs a candidate the wrong entity kind, which a human
 * sees in the review queue before anything enters the graph.
 */
export function looksLikeImageFile(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const p = parsed.pathname
  if (!IMAGE_EXTENSIONS.test(p)) return false
  const last = p.slice(p.lastIndexOf('/') + 1)
  if (last.includes(':')) return false
  if (/\/wiki\//i.test(p)) return false
  return true
}

/**
 * Are these two URLs the same picture?
 *
 * Scheme and a trailing `www.` are ignored because engines rewrite both — TinEye hands back
 * `http://en.wikipedia.org/...` for a page it was shown over https. Query strings are kept:
 * on an image CDN the query is usually the resize, and two sizes of one file are still two
 * URLs worth recording separately.
 */
function sameResource(a: string, b: string): boolean {
  if (!a || !b) return false
  const strip = (u: string): string => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')
  return strip(a).toLowerCase() === strip(b).toLowerCase()
}

/**
 * The candidate a result row implies, or `null` when it implies nothing worth reviewing.
 *
 * Three shapes, in descending order of how much they are worth: a profile URL is an
 * `account` and is the whole reason this adapter exists; a bare image URL is an `image`,
 * which is a second copy to hash and compare rather than a place; anything else is a
 * `domain`. Every rationale carries the warning, because the review row is the last place
 * the operator sees before a candidate becomes part of the graph.
 */
function proposalFor(
  url: string,
  isFile: boolean,
  title: string,
  fromFindingId: string,
  submittedHost: string
): EntityProposal | null {
  const account = accountFromUrl(url)
  if (account) {
    return {
      fromFindingId,
      kind: 'account',
      value: `${account.platform}/${account.handle}`,
      label: `${account.platform}/${account.handle}`,
      attrs: { platform: account.platform, handle: account.handle, url },
      rationale:
        `${title} found this image on a profile page for this account. That proves the picture is on that page and nothing more — ` +
        `an avatar can be borrowed, a meme is on ten thousand profiles, and a default avatar is on millions. Confirm it is the same person before promoting.`
    }
  }
  if (isFile) {
    return {
      fromFindingId,
      kind: 'image',
      value: url,
      attrs: { sourceUrl: url },
      rationale:
        `${title} says this URL holds the same picture. Adding it lets the app hash this copy and compare it against the original, ` +
        `which is the only way to tell a genuine re-upload from a resized thumbnail the engine matched loosely.`
    }
  }
  const host = hostOf(url).replace(/^www\./, '')
  // A host that is only ever an image CDN is noise as a domain entity, and the site the
  // picture was submitted from is the input rather than a discovery.
  if (!host || !host.includes('.') || host === submittedHost.replace(/^www\./, '')) return null
  return {
    fromFindingId,
    kind: 'domain',
    value: host,
    rationale:
      `${title} found this image on a page hosted here. The host is worth looking at, but a site carrying a picture is not ` +
      `connected to the subject by that alone — image hosts, aggregators and scrapers dominate these lists.`
  }
}

/** How a block reads in a claim. */
function blockPhrase(engine: BrowserEngineResult): string {
  const kind = engine.block?.kind ?? 'unknown'
  const marker = engine.block?.marker ?? 'an unrecognised interstitial'
  if (kind === 'captcha') return `a captcha was served (${marker})`
  if (kind === 'consent') return `a consent wall was served (${marker}), and this app never accepts terms on your behalf`
  if (kind === 'ratelimit') return `it rate-limited us (${marker})`
  if (kind === 'login') return `it demanded a login (${marker}), and this app never signs in`
  return `it served an interstitial instead of results (${marker})`
}

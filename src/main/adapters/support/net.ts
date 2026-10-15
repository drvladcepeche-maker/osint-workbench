/**
 * HTTP for the adapters that talk to an API directly instead of wrapping a CLI.
 *
 * Four of the twelve adapters — wayback, reddit-profile, hibp-passwords and the
 * timestamp reader — need no external tool at all. They are the most reliable things in
 * the app precisely because there is no third-party Python package between us and the
 * endpoint: nothing to install, nothing to rot, nothing that dies on a `♥` in its banner.
 *
 * This wrapper exists so those four behave like the spawned tools do:
 *
 *  - **A real, honest User-Agent.** Not a browser impersonation. The Internet Archive and
 *    Reddit both ask for one, Reddit enforces it, and pretending to be Chrome while
 *    hammering a free public API is how a keyless source stops being available to
 *    everybody. It is overridable per adapter for the same reason it is set: the operator
 *    should be able to say who they are.
 *  - **Timeout and cancellation.** The same deadline the orchestrator gives a child
 *    process, and the same abort signal, so Cancel means cancel for every adapter.
 *  - **A response-size cap**, so a pathological endpoint cannot fill memory.
 *  - **Never throws.** A DNS failure, a 429 or a socket reset all come back as a value.
 *    Failure is the common case in this domain and it is itself informative — "the
 *    Archive rate-limited us" belongs in the case file, not in a stack trace.
 */

import { createHash } from 'node:crypto'

/** Identifies this app honestly. Overridable via `options.userAgent`. */
export const DEFAULT_USER_AGENT =
  'osint-workbench/0.1 (local research instrument; single operator; contact via repository)'

export interface HttpRequest {
  url: string
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  userAgent?: string
  timeoutMs: number
  /** The orchestrator's cancellation signal. */
  signal?: AbortSignal
  /** Hard cap on the response body. Default 8 MB. */
  maxBytes?: number
  accept?: string
  /**
   * Redirect policy. Defaults to `'follow'`, which is what every JSON endpoint here wants.
   *
   * `'manual'` exists for one caller: avatar fetching runs every URL through a safety gate
   * before requesting it, and a gate that only sees the first URL is not a gate at all —
   * a perfectly public `https://` address is free to answer 302 to a link-local metadata
   * endpoint, and `fetch` would follow it without asking anyone. With `'manual'` the
   * response comes back with its `Location` intact so the caller can re-run the gate on
   * every hop.
   */
  redirect?: 'follow' | 'manual'
}

export interface HttpResponse {
  url: string
  ok: boolean
  status: number
  statusText: string
  /** Only the headers worth keeping in a case file. */
  headers: Record<string, string>
  body: string
  bytes: number
  truncated: boolean
  durationMs: number
  /** Transport-level failure: DNS, TLS, reset, timeout, cancellation. */
  error: string | null
}

/**
 * The same response, with the bytes kept instead of decoded.
 *
 * `httpGet` calls `.toString('utf8')` on the buffer it already has, which is right for
 * every JSON and text endpoint but destroys an image: UTF-8 decoding replaces every
 * invalid sequence with U+FFFD, so a JPEG that has made the round trip is no longer the
 * JPEG that was sent, and its digest is no longer the digest of what the server served.
 * Avatar hashing needs the actual bytes, so it gets its own return type rather than a
 * flag on the existing one — a `body` that is sometimes a string and sometimes a Buffer
 * is exactly the kind of thing that type-checks and then corrupts evidence.
 */
export interface HttpBinaryResponse extends Omit<HttpResponse, 'body'> {
  /** Exactly what came off the wire, cut at `maxBytes` when the cap was hit. */
  body: Buffer
}

const KEEP_HEADERS = [
  'content-type',
  'location',
  'content-length',
  'date',
  'retry-after',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-used',
  'cf-ray',
  'server'
]

/**
 * The one request path. `httpGet` decodes its result; `httpGetBinary` does not.
 *
 * Both exports go through here so that a change to the timeout handling, the cap or the
 * kept headers cannot apply to one caller and miss the other.
 */
export async function httpGetBinary(req: HttpRequest): Promise<HttpBinaryResponse> {
  const started = Date.now()
  const maxBytes = req.maxBytes ?? 8 * 1024 * 1024
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  req.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), req.timeoutMs)

  const fail = (error: string, status = 0): HttpBinaryResponse => ({
    url: req.url,
    ok: false,
    status,
    statusText: '',
    headers: {},
    body: Buffer.alloc(0),
    bytes: 0,
    truncated: false,
    durationMs: Date.now() - started,
    error
  })

  try {
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      redirect: req.redirect ?? 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': req.userAgent ?? DEFAULT_USER_AGENT,
        Accept: req.accept ?? 'application/json, text/plain;q=0.9, */*;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        ...(req.headers ?? {})
      }
    })

    const headers: Record<string, string> = {}
    for (const name of KEEP_HEADERS) {
      const v = res.headers.get(name)
      if (v !== null) headers[name] = v
    }

    const buf = Buffer.from(await res.arrayBuffer())
    const truncated = buf.byteLength > maxBytes
    const body = truncated ? buf.subarray(0, maxBytes) : buf

    return {
      url: res.url || req.url,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      bytes: buf.byteLength,
      truncated,
      durationMs: Date.now() - started,
      error: null
    }
  } catch (err) {
    if (req.signal?.aborted) return fail('Cancelled.')
    const e = err as Error & { cause?: { code?: string } }
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return fail(`Timed out after ${req.timeoutMs} ms.`)
    }
    const code = e.cause?.code ? `${e.cause.code}: ` : ''
    return fail(`${code}${e.message}`)
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onOuterAbort)
  }
}

export async function httpGet(req: HttpRequest): Promise<HttpResponse> {
  const res = await httpGetBinary(req)
  return { ...res, body: res.body.toString('utf8') }
}

/**
 * Wait, but wake up immediately on cancellation.
 *
 * Used between paginated requests. The politeness gap between two pages of a Reddit
 * listing is the difference between "read a profile" and "scraped a site", and a plain
 * `setTimeout` would keep a cancelled job alive for its duration.
 */
export function politeDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Uppercase hex SHA-1. Used by `hibp-passwords`; see that adapter for why SHA-1. */
export function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').toUpperCase()
}

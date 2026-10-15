/**
 * The run envelope: one JSON shape that every adapter in this app emits as its raw
 * output, and the only thing `parse()` is ever given.
 *
 * ## Why an envelope instead of the tool's own bytes
 *
 * The contract says `run()` persists output verbatim and `parse()` is pure. Those two
 * requirements collide with reality in three places:
 *
 *  - **Five of the eight CLI tools write their structured output to a file**, not to
 *    stdout, and choose the filename themselves. If `run()` handed back only stdout,
 *    `parse()` would have to open that file — which would make it impure and would mean a
 *    parser fix could no longer be applied to a capture from last week, because the
 *    scratch file is long gone.
 *  - **Exit codes are worthless here.** sherlock, maigret and theHarvester all exit `0`
 *    on zero results, and theHarvester exits `0` when every one of its sources errored.
 *    The only way `parse()` can tell "found nothing" from "was blocked" is if the exit
 *    code, the stderr and the per-source telemetry travel *with* the artifact.
 *  - **stderr is where the explanation lives.** "Too many errors of type Bot protection"
 *    never appears in the JSON report; it appears on stderr, and it is the single most
 *    important fact about that run.
 *
 * So `run()` collects the tool's artifact bytes *unmodified*, wraps them together with the
 * exact command line, the exit code, stdout and stderr, and hands that over. The envelope
 * is a superset of what the tool produced: nothing is dropped, nothing is interpreted.
 * That JSON is what lands in `cases/<id>/raw/`, and re-parsing it years later needs
 * nothing but the file.
 *
 * `artifacts` holds file contents keyed by the file's own name, exactly as the tool wrote
 * them. `notes` holds mechanical observations made while collecting (e.g. "no report file
 * appeared in the scratch directory") — never interpretation of the *results*.
 */

import type { CaseId, EntityId, IsoTimestamp } from '../../../shared/types'
import type { AdapterInput, RawResult, SpawnResult } from '../types'

export interface RunEnvelope {
  /** Adapter id, so a raw file identifies itself without its filename. */
  adapter: string
  adapterVersion: string
  entityId: EntityId
  entityKind: string
  /** The value actually handed to the tool. */
  target: string
  startedAt: IsoTimestamp
  finishedAt: IsoTimestamp
  durationMs: number
  /** Exactly what was executed. `null` for adapters that spawn nothing. */
  command: { file: string; args: string[] } | null
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /** True when the child's output hit the cap. A parser must not assume valid JSON then. */
  truncated: boolean
  /** Set when the process could not be started at all. */
  spawnError: string | null
  stdout: string
  stderr: string
  /** Verbatim file contents the tool produced, keyed by filename. */
  artifacts: Record<string, string>
  /** Mechanical observations from collection. Not interpretation of results. */
  notes: string[]
  /**
   * Optional, opt-in: timestamps this run observed, transcribed (not analysed).
   * `pattern-timezone` reads these. See that adapter for the contract.
   */
  activity?: { source: string; timestamps: string[] }
}

export const ENVELOPE_MEDIA_TYPE = 'application/json'

export interface EnvelopeInit {
  adapterId: string
  adapterVersion: string
  input: AdapterInput
  target: string
  startedAt: IsoTimestamp
}

/** Start an envelope at the top of `run()`, before anything is executed. */
export function beginEnvelope(init: EnvelopeInit): RunEnvelope {
  return {
    adapter: init.adapterId,
    adapterVersion: init.adapterVersion,
    entityId: init.input.entity.id,
    entityKind: init.input.entity.kind,
    target: init.target,
    startedAt: init.startedAt,
    finishedAt: init.startedAt,
    durationMs: 0,
    command: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    truncated: false,
    spawnError: null,
    stdout: '',
    stderr: '',
    artifacts: {},
    notes: []
  }
}

/** Fold a `SpawnResult` into the envelope. Copies, never interprets. */
export function recordSpawn(
  env: RunEnvelope,
  command: { file: string; args: string[] },
  res: SpawnResult
): RunEnvelope {
  env.command = command
  env.exitCode = res.exitCode
  env.signal = res.signal
  env.timedOut = res.timedOut
  env.truncated = res.truncated
  env.spawnError = res.spawnError
  env.stdout = res.stdout
  env.stderr = res.stderr
  return env
}

export interface FinishOptions {
  caseId: CaseId
  /**
   * Whether there is something worth parsing.
   *
   * **Never derive this from the exit code.** `ok: true` means "an artifact exists and can
   * be interpreted", including when the artifact says the tool found nothing or was
   * blocked — those are findings about the world and `parse()` should get the chance to
   * say so. `ok: false` is for the cases where there is genuinely nothing to read: the
   * binary is missing, the process was killed, or no output appeared at all.
   */
  ok: boolean
  /** Required when `ok` is false: the one-line reason shown on the job row. */
  error?: string | null
  finishedAt: IsoTimestamp
  startedMs: number
}

/** Close the envelope and wrap it in the `RawResult` the orchestrator expects. */
export function finishEnvelope(env: RunEnvelope, opts: FinishOptions): RawResult {
  env.finishedAt = opts.finishedAt
  env.durationMs = Date.now() - opts.startedMs
  return {
    adapterId: env.adapter,
    caseId: opts.caseId,
    entityId: env.entityId,
    ok: opts.ok,
    exitCode: env.exitCode,
    signal: env.signal,
    stdout: JSON.stringify(env, null, 2),
    stderr: env.stderr,
    mediaType: ENVELOPE_MEDIA_TYPE,
    startedAt: env.startedAt,
    finishedAt: env.finishedAt,
    durationMs: env.durationMs,
    truncated: env.truncated,
    timedOut: env.timedOut,
    command: env.command,
    error: opts.ok ? null : (opts.error ?? 'The tool produced no output that could be interpreted.'),
    // Replaced by the orchestrator once the bytes are on disk.
    raw: { rawId: '', path: '', sha256: '', bytes: 0, mediaType: ENVELOPE_MEDIA_TYPE, excerpt: '' }
  }
}

/**
 * Recover the envelope inside `parse()`.
 *
 * Returns `null` rather than throwing on anything malformed. A truncated capture is an
 * expected condition — the orchestrator caps output — and the contract is that a parser
 * returns `[]` for input it cannot read, so the raw bytes stay on disk and the run stays
 * re-parseable once the parser is fixed.
 */
export function readEnvelope(raw: RawResult): RunEnvelope | null {
  if (typeof raw.stdout !== 'string' || !raw.stdout.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const env = parsed as Partial<RunEnvelope>
  if (typeof env.adapter !== 'string') return null
  return {
    adapter: env.adapter,
    adapterVersion: typeof env.adapterVersion === 'string' ? env.adapterVersion : '0.0.0',
    entityId: typeof env.entityId === 'string' ? env.entityId : raw.entityId,
    entityKind: typeof env.entityKind === 'string' ? env.entityKind : 'unknown',
    target: typeof env.target === 'string' ? env.target : '',
    startedAt: typeof env.startedAt === 'string' ? env.startedAt : raw.startedAt,
    finishedAt: typeof env.finishedAt === 'string' ? env.finishedAt : raw.finishedAt,
    durationMs: typeof env.durationMs === 'number' ? env.durationMs : 0,
    command: env.command && typeof env.command === 'object' ? env.command : null,
    exitCode: typeof env.exitCode === 'number' ? env.exitCode : null,
    signal: typeof env.signal === 'string' ? env.signal : null,
    timedOut: env.timedOut === true,
    truncated: env.truncated === true,
    spawnError: typeof env.spawnError === 'string' ? env.spawnError : null,
    stdout: typeof env.stdout === 'string' ? env.stdout : '',
    stderr: typeof env.stderr === 'string' ? env.stderr : '',
    artifacts: isStringMap(env.artifacts) ? env.artifacts : {},
    notes: Array.isArray(env.notes) ? env.notes.filter((n): n is string => typeof n === 'string') : [],
    activity: readActivity(env.activity)
  }
}

function isStringMap(x: unknown): x is Record<string, string> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  return Object.values(x as Record<string, unknown>).every((v) => typeof v === 'string')
}

function readActivity(x: unknown): RunEnvelope['activity'] {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const a = x as { source?: unknown; timestamps?: unknown }
  if (!Array.isArray(a.timestamps)) return undefined
  return {
    source: typeof a.source === 'string' ? a.source : 'unknown',
    timestamps: a.timestamps.filter((t): t is string => typeof t === 'string')
  }
}

/** The first artifact whose name matches, or `null`. */
export function artifact(env: RunEnvelope, match: RegExp): string | null {
  for (const [name, body] of Object.entries(env.artifacts)) {
    if (match.test(name)) return body
  }
  return null
}

/** `JSON.parse` that returns `null` instead of throwing. Used all over the parsers. */
export function parseJsonSafe<T>(text: string | null | undefined): T | null {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * Parse JSON Lines, skipping unreadable lines.
 *
 * subfinder emits one object per line, and a truncated capture ends mid-object. Losing
 * that last line is correct; losing the 24,947 before it would not be.
 */
export function parseJsonLines<T>(text: string | null | undefined): { records: T[]; badLines: number } {
  if (typeof text !== 'string' || !text.trim()) return { records: [], badLines: 0 }
  const records: T[] = []
  let badLines = 0
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      records.push(JSON.parse(t) as T)
    } catch {
      badLines++
    }
  }
  return { records, badLines }
}

/** The last few meaningful lines of stderr, for a claim that has to explain a failure. */
export function stderrSummary(env: RunEnvelope, lines = 3): string {
  return env.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' / ')
    .slice(0, 400)
}

/** `1234` -> `1,234`. Claims are read by a human, so numbers are grouped. */
export function group(n: number): string {
  return n.toLocaleString('en-US')
}

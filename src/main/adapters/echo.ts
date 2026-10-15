/**
 * `echo` — the reference adapter.
 *
 * It is not an OSINT tool. It exists to prove the contract end-to-end: run -> persist
 * raw -> parse -> finding -> SQLite, with a fully populated `doc`, no network, and no
 * child process. Every real adapter should read like this one.
 *
 * Deliberately NOT here: any interpretation inside `run()`, any I/O inside `parse()`,
 * and any confidence above `unverified`.
 */

import { makeFinding, type Adapter, type AdapterContext, type AdapterInput, type RawResult } from './types'
import type { Finding } from '../../shared/types'

interface EchoPayload {
  adapter: 'echo'
  entityId: string
  kind: string
  value: string
  label: string
  seed: boolean
  characters: number
  /** Deterministic, local, no-LLM "analysis" — the only kind this app does. */
  characterClasses: Record<string, number>
  observedAt: string
}

function classify(value: string): Record<string, number> {
  const classes: Record<string, number> = { letters: 0, digits: 0, punctuation: 0, whitespace: 0, other: 0 }
  for (const ch of value) {
    if (/\p{L}/u.test(ch)) classes.letters = (classes.letters ?? 0) + 1
    else if (/\p{N}/u.test(ch)) classes.digits = (classes.digits ?? 0) + 1
    else if (/\s/.test(ch)) classes.whitespace = (classes.whitespace ?? 0) + 1
    else if (/\p{P}|\p{S}/u.test(ch)) classes.punctuation = (classes.punctuation ?? 0) + 1
    else classes.other = (classes.other ?? 0) + 1
  }
  return classes
}

export const echoAdapter: Adapter = {
  id: 'echo',
  title: 'Echo (self-test)',
  version: '1.0.0',

  accepts: ['person', 'username', 'email', 'phone', 'domain', 'ipaddr', 'image', 'account', 'location', 'organisation'],
  produces: [],

  requiresKey: false,
  requiresNetwork: false,

  concurrency: 4,
  minIntervalMs: 0,
  defaultTimeoutMs: 5_000,

  doc: {
    what: 'Reads back the entity you pointed it at, with a deterministic character-class breakdown. A self-test, not an investigative tool.',
    how: 'Runs entirely in the main process with no network and no child process. It serialises the entity to JSON, writes that JSON to the case\'s raw/ folder like any real adapter, then parses its own output back into a single Finding.',
    why: 'It exercises every joint in the pipeline — registry, orchestrator, raw persistence, parser, confidence gate, SQLite index and the UI panel you are reading — so that when a real adapter misbehaves you know the fault is in the adapter and not in the plumbing underneath it.',
    betterAt: 'Proving the app itself works after a change, and demonstrating the adapter contract to anyone writing a new one. It is instantaneous, deterministic, and cannot be rate-limited or blocked.',
    worseAt: 'Telling you anything you did not already know. It contacts nothing, discovers nothing, and produces no new entities — its produces list is empty on purpose.',
    falsePositives: 'None in the usual sense: it can only restate its input. The trap is the opposite one — an echo Finding sitting in a case file looks exactly as authoritative as a real one in the findings table, so it is deliberately marked source "local:echo" to make its provenance obvious at a glance.'
  },

  async run(input: AdapterInput, ctx: AdapterContext): Promise<RawResult> {
    const startedAt = ctx.now()
    const t0 = Date.now()
    ctx.progress({ pct: 10, note: 'reading entity' })

    // Even a trivial adapter honours cancellation — the orchestrator aborts the signal
    // and every adapter is expected to notice.
    if (ctx.signal.aborted) throw new Error('cancelled')

    const payload: EchoPayload = {
      adapter: 'echo',
      entityId: input.entity.id,
      kind: input.entity.kind,
      value: input.entity.value,
      label: input.entity.label,
      seed: input.entity.seed,
      characters: [...input.entity.value].length,
      characterClasses: classify(input.entity.value),
      observedAt: startedAt
    }

    ctx.progress({ pct: 90, note: 'serialising' })
    const finishedAt = ctx.now()

    return {
      adapterId: 'echo',
      caseId: input.caseId,
      entityId: input.entity.id,
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify(payload, null, 2),
      stderr: '',
      mediaType: 'application/json',
      startedAt,
      finishedAt,
      durationMs: Date.now() - t0,
      truncated: false,
      timedOut: false,
      command: null,
      error: null,
      // Filled in by the orchestrator after the raw output is persisted. `run` never
      // writes to disk itself.
      raw: { rawId: '', path: '', sha256: '', bytes: 0, mediaType: 'application/json', excerpt: '' }
    }
  },

  parse(raw: RawResult): Finding[] {
    if (!raw.ok) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.stdout)
    } catch {
      // A parser must never throw the run away. The raw bytes are already on disk; the
      // orchestrator records the parse failure and the operator can re-parse later.
      return []
    }
    // Valid JSON is not the same as the expected *shape*: `null`, `[]` and `"x"` all parse
    // cleanly and then explode on property access. A malformed payload is an expected
    // condition, so it returns [] like a syntax error does.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const payload = parsed as EchoPayload
    if (!payload.characterClasses || typeof payload.characterClasses !== 'object') return []

    const classes = Object.entries(payload.characterClasses)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ')

    return [
      makeFinding(raw, {
        source: 'local:echo',
        claim: `Entity "${payload.label}" is a ${payload.kind} of ${payload.characters} characters (${classes || 'no characters'}), ${payload.seed ? 'supplied as a seed' : 'discovered by a tool'}.`
      })
    ]
  }
}

/**
 * The two files the engine owns, and nothing else.
 *
 * ```
 * cases/<case-id>/provenance.jsonl   how every node was reached, and every prune
 * cases/<case-id>/engine-log.jsonl   every automatic decision, with its reason
 * ```
 *
 * Both are **append-only**, for the same reason `confidence-log.jsonl` is: they are the
 * answer to *how did I get here* and *why did it do that*, and a record that can be
 * rewritten after the fact answers neither. Nothing here ever rewrites a line, and a
 * corrupt line costs that line only — `parseJsonl` in the case store already established
 * that policy and this reuses it rather than inventing a second one.
 *
 * ## Why these are not in SQLite
 *
 * The index is derived and disposable; `rebuildIndex()` reconstructs it from `cases/` and
 * a test asserts the rebuild is exact. Adding engine tables would mean a schema bump and a
 * second place for provenance to live and disagree. The volume does not justify it either:
 * a provenance graph is one line per hop, and an investigation that produces four thousand
 * findings produces a few dozen hops. Files are truth here in the strongest sense — this
 * is the only copy.
 *
 * ## Concurrency
 *
 * Appends are single `appendFile` calls, which is what `appendConfidenceChange` does, for
 * the same reason: an append of a line under the size of a pipe buffer does not interleave
 * with another, and there is no read-modify-write to serialise. Reads tolerate a missing
 * file — a case the engine has never touched has neither of these.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  EngineDecision,
  EngineDecisionKind,
  NodeRef,
  ProvenanceHop,
  ProvenancePrune,
  ProvenanceRecord
} from '../../shared/engine'
import { ulid } from '../../shared/ids'
import { parseJsonl, type JsonlReadResult } from '../store/caseStore'

export const PROVENANCE_FILE = 'provenance.jsonl'
export const ENGINE_LOG_FILE = 'engine-log.jsonl'

export interface ProvenanceFile {
  hops: ProvenanceHop[]
  prunes: ProvenancePrune[]
  /** Lines that failed to parse. Skipped, never fatal, and reported so a corruption is visible. */
  badLines: JsonlReadResult<unknown>['badLines']
}

async function readTextOr(file: string, fallback: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

async function appendLine(file: string, record: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.appendFile(file, JSON.stringify(record) + '\n')
}

/**
 * Reader and writer for one case's engine files.
 *
 * Takes the case directory rather than a `CaseStore` so it can be pointed at a folder in a
 * test without standing the whole service up, and so the engine's storage stays visibly
 * separate from the case store's.
 */
export class EngineStore {
  constructor(private readonly caseDirFor: (caseId: string) => string) {}

  private provenancePath(caseId: string): string {
    return path.join(this.caseDirFor(caseId), PROVENANCE_FILE)
  }

  private logPath(caseId: string): string {
    return path.join(this.caseDirFor(caseId), ENGINE_LOG_FILE)
  }

  /* ---------------- provenance ---------------- */

  async readProvenance(caseId: string): Promise<ProvenanceFile> {
    const { records, badLines } = parseJsonl<ProvenanceRecord>(await readTextOr(this.provenancePath(caseId), ''))
    const hops: ProvenanceHop[] = []
    const prunes: ProvenancePrune[] = []
    for (const r of records) {
      // A record with no discriminant predates nothing — the file has always carried one —
      // so an untagged line is corruption and is counted as such rather than guessed at.
      if (r && r.record === 'hop') hops.push(stripTag(r))
      else if (r && r.record === 'prune') prunes.push(stripTag(r))
      else badLines.push({ line: -1, reason: 'a provenance line with no record type' })
    }
    return { hops, prunes, badLines }
  }

  /**
   * Record a hop.
   *
   * Deliberately not deduplicated on write. Two runs finding the same account by two
   * different routes is **two hops**, and collapsing them would destroy exactly the
   * information that makes a node worth believing — `ProvenanceChain.alternates` counts
   * them. Duplicate *identical* hops are folded at read time by the graph builder instead,
   * where the fold is visible and reversible.
   */
  async appendHop(hop: Omit<ProvenanceHop, 'id'> & { id?: string }): Promise<ProvenanceHop> {
    const record: ProvenanceHop = { ...hop, id: hop.id ?? `hop_${ulid()}` }
    await appendLine(this.provenancePath(record.caseId), { record: 'hop', ...record })
    return record
  }

  async appendPrune(prune: Omit<ProvenancePrune, 'id'> & { id?: string }): Promise<ProvenancePrune> {
    const record: ProvenancePrune = { ...prune, id: prune.id ?? `prn_${ulid()}` }
    await appendLine(this.provenancePath(record.caseId), { record: 'prune', ...record })
    return record
  }

  /* ---------------- decisions ---------------- */

  /** Newest first, because that is the order the brief reads them in. */
  async readDecisions(caseId: string, limit = 0): Promise<EngineDecision[]> {
    const { records } = parseJsonl<EngineDecision>(await readTextOr(this.logPath(caseId), ''))
    const out = records.slice().reverse()
    return limit > 0 ? out.slice(0, limit) : out
  }

  /**
   * Append one decision.
   *
   * `reason` is required by the type and checked here as well, because this is the file
   * that makes the engine auditable and an empty reason would make one line of it a lie.
   */
  async appendDecision(input: {
    caseId: string
    kind: EngineDecisionKind
    reason: string
    node?: NodeRef | null
    adapterId?: string | null
    gain?: number | null
    at?: string
  }): Promise<EngineDecision> {
    const reason = input.reason.trim()
    if (!reason) {
      throw new Error(
        `The engine tried to record a "${input.kind}" decision with no reason. Every automatic decision states its reason; that is the point of the log.`
      )
    }
    const decision: EngineDecision = {
      id: `dec_${ulid()}`,
      caseId: input.caseId,
      kind: input.kind,
      at: input.at ?? new Date().toISOString(),
      reason,
      node: input.node ?? null,
      adapterId: input.adapterId ?? null,
      gain: input.gain ?? null
    }
    await appendLine(this.logPath(decision.caseId), decision)
    return decision
  }

  /** True when the engine has ever touched this case. Drives the brief's empty state. */
  async hasRun(caseId: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.logPath(caseId))
      return stat.size > 0
    } catch {
      return false
    }
  }
}

function stripTag<T extends { record?: unknown }>(r: T): Omit<T, 'record'> {
  const { record: _record, ...rest } = r
  return rest
}

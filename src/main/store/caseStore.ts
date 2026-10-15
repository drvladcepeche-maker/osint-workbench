/**
 * The case store. **Files are the source of truth.**
 *
 * A case is a folder you can open in Explorer, read in a text editor, diff in git, and
 * copy to a USB stick. SQLite (`src/main/db`) is a *derived* index that can be deleted
 * at any moment and rebuilt from these files — `rebuildIndex()` exists to prove it.
 *
 *   cases/<case-id>/
 *     case.json               the Case record + schema version
 *     entities.json           an array of Entity, rewritten whole (small, hand-editable)
 *     findings.jsonl          one Finding per line, append-and-rewrite
 *     confidence-log.jsonl    every confidence change, append-only, never rewritten
 *     evidence/index.jsonl    one Evidence record per line
 *     evidence/<id>.<ext>     the captured bytes
 *     raw/<raw-id>.<ext>      unparsed tool output, append-only, never deleted
 *
 * Why JSONL for findings and JSON for entities: findings are the high-volume, append-
 * heavy collection where a partial write must not corrupt the ones before it, and where
 * a single corrupt line should cost one finding rather than the whole file. Entities are
 * few, mutate in place (attrs get enriched), and are the thing you most often want to
 * hand-edit — so a pretty-printed array wins there.
 *
 * All writes are atomic: write to `<file>.tmp` then rename. A killed process leaves
 * either the old file or the new one, never half of either.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_CONFIDENCE,
  SCHEMA_VERSION,
  type CandidateProposal,
  type CandidateState,
  type Case,
  type CaseBasis,
  type CaseFile,
  type ConfidenceChange,
  type Entity,
  type EntityCandidate,
  type EntityKind,
  type Evidence,
  type EvidenceType,
  type Finding,
  type IsoTimestamp,
  type MatcherQuality,
  type NewEntity,
  type RawPayload,
  type RemovedEntity
} from '../../shared/types'
import {
  caseId as makeCaseId,
  entityId as makeEntityId,
  evidenceId,
  findingId as makeFindingId,
  isSafeIdSegment,
  rawId
} from '../../shared/ids'
import { normaliseEntityValue } from '../../shared/normalise'

export const CASE_FILE = 'case.json'
export const ENTITIES_FILE = 'entities.json'
export const CANDIDATES_FILE = 'candidates.jsonl'
export const FINDINGS_FILE = 'findings.jsonl'
export const CONFIDENCE_LOG_FILE = 'confidence-log.jsonl'
/** Append-only tombstones for entities taken out of the case. See `RemovedEntity`. */
export const REMOVED_ENTITIES_FILE = 'removed-entities.jsonl'
export const EVIDENCE_DIR = 'evidence'
export const EVIDENCE_INDEX = 'evidence/index.jsonl'
export const RAW_DIR = 'raw'

/** How much of a raw capture is copied into the finding for previews and FTS. */
export const RAW_EXCERPT_BYTES = 2048

export class CaseStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaseStoreError'
  }
}

export function nowIso(): IsoTimestamp {
  return new Date().toISOString()
}

/* ------------------------------------------------------------------ *
 * Atomic primitives
 * ------------------------------------------------------------------ */

let tmpCounter = 0

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // The temp name must be unique per write. A fixed `<file>.tmp` looks atomic but two
  // concurrent writers share it: the first rename moves it away and the second fails
  // with ENOENT. The orchestrator runs adapters in parallel by design, so this is a
  // routine occurrence, not a corner case.
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${(tmpCounter++).toString(36)}.tmp`
  try {
    await fsp.writeFile(tmp, data)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Serialises read-modify-write sequences per file.
 *
 * `entities.json` and `findings.jsonl` are read whole, mutated, and written back. Two
 * adapters finishing at the same moment would both read the old contents and the second
 * write would erase the first one's finding — a silent, intermittent data loss that only
 * shows up under exactly the concurrency the orchestrator exists to provide. Every such
 * sequence goes through here.
 *
 * This guards a single process. Two copies of the app pointed at the same cases folder
 * would still race; the single-instance lock in `main/index.ts` is what prevents that.
 */
const fileLocks = new Map<string, Promise<unknown>>()

function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(key) ?? Promise.resolve()
  const next = prior.then(fn, fn)
  // Keep the chain alive but never let a rejection poison the next waiter.
  fileLocks.set(
    key,
    next.catch(() => undefined)
  )
  void next.catch(() => undefined).finally(() => {
    if (fileLocks.get(key) === undefined) fileLocks.delete(key)
  })
  return next
}

async function readTextOr(file: string, fallback: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

export interface JsonlReadResult<T> {
  records: T[]
  /** 1-based line numbers that failed to parse, with the reason. A bad line is skipped, never fatal. */
  badLines: { line: number; reason: string }[]
}

export function parseJsonl<T>(text: string): JsonlReadResult<T> {
  const records: T[] = []
  const badLines: { line: number; reason: string }[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? '').trim()
    if (!raw) continue
    try {
      records.push(JSON.parse(raw) as T)
    } catch (err) {
      badLines.push({ line: i + 1, reason: (err as Error).message })
    }
  }
  return { records, badLines }
}

function serialiseJsonl(records: readonly unknown[]): string {
  return records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : ''
}

/* ------------------------------------------------------------------ *
 * CaseStore
 * ------------------------------------------------------------------ */

export interface CreateCaseInput {
  name: string
  basis: CaseBasis
  subjectConsent?: boolean
  notes?: string
  /** Only for tests / imports; normally derived from the name. */
  id?: string
  createdAt?: IsoTimestamp
}

export interface AddFindingInput {
  entityId: string
  source: string
  tool: string
  claim: string
  raw: RawPayload
  evidenceRef?: string | null
  at?: IsoTimestamp
  /**
   * How much the probe behind this claim was structurally capable of meaning.
   *
   * Carried through here rather than left on the object `parse()` returned, because this
   * constructor rebuilds the `Finding` from these fields — anything not named here is
   * silently dropped on the way to `findings.jsonl`, which is exactly what happened to the
   * first version of the matcher classification. It is not part of the finding id: a
   * reclassification updates the explanation on the existing row instead of minting a
   * second one.
   */
  matcher?: MatcherQuality | null
}

export class CaseStore {
  constructor(readonly casesDir: string) {}

  dir(id: string): string {
    if (!isSafeIdSegment(id)) throw new CaseStoreError(`Unsafe case id: ${JSON.stringify(id)}`)
    return path.join(this.casesDir, id)
  }

  async ensureRoot(): Promise<void> {
    await fsp.mkdir(this.casesDir, { recursive: true })
  }

  /** Case folder names, sorted. Anything without a `case.json` is not a case. */
  async listCaseIds(): Promise<string[]> {
    await this.ensureRoot()
    const entries = await fsp.readdir(this.casesDir, { withFileTypes: true })
    const ids: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (!isSafeIdSegment(e.name)) continue
      if (fs.existsSync(path.join(this.casesDir, e.name, CASE_FILE))) ids.push(e.name)
    }
    return ids.sort()
  }

  /* ---------------- case.json ---------------- */

  async createCase(input: CreateCaseInput): Promise<CaseFile> {
    const name = input.name.trim()
    if (!name) throw new CaseStoreError('A case needs a name.')

    // `basis` is the app's legal spine, so the consistency rule is enforced at creation
    // rather than trusted to the UI: a `consent` case without recorded consent is not a
    // thing that may exist.
    if (input.basis === 'consent' && input.subjectConsent !== true) {
      throw new CaseStoreError(
        'A case with basis "consent" requires subjectConsent === true. ' +
          'If consent has not been given, the basis is not "consent".'
      )
    }

    const id = input.id ?? makeCaseId(name)
    const dir = this.dir(id)
    if (fs.existsSync(path.join(dir, CASE_FILE))) throw new CaseStoreError(`Case ${id} already exists.`)

    const at = input.createdAt ?? nowIso()
    const file: CaseFile = {
      schemaVersion: SCHEMA_VERSION,
      id,
      name,
      basis: input.basis,
      subjectConsent: input.basis === 'consent' ? true : false,
      createdAt: at,
      updatedAt: at,
      notes: input.notes ?? ''
    }

    await fsp.mkdir(path.join(dir, RAW_DIR), { recursive: true })
    await fsp.mkdir(path.join(dir, EVIDENCE_DIR), { recursive: true })
    await writeAtomic(path.join(dir, CASE_FILE), JSON.stringify(file, null, 2) + '\n')
    await writeAtomic(path.join(dir, ENTITIES_FILE), '[]\n')
    await writeAtomic(path.join(dir, CANDIDATES_FILE), '')
    await writeAtomic(path.join(dir, FINDINGS_FILE), '')
    await writeAtomic(path.join(dir, CONFIDENCE_LOG_FILE), '')
    await writeAtomic(path.join(dir, EVIDENCE_INDEX), '')
    return file
  }

  async readCase(id: string): Promise<CaseFile> {
    const file = path.join(this.dir(id), CASE_FILE)
    let text: string
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      throw new CaseStoreError(`No case.json for ${id}`)
    }
    const parsed = JSON.parse(text) as CaseFile
    if (parsed.id !== id) {
      throw new CaseStoreError(`Case folder ${id} contains a case.json claiming id ${parsed.id}`)
    }
    return parsed
  }

  async updateCase(id: string, patch: Partial<Omit<Case, 'id' | 'createdAt'>>): Promise<CaseFile> {
    const current = await this.readCase(id)
    const next: CaseFile = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: nowIso() }
    if (next.basis === 'consent' && next.subjectConsent !== true) {
      throw new CaseStoreError('Cannot set basis "consent" without subjectConsent === true.')
    }
    if (next.basis !== 'consent') next.subjectConsent = false
    await writeAtomic(path.join(this.dir(id), CASE_FILE), JSON.stringify(next, null, 2) + '\n')
    return next
  }

  /* ---------------- entities.json ---------------- */

  async readEntities(id: string): Promise<Entity[]> {
    const text = await readTextOr(path.join(this.dir(id), ENTITIES_FILE), '[]')
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as Entity[]) : []
  }

  private async writeEntities(id: string, entities: readonly Entity[]): Promise<void> {
    await writeAtomic(path.join(this.dir(id), ENTITIES_FILE), JSON.stringify(entities, null, 2) + '\n')
  }

  /**
   * Idempotent upsert. Identity is `(caseId, kind, canonical value)`, so calling this
   * twice with the same value returns the same entity and merges any new attrs.
   *
   * `seed` is sticky-true: once an entity is marked as operator-supplied it stays that
   * way even when an adapter later rediscovers it. Otherwise the adversary-level
   * analysis ("what did this seed unlock?") would quietly lose its baseline.
   */
  async upsertEntity<K extends EntityKind>(id: string, input: NewEntity<K>): Promise<Entity> {
    return withFileLock(path.join(this.dir(id), ENTITIES_FILE), async () => {
      const entities = await this.readEntities(id)
      const norm = normaliseEntityValue(input.kind, input.value)
      const eid = makeEntityId(id, input.kind, norm.value)
      const existingIndex = entities.findIndex((e) => e.id === eid)

      if (existingIndex >= 0) {
        const existing = entities[existingIndex] as Entity
        const merged = {
          ...existing,
          label: input.label ?? existing.label,
          seed: existing.seed || input.seed === true,
          attrs: { ...norm.attrs, ...(existing.attrs as object), ...(input.attrs ?? {}) }
        } as Entity
        entities[existingIndex] = merged
        await this.writeEntities(id, entities)
        return merged
      }

      const created = {
        id: eid,
        caseId: id,
        kind: input.kind,
        value: norm.value,
        label: input.label ?? norm.label,
        createdAt: nowIso(),
        seed: input.seed ?? false,
        attrs: { ...norm.attrs, ...(input.attrs ?? {}) }
      } as Entity
      entities.push(created)
      await this.writeEntities(id, entities)
      return created
    })
  }

  async getEntity(id: string, eid: string): Promise<Entity | null> {
    return (await this.readEntities(id)).find((e) => e.id === eid) ?? null
  }

  /**
   * Take an entity out of the case.
   *
   * Only `entities.json` is touched. Findings are **not** deleted and raw captures are
   * **never** deleted — see `RemovedEntity` for why. The findings that were about this
   * entity keep pointing at its id and become orphaned, which is a state the UI names
   * rather than a state it hides.
   *
   * Returns the entity that was removed, or `null` when it was not there. Not an error:
   * removal is idempotent, and two clicks on the same row must not produce a stack trace.
   */
  async removeEntity(id: string, eid: string): Promise<Entity | null> {
    return withFileLock(path.join(this.dir(id), ENTITIES_FILE), async () => {
      const entities = await this.readEntities(id)
      const idx = entities.findIndex((e) => e.id === eid)
      if (idx < 0) return null
      const [removed] = entities.splice(idx, 1)
      await this.writeEntities(id, entities)
      return removed ?? null
    })
  }

  /* ---------------- removed-entities.jsonl ---------------- */

  async readRemovedEntities(id: string): Promise<JsonlReadResult<RemovedEntity>> {
    return parseJsonl<RemovedEntity>(await readTextOr(path.join(this.dir(id), REMOVED_ENTITIES_FILE), ''))
  }

  /**
   * Append-only, and written **only when the removal left something behind** — orphaned
   * findings, or a rename that points at a replacement.
   *
   * A removal that left nothing writes nothing. That is the difference the operator
   * asked for between deleting a seed and deleting a discovery: a seed nothing was ever
   * run against is something he typed by mistake, and correcting a typo should not leave
   * a permanent record that he made one.
   */
  async appendRemovedEntity(id: string, record: RemovedEntity): Promise<void> {
    const file = path.join(this.dir(id), REMOVED_ENTITIES_FILE)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, JSON.stringify(record) + '\n')
  }

  /* ---------------- candidates.jsonl ---------------- */

  async readCandidates(id: string): Promise<JsonlReadResult<EntityCandidate>> {
    return parseJsonl<EntityCandidate>(await readTextOr(path.join(this.dir(id), CANDIDATES_FILE), ''))
  }

  private async writeCandidates(id: string, candidates: readonly EntityCandidate[]): Promise<void> {
    await writeAtomic(path.join(this.dir(id), CANDIDATES_FILE), serialiseJsonl(candidates))
  }

  async getCandidate(id: string, candidateId: string): Promise<EntityCandidate | null> {
    return (await this.readCandidates(id)).records.find((c) => c.id === candidateId) ?? null
  }

  /**
   * Record that a finding implies an entity that is not in the graph.
   *
   * Idempotent on `(caseId, kind, canonical value)` — the same id an `Entity` would get —
   * so two adapters discovering the same account converge on one candidate carrying two
   * proposals, which is exactly the signal the reviewer wants: two tools, and (if their
   * sources differ) two independent ones.
   *
   * **A decided candidate stays decided.** A later run that re-proposes something the
   * operator dismissed appends the new proposal but does not resurrect it. Re-asking a
   * question a human has already answered, every time a tool runs again, is how a review
   * queue becomes noise nobody reads.
   */
  async proposeCandidate(
    id: string,
    input: {
      kind: EntityKind
      value: string
      label?: string
      attrs?: Record<string, unknown>
      proposal: CandidateProposal
    }
  ): Promise<{ candidate: EntityCandidate; created: boolean }> {
    return withFileLock(path.join(this.dir(id), CANDIDATES_FILE), async () => {
      const { records } = await this.readCandidates(id)
      const norm = normaliseEntityValue(input.kind, input.value)
      const cid = makeEntityId(id, input.kind, norm.value)
      const idx = records.findIndex((c) => c.id === cid)

      if (idx >= 0) {
        const prev = records[idx] as EntityCandidate
        const proposals = prev.proposals.some((p) => p.findingId === input.proposal.findingId)
          ? prev.proposals
          : [...prev.proposals, input.proposal]
        const next: EntityCandidate = {
          ...prev,
          label: prev.label || input.label || norm.label,
          attrs: { ...norm.attrs, ...prev.attrs, ...(input.attrs ?? {}) },
          proposals
        }
        records[idx] = next
        await this.writeCandidates(id, records)
        return { candidate: next, created: false }
      }

      const created: EntityCandidate = {
        id: cid,
        caseId: id,
        kind: input.kind,
        value: norm.value,
        label: input.label ?? norm.label,
        attrs: { ...norm.attrs, ...(input.attrs ?? {}) },
        proposals: [input.proposal],
        state: 'pending',
        firstProposedAt: input.proposal.at,
        decidedAt: null
      }
      records.push(created)
      await this.writeCandidates(id, records)
      return { candidate: created, created: true }
    })
  }

  /** Record a human's decision. The only thing that moves a candidate off `pending`. */
  async decideCandidate(
    id: string,
    candidateId: string,
    state: CandidateState,
    at?: IsoTimestamp
  ): Promise<EntityCandidate> {
    return withFileLock(path.join(this.dir(id), CANDIDATES_FILE), async () => {
      const { records } = await this.readCandidates(id)
      const idx = records.findIndex((c) => c.id === candidateId)
      if (idx < 0) throw new CaseStoreError(`Candidate ${candidateId} not found in case ${id}`)
      const next: EntityCandidate = {
        ...(records[idx] as EntityCandidate),
        state,
        decidedAt: state === 'pending' ? null : (at ?? nowIso())
      }
      records[idx] = next
      await this.writeCandidates(id, records)
      return next
    })
  }

  /* ---------------- raw/ ---------------- */

  /**
   * Persist a tool's unparsed output. Called *before* `parse()` runs, and also for runs
   * that failed, timed out, or exited non-zero — the output of a failure is often the
   * most informative thing you have, and a parser that throws must not take the evidence
   * with it.
   *
   * Raw files are never deleted or overwritten.
   */
  async writeRaw(
    id: string,
    body: string,
    opts: { mediaType?: string; at?: number } = {}
  ): Promise<RawPayload> {
    const mediaType = opts.mediaType ?? 'text/plain'
    const rid = rawId(opts.at ?? Date.now())
    const ext = mediaType.includes('json') ? 'json' : mediaType.includes('html') ? 'html' : 'txt'
    const rel = `${RAW_DIR}/${rid}.${ext}`
    const abs = path.join(this.dir(id), RAW_DIR, `${rid}.${ext}`)
    const buf = Buffer.from(body, 'utf8')
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, buf, { flag: 'wx' })
    return {
      rawId: rid,
      path: rel,
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.byteLength,
      mediaType,
      excerpt: body.slice(0, RAW_EXCERPT_BYTES)
    }
  }

  async readRaw(id: string, payload: RawPayload): Promise<string> {
    return fsp.readFile(path.join(this.dir(id), payload.path), 'utf8')
  }

  /* ---------------- findings.jsonl ---------------- */

  async readFindings(id: string): Promise<JsonlReadResult<Finding>> {
    return parseJsonl<Finding>(await readTextOr(path.join(this.dir(id), FINDINGS_FILE), ''))
  }

  private async writeFindings(id: string, findings: readonly Finding[]): Promise<void> {
    await writeAtomic(path.join(this.dir(id), FINDINGS_FILE), serialiseJsonl(findings))
  }

  /**
   * Insert or refresh a finding.
   *
   * Identity is `(caseId, entityId, tool, source, claim)` — deliberately *not* including
   * the raw payload. Re-running a tool that says the same thing again updates
   * `lastVerified` and repoints `raw` at the newer capture; it does not create a second
   * row. Every capture stays on disk regardless.
   *
   * Confidence is never taken from the caller here. It is `unverified` on creation and
   * preserved on refresh; the only thing that changes it is `promoteFinding`.
   */
  async upsertFinding(id: string, input: AddFindingInput): Promise<{ finding: Finding; created: boolean }> {
    return withFileLock(path.join(this.dir(id), FINDINGS_FILE), async () => {
      const { records: findings } = await this.readFindings(id)
      const at = input.at ?? nowIso()
      const fid = makeFindingId(id, input.entityId, input.tool, input.source, input.claim)
      const idx = findings.findIndex((f) => f.id === fid)

      if (idx >= 0) {
        const prev = findings[idx] as Finding
        const next: Finding = {
          ...prev,
          raw: input.raw,
          evidenceRef: input.evidenceRef ?? prev.evidenceRef,
          // A re-run may classify the probe differently — the site list it came from
          // updates itself — so the newer reading wins, and the older one is still in the
          // raw capture it was derived from.
          matcher: input.matcher ?? prev.matcher ?? null,
          // Seeing the same claim again from the same source is a re-observation, not
          // corroboration. It moves the clock, never the confidence.
          lastVerified: at
        }
        findings[idx] = next
        await this.writeFindings(id, findings)
        return { finding: next, created: false }
      }

      const created: Finding = {
        id: fid,
        caseId: id,
        entityId: input.entityId,
        source: input.source,
        tool: input.tool,
        claim: input.claim,
        confidence: DEFAULT_CONFIDENCE,
        evidenceRef: input.evidenceRef ?? null,
        firstSeen: at,
        lastVerified: null,
        raw: input.raw,
        matcher: input.matcher ?? null
      }
      findings.push(created)
      await this.writeFindings(id, findings)
      return { finding: created, created: true }
    })
  }

  async getFinding(id: string, fid: string): Promise<Finding | null> {
    const { records } = await this.readFindings(id)
    return records.find((f) => f.id === fid) ?? null
  }

  /** Replace a finding in place. Used by `promoteFinding`; not part of the public API. */
  async replaceFinding(id: string, finding: Finding): Promise<void> {
    return withFileLock(path.join(this.dir(id), FINDINGS_FILE), async () => {
      const { records } = await this.readFindings(id)
      const idx = records.findIndex((f) => f.id === finding.id)
      if (idx < 0) throw new CaseStoreError(`Finding ${finding.id} not found in case ${id}`)
      records[idx] = finding
      await this.writeFindings(id, records)
    })
  }

  /* ---------------- confidence-log.jsonl ---------------- */

  async readConfidenceLog(id: string): Promise<JsonlReadResult<ConfidenceChange>> {
    return parseJsonl<ConfidenceChange>(await readTextOr(path.join(this.dir(id), CONFIDENCE_LOG_FILE), ''))
  }

  /** Append-only. This file is the answer to "why do I believe this?" and is never rewritten. */
  async appendConfidenceChange(id: string, change: ConfidenceChange): Promise<void> {
    const file = path.join(this.dir(id), CONFIDENCE_LOG_FILE)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, JSON.stringify(change) + '\n')
  }

  /* ---------------- evidence/ ---------------- */

  async readEvidence(id: string): Promise<JsonlReadResult<Evidence>> {
    return parseJsonl<Evidence>(await readTextOr(path.join(this.dir(id), EVIDENCE_INDEX), ''))
  }

  async addEvidence(
    id: string,
    input: {
      findingId: string
      type: EvidenceType
      body: Uint8Array | string
      ext: string
      sourceUrl?: string | null
      capturedAt?: IsoTimestamp
    }
  ): Promise<Evidence> {
    const eid = evidenceId()
    const rel = `${EVIDENCE_DIR}/${eid}.${input.ext.replace(/^\./, '')}`
    const abs = path.join(this.dir(id), rel)
    const buf = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, buf, { flag: 'wx' })

    const record: Evidence = {
      id: eid,
      findingId: input.findingId,
      type: input.type,
      path: rel,
      // Hashed at capture time so the artifact can later be shown to be unmodified.
      sha256: createHash('sha256').update(buf).digest('hex'),
      capturedAt: input.capturedAt ?? nowIso(),
      sourceUrl: input.sourceUrl ?? null
    }
    await fsp.appendFile(path.join(this.dir(id), EVIDENCE_INDEX), JSON.stringify(record) + '\n')
    return record
  }

  /** Re-hash a stored artifact and compare. `null` when the file is gone. */
  async verifyEvidence(id: string, record: Evidence): Promise<boolean | null> {
    try {
      const buf = await fsp.readFile(path.join(this.dir(id), record.path))
      return createHash('sha256').update(buf).digest('hex') === record.sha256
    } catch {
      return null
    }
  }

  /* ---------------- bulk read, for the indexer ---------------- */

  async readAll(id: string): Promise<{
    case: CaseFile
    entities: Entity[]
    candidates: EntityCandidate[]
    findings: Finding[]
    evidence: Evidence[]
    confidenceChanges: ConfidenceChange[]
    warnings: string[]
  }> {
    const c = await this.readCase(id)
    const entities = await this.readEntities(id)
    const cand = await this.readCandidates(id)
    const f = await this.readFindings(id)
    const e = await this.readEvidence(id)
    const cc = await this.readConfidenceLog(id)
    const warnings = [
      ...cand.badLines.map((b) => `${CANDIDATES_FILE}:${b.line} — ${b.reason}`),
      ...f.badLines.map((b) => `${FINDINGS_FILE}:${b.line} — ${b.reason}`),
      ...e.badLines.map((b) => `${EVIDENCE_INDEX}:${b.line} — ${b.reason}`),
      ...cc.badLines.map((b) => `${CONFIDENCE_LOG_FILE}:${b.line} — ${b.reason}`)
    ]
    return {
      case: c,
      entities,
      candidates: cand.records,
      findings: f.records,
      evidence: e.records,
      confidenceChanges: cc.records,
      warnings
    }
  }
}

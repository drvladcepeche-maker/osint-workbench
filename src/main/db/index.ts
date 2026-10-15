/**
 * The SQLite index.
 *
 * Read `schema.ts` first. The single most important function in this file is
 * `rebuildIndex()`: it wipes the database and reconstructs it purely from the case
 * folders. Everything else exists to keep the index in step with the files as they
 * change; the rebuild is what makes that safe to get wrong.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import {
  isPublishableBasis,
  type CandidateState,
  type CandidateView,
  type CaseFile,
  type ConfidenceChange,
  type Confidence,
  type Entity,
  type EntityCandidate,
  type EntityKind,
  type Evidence,
  type Finding,
  type IndexStats,
  type MatcherQuality
} from '../../shared/types'
import type { ProvenanceMechanism } from '../../shared/engine'
import { independenceKey, isDerivedSource } from '../../shared/confidence'
import { DROP_SQL, INDEX_SCHEMA_VERSION, SCHEMA_SQL } from './schema'
import type { CaseStore } from '../store/caseStore'

export function openDatabase(dbFile: string): Db {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
  // WAL: the orchestrator writes from the main process while the UI reads; WAL keeps
  // readers from blocking on a write. NORMAL synchronous is safe under WAL and the index
  // is rebuildable anyway, so durability here is not worth the fsyncs.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return db
}

export function getIndexVersion(db: Db): number {
  const row = db.pragma('user_version', { simple: true })
  return typeof row === 'number' ? row : 0
}

export function setIndexVersion(db: Db, v: number): void {
  db.pragma(`user_version = ${v}`)
}

/** Drop everything and recreate an empty schema. */
export function resetSchema(db: Db): void {
  db.exec(DROP_SQL)
  db.exec(SCHEMA_SQL)
  setIndexVersion(db, INDEX_SCHEMA_VERSION)
}

/* ------------------------------------------------------------------ *
 * Row <-> record mapping
 * ------------------------------------------------------------------ */

interface FindingRow {
  id: string
  case_id: string
  entity_id: string
  source: string
  source_key: string
  tool: string
  claim: string
  confidence: string
  matcher: string | null
  evidence_ref: string | null
  first_seen: string
  last_verified: string | null
  raw_id: string
  raw_path: string
  raw_sha256: string
  raw_bytes: number
  raw_media_type: string
  raw_excerpt: string
}

export function rowToFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    caseId: r.case_id,
    entityId: r.entity_id,
    source: r.source,
    tool: r.tool,
    claim: r.claim,
    confidence: r.confidence as Confidence,
    evidenceRef: r.evidence_ref,
    firstSeen: r.first_seen,
    lastVerified: r.last_verified,
    raw: {
      rawId: r.raw_id,
      path: r.raw_path,
      sha256: r.raw_sha256,
      bytes: r.raw_bytes,
      mediaType: r.raw_media_type,
      excerpt: r.raw_excerpt
    },
    // The key is omitted rather than set to null when there is nothing stored, so a
    // finding that never carried a matcher round-trips to exactly the object the file
    // holds. Adding `matcher: undefined` would make it a different object to every
    // deep-equality check in the suite for no gain.
    ...matcherFromRow(r.matcher)
  }
}

/**
 * Read the stored `MatcherQuality`.
 *
 * Unparseable JSON is dropped rather than thrown on: the index is derived and the case
 * file is the truth, so the worst case is a missing badge on one row until the next
 * rebuild — never a query that fails.
 */
function matcherFromRow(text: string | null): { matcher?: MatcherQuality } {
  if (typeof text !== 'string' || !text.trim()) return {}
  try {
    const parsed = JSON.parse(text) as MatcherQuality
    return parsed && typeof parsed === 'object' ? { matcher: parsed } : {}
  } catch {
    return {}
  }
}

interface EntityRow {
  id: string
  case_id: string
  kind: string
  value: string
  label: string
  created_at: string
  seed: number
  attrs: string
}

export function rowToEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    caseId: r.case_id,
    kind: r.kind,
    value: r.value,
    label: r.label,
    createdAt: r.created_at,
    seed: r.seed === 1,
    attrs: JSON.parse(r.attrs) as Record<string, unknown>
  } as unknown as Entity
}

/* ------------------------------------------------------------------ *
 * Writers
 * ------------------------------------------------------------------ */

export function upsertCaseRow(db: Db, c: CaseFile, dir: string): void {
  db.prepare(
    `INSERT INTO cases (id,name,basis,subject_consent,created_at,updated_at,notes,publishable,dir)
     VALUES (@id,@name,@basis,@subject_consent,@created_at,@updated_at,@notes,@publishable,@dir)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, basis=excluded.basis, subject_consent=excluded.subject_consent,
       updated_at=excluded.updated_at, notes=excluded.notes,
       publishable=excluded.publishable, dir=excluded.dir`
  ).run({
    id: c.id,
    name: c.name,
    basis: c.basis,
    subject_consent: c.subjectConsent ? 1 : 0,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    notes: c.notes,
    publishable: isPublishableBasis(c.basis) ? 1 : 0,
    dir
  })
}

export function upsertEntityRow(db: Db, e: Entity): void {
  db.prepare(
    `INSERT INTO entities (id,case_id,kind,value,label,created_at,seed,attrs)
     VALUES (@id,@case_id,@kind,@value,@label,@created_at,@seed,@attrs)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label, seed=excluded.seed, attrs=excluded.attrs`
  ).run({
    id: e.id,
    case_id: e.caseId,
    kind: e.kind,
    value: e.value,
    label: e.label,
    created_at: e.createdAt,
    seed: e.seed ? 1 : 0,
    attrs: JSON.stringify(e.attrs ?? {})
  })
}

/**
 * Drop an entity from the index.
 *
 * Findings pointing at it are deliberately left alone. There is no `ON DELETE CASCADE`
 * anywhere in this schema and this is the case that explains why: the files decide what
 * exists, `entities.json` no longer holds this row, and `findings.jsonl` still does. A
 * cascade here would make the index disagree with the files, and the next rebuild would
 * silently put the findings back.
 */
export function deleteEntityRow(db: Db, entityId: string): void {
  db.prepare(`DELETE FROM entities WHERE id = ?`).run(entityId)
}

/**
 * Write a candidate and its proposals.
 *
 * The proposals are replaced rather than merged: the file is the truth and holds the
 * whole list, so a partial merge could only ever produce a row the file disagrees with.
 */
export function upsertCandidateRow(db: Db, c: EntityCandidate): void {
  db.prepare(
    `INSERT INTO candidates (id,case_id,kind,value,label,attrs,state,first_proposed_at,decided_at)
     VALUES (@id,@case_id,@kind,@value,@label,@attrs,@state,@first_proposed_at,@decided_at)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label, attrs=excluded.attrs, state=excluded.state,
       decided_at=excluded.decided_at`
  ).run({
    id: c.id,
    case_id: c.caseId,
    kind: c.kind,
    value: c.value,
    label: c.label,
    attrs: JSON.stringify(c.attrs ?? {}),
    state: c.state,
    first_proposed_at: c.firstProposedAt,
    decided_at: c.decidedAt
  })
  db.prepare(`DELETE FROM candidate_proposals WHERE candidate_id = ?`).run(c.id)
  const insert = db.prepare(
    `INSERT INTO candidate_proposals (candidate_id,finding_id,tool,source,rationale,mechanism,at)
     VALUES (@candidate_id,@finding_id,@tool,@source,@rationale,@mechanism,@at)
     ON CONFLICT(candidate_id,finding_id) DO UPDATE SET
       tool=excluded.tool, source=excluded.source, rationale=excluded.rationale,
       mechanism=excluded.mechanism, at=excluded.at`
  )
  for (const p of c.proposals) {
    insert.run({
      candidate_id: c.id,
      finding_id: p.findingId,
      tool: p.tool,
      source: p.source,
      rationale: p.rationale,
      // The engine reads this to decide whether a lead may be followed without a human, so
      // an index that dropped it would silently downgrade every declared link to the
      // adapter's default route.
      mechanism: p.mechanism ?? null,
      at: p.at
    })
  }
}

export function upsertFindingRow(db: Db, f: Finding): void {
  db.prepare(
    `INSERT INTO findings
       (id,case_id,entity_id,source,source_key,tool,claim,confidence,matcher,evidence_ref,
        first_seen,last_verified,raw_id,raw_path,raw_sha256,raw_bytes,raw_media_type,raw_excerpt)
     VALUES
       (@id,@case_id,@entity_id,@source,@source_key,@tool,@claim,@confidence,@matcher,@evidence_ref,
        @first_seen,@last_verified,@raw_id,@raw_path,@raw_sha256,@raw_bytes,@raw_media_type,@raw_excerpt)
     ON CONFLICT(id) DO UPDATE SET
       confidence=excluded.confidence, matcher=excluded.matcher, evidence_ref=excluded.evidence_ref,
       last_verified=excluded.last_verified, raw_id=excluded.raw_id, raw_path=excluded.raw_path,
       raw_sha256=excluded.raw_sha256, raw_bytes=excluded.raw_bytes,
       raw_media_type=excluded.raw_media_type, raw_excerpt=excluded.raw_excerpt`
  ).run({
    id: f.id,
    case_id: f.caseId,
    entity_id: f.entityId,
    source: f.source,
    source_key: independenceKey(f.source),
    tool: f.tool,
    claim: f.claim,
    confidence: f.confidence,
    // Re-running after the classifier changed must move this column, which is why it is in
    // the DO UPDATE list above: the id is content-addressed over the claim and not over
    // this, so the row is the same row and the explanation on it is the newer one.
    matcher: f.matcher ? JSON.stringify(f.matcher) : null,
    evidence_ref: f.evidenceRef,
    first_seen: f.firstSeen,
    last_verified: f.lastVerified,
    raw_id: f.raw.rawId,
    raw_path: f.raw.path,
    raw_sha256: f.raw.sha256,
    raw_bytes: f.raw.bytes,
    raw_media_type: f.raw.mediaType,
    raw_excerpt: f.raw.excerpt
  })
}

export function upsertEvidenceRow(db: Db, caseId: string, e: Evidence): void {
  db.prepare(
    `INSERT INTO evidence (id,case_id,finding_id,type,path,sha256,captured_at,source_url)
     VALUES (@id,@case_id,@finding_id,@type,@path,@sha256,@captured_at,@source_url)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, path=excluded.path, sha256=excluded.sha256,
       captured_at=excluded.captured_at, source_url=excluded.source_url`
  ).run({
    id: e.id,
    case_id: caseId,
    finding_id: e.findingId,
    type: e.type,
    path: e.path,
    sha256: e.sha256,
    captured_at: e.capturedAt,
    source_url: e.sourceUrl
  })
}

export function upsertConfidenceChangeRow(db: Db, c: ConfidenceChange): void {
  db.prepare(
    `INSERT INTO confidence_changes
       (id,case_id,finding_id,from_confidence,to_confidence,actor,
        supporting_finding_ids,independent_sources,note,at)
     VALUES (@id,@case_id,@finding_id,@from,@to,@actor,@supporting,@sources,@note,@at)
     ON CONFLICT(id) DO NOTHING`
  ).run({
    id: c.id,
    case_id: c.caseId,
    finding_id: c.findingId,
    from: c.from,
    to: c.to,
    actor: c.actor,
    supporting: JSON.stringify(c.supportingFindingIds),
    sources: JSON.stringify(c.independentSources),
    note: c.note,
    at: c.at
  })
}

/* ------------------------------------------------------------------ *
 * Rebuild
 * ------------------------------------------------------------------ */

/**
 * Wipe the index and reconstruct it from the case folders.
 *
 * This is the proof that the database is disposable. It is called:
 *   - on startup when `PRAGMA user_version` does not match `INDEX_SCHEMA_VERSION`
 *   - from Settings, by hand
 *   - by the test suite, which builds an index, deletes the file, rebuilds, and asserts
 *     the two are identical
 *
 * A case folder that fails to load is recorded in `stats.skipped` and skipped. One
 * corrupt case must not take the other twelve down with it.
 */
export async function rebuildIndex(db: Db, store: CaseStore): Promise<IndexStats> {
  const started = Date.now()
  const stats: IndexStats = {
    cases: 0,
    entities: 0,
    findings: 0,
    evidence: 0,
    confidenceChanges: 0,
    candidates: 0,
    skipped: [],
    durationMs: 0,
    at: new Date().toISOString()
  }

  const ids = await store.listCaseIds()

  // Reading is async (fs promises) and better-sqlite3 is synchronous, so all the I/O
  // happens first and the whole write lands in one transaction. That also means a failed
  // rebuild leaves the previous index intact rather than a half-populated one.
  const loaded: {
    id: string
    data: Awaited<ReturnType<CaseStore['readAll']>>
  }[] = []

  for (const id of ids) {
    try {
      loaded.push({ id, data: await store.readAll(id) })
    } catch (err) {
      stats.skipped.push({ caseId: id, reason: (err as Error).message })
    }
  }

  db.transaction(() => {
    resetSchema(db)
    for (const { id, data } of loaded) {
      upsertCaseRow(db, data.case, store.dir(id))
      stats.cases++
      for (const e of data.entities) {
        upsertEntityRow(db, e)
        stats.entities++
      }
      for (const cand of data.candidates) {
        upsertCandidateRow(db, cand)
        stats.candidates++
      }
      for (const f of data.findings) {
        upsertFindingRow(db, f)
        stats.findings++
      }
      for (const ev of data.evidence) {
        upsertEvidenceRow(db, id, ev)
        stats.evidence++
      }
      for (const cc of data.confidenceChanges) {
        upsertConfidenceChangeRow(db, cc)
        stats.confidenceChanges++
      }
      for (const w of data.warnings) stats.skipped.push({ caseId: id, reason: w })
    }
    db.prepare(`INSERT INTO meta (key,value) VALUES ('lastRebuild', ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(stats.at)
  })()

  // FTS5 external-content tables can drift if rows were ever written with triggers
  // disabled. Rebuilding the index from the content table is cheap and makes the
  // guarantee unconditional.
  db.exec(`INSERT INTO findings_fts(findings_fts) VALUES('rebuild')`)

  stats.durationMs = Date.now() - started
  return stats
}

/** Open the index, rebuilding automatically if the schema version moved. */
export async function openIndex(dbFile: string, store: CaseStore): Promise<{ db: Db; rebuilt: IndexStats | null }> {
  const db = openDatabase(dbFile)
  if (getIndexVersion(db) !== INDEX_SCHEMA_VERSION) {
    const rebuilt = await rebuildIndex(db, store)
    return { db, rebuilt }
  }
  return { db, rebuilt: null }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export function listFindings(db: Db, caseId: string): Finding[] {
  return (
    db
      .prepare(`SELECT * FROM findings WHERE case_id = ? ORDER BY first_seen DESC, id`)
      .all(caseId) as FindingRow[]
  ).map(rowToFinding)
}

export function listEntities(db: Db, caseId: string): Entity[] {
  return (
    db
      .prepare(`SELECT * FROM entities WHERE case_id = ? ORDER BY seed DESC, kind, value`)
      .all(caseId) as EntityRow[]
  ).map(rowToEntity)
}

/**
 * Full-text search across a case's findings.
 *
 * The query is passed to FTS5 as a prefix query with the user's terms quoted, so pasted
 * text containing `-`, `:` or `"` cannot become FTS operators and blow up mid-typing.
 */
export function searchFindings(db: Db, caseId: string, query: string, limit = 200): Finding[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
  if (!terms.length) return listFindings(db, caseId).slice(0, limit)
  const match = terms.map((t) => `"${t}"*`).join(' ')
  return (
    db
      .prepare(
        `SELECT f.* FROM findings_fts
          JOIN findings f ON f.rowid = findings_fts.rowid
          WHERE findings_fts MATCH ? AND f.case_id = ?
          ORDER BY bm25(findings_fts) LIMIT ?`
      )
      .all(match, caseId, limit) as FindingRow[]
  ).map(rowToFinding)
}

/**
 * Findings that make the same claim about the same entity from a *different* source.
 * This is the query behind the "corroborate" button.
 */
export function findCorroborationCandidates(db: Db, finding: Finding): Finding[] {
  return (
    db
      .prepare(
        `SELECT * FROM findings
          WHERE entity_id = ? AND claim = ? AND id != ? AND source_key != ?
          ORDER BY first_seen`
      )
      .all(finding.entityId, finding.claim, finding.id, independenceKey(finding.source)) as FindingRow[]
  ).map(rowToFinding)
}

/** Ranking for "the strongest thing any proposing finding says". `refuted` is off the ladder. */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  refuted: 0,
  unverified: 1,
  corroborated: 2,
  confirmed: 3
}

interface CandidateRow {
  id: string
  case_id: string
  kind: string
  value: string
  label: string
  attrs: string
  state: string
  first_proposed_at: string
  decided_at: string | null
}

/**
 * Candidates with their evidence resolved.
 *
 * The confidence shown next to a candidate is read from the proposing findings **here**,
 * at read time, rather than stored on the candidate. Promoting a finding to `confirmed`
 * must change what the review queue says about everything that finding proposed, and a
 * denormalised copy would be wrong from the moment of the first promotion.
 */
export function listCandidates(
  db: Db,
  caseId: string,
  state: CandidateState | 'all' = 'pending'
): CandidateView[] {
  const rows = (
    state === 'all'
      ? db.prepare(`SELECT * FROM candidates WHERE case_id = ? ORDER BY first_proposed_at DESC, id`).all(caseId)
      : db
          .prepare(
            `SELECT * FROM candidates WHERE case_id = ? AND state = ? ORDER BY first_proposed_at DESC, id`
          )
          .all(caseId, state)
  ) as CandidateRow[]
  if (!rows.length) return []

  const proposalStmt = db.prepare(
    `SELECT p.finding_id, p.tool, p.source, p.rationale, p.mechanism, p.at,
            f.claim AS claim, f.confidence AS confidence, f.matcher AS matcher
       FROM candidate_proposals p
       LEFT JOIN findings f ON f.id = p.finding_id
      WHERE p.candidate_id = ?
      ORDER BY p.at, p.finding_id`
  )

  return rows.map((r) => {
    const proposals = proposalStmt.all(r.id) as {
      finding_id: string
      tool: string
      source: string
      rationale: string
      mechanism: string | null
      at: string
      claim: string | null
      confidence: string | null
      matcher: string | null
    }[]

    let best: Confidence = 'unverified'
    let bestRank = -1
    const sources = new Set<string>()
    const derived = new Set<string>()
    const claims: CandidateView['claims'] = []

    for (const p of proposals) {
      // Derived sources are named, never counted. `isDerivedSource` and `independenceKey`
      // are the same pair the engine and `promote()` use, so the queue, the brief and the
      // promotion dialog can no longer disagree about what two sources means.
      if (isDerivedSource(p.source)) derived.add(independenceKey(p.source))
      else sources.add(independenceKey(p.source))
      // A proposal whose finding is gone still counts as a proposal — the file said so —
      // but it cannot contribute a confidence it no longer has.
      const conf = (p.confidence as Confidence | null) ?? null
      if (conf && CONFIDENCE_RANK[conf] > bestRank) {
        bestRank = CONFIDENCE_RANK[conf]
        best = conf
      }
      claims.push({
        findingId: p.finding_id,
        claim: p.claim ?? p.rationale,
        confidence: conf ?? 'unverified',
        source: p.source,
        tool: p.tool,
        // Carried into the review queue so triage can see that a whole candidate rests on
        // probes that were never structurally capable of meaning anything. Without it the
        // queue sorts a Gitea API hit and a shared AJAX endpoint identically.
        ...matcherFromRow(p.matcher)
      })
    }

    return {
      id: r.id,
      caseId: r.case_id,
      kind: r.kind as EntityKind,
      value: r.value,
      label: r.label,
      attrs: JSON.parse(r.attrs) as Record<string, unknown>,
      proposals: proposals.map((p) => ({
        findingId: p.finding_id,
        tool: p.tool,
        source: p.source,
        rationale: p.rationale,
        ...(p.mechanism ? { mechanism: p.mechanism as ProvenanceMechanism } : {}),
        at: p.at
      })),
      state: r.state as CandidateState,
      firstProposedAt: r.first_proposed_at,
      decidedAt: r.decided_at,
      bestConfidence: best,
      independentSources: sources.size,
      derivedSources: [...derived].sort(),
      claims
    }
  })
}

/**
 * What is attached to one entity, for the confirmation shown before it is removed.
 *
 * `findings` is the number that would be orphaned; `evidence` is the captured artifacts
 * hanging off those findings. Both are read here rather than in the store because the
 * store would have to scan two JSONL files to answer, and this is one indexed query.
 */
export function entityAttachments(
  db: Db,
  caseId: string,
  entityId: string
): { findings: number; evidence: number } {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM findings WHERE case_id = @c AND entity_id = @e) AS findings,
         (SELECT COUNT(*) FROM evidence WHERE case_id = @c AND finding_id IN
            (SELECT id FROM findings WHERE case_id = @c AND entity_id = @e)) AS evidence`
    )
    .get({ c: caseId, e: entityId }) as { findings: number; evidence: number }
  return { findings: row.findings ?? 0, evidence: row.evidence ?? 0 }
}

export function caseCounts(db: Db, caseId: string): Record<string, number> {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM entities WHERE case_id = @c) AS entities,
         (SELECT COUNT(*) FROM findings WHERE case_id = @c) AS findings,
         (SELECT COUNT(*) FROM findings WHERE case_id = @c AND confidence = 'unverified') AS unverified,
         (SELECT COUNT(*) FROM findings WHERE case_id = @c AND confidence = 'corroborated') AS corroborated,
         (SELECT COUNT(*) FROM findings WHERE case_id = @c AND confidence = 'confirmed') AS confirmed,
         (SELECT COUNT(*) FROM findings WHERE case_id = @c AND confidence = 'refuted') AS refuted,
         (SELECT COUNT(*) FROM evidence WHERE case_id = @c) AS evidence,
         (SELECT COUNT(*) FROM candidates WHERE case_id = @c AND state = 'pending') AS candidates`
    )
    .get({ c: caseId }) as Record<string, number>
  return row
}

/**
 * The SQLite schema.
 *
 * Everything here is **derived**. `data/index.db` can be deleted at any moment and
 * rebuilt from `cases/` with no loss. That is a design constraint, not a nice property:
 * it means no feature is ever tempted to store something only in the database, and it
 * means a schema change is a rebuild rather than a migration.
 *
 * Consequences visible in the DDL:
 *  - no `AUTOINCREMENT` and no surrogate keys; ids come from the files
 *  - no `ON DELETE CASCADE` doing real work — deletion happens in the files
 *  - `PRAGMA user_version` records the index schema version, so a mismatch triggers an
 *    automatic rebuild instead of a broken query
 */

/**
 * Bump this whenever the DDL changes. A mismatch forces a rebuild on next open.
 *
 * 2 — added `candidates` and `candidate_proposals`: discovered entities awaiting a human
 *     decision. A schema change is a rebuild here, not a migration, which is the whole
 *     reason the files are the truth.
 * 3 — added `findings.matcher`: how much the probe behind a claim was structurally capable
 *     of meaning. Every existing case file already holds everything needed to fill it, so
 *     the upgrade is one rebuild on next open and no data is at risk in it.
 * 4 — no DDL change: `findings.source_key` is computed by `independenceKey()`, and that
 *     fold now goes all the way to the site operator (`api.github.com` -> `github.com`)
 *     instead of stripping `www.` alone. A denormalised column that carries a rule has to
 *     be recomputed when the rule changes, or "how many independent sources back this
 *     claim" answers with the old fold on old rows and the new one on new rows. The
 *     version is what forces that recomputation, so it is bumped for a value change and
 *     not only for a shape change.
 * 5 — shipped in the same commit as 4, and kept as its own entry because it is a separate
 *     reason rather than a separate release: a case on 3 rebuilds once and arrives here.
 *     Added `candidate_proposals.mechanism`: the route the adapter says it took to reach
 *     what it proposed. The engine decides whether a lead may be followed from it, and it
 *     used to be inferred by regex over the claim — text that includes verbatim page
 *     titles and snippets, so a fetched page could mint the strongest provenance in the
 *     system. Structural or not claimed at all; that means it has to survive the index.
 */
export const INDEX_SCHEMA_VERSION = 5

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS cases (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  basis         TEXT NOT NULL,
  subject_consent INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  notes         TEXT NOT NULL DEFAULT '',
  -- Denormalised from basis so an export query cannot forget the rule.
  publishable   INTEGER NOT NULL,
  dir           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seed       INTEGER NOT NULL,
  attrs      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_entities_case ON entities(case_id);
CREATE INDEX IF NOT EXISTS idx_entities_kind_value ON entities(kind, value);
CREATE INDEX IF NOT EXISTS idx_entities_seed ON entities(case_id, seed);

-- Discovered entities that are NOT in the graph yet.
--
-- Deliberately a separate table from entities rather than a flag on it: a query that
-- forgets the flag would silently treat unreviewed guesses as facts, and half the queries
-- in this app are about "what do we actually have". Separation makes forgetting
-- impossible instead of merely discouraged.
--
-- id is the id the entity WILL have if promoted (same content-addressing), which is what
-- makes "is this already in the graph?" a primary-key lookup.
CREATE TABLE IF NOT EXISTS candidates (
  id                TEXT PRIMARY KEY,
  case_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  value             TEXT NOT NULL,
  label             TEXT NOT NULL,
  attrs             TEXT NOT NULL DEFAULT '{}',
  state             TEXT NOT NULL,
  first_proposed_at TEXT NOT NULL,
  decided_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_case ON candidates(case_id, state);

CREATE TABLE IF NOT EXISTS candidate_proposals (
  candidate_id TEXT NOT NULL,
  finding_id   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  source       TEXT NOT NULL,
  rationale    TEXT NOT NULL DEFAULT '',
  -- The adapter's own statement of how it reached this. NULL means it did not say, and the
  -- hop then falls back to that adapter's documented default route.
  mechanism    TEXT,
  at           TEXT NOT NULL,
  PRIMARY KEY (candidate_id, finding_id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_proposals_finding ON candidate_proposals(finding_id);

CREATE TABLE IF NOT EXISTS findings (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  source         TEXT NOT NULL,
  -- Normalised source host: the corroboration independence key. Stored so
  -- "how many independent sources back this claim" is one GROUP BY, not a scan.
  source_key     TEXT NOT NULL,
  tool           TEXT NOT NULL,
  claim          TEXT NOT NULL,
  confidence     TEXT NOT NULL,
  -- MatcherQuality as JSON, or NULL when the claim did not come from probing a site.
  --
  -- One JSON column rather than four (strength/label/why/reasons) because the object is
  -- always written and read as a unit and nothing queries inside it: the reasons are a
  -- list, which would need a child table, and no query in this app asks "which findings
  -- had reason X". If a "show me every weak-matcher hit" view ever appears, the strength
  -- is a one-line generated column away and the rebuild that adds it costs nothing,
  -- because the files already hold the whole object.
  matcher        TEXT,
  evidence_ref   TEXT,
  first_seen     TEXT NOT NULL,
  last_verified  TEXT,
  raw_id         TEXT NOT NULL,
  raw_path       TEXT NOT NULL,
  raw_sha256     TEXT NOT NULL,
  raw_bytes      INTEGER NOT NULL,
  raw_media_type TEXT NOT NULL,
  raw_excerpt    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_findings_case ON findings(case_id);
CREATE INDEX IF NOT EXISTS idx_findings_entity ON findings(entity_id);
CREATE INDEX IF NOT EXISTS idx_findings_confidence ON findings(case_id, confidence);
CREATE INDEX IF NOT EXISTS idx_findings_tool ON findings(case_id, tool);
CREATE INDEX IF NOT EXISTS idx_findings_corroboration ON findings(entity_id, claim, source_key);

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  finding_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_url  TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_finding ON evidence(finding_id);
CREATE INDEX IF NOT EXISTS idx_evidence_case ON evidence(case_id);

CREATE TABLE IF NOT EXISTS confidence_changes (
  id                     TEXT PRIMARY KEY,
  case_id                TEXT NOT NULL,
  finding_id             TEXT NOT NULL,
  from_confidence        TEXT NOT NULL,
  to_confidence          TEXT NOT NULL,
  actor                  TEXT NOT NULL,
  supporting_finding_ids TEXT NOT NULL DEFAULT '[]',
  independent_sources    TEXT NOT NULL DEFAULT '[]',
  note                   TEXT NOT NULL DEFAULT '',
  at                     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cc_finding ON confidence_changes(finding_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Full-text search over findings.
--
-- External-content FTS5: the index stores only the tokens and points back at
-- findings.rowid, so the text is not duplicated. raw_excerpt is included so a search hits
-- text the parser did not turn into a claim -- which is exactly what you want when you
-- suspect the parser missed something.
--
-- 'unicode61 remove_diacritics 2' matters here: case material is often Bulgarian, and
-- without it "Варна" and "Варна" tokenise inconsistently across sources.
CREATE VIRTUAL TABLE IF NOT EXISTS findings_fts USING fts5(
  claim,
  source,
  tool,
  raw_excerpt,
  content='findings',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS findings_ai AFTER INSERT ON findings BEGIN
  INSERT INTO findings_fts(rowid, claim, source, tool, raw_excerpt)
  VALUES (new.rowid, new.claim, new.source, new.tool, new.raw_excerpt);
END;

CREATE TRIGGER IF NOT EXISTS findings_ad AFTER DELETE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, claim, source, tool, raw_excerpt)
  VALUES ('delete', old.rowid, old.claim, old.source, old.tool, old.raw_excerpt);
END;

CREATE TRIGGER IF NOT EXISTS findings_au AFTER UPDATE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, claim, source, tool, raw_excerpt)
  VALUES ('delete', old.rowid, old.claim, old.source, old.tool, old.raw_excerpt);
  INSERT INTO findings_fts(rowid, claim, source, tool, raw_excerpt)
  VALUES (new.rowid, new.claim, new.source, new.tool, new.raw_excerpt);
END;
`

/** Dropped in this order so the FTS triggers go before the table they reference. */
export const DROP_SQL = /* sql */ `
DROP TRIGGER IF EXISTS findings_ai;
DROP TRIGGER IF EXISTS findings_ad;
DROP TRIGGER IF EXISTS findings_au;
DROP TABLE IF EXISTS findings_fts;
DROP TABLE IF EXISTS confidence_changes;
DROP TABLE IF EXISTS evidence;
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS candidate_proposals;
DROP TABLE IF EXISTS candidates;
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS cases;
DROP TABLE IF EXISTS meta;
`

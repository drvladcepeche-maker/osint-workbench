/**
 * Snapshots: what one run of one level actually saw.
 *
 * A snapshot is written to `cases/<case-id>/selfaudit/<ulid>.json` — inside the level's
 * own case folder, not in the vault, so that copying a case folder carries its audit
 * history with it and deleting a case takes its snapshots too. `CaseStore` ignores files
 * it does not know about and `rebuildIndex()` never reads this directory, so nothing here
 * can corrupt the index.
 *
 * A snapshot is **derived and disposable** in the same sense the SQLite index is: every
 * field in it can be recomputed from the case files. It is written anyway, because the
 * re-scan diff needs a fixed point to compare against — "what did this level look like
 * before I sent the deletion requests" is not a question the current state can answer.
 *
 * Two things in here are load-bearing rather than convenient:
 *
 *  - `derived` splits `local:<adapter>` findings out of the counts. Those are the run's
 *    own telemetry ("120 of 122 sites refused"), and counting them alongside claims about
 *    the person would inflate every total in the app by roughly one per run.
 *  - `checks` is built for **every** adapter that could have been pointed at a seed,
 *    including the ones that were never run because the binary is missing. A tool that
 *    was not installed is a hole in the audit, and a hole that is invisible reads as
 *    ground that was covered.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { independenceKey } from '../../shared/confidence'
import { ulid } from '../../shared/ids'
import type { CandidateView, Entity, EntityKind, Finding, Job } from '../../shared/types'
import type {
  CheckOutcome,
  SeedAttribution,
  SelfAuditCheck,
  SelfAuditLevel,
  SelfAuditProfile,
  SelfAuditSnapshot,
  SnapshotAccount,
  SnapshotCounts,
  SnapshotFinding,
  SnapshotRef,
  SnapshotSeed
} from '../../shared/selfaudit'
import { isSilent, seedField } from '../../shared/selfaudit'
import { seedValuesUpTo } from './vault'
import { readCoverage } from './coverage'
import { excerptAround, fold, prepareText, seedHits } from './match'

export const SNAPSHOT_DIR = 'selfaudit'

/** How many raw-derived attributions one seed value may contribute per capture. */
const MAX_RAW_ATTRIBUTIONS = 4
/** Raw captures larger than this are matched on their first slice only. Maigret dumps run to tens of MB. */
const MAX_RAW_SCAN_BYTES = 512 * 1024

export function isDerivedSource(source: string): boolean {
  return source.trim().toLowerCase().startsWith('local:')
}

export function toSnapshotFinding(
  f: Finding,
  context?: { observed?: ReadonlySet<string>; liveEntityIds?: ReadonlySet<string> }
): SnapshotFinding {
  return {
    id: f.id,
    entityId: f.entityId,
    source: f.source,
    sourceKey: independenceKey(f.source),
    tool: f.tool,
    claim: f.claim,
    confidence: f.confidence,
    firstSeen: f.firstSeen,
    lastVerified: f.lastVerified,
    rawPath: f.raw?.path ?? '',
    derived: isDerivedSource(f.source),
    ...(context?.observed ? { observedThisRun: context.observed.has(f.id) } : {}),
    ...(context?.liveEntityIds ? { orphaned: !context.liveEntityIds.has(f.entityId) } : {})
  }
}

export interface SnapshotInput {
  level: SelfAuditLevel
  caseId: string
  caseDir: string
  seeds: SnapshotSeed[]
  entities: Entity[]
  candidates: CandidateView[]
  findings: Finding[]
  jobs: Job[]
  profile: SelfAuditProfile
  /** Adapter id -> display title, for the check rows. */
  adapterTitles: Map<string, string>
  /**
   * Adapter id -> the entity kinds it accepts, as the registry described them at run time.
   * Carried into each check so a later delta can tell a tool the seed unlocked from a
   * tool the operator had switched off below.
   */
  adapterAccepts?: Map<string, EntityKind[]>
  /** Adapters that could not be run, with the reason the registry gave. */
  unavailable: Map<string, string>
  /** Adapter/entity pairs that were planned but never got a job, and why. */
  skipped: { adapterId: string; entityId: string; reason: string }[]
  /**
   * The finding ids this run's jobs actually produced.
   *
   * Absent means the caller could not say, and every finding is then left unflagged —
   * which reads downstream as the old behaviour rather than as a claim that nothing was
   * observed. `SelfAudit.execute` always supplies it.
   */
  observedFindingIds?: ReadonlySet<string>
  readRaw(relativePath: string): Promise<string | null>
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

function accountsFrom(input: SnapshotInput): SnapshotAccount[] {
  const byKey = new Map<string, SnapshotAccount>()

  // Promoted accounts first: an entity outranks a candidate for the same key, because a
  // human decided about it.
  for (const e of input.entities) {
    if (e.kind !== 'account') continue
    const attrs = e.attrs as { platform?: string; handle?: string; url?: string }
    const backing = input.findings.filter((f) => f.entityId === e.id)
    byKey.set(e.value, {
      key: e.value,
      platform: attrs.platform ?? e.value.split('/')[0] ?? '',
      handle: attrs.handle ?? e.value.split('/').slice(1).join('/'),
      url: attrs.url ?? null,
      state: 'entity',
      confidence: strongest(backing.map((f) => f.confidence)),
      independentSources: new Set(backing.map((f) => independenceKey(f.source))).size,
      tools: [...new Set(backing.map((f) => f.tool))].sort(),
      findingIds: backing.map((f) => f.id)
    })
  }

  for (const c of input.candidates) {
    if (c.kind !== 'account' || byKey.has(c.value)) continue
    const attrs = c.attrs as { platform?: string; handle?: string; url?: string }
    byKey.set(c.value, {
      key: c.value,
      platform: attrs.platform ?? c.value.split('/')[0] ?? '',
      handle: attrs.handle ?? c.value.split('/').slice(1).join('/'),
      url: typeof attrs.url === 'string' ? attrs.url : null,
      state: 'candidate',
      confidence: c.bestConfidence,
      independentSources: c.independentSources,
      tools: [...new Set(c.claims.map((x) => x.tool))].sort(),
      findingIds: c.claims.map((x) => x.findingId)
    })
  }

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function strongest(levels: readonly string[]): SnapshotAccount['confidence'] {
  const order = ['refuted', 'unverified', 'corroborated', 'confirmed']
  let best = 'unverified'
  for (const l of levels) if (order.indexOf(l) > order.indexOf(best)) best = l
  return best as SnapshotAccount['confidence']
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

async function checksFrom(input: SnapshotInput): Promise<SelfAuditCheck[]> {
  const out: SelfAuditCheck[] = []
  const entityById = new Map(input.entities.map((e) => [e.id, e]))
  // One raw file per job, shared by all of that job's findings. Read once.
  const rawCache = new Map<string, string | null>()

  for (const job of input.jobs) {
    const jobFindings = input.findings.filter((f) => job.findingIds.includes(f.id))
    const claims = jobFindings.filter((f) => !isDerivedSource(f.source)).length

    let rawText: string | null = null
    const rawPath = jobFindings[0]?.raw?.path ?? (job.rawId ? await guessRawPath(input.caseDir, job.rawId) : null)
    if (rawPath) {
      if (!rawCache.has(rawPath)) rawCache.set(rawPath, await input.readRaw(rawPath))
      rawText = rawCache.get(rawPath) ?? null
    }

    const reading = readCoverage({
      adapterId: job.adapterId,
      rawText,
      jobState: job.state,
      jobError: job.error,
      claims,
      // The tool's own run note. Several adapters count what they could not resolve and
      // say so only here — Sherlock's per-site failures go to stdout and its "not checked"
      // tally lands in a `local:` claim, so a run where half the site list errored used to
      // classify as "answered — nothing there" on the strength of a clean stderr.
      telemetry: jobFindings
        .filter((f) => isDerivedSource(f.source))
        .map((f) => f.claim)
        .join('\n')
    })

    const entity = entityById.get(job.entityId)
    const accepts = input.adapterAccepts?.get(job.adapterId)
    out.push({
      adapterId: job.adapterId,
      adapterTitle: input.adapterTitles.get(job.adapterId) ?? job.adapterId,
      entityId: job.entityId,
      entityKind: entity?.kind ?? null,
      entityLabel: entity?.label ?? null,
      outcome: reading.outcome,
      detail: reading.detail,
      jobId: job.id,
      jobState: job.state,
      findingIds: jobFindings.map((f) => f.id),
      coverage: reading.coverage,
      ...(accepts ? { adapterAccepts: [...accepts] } : {})
    })
  }

  // Tools that were never asked. An uninstalled adapter is a hole in the audit; leaving
  // it off the list would let the hole read as covered ground.
  for (const [adapterId, reason] of input.unavailable) {
    const accepts = input.adapterAccepts?.get(adapterId)
    out.push({
      adapterId,
      adapterTitle: input.adapterTitles.get(adapterId) ?? adapterId,
      entityId: null,
      entityKind: null,
      entityLabel: null,
      outcome: 'unavailable' as CheckOutcome,
      detail: `${reason} Everything this tool would have covered is unchecked.`,
      jobId: null,
      jobState: null,
      findingIds: [],
      coverage: null,
      ...(accepts ? { adapterAccepts: [...accepts] } : {})
    })
  }
  for (const s of input.skipped) {
    const entity = entityById.get(s.entityId)
    const accepts = input.adapterAccepts?.get(s.adapterId)
    out.push({
      adapterId: s.adapterId,
      adapterTitle: input.adapterTitles.get(s.adapterId) ?? s.adapterId,
      entityId: s.entityId,
      entityKind: entity?.kind ?? null,
      entityLabel: entity?.label ?? null,
      outcome: 'skipped',
      detail: `${s.reason} Nothing it would have covered was checked.`,
      jobId: null,
      jobState: null,
      findingIds: [],
      coverage: null,
      ...(accepts ? { adapterAccepts: [...accepts] } : {})
    })
  }

  return out
}

async function guessRawPath(caseDir: string, rawId: string): Promise<string | null> {
  try {
    const names = await fsp.readdir(path.join(caseDir, 'raw'))
    const hit = names.find((n) => n.startsWith(`${rawId}.`))
    return hit ? `raw/${hit}` : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Attribution
 * ------------------------------------------------------------------ */

/**
 * Which findings a seed value shows up inside.
 *
 * This is what a real name, a city or a school buys: not a new tool, but the ability to
 * say which of the accounts already found belongs to you. See `match.ts` for why the
 * matching is as conservative as it is.
 *
 * Two searches, deliberately different in weight:
 *
 *  - the **claim**, which is precise and belongs to exactly one finding;
 *  - the **raw capture**, which catches things the parser never turned into a claim —
 *    a scraped bio, a profile location field, an employer string. Those are attributed to
 *    the run rather than to a specific claim, and the excerpt is shown so the operator can
 *    see the sentence rather than take the match on trust.
 */
async function attributionsFrom(input: SnapshotInput): Promise<SeedAttribution[]> {
  const values = seedValuesUpTo(input.profile, input.level)
  if (!values.length) return []

  const seedEntityByValue = new Map(input.seeds.map((s) => [fold(s.value), s.entityId]))
  const out: SeedAttribution[] = []
  const seen = new Set<string>()

  for (const f of input.findings) {
    if (isDerivedSource(f.source)) continue
    const claim = prepareText(f.claim)
    for (const v of values) {
      const needle = fold(v.value)
      // A claim about the very thing the operator typed contains it trivially: holehe
      // pointed at an address says the address back. That is not attribution.
      if (seedEntityByValue.get(needle) === f.entityId) continue
      const hit = seedHits(seedField(v.field).kind, v.value, claim, 1)[0]
      if (!hit) continue
      const key = `${f.id}:${v.field}:${needle}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        findingId: f.id,
        field: v.field,
        seedValue: v.value,
        level: v.level,
        where: 'claim',
        excerpt: excerptAround(f.claim, hit.at, hit.length),
        sourceKey: independenceKey(f.source),
        tool: f.tool,
        rule: hit.rule,
        strength: hit.strength,
        why: hit.why
      })
    }
  }

  // The raw sweep. One pass per capture, anchored to the first finding that capture
  // produced, so the operator has something to click through to.
  const byRaw = new Map<string, Finding[]>()
  for (const f of input.findings) {
    if (!f.raw?.path) continue
    const list = byRaw.get(f.raw.path)
    if (list) list.push(f)
    else byRaw.set(f.raw.path, [f])
  }

  for (const [rawPath, group] of byRaw) {
    const anchor = group.find((f) => !isDerivedSource(f.source)) ?? group[0]
    if (!anchor) continue
    const text = await input.readRaw(rawPath)
    if (!text) continue
    const slice = text.length > MAX_RAW_SCAN_BYTES ? text.slice(0, MAX_RAW_SCAN_BYTES) : text
    // Tokenised once and reused by every seed. Half a megabyte per capture makes this the
    // difference between a snapshot costing a moment and costing a minute.
    const prepared = prepareText(slice)

    for (const v of values) {
      const needle = fold(v.value)
      // The value the run was pointed at is in its own command line. Not attribution.
      if (seedEntityByValue.get(needle) === anchor.entityId) continue
      for (const hit of seedHits(seedField(v.field).kind, v.value, prepared, MAX_RAW_ATTRIBUTIONS)) {
        const key = `${anchor.id}:${v.field}:${needle}:${hit.at}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          findingId: anchor.id,
          field: v.field,
          seedValue: v.value,
          level: v.level,
          where: 'raw',
          excerpt: excerptAround(slice, hit.at, hit.length),
          // Deliberately empty. One capture covers every site the tool touched, and the
          // anchoring finding is just the first one that run produced — putting its
          // hostname here would credit a site with a sentence it never said.
          sourceKey: '',
          tool: anchor.tool,
          rule: hit.rule,
          strength: hit.strength,
          why: hit.why
        })
      }
    }
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Build and persist
 * ------------------------------------------------------------------ */

export async function buildSnapshot(input: SnapshotInput): Promise<SelfAuditSnapshot> {
  const liveEntityIds = new Set(input.entities.map((e) => e.id))
  const findings = input.findings.map((f) =>
    toSnapshotFinding(f, {
      ...(input.observedFindingIds ? { observed: input.observedFindingIds } : {}),
      liveEntityIds
    })
  )
  const checks = await checksFrom(input)
  const accounts = accountsFrom(input)
  const attributions = await attributionsFrom(input)

  // Orphans are claims whose seed the operator purged out of the case. The observation
  // happened and its capture is permanent, but nothing left in this snapshot names the
  // seed that caused it, so counting it as current exposure would state a number with no
  // visible cause. Its own section, out of every total.
  const live = findings.filter((f) => !f.derived && !f.orphaned)
  const counts: SnapshotCounts = {
    claims: live.length,
    observedClaims: live.filter((f) => f.observedThisRun !== false).length,
    orphanedClaims: findings.filter((f) => !f.derived && f.orphaned).length,
    telemetry: findings.filter((f) => f.derived).length,
    accounts: accounts.length,
    sources: new Set(live.map((f) => f.sourceKey).filter(Boolean)).size,
    silentChecks: checks.filter((c) => isSilent(c.outcome)).length
  }

  return {
    id: `sas_${ulid()}`,
    level: input.level,
    caseId: input.caseId,
    at: new Date().toISOString(),
    seeds: input.seeds,
    checks,
    findings,
    accounts,
    attributions,
    counts
  }
}

export function snapshotRef(s: SelfAuditSnapshot): SnapshotRef {
  return { id: s.id, level: s.level, caseId: s.caseId, at: s.at, counts: s.counts }
}

export async function writeSnapshot(caseDir: string, snapshot: SelfAuditSnapshot): Promise<string> {
  const dir = path.join(caseDir, SNAPSHOT_DIR)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${snapshot.id}.json`)
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, file)
  return file
}

/** Newest first. A corrupt snapshot costs that snapshot and nothing else. */
export async function listSnapshots(caseDir: string): Promise<SelfAuditSnapshot[]> {
  const dir = path.join(caseDir, SNAPSHOT_DIR)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const out: SelfAuditSnapshot[] = []
  for (const name of names.sort().reverse()) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as SelfAuditSnapshot
      if (parsed && typeof parsed.id === 'string') out.push(parsed)
    } catch {
      /* one unreadable snapshot must not hide the others */
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Match materialised seeds back to the entities they became.
 *
 * The caller supplies each seed's own entry level, because a field's level is no longer
 * the answer for every value in it: `usernames` puts its first value at L0 and the rest at
 * L1, and a snapshot that recorded them all as L0 would let the delta credit L1's gain to
 * a seed L0 already had.
 */
export function seedsFromEntities(
  entities: readonly Entity[],
  materialised: readonly {
    field: SnapshotSeed['field']
    value: string
    kind: string
    level: SelfAuditLevel
  }[]
): SnapshotSeed[] {
  const out: SnapshotSeed[] = []
  for (const m of materialised) {
    const entity = entities.find((e) => e.kind === m.kind && e.label === m.value) ??
      entities.find((e) => e.kind === m.kind && e.value === m.value.toLowerCase())
    if (!entity) continue
    out.push({
      entityId: entity.id,
      kind: entity.kind,
      value: entity.value,
      label: entity.label,
      field: m.field,
      level: m.level
    })
  }
  return out
}

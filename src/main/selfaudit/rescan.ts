/**
 * Re-scan: did anything change, and did the removal request actually work?
 *
 * The question this answers is the one nobody else answers honestly. A privacy tool tells
 * you it sent a deletion request. It does not go back three weeks later and check, and
 * when it does check, it reports "not found" without saying whether it looked.
 *
 * So the diff has three buckets rather than two:
 *
 *  - **appeared** — present now, absent before.
 *  - **disappeared, explained** — absent now, and the tool that used to report it was
 *    refused this time. This is the common case and it is *not* evidence of removal.
 *  - **disappeared, unexplained** — absent now, and the tool that used to report it
 *    answered normally this time. This is the only bucket that supports "it worked", and
 *    even then it supports it weakly: these tools have a large false-negative rate on
 *    their own.
 *
 * Findings are matched across runs with `diffKey` from `delta.ts` rather than on
 * `Finding.id`. Two reasons, and the second was found by running this against real output:
 * an id is content-addressed over the case as well, and Sherlock used to write its own
 * response time into every claim — so a key over the raw claim reported all eighty-nine
 * rows as removed and re-added on every single re-run, which is precisely the number this
 * page exists to get right. One key function serves both views, so a change in one place
 * cannot make them disagree.
 *
 * ## What a snapshot's findings actually are, and why the middle bucket used to be empty
 *
 * A level reuses one case folder across every run and `upsertFinding` only inserts or
 * refreshes — nothing ever removes a row from `findings.jsonl`. So a snapshot built from
 * the whole file is the level's *history*, not its present, and `current ⊇ previous` holds
 * by construction: `disappeared` was **structurally always empty**, and an operator who
 * deleted his Instagram and waited three weeks was told "nothing changed; if a removal
 * request is outstanding, it has not taken effect."
 *
 * So the comparison is over what each run **re-observed**, which the run itself reports:
 * every job hands back the finding ids it produced and the snapshot marks them
 * (`SnapshotFinding.observedThisRun`). A claim in the previous run's observed set and
 * absent from this one's has genuinely stopped being reported — and then, and only then,
 * the three buckets decide whether that is a removal or a refusal.
 *
 * A snapshot written before that flag existed carries no observation record at all. Those
 * are read as fully observed, which reproduces the old behaviour exactly: it is the one
 * reading the file supports, and inventing an observed set for it would put a claim about
 * a removal on top of data that cannot carry one.
 */

import type { RescanDiff, SelfAuditCheck, SelfAuditSnapshot, SnapshotFinding } from '../../shared/selfaudit'
import { isSilent } from '../../shared/selfaudit'
import { diffKey as key } from './delta'

/** Was this tool able to speak in this run? Keyed per adapter, and per source where known. */
function silenceReason(checks: readonly SelfAuditCheck[], tool: string): string | null {
  const relevant = checks.filter((c) => c.adapterId === tool)
  if (!relevant.length) {
    return 'that tool did not run at all this time, so nothing it used to report could have been re-observed'
  }
  const silent = relevant.find((c) => isSilent(c.outcome))
  if (silent) return silent.detail
  const partial = relevant.find((c) => c.outcome === 'partial')
  if (partial) return `the tool only partly got through: ${partial.detail}`
  return null
}

/**
 * The claims a run actually re-observed.
 *
 * `observedThisRun === false` is the only value that excludes a finding. `undefined` means
 * the snapshot predates the flag and says nothing either way, and the honest reading of a
 * file that says nothing is the one it used to get. Orphans — claims whose seed the
 * operator purged out of the case — are excluded from both sides, because a claim with no
 * cause left in the snapshot cannot appear or disappear in any meaningful sense.
 */
function observedClaims(snapshot: SelfAuditSnapshot): SnapshotFinding[] {
  return snapshot.findings.filter((f) => !f.derived && !f.orphaned && f.observedThisRun !== false)
}

export function computeRescan(current: SelfAuditSnapshot, previous: SelfAuditSnapshot): RescanDiff {
  const curClaims = observedClaims(current)
  const prevClaims = observedClaims(previous)

  const curKeys = new Map(curClaims.map((f) => [key(f), f]))
  const prevKeys = new Map(prevClaims.map((f) => [key(f), f]))

  const appeared = curClaims.filter((f) => !prevKeys.has(key(f)))
  const disappeared = prevClaims.filter((f) => !curKeys.has(key(f)))
  const stillThere = curClaims.length - appeared.length

  const explainedBySilence: { finding: SnapshotFinding; because: string }[] = []
  const unexplained: SnapshotFinding[] = []
  for (const f of disappeared) {
    const because = silenceReason(current.checks, f.tool)
    if (because) explainedBySilence.push({ finding: f, because })
    else unexplained.push(f)
  }

  return {
    level: current.level,
    caseId: current.caseId,
    previous: {
      id: previous.id,
      level: previous.level,
      caseId: previous.caseId,
      at: previous.at,
      counts: previous.counts
    },
    current: { id: current.id, level: current.level, caseId: current.caseId, at: current.at, counts: current.counts },
    appeared,
    disappeared,
    stillThere,
    unexplained,
    explainedBySilence,
    verdict: writeVerdict({ appeared, disappeared, unexplained, explainedBySilence, stillThere, current, previous })
  }
}

function writeVerdict(x: {
  appeared: SnapshotFinding[]
  disappeared: SnapshotFinding[]
  unexplained: SnapshotFinding[]
  explainedBySilence: { finding: SnapshotFinding; because: string }[]
  stillThere: number
  current: SelfAuditSnapshot
  previous: SelfAuditSnapshot
}): string {
  const gap = daysBetween(x.previous.at, x.current.at)
  const when = gap === 0 ? 'since the run earlier today' : `over ${gap} day${gap === 1 ? '' : 's'}`

  if (!x.appeared.length && !x.disappeared.length) {
    return `Nothing changed ${when}: the same ${x.stillThere} claims, from the same sources. If a removal request is outstanding, it has not taken effect where these tools can see it.`
  }

  const parts: string[] = []
  if (x.unexplained.length) {
    parts.push(
      `${x.unexplained.length} claim${x.unexplained.length === 1 ? '' : 's'} disappeared while the tool that used to report ` +
        `${x.unexplained.length === 1 ? 'it' : 'them'} answered normally. That is the only kind of disappearance that supports "it worked", ` +
        `and it still supports it weakly — these tools miss things they found the day before.`
    )
  }
  if (x.explainedBySilence.length) {
    parts.push(
      `${x.explainedBySilence.length} disappeared because the tool was refused this time, not because anything was removed. ` +
        `Read those as unchecked.`
    )
  }
  if (x.appeared.length) {
    parts.push(
      `${x.appeared.length} claim${x.appeared.length === 1 ? '' : 's'} appeared that ${x.appeared.length === 1 ? 'was' : 'were'} not there before.`
    )
  }
  parts.push(`${x.stillThere} unchanged.`)
  return `${capitalise(when)}: ${parts.join(' ')}`
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a)
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.round(ms / 86_400_000))
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

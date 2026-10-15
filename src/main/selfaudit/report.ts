/**
 * The exposure report, and the ranked list of what to do about it.
 *
 * PRODUCT.md is binding here and it rules out most of what a security product would
 * normally put on this page: no threat score, no red numeral, no "EXPOSED", no siren, no
 * progress bar towards being safe. *"The data should alarm him; the chrome should not."*
 *
 * So the ranking is built from one honest quantity — **reach**, the number of distinct
 * things an action disconnects — and that number is shown as the fact it is ("breaks the
 * link between six accounts") rather than converted into a severity. An action that
 * touches six accounts sits above one that touches one because it does more, not because
 * it is scarier.
 *
 * The other ordering rule is that **what could not be checked comes first on the page**,
 * before any finding. A report that leads with what it found and buries what it could not
 * ask is a report that reads as complete, and a self-audit that reads as complete when it
 * is not is worse than none — it converts ignorance into confidence.
 */

import { independenceKey } from '../../shared/confidence'
import type {
  Appearance,
  ExposureReport,
  RemediationItem,
  ResetPathMap,
  SelfAuditSnapshot,
  SnapshotAccount,
  SnapshotFinding
} from '../../shared/selfaudit'
import { isSilent } from '../../shared/selfaudit'
import { findContact } from './gdpr'
import { fold } from './match'

const EFFORT_ORDER: Record<RemediationItem['effort'], number> = {
  minutes: 0,
  'an evening': 1,
  'weeks of waiting': 2
}

export function buildReport(snapshot: SelfAuditSnapshot, resetPaths: ResetPathMap): ExposureReport {
  // Orphans are claims produced by a seed the operator later purged out of this case.
  // `deleteEntity` orphans rather than deletes, and `snapshot` reads every finding
  // unconditionally, so those claims used to keep counting, keep appearing under "Where
  // you appear", and keep driving remediation reach — while nothing in the snapshot still
  // named the seed that caused them. They get their own section instead.
  const claims = snapshot.findings.filter((f) => !f.derived && !f.orphaned)
  const orphaned = snapshot.findings.filter((f) => !f.derived && f.orphaned)
  const telemetry = snapshot.findings.filter((f) => f.derived)

  return {
    caseId: snapshot.caseId,
    level: snapshot.level,
    at: snapshot.at,
    snapshotId: snapshot.id,
    appearances: buildAppearances(snapshot, claims),
    unchecked: snapshot.checks.filter((c) => isSilent(c.outcome) || c.outcome === 'partial'),
    telemetry,
    orphaned,
    remediation: rank(buildRemediation(snapshot, resetPaths, claims)),
    resetPaths
  }
}

/* ------------------------------------------------------------------ *
 * Where you appear
 * ------------------------------------------------------------------ */

function buildAppearances(snapshot: SelfAuditSnapshot, claims: readonly SnapshotFinding[]): Appearance[] {
  const bySource = new Map<string, SnapshotFinding[]>()
  for (const f of claims) {
    if (!f.sourceKey) continue
    const list = bySource.get(f.sourceKey)
    if (list) list.push(f)
    else bySource.set(f.sourceKey, [f])
  }

  const attributedSources = new Set(snapshot.attributions.map((a) => a.sourceKey).filter(Boolean))
  const rank = ['refuted', 'unverified', 'corroborated', 'confirmed']

  const out: Appearance[] = []
  for (const [sourceKey, findings] of bySource) {
    const accounts = snapshot.accounts.filter(
      (a) => independenceKey(a.platform) === sourceKey || a.platform === sourceKey
    )
    let best = 'unverified'
    for (const f of findings) if (rank.indexOf(f.confidence) > rank.indexOf(best)) best = f.confidence
    out.push({
      sourceKey,
      platform: accounts[0]?.platform ?? sourceKey,
      handles: [...new Set(accounts.map((a) => a.handle).filter(Boolean))].sort(),
      urls: [...new Set(accounts.map((a) => a.url).filter((u): u is string => !!u))].sort(),
      confidence: best as Appearance['confidence'],
      tools: [...new Set(findings.map((f) => f.tool))].sort(),
      findingIds: findings.map((f) => f.id),
      attributed: attributedSources.has(sourceKey)
    })
  }

  // Attributed first — those are the ones that are demonstrably about him rather than
  // about anyone holding the same handle — then by how many tools agree, then by name.
  return out.sort(
    (a, b) =>
      Number(b.attributed) - Number(a.attributed) ||
      b.tools.length - a.tools.length ||
      a.sourceKey.localeCompare(b.sourceKey)
  )
}

/* ------------------------------------------------------------------ *
 * Remediation
 * ------------------------------------------------------------------ */

/**
 * Is this account something the report may state as a fact?
 *
 * A promoted entity means a human looked and decided. Two independent sources means two
 * different tools reading two different origins agreed. Anything else is one tool hit —
 * and a Sherlock sweep over a common handle returns tens of anti-bot pages that answer
 * 200, every one of which looks exactly like a real account in the row. Those are real
 * leads and they stay on the page; what they may not do is be counted as fact, or order
 * the list of things the operator should go and do.
 */
function isVerified(account: SnapshotAccount): boolean {
  return account.state === 'entity' || account.independentSources >= 2
}

function buildRemediation(
  snapshot: SelfAuditSnapshot,
  resetPaths: ResetPathMap,
  claims: readonly SnapshotFinding[]
): RemediationItem[] {
  const out: RemediationItem[] = []

  /* 1. Recovery hubs. One address or number that reaches several accounts is the highest
        leverage thing on the page: changing it once disconnects all of them, and it is
        also the route an attacker takes, in the same direction, for the same reason. */
  for (const hub of resetPaths.hubs) {
    if (hub.platforms.length < 2) continue
    out.push({
      id: `hub:${hub.kind}:${hub.value}`,
      kind: 'recovery-hub',
      action:
        hub.kind === 'email'
          ? `Move ${hub.platforms.length} accounts off ${hub.value} as their recovery address, or put a separate address on the ones that matter.`
          : `Take ${hub.value} off the recovery settings of ${hub.platforms.length} accounts, or move the ones that matter to an authenticator app.`,
      effect: `Whoever holds ${hub.value} can currently start a reset on ${hub.platforms.join(', ')}. Splitting it means one compromise reaches one account instead of ${hub.platforms.length}.`,
      reach: hub.platforms.length,
      // Every hub edge is something a site itself said through its own recovery flow, so
      // there is no unverified remainder to separate out here.
      unverifiedReach: 0,
      effort: 'an evening',
      targets: hub.platforms,
      evidence: resetPaths.edges
        .filter((e) => e.fromValue.toLowerCase() === hub.value.toLowerCase())
        .flatMap((e) => e.evidenceFindingIds),
      confidence: 'unverified',
      caveat: hub.inferred
        ? `${hub.inferred} of these ${hub.platforms.length} links come from a masked hint being consistent with this value, not from the site naming it. Check those before acting.`
        : null
    })
  }

  /* 2. Handle reuse. The mechanism DECISIONS.md names as the thing the whole self-audit
        exists to demonstrate: one handle on several platforms is the edge that joins a
        gaming identity to a professional one. */
  const byHandle = new Map<string, SnapshotAccount[]>()
  for (const a of snapshot.accounts) {
    if (!a.handle) continue
    const key = fold(a.handle)
    const list = byHandle.get(key)
    if (list) list.push(a)
    else byHandle.set(key, [a])
  }
  for (const [, accounts] of byHandle) {
    const platforms = [...new Set(accounts.map((a) => a.platform).filter(Boolean))]
    if (platforms.length < 2) continue
    const handle = accounts[0]?.handle ?? ''
    const attributed = snapshot.attributions.filter((att) => platforms.some((p) => att.sourceKey === p))

    /* Reach counts only what survives scrutiny.
     *
     * `snapshot.accounts` is mostly `state: 'candidate'`, `confidence: 'unverified'`,
     * `independentSources: 1` — a single tool hit. Counting those into "N sites use it",
     * writing that N into the imperative, and then making it the sole ordering key means
     * a Sherlock sweep over a common handle can put its own anti-bot noise at the top of
     * the page. The caveat underneath was already honest about it; the number was not.
     * So the number is the verified one, and the remainder is reported beside it as
     * exactly what it is. */
    const verified = [...new Set(accounts.filter(isVerified).map((a) => a.platform).filter(Boolean))]
    const unverified = platforms.filter((p) => !verified.includes(p))
    // The action names a count and three examples. A run against a common handle turns up
    // eighty-nine sites, and an imperative sentence with eighty-nine hostnames in it is
    // not an instruction anybody reads — the full list is in `targets`, where the UI can
    // truncate it and the operator can expand it.
    const named = (verified.length ? verified : platforms).slice(0, 3).join(', ')
    const counted = verified.length
      ? `${verified.length} site${verified.length === 1 ? '' : 's'} are confirmed to use it, including ${named}` +
        (unverified.length ? `, and ${unverified.length} more turned up on a single tool hit nobody has checked` : '')
      : `No site is confirmed to use it yet: all ${unverified.length} hits — ${named} among them — rest on one tool and nobody's judgement`
    out.push({
      id: `handle:${fold(handle)}`,
      kind: 'handle-reuse',
      action: `Retire the handle ${handle} on the accounts you want kept separate. ${counted}.`,
      effect:
        `Anyone who finds one of these finds the rest by typing the same string into a username sweep. ` +
        (attributed.length
          ? `One of them also carries a fact you seeded, so the chain ends at a person rather than at another pseudonym.`
          : `They are currently one search apart.`),
      reach: verified.length,
      unverifiedReach: unverified.length,
      effort: 'an evening',
      targets: verified.length ? [...verified, ...unverified] : platforms,
      evidence: accounts.flatMap((a) => a.findingIds),
      confidence: strongestOf(accounts),
      caveat:
        'Username hits are the single most false-positive-prone thing this app produces — an anti-bot page answering 200 reads as "account exists". Open each one before you act on it.'
    })
  }

  /* 3. Individual accounts, ranked below the structural items because deleting one
        account disconnects one thing. Only offered where a real erasure path is known. */
  for (const account of snapshot.accounts) {
    if (!account.platform) continue
    const contact = findContact(account.platform)
    if (!contact) continue
    if (byHandleReach(byHandle, account) > 1) continue // already covered by the handle item
    out.push({
      id: `account:${account.key}`,
      kind: 'account',
      action: `Delete or lock the ${account.platform} account ${account.handle ? `(${account.handle})` : ''}`.trim(),
      effect: `Removes one of the ${snapshot.accounts.length} accounts this level found. ${contact.name} has a published erasure route, so this is a request you can actually send.`,
      // One account, and it only counts as a thing to do at all once something backs it.
      // An unverified candidate is a lead to open, not an erasure request to send.
      reach: isVerified(account) ? 1 : 0,
      unverifiedReach: isVerified(account) ? 0 : 1,
      effort: 'minutes',
      targets: [account.platform],
      evidence: account.findingIds,
      confidence: account.confidence,
      caveat:
        account.state === 'candidate'
          ? 'This is still a candidate — no human has confirmed the account exists. Open it before you write to anyone about it.'
          : null
    })
  }

  /* 4. The archive. Deleting the live page does not delete the capture, and saying so is
        more useful than a recommendation that quietly fails. */
  const archived = claims.filter((f) => f.tool === 'wayback')
  if (archived.length) {
    out.push({
      id: 'archive',
      kind: 'archive',
      action: 'Decide what to do about the archived copies before you delete the live pages.',
      effect: `The Internet Archive holds ${archived.length} capture${archived.length === 1 ? '' : 's'} of pages connected to these seeds. Deleting the original does not remove the capture; exclusion is a request to archive.org and is neither quick nor guaranteed.`,
      reach: archived.length,
      // The Internet Archive holding a capture is not a candidate account; the capture
      // either exists or it does not, and wayback answered about it directly.
      unverifiedReach: 0,
      effort: 'weeks of waiting',
      targets: [...new Set(archived.map((f) => f.sourceKey))],
      evidence: archived.map((f) => f.id),
      confidence: 'unverified',
      caveat: 'Deleting the live page first can make the archived copy the only version left in circulation.'
    })
  }

  /* 5. What was never checked. This does not reduce exposure and does not pretend to —
        it reduces the part of the report that is guesswork, which is the prerequisite for
        every item above it being worth acting on. */
  const silent = snapshot.checks.filter((c) => isSilent(c.outcome))
  if (silent.length) {
    const tools = [...new Set(silent.map((c) => c.adapterTitle))]
    out.push({
      id: 'unchecked',
      kind: 'unchecked',
      action: `Re-run ${tools.length === 1 ? tools[0] : `${tools.length} tools`} from a different network before trusting the shape of this report.`,
      effect: `This does not reduce exposure. ${silent.length} of ${snapshot.checks.length} checks produced no answer at all, so the report below is a floor, not a total — and a floor built mostly from refusals is close to meaningless.`,
      reach: silent.length,
      // A silent check is a counted fact about the run, not a proposal about the world.
      unverifiedReach: 0,
      effort: 'minutes',
      targets: tools,
      evidence: [],
      confidence: 'unverified',
      caveat: null
    })
  }

  return out
}

function byHandleReach(byHandle: Map<string, SnapshotAccount[]>, account: SnapshotAccount): number {
  const group = byHandle.get(fold(account.handle)) ?? []
  return new Set(group.map((a) => a.platform).filter(Boolean)).size
}

function strongestOf(accounts: readonly SnapshotAccount[]): SnapshotAccount['confidence'] {
  const order = ['refuted', 'unverified', 'corroborated', 'confirmed']
  let best = 'unverified'
  for (const a of accounts) if (order.indexOf(a.confidence) > order.indexOf(best)) best = a.confidence
  return best as SnapshotAccount['confidence']
}

/**
 * Reach descending, then the cheaper action first.
 *
 * Deliberately *not* sorted by a computed severity. There is no severity here — there is
 * how many things an action disconnects and how long it takes, and both of those are
 * observable rather than assigned.
 *
 * `reach` counts only what a human promoted or two independent sources agreed on. The
 * unverified remainder rides along in `unverifiedReach` and never touches the ordering,
 * because a tool that answers 200 from an anti-bot page would otherwise be able to push
 * its own noise to the top of the page the operator acts on.
 */
function rank(items: readonly RemediationItem[]): RemediationItem[] {
  return [...items].sort(
    (a, b) => b.reach - a.reach || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || a.action.localeCompare(b.action)
  )
}

import {
  SELF_AUDIT_LEVELS,
  seedField,
  type SeedFieldId,
  type SelfAuditLevel,
  type SelfAuditLevelState,
  type SelfAuditProfile,
  type SelfAuditRunState
} from '../../../shared/selfaudit'
import { Icon } from './Icon'
import { plural, stampMinute } from '../lib/format'

/**
 * The next thing to do, and only that.
 *
 * The Self-Audit used to be five panels the operator had to assemble himself: fill the
 * vault at the top, scroll back up to the ladder, select a level, find the run button
 * inside a collapsed panel, then hunt for the delta. Every step required scrolling
 * backwards to somewhere he had already been. His verdict was that it is *"not
 * straightforward to use"*, and he was right — nothing on the screen ever said what to do
 * next, so he had to hold the whole procedure in his head.
 *
 * So the procedure is on the screen now. This card computes the single next action from
 * the state and renders exactly one primary button for it, directly under the level rail
 * where the eye already is. It never offers two things at once, and it never offers an
 * action that cannot be taken.
 *
 * The ladder is cumulative, so the next action is always the lowest rung that is not
 * finished: a level missing a seed asks for that seed and says what it buys, a level with
 * its seeds asks to be run, and when all five have run the card stops asking for input and
 * points at the delta — which DECISIONS.md is explicit is the actual product of the whole
 * feature.
 */

export type Step =
  /** Nothing has been entered at all. */
  | { kind: 'empty' }
  /** `level` cannot run until `field` has a value. */
  | { kind: 'seed'; level: SelfAuditLevel; field: SeedFieldId }
  /** `level` has everything it needs and has not been run. */
  | { kind: 'run'; level: SelfAuditLevel }
  /** A sweep is in flight. */
  | { kind: 'running'; level: SelfAuditLevel }
  /** Every level has run at least once. */
  | { kind: 'read'; level: SelfAuditLevel }

/**
 * Where the operator is in the procedure.
 *
 * Pure, and deliberately not memoised anywhere: it reads five small numbers and is
 * recomputed on every push from a running sweep, which is what keeps the card and the rail
 * agreeing with each other while a run is in flight.
 */
export function nextStep(
  profile: SelfAuditProfile,
  levels: SelfAuditLevelState[],
  run: SelfAuditRunState | null
): Step {
  if (run && (run.phase === 'seeding' || run.phase === 'running' || run.phase === 'analysing')) {
    return { kind: 'running', level: run.level }
  }

  const anySeed = Object.values(profile.values).some((v) => v.length > 0)
  if (!anySeed) return { kind: 'empty' }

  for (const spec of SELF_AUDIT_LEVELS) {
    const state = levels.find((l) => l.level === spec.level)
    if (!state) continue
    // `missing` is cumulative and already excludes the one optional field, so its first
    // entry is the lowest-level thing standing between the operator and this rung.
    if (state.missing.length > 0) return { kind: 'seed', level: spec.level, field: state.missing[0]! }
    if (!state.latest) return { kind: 'run', level: spec.level }
  }

  return { kind: 'read', level: 4 }
}

/** The most recently completed level, for the one line of "what just happened". */
export function lastRunLevel(levels: SelfAuditLevelState[]): SelfAuditLevelState | null {
  let best: SelfAuditLevelState | null = null
  for (const l of levels) {
    if (!l.latest) continue
    if (!best || l.latest.at > best.latest!.at) best = l
  }
  return best
}

export function SelfAuditStep({
  step,
  levels,
  starting,
  onSeed,
  onRun,
  onRead
}: {
  step: Step
  levels: SelfAuditLevelState[]
  starting: boolean
  /** Open the vault with this field focused. */
  onSeed: (field: SeedFieldId, level: SelfAuditLevel) => void
  onRun: (level: SelfAuditLevel) => void
  onRead: (level: SelfAuditLevel) => void
}): React.JSX.Element | null {
  const last = lastRunLevel(levels)

  // While a sweep is running the run bar under the level panel is the live surface, and a
  // second copy of "it is running" here would be noise rather than guidance.
  if (step.kind === 'running') return null

  const spec = step.kind === 'empty' ? SELF_AUDIT_LEVELS[0]! : SELF_AUDIT_LEVELS[step.level]!

  let title: string
  let body: React.ReactNode
  let action: React.ReactNode

  if (step.kind === 'empty') {
    title = 'Start with one username'
    body = (
      <>
        Put every handle you use on its own line — the field takes a list, and the ladder
        splits it. L0 seeds only the first one, because it simulates a stranger who saw you
        on one platform and nothing else; L1 adds the rest, because that is the rung where
        a handle you reused across two accounts shows up as a jump instead of disappearing
        into the baseline. Put the handle you consider your main one first.
      </>
    )
    action = (
      <button type="button" className="btn btn--primary" onClick={() => onSeed('usernames', 0)}>
        Add a username
      </button>
    )
  } else if (step.kind === 'seed') {
    const f = seedField(step.field)
    title = `${spec.code} needs ${aOrAn(f.unit)}`
    body = (
      <>
        {spec.code} models {lowerFirst(spec.simulates)} {f.buys}
      </>
    )
    action = (
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => onSeed(step.field, step.level)}
      >
        Add {aOrAn(f.unit)} → run {spec.code}
      </button>
    )
  } else if (step.kind === 'run') {
    const state = levels.find((l) => l.level === step.level)
    title = `Ready to run ${spec.code}`
    body = (
      <>
        {plural(state?.seedCount ?? 0, 'seed')} go into {spec.code}&rsquo;s own case folder, and
        nothing above this rung goes with them — that is what makes it an honest simulation of{' '}
        {lowerFirst(spec.simulates)} rather than a filtered view of everything you have told it.
      </>
    )
    action = (
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => onRun(step.level)}
        disabled={starting}
        data-loading={starting ? 'true' : undefined}
      >
        {starting ? 'Starting…' : `Run ${spec.code}`}
      </button>
    )
  } else {
    title = 'All five levels have run'
    body = (
      <>
        The totals are the context and the delta is the product: which single added fact
        unlocked the most. Read it from the top of the ladder down — the jump between two
        rungs is the actionable finding, not the number of accounts at either end.
      </>
    )
    action = (
      <button type="button" className="btn btn--primary" onClick={() => onRead(4)}>
        Read the delta
      </button>
    )
  }

  return (
    <section className="sa-step">
      <div className="sa-step__text">
        <h2 className="sa-step__title">{title}</h2>
        <p className="sa-step__body">{body}</p>
      </div>
      <div className="sa-step__action">
        {action}
        {last?.latest && (
          <span className="hint sa-step__last">
            <Icon name="check" size={11} /> {last.code} last ran {stampMinute(last.latest.at)} ·{' '}
            {plural(last.latest.counts.claims, 'claim')}
            {last.latest.counts.silentChecks > 0
              ? `, ${last.latest.counts.silentChecks} unchecked`
              : ''}
          </span>
        )}
      </div>
    </section>
  )
}

function aOrAn(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, '')
}

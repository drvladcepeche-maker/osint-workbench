import {
  SELF_AUDIT_LEVELS,
  seedField,
  type SelfAuditLevel,
  type SelfAuditLevelState,
  type SelfAuditRunState
} from '../../../shared/selfaudit'
import { Icon } from './Icon'

/**
 * The ladder, as a spine rather than a list.
 *
 * It used to be five tall rows inside a collapsible panel halfway down the page, which
 * meant that after filling in the seed vault the operator had to scroll back up past his
 * own form to find out where he was and what to press. His words: *"you enter your
 * fucking information, then you have to go up and go to like see something, and then you
 * run the thing."* The five levels are the structure of this whole feature, so they now
 * sit directly under the title, outside the scrollport, and never move.
 *
 * Compressing five rows into one rail costs the detail each row used to carry — how many
 * seeds, when it last ran, which tools were refused. None of that is lost; it moved into
 * the panel for the level you have selected, which is the only level that detail is ever
 * about. What the rail keeps is the one thing you need at a glance and could not get
 * before: **where you are, and which rung is next.**
 *
 * Exactly one rung is marked `next` at a time, and it is the same level the step card
 * below is offering to act on. Two places on the screen pointing at different next actions
 * is how the old layout got confusing in the first place.
 */
export function SelfAuditSpine({
  levels,
  selected,
  next,
  run,
  onSelect
}: {
  levels: SelfAuditLevelState[]
  selected: SelfAuditLevel
  /** The level the step card is currently offering. Marked on the rail. */
  next: SelfAuditLevel | null
  run: SelfAuditRunState | null
  onSelect: (level: SelfAuditLevel) => void
}): React.JSX.Element {
  return (
    <div className="sa-spine" role="tablist" aria-label="Adversary knowledge levels">
      {SELF_AUDIT_LEVELS.map((spec) => {
        const state = levels.find((l) => l.level === spec.level)
        const running = run?.level === spec.level && isLive(run)
        const ran = !!state?.latest
        const blocked = (state?.missing.length ?? 0) > 0
        const isNext = next === spec.level

        const status = running
          ? 'running'
          : ran
            ? 'ran'
            : blocked
              ? 'blocked'
              : isNext
                ? 'next'
                : 'waiting'

        return (
          <button
            key={spec.code}
            type="button"
            role="tab"
            className="sa-rung"
            data-status={status}
            aria-selected={selected === spec.level}
            onClick={() => onSelect(spec.level)}
            title={spec.simulates}
          >
            <span className="sa-rung__top">
              <span className="sa-rung__code">{spec.code}</span>
              <span className="sa-rung__adds">{spec.adds}</span>
            </span>
            <span className="sa-rung__status">
              {running ? (
                <>
                  <span className="sa-rung__live" aria-hidden="true" />
                  running
                </>
              ) : ran ? (
                <>
                  <Icon name="check" size={11} />
                  {state?.latest?.counts.claims ?? 0} claims
                </>
              ) : blocked ? (
                <>needs {seedField(state!.missing[0]!).unit}</>
              ) : isNext ? (
                <>ready to run</>
              ) : (
                <>never run</>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function isLive(run: SelfAuditRunState): boolean {
  return run.phase === 'seeding' || run.phase === 'running' || run.phase === 'analysing'
}

import { useEffect, useState } from 'react'
import {
  levelSpec,
  seedField,
  type SelfAuditLevel,
  type SelfAuditLevelSpec,
  type SelfAuditLevelState,
  type SelfAuditPlan,
  type SelfAuditRunState
} from '../../../shared/selfaudit'
import { Data } from './Data'
import { Icon } from './Icon'
import { Notice } from './Feedback'
import { plural } from '../lib/format'

/**
 * One rung, in detail: what it would run, what is missing, and the run itself.
 *
 * This used to render the ladder as well, which put the five levels halfway down a
 * scrolling page — so the operator had to scroll backwards past his own seed form to see
 * where he was. The ladder is now a rail above the scrollport (`SelfAuditSpine`) and this
 * panel is only ever about the rung that rail has selected. Splitting them is what lets
 * each say more: the rail says where you are, this says what will actually happen.
 *
 * The chain is shown **before** it runs, which is where the operator first sees that L2
 * adds no tools at all. Read before the run that is a fact about the toolbelt; read
 * afterwards it looks like a failure, and it is not one.
 *
 * The run bar is the only amber on this screen and only while a sweep is in progress.
 */
export function SelfAuditLevelPanel({
  level,
  state,
  run,
  onRan
}: {
  level: SelfAuditLevel
  state: SelfAuditLevelState | null
  run: SelfAuditRunState | null
  onRan: () => void
}): React.JSX.Element {
  const [plan, setPlan] = useState<SelfAuditPlan | null>(null)
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    let live = true
    setPlan(null)
    setDropped(new Set())
    void window.osint.selfAudit
      .plan(level)
      .then((p) => {
        if (live) setPlan(p)
      })
      .catch((err) => {
        if (live) setError((err as Error).message)
      })
    return () => {
      live = false
    }
  }, [level, run?.phase, state?.seedCount, state?.latest?.at])

  const spec = levelSpec(level)
  const busy = !!run && run.phase !== 'done' && run.phase !== 'failed' && run.phase !== 'cancelled'

  const adapterIds = plan ? [...new Set(plan.runs.map((r) => r.adapterId))] : []
  const chosen = adapterIds.filter((id) => !dropped.has(id))

  const start = async (): Promise<void> => {
    setError(null)
    setStarting(true)
    try {
      await window.osint.selfAudit.run({
        level,
        ...(chosen.length !== adapterIds.length ? { adapterIds: chosen } : {})
      })
      onRan()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="panel__body">
      {error && (
        <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      <p className="hint" style={{ marginBottom: 'var(--space-3)' }}>
        {spec.code} seeds {describeAdds(spec)} on top of everything below it, into its own case
        folder {state?.caseId ? <Data>{state.caseId}</Data> : <>(created on the first run)</>}.{' '}
        {state?.missing.length
          ? `It cannot run yet: no ${state.missing.map((m) => seedField(m).label.toLowerCase()).join(' and no ')} in the vault.`
          : `${plural(state?.seedCount ?? 0, 'seed')} would be materialised.`}
      </p>

      {/* Seed entities the folder holds that this level would not seed today. Two ways to
          get one: a value removed from the vault without purging the case (which is the
          documented default, and leaves the level querying it forever), or the ladder
          moving underneath an old folder — L0 used to seed every username and now seeds
          one. Neither is corrected automatically: a case folder is an audit trail. */}
      {plan && plan.strayCaseSeeds.length > 0 && (
        <Notice state="warning" label="Seeds this level would not add today">
          This folder holds {joinAnd(plan.strayCaseSeeds.map((s) => s.label))} as{' '}
          {plan.strayCaseSeeds.length === 1 ? 'a seed' : 'seeds'}, and {spec.code} would not
          materialise {plan.strayCaseSeeds.length === 1 ? 'it' : 'them'} on a run today — either
          you removed {plan.strayCaseSeeds.length === 1 ? 'it' : 'them'} from the vault without
          purging the case, or the ladder changed. Nothing is deleted automatically, and every
          search this level runs still welds{' '}
          {plan.strayCaseSeeds.length === 1 ? 'it' : 'them'} into its queries. Remove{' '}
          {plan.strayCaseSeeds.length === 1 ? 'it' : 'them'} from the vault with “purge case
          folders” if that is not what you want.
        </Notice>
      )}

      {run && run.level === level && <RunBar run={run} />}

      {plan && !busy && (
        <>
          {plan.runs.length > 0 ? (
            <div className="runbar" style={{ marginBottom: 'var(--space-3)' }}>
              <span className="runbar__label">Chain</span>
              {adapterIds.map((id) => {
                const first = plan.runs.find((r) => r.adapterId === id)
                const n = plan.runs.filter((r) => r.adapterId === id).length
                return (
                  <label className="check" key={id}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={!dropped.has(id)}
                      onChange={() =>
                        setDropped((prev) => {
                          const next = new Set(prev)
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }
                    />
                    <span className="check__box" aria-hidden="true">
                      <Icon name="check" size={10} />
                    </span>
                    <span className="check__label">
                      {first?.adapterTitle ?? id} <span className="hint">×{n}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          ) : (
            <Notice state="info" label="Note">
              No adapter in this build accepts any of the kinds {spec.code} adds. That is not a
              failure — nothing in the toolbelt takes a person, a city or a school as a starting
              point. What this level adds is attribution: it re-reads what the levels below already
              found and reports which of it now matches something you seeded.
            </Notice>
          )}

          {plan.unavailable.length > 0 && (
            <div className="sa-rows" style={{ marginBottom: 'var(--space-3)' }}>
              {plan.unavailable.map((u) => (
                <div className="sa-row sa-row--silent" key={u.adapterId}>
                  <span className="sa-row__lead">
                    <span className="sa-silent">
                      <Icon name="warning" size={11} />
                      not installed
                    </span>
                  </span>
                  <span className="sa-row__body">
                    <strong>{u.adapterTitle}</strong> — {u.reason} Everything it would have covered
                    is unchecked, and the report will say so rather than counting it as clear.
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="runbar">
        <button
          type="button"
          className="btn"
          onClick={() => void start()}
          disabled={busy || starting || !state || state.seedCount === 0}
          data-loading={starting ? 'true' : undefined}
          title={
            state?.seedCount === 0
              ? 'This level has no seeds. Fill the vault above first.'
              : 'Seeds this level, runs its chain, and writes a snapshot.'
          }
        >
          {busy ? 'Running…' : state?.latest ? `Run ${spec.code} again` : `Run ${spec.code}`}
        </button>
        {busy && (
          <button type="button" className="btn" onClick={() => void window.osint.selfAudit.cancel()}>
            Stop
          </button>
        )}
        {state?.snapshotCount ? (
          <span className="hint">
            {plural(state.snapshotCount, 'snapshot')} on disk. Running again writes another and
            diffs against the last one.
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * What this rung adds, in words — including a field it only *finishes*.
 *
 * L1 introduces email and domains and also completes `usernames`, whose first value went
 * in at L0. Listing only the fields that enter here would have L1 silently seeding two more
 * handles than the panel says it does.
 */
function describeAdds(spec: SelfAuditLevelSpec): string {
  const entering = spec.fields.map((f) => seedField(f).label.toLowerCase())
  const completing = (spec.completes ?? []).map(
    (f) => `the rest of your ${seedField(f).label.toLowerCase()}`
  )
  return joinAnd([...entering, ...completing])
}

/** "a", "a and b", "a, b and c". Prose, not a comma-separated list. */
function joinAnd(items: readonly string[]): string {
  if (!items.length) return 'nothing new'
  if (items.length === 1) return items[0] as string
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Honest progress, per DESIGN.md: the real count, what is in flight, and no spinner.
 *
 * A level's sweep has a genuine denominator — the number of adapter/seed pairs planned —
 * so the bar is determinate here, unlike a single sherlock run where the tool never states
 * one. The amber is the safelight and it is the only amber on the screen.
 */
function RunBar({ run }: { run: SelfAuditRunState }): React.JSX.Element {
  const live = run.phase === 'seeding' || run.phase === 'running' || run.phase === 'analysing'
  const fraction = run.planned > 0 ? run.finished / run.planned : null
  return (
    <div className="run">
      <div className="run__head">
        {live && <span className="run__live" aria-hidden="true" />}
        <span className="run__tool">Self-Audit L{run.level}</span>
        <span className="run__state">{run.phase}</span>
      </div>

      <div className="run__line" aria-live="off">
        {run.planned > 0
          ? `${run.finished} / ${run.planned} checks · ${run.running.length} in flight`
          : 'no checks planned for this level'}
      </div>
      <span className="sr-only" role="status">
        Self-audit level {run.level} is {run.phase}.
      </span>

      {live && (
        <div className={fraction === null ? 'run__bar run__bar--unknown' : 'run__bar'}>
          <div
            className="run__bar-fill"
            style={{ '--run-progress': fraction ?? 1 } as React.CSSProperties}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={run.planned || 100}
            aria-valuenow={fraction === null ? undefined : run.finished}
            aria-label={`Level ${run.level} progress`}
          />
        </div>
      )}

      {live && run.running[0] && (
        <div className="run__target is-probing">
          <span>
            {run.running[0].adapterId} · {run.running[0].entityLabel}
          </span>
        </div>
      )}

      <p className="hint">
        {run.message}
        {run.error ? ` ${run.error}` : ''}
      </p>
    </div>
  )
}

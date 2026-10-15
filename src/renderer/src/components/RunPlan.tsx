import type { AdapterInfo, Entity, EntityKind } from '../../../shared/types'
import type { RunPlan } from '../../../shared/ipc'
import { attributionOnlyKind, kindWithArticle } from '../../../shared/ipc'
import { plural } from '../lib/format'
import { Data } from './Data'
import { Icon } from './Icon'

/**
 * The launcher.
 *
 * It used to be one row of adapter buttons acting on one selected entity, which meant a
 * case with five seeds and six applicable tools was thirty deliberate clicks, in an order
 * the operator had to hold in his head. His words: *"I can't run Blackbird on both the
 * person's name and username. There's no unifying thing, and I have to click each one
 * independently?"*
 *
 * So there are three actions here and the labels never blur them:
 *
 *  - **Run everything applicable** means every entity in the case against every adapter
 *    that accepts its kind, regardless of what is selected. It always shows the plan
 *    first, because some of these take minutes and fourteen of them take a while.
 *  - **Every applicable tool** is the same thing narrowed to the selection: one entity
 *    selected makes it "every tool that accepts this handle", which is the fan-out he
 *    was doing by hand, one button at a time.
 *  - **A tool button** runs that one adapter against the current selection. One entity
 *    selected is exactly the old behaviour and stays a single click; more than one shows
 *    the plan first for the same reason.
 *
 * **Pick tools** turns the same row into a multi-select and the run becomes the
 * intersection of the two selections. It is a mode rather than the default because the
 * default has to stay one click: a launcher where the common case costs three clicks to
 * buy a rare case its two is a worse launcher.
 *
 * Adapters that accept nothing selected are not rendered as dead buttons. They are
 * counted in one line underneath, because "nine other tools take other kinds" is a fact
 * about the toolbelt and hiding it entirely is how a launcher starts feeling arbitrary.
 */
export function RunLauncher({
  adapters,
  entities,
  selected,
  pickedTools,
  busy,
  hasActiveRuns,
  runFormId,
  onRunEverything,
  onRunApplicable,
  onRunAdapter,
  onPickTools,
  onToggleTool,
  onRunPicked,
  onCancelAll
}: {
  adapters: AdapterInfo[]
  entities: Entity[]
  selected: ReadonlySet<string>
  /** Null in the default one-click mode; a set once "Pick tools" is on. */
  pickedTools: ReadonlySet<string> | null
  busy: boolean
  hasActiveRuns: boolean
  /** The adapter whose per-run form is open, if any. */
  runFormId: string | null
  onRunEverything: () => void
  onRunApplicable: () => void
  onRunAdapter: (adapterId: string) => void
  onPickTools: (on: boolean) => void
  onToggleTool: (adapterId: string) => void
  onRunPicked: () => void
  onCancelAll: () => void
}): React.JSX.Element {
  const chosen = entities.filter((e) => selected.has(e.id))
  const kinds = new Set(chosen.map((e) => e.kind))
  const applicable = adapters.filter((a) => a.accepts.some((k) => kinds.has(k)))
  const otherTools = adapters.length - applicable.length
  const picking = pickedTools !== null

  return (
    <div className="runbar">
      <button
        type="button"
        className="btn btn--primary"
        onClick={onRunEverything}
        disabled={busy || entities.length === 0}
        title="Every entity in this case against every adapter that accepts its kind, whatever is selected. You see the plan before anything starts."
      >
        Run everything applicable
      </button>

      {hasActiveRuns && (
        <button
          type="button"
          className="btn"
          onClick={onCancelAll}
          title="Stop every queued and running job in this case. Output captured so far is kept."
        >
          Cancel all runs
        </button>
      )}

      <span className="runbar__sep" aria-hidden="true" />

      <span className="runbar__label">
        {chosen.length === 1 ? (
          <>
            Run on {chosen[0]?.kind} <Data>{chosen[0]?.label}</Data>
          </>
        ) : (
          `Run on ${plural(chosen.length, 'selected entity', 'selected entities')}`
        )}
      </span>

      {/* Per-entity fan-out. Only worth offering when more than one tool would answer —
          with exactly one, it is the tool button beside it wearing a vaguer label. */}
      {!picking && applicable.length > 1 && (
        <button
          type="button"
          className="btn"
          onClick={onRunApplicable}
          disabled={busy || !chosen.length}
          title={`Every tool that accepts ${chosen.length === 1 ? 'this entity' : 'one of these entities'}. You see the plan before anything starts.`}
        >
          Every applicable tool
        </button>
      )}

      {applicable.map((a) => (
        <button
          key={a.id}
          type="button"
          className="btn"
          aria-pressed={picking ? pickedTools.has(a.id) : undefined}
          disabled={!a.available || busy}
          aria-expanded={!picking && runFormId === a.id ? true : undefined}
          onClick={() => (picking ? onToggleTool(a.id) : onRunAdapter(a.id))}
          title={
            a.unavailableReason ??
            (picking
              ? `Include ${a.title} in the run. Takes ${a.accepts.join(', ')}.`
              : `${a.doc.what} — takes ${a.accepts.join(', ')}.`)
          }
        >
          {a.title}
          {a.requiresNetwork && <Icon name="network" size={11} />}
          {a.requiresKey && <Icon name="key" size={11} />}
        </button>
      ))}

      {!applicable.length && (
        <span className="hint">{noToolFor(chosen.map((e) => e.kind))}</span>
      )}

      {applicable.length > 0 && (
        <>
          <span className="runbar__sep" aria-hidden="true" />
          {picking ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                onClick={onRunPicked}
                disabled={busy || pickedTools.size === 0 || chosen.length === 0}
              >
                Run {pickedTools.size === 0 ? 'the selection' : `${pickedTools.size} × ${chosen.length}`}
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => onPickTools(false)}>
                Done picking
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => onPickTools(true)}
              title="Choose several tools, then run them against every selected entity at once."
            >
              Pick tools
            </button>
          )}
        </>
      )}

      {applicable.length > 0 && otherTools > 0 && (
        <span
          className="hint"
          title={adapters
            .filter((a) => !a.accepts.some((k) => kinds.has(k)))
            .map((a) => `${a.title} — takes ${a.accepts.join(', ')}`)
            .join('\n')}
        >
          {otherTools} other {otherTools === 1 ? 'tool takes' : 'tools take'} kinds nothing
          selected is.
        </span>
      )}
    </div>
  )
}

/**
 * Why the selection has no tool pointed at it.
 *
 * This sentence is the one the operator has already been caught by. An adapter that does
 * not accept a kind has not failed — it cannot answer that question, which is a different
 * thing and has to read differently. `attributionOnlyKind` carries the design reason for
 * the kinds where the absence is deliberate rather than a gap.
 */
function noToolFor(kinds: EntityKind[]): string {
  if (!kinds.length) return 'Select an entity above. A tool needs something to point at.'
  const unique = [...new Set(kinds)]
  const design = unique.map((k) => attributionOnlyKind(k)).filter(Boolean)[0]
  const named = unique.map(kindWithArticle).join(' or ')
  return design
    ? `No tool here takes ${named} as a query. ${design}`
    : `No tool in this build takes ${named}. That is a gap in the toolbelt, not a fault in this case.`
}

/**
 * The plan, before any of it runs.
 *
 * Fourteen runs is minutes of network traffic aimed at real sites, so it is shown and
 * confirmed rather than started on a click. The three lists underneath are the honest
 * half: an entity nothing accepts, an adapter nothing selected suits, and the adapters a
 * batch never reaches for. Each carries the reason next to it, because a plan of zero
 * runs is a legitimate answer and silence is indistinguishable from a bug.
 */
export function RunPlanPreview({
  plan,
  busy,
  onRun,
  onCancel
}: {
  plan: RunPlan
  busy: boolean
  onRun: () => void
  onCancel: () => void
}): React.JSX.Element {
  const byEntity = new Map<string, { label: string; kind: EntityKind; tools: string[] }>()
  for (const r of plan.runs) {
    const row = byEntity.get(r.entityId) ?? { label: r.entityLabel, kind: r.entityKind, tools: [] }
    row.tools.push(r.adapterTitle)
    byEntity.set(r.entityId, row)
  }

  const nothing = plan.runs.length === 0

  return (
    <section className="plan" aria-label="What this would run">
      <div className="plan__head">
        <span className="plan__count">
          {nothing
            ? 'Nothing to run'
            : `${plural(plan.runs.length, 'run')} across ${plural(plan.entitiesCovered, 'entity', 'entities')} · ${plural(plan.adaptersUsed, 'tool')}`}
        </span>
        <div className="toolbar__spacer" />
        {!nothing && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onRun}
            disabled={busy}
            data-loading={busy ? 'true' : undefined}
          >
            {busy ? 'Queueing…' : `Run ${plan.runs.length}`}
          </button>
        )}
        <button type="button" className="btn btn--quiet" onClick={onCancel}>
          {nothing ? 'Close' : 'Not now'}
        </button>
      </div>

      {!nothing && (
        <ul className="plan__list">
          {[...byEntity.entries()].map(([id, row]) => (
            <li key={id} className="plan__row">
              <span className="plan__kind">{row.kind}</span>
              <span className="plan__entity data">{row.label}</span>
              <span className="plan__tools">{row.tools.join(', ')}</span>
            </li>
          ))}
        </ul>
      )}

      {(plan.idleEntities.length > 0 ||
        plan.idleAdapters.length > 0 ||
        plan.excluded.length > 0 ||
        plan.alreadyQueued.length > 0) && (
        <div className="plan__aside">
          <h3 className="plan__aside-title">Not run, and why</h3>
          <ul className="plan__reasons">
            {plan.idleEntities.map((e) => (
              <li key={e.entityId}>
                <span className="plan__kind">{e.kind}</span>
                <span className="data">{e.label}</span>
                <span className="plan__why">{e.reason}</span>
              </li>
            ))}
            {plan.idleAdapters.map((a) => (
              <li key={a.adapterId}>
                <span className="plan__kind">tool</span>
                <span className="data">{a.adapterId}</span>
                <span className="plan__why">{a.reason}</span>
              </li>
            ))}
            {plan.excluded.map((a) => (
              <li key={a.adapterId}>
                <span className="plan__kind">tool</span>
                <span className="data">{a.adapterId}</span>
                <span className="plan__why">{a.reason}</span>
              </li>
            ))}
            {plan.alreadyQueued.length > 0 && (
              <li>
                <span className="plan__kind">queued</span>
                <span className="data">{plan.alreadyQueued.length}</span>
                <span className="plan__why">
                  Already queued or running from an earlier click. Starting them again would
                  only duplicate the work.
                </span>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}

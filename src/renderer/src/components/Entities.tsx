import { useEffect, useState } from 'react'
import type { Entity } from '../../../shared/types'
import type { EntityRemoval, EntityUsage } from '../../../shared/ipc'
import { plural } from '../lib/format'
import { Data } from './Data'
import { Notice } from './Feedback'
import { Icon } from './Icon'

/**
 * The entity strip: what is in the case, what is selected, and how to correct it.
 *
 * Two things this pass added, both because there was previously no way to undo a
 * keystroke. A typo in a seed was permanent — the entity could be added again with the
 * right spelling, but the wrong one stayed in the case forever and every "run everything"
 * kept pointing tools at it.
 *
 *  1. **Selection is multiple.** A chip toggles. The launcher runs against whatever is
 *     selected, so "this tool against these three handles" is a selection rather than
 *     three trips around the same loop.
 *  2. **Every chip opens an editor.** One pencil per chip, one place behind it holding
 *     both operations, with the consequence of each stated before it happens.
 *
 * Why the two controls live behind one affordance rather than as a pencil and a bin side
 * by side: a bin next to a chip is a click away from destroying something, and the thing
 * being destroyed may have twelve findings hanging off it. Opening a panel that says so
 * first costs one click and removes the whole class of accident.
 */
export function EntityStrip({
  caseId,
  entities,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  onChanged,
  onError
}: {
  caseId: string
  entities: Entity[]
  selected: ReadonlySet<string>
  onToggle: (entityId: string) => void
  onSelectAll: () => void
  onClear: () => void
  /** Refresh the case after an edit or a removal, and say what happened. */
  onChanged: (message: string | null) => void
  onError: (message: string | null) => void
}): React.JSX.Element | null {
  const [editing, setEditing] = useState<string | null>(null)

  // A chip that is edited away — renamed, or removed — must not leave its editor open
  // over an entity that no longer exists.
  useEffect(() => {
    if (editing && !entities.some((e) => e.id === editing)) setEditing(null)
  }, [entities, editing])

  if (!entities.length) return null

  const open = entities.find((e) => e.id === editing) ?? null
  const all = selected.size >= entities.length

  return (
    <div className="entities-block">
      <div className="entities" role="group" aria-label="Entities in this case">
        {entities.map((e) => (
          <span
            key={e.id}
            className="entity"
            data-selected={selected.has(e.id) ? 'true' : undefined}
            data-open={editing === e.id ? 'true' : undefined}
          >
            <button
              type="button"
              className="entity__pick"
              aria-pressed={selected.has(e.id)}
              onClick={() => onToggle(e.id)}
              title={
                e.seed
                  ? `${e.kind} — supplied by you as a starting point. Click to select or deselect it for a run.`
                  : `${e.kind} — discovered by an adapter and promoted by you. Click to select or deselect it for a run.`
              }
            >
              <span className="entity__kind">{e.kind}</span>
              <span className="entity__value">{e.label}</span>
              {e.seed && (
                <>
                  <span className="entity__seed" aria-hidden="true" />
                  <span className="sr-only">seed</span>
                </>
              )}
            </button>
            <button
              type="button"
              className="entity__edit"
              aria-expanded={editing === e.id}
              onClick={() => setEditing((prev) => (prev === e.id ? null : e.id))}
              title={`Correct or remove ${e.label}`}
              aria-label={`Correct or remove ${e.kind} ${e.label}`}
            >
              <Icon name="edit" size={11} />
            </button>
          </span>
        ))}
      </div>

      <div className="entities__foot">
        <span className="hint">
          {selected.size === 0
            ? 'Nothing selected. A tool needs at least one entity to point at.'
            : `${plural(selected.size, 'entity', 'entities')} selected of ${entities.length}.`}
        </span>
        <button type="button" className="btn btn--quiet" onClick={all ? onClear : onSelectAll}>
          {all ? 'Select none' : 'Select all'}
        </button>
      </div>

      {open && (
        <EntityEditor
          key={open.id}
          caseId={caseId}
          entity={open}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
          onError={onError}
        />
      )}
    </div>
  )
}

/**
 * Correcting or removing one entity, with the consequences on screen before either
 * happens.
 *
 * The usage is fetched when this opens rather than computed here: the count of findings
 * that would be orphaned is an indexed query in the main process, and a number offered
 * before a destructive action has to be the real one.
 */
function EntityEditor({
  caseId,
  entity,
  onClose,
  onChanged,
  onError
}: {
  caseId: string
  entity: Entity
  onClose: () => void
  onChanged: (message: string | null) => void
  onError: (message: string | null) => void
}): React.JSX.Element {
  const [usage, setUsage] = useState<EntityUsage | null>(null)
  const [draft, setDraft] = useState(entity.label)
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let live = true
    void window.osint.entities
      .usage(caseId, entity.id)
      .then((u) => {
        if (live) setUsage(u)
      })
      .catch((err: Error) => onError(err.message))
    return () => {
      live = false
    }
  }, [caseId, entity.id, onError])

  const changed = draft.trim() !== '' && draft.trim() !== entity.label

  const save = async (): Promise<void> => {
    if (!changed || busy) return
    onError(null)
    setBusy('save')
    try {
      const result = await window.osint.entities.edit({
        caseId,
        entityId: entity.id,
        value: draft.trim()
      })
      onChanged(describeEdit(result.entity.label, result.renamed, result.removal))
      onClose()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    onError(null)
    setBusy('delete')
    try {
      const result = await window.osint.entities.delete({ caseId, entityId: entity.id })
      onChanged(describeRemoval(result))
      onClose()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const attached = usage?.attached ?? false

  return (
    <div className="entity-edit">
      <div className="entity-edit__head">
        <span className="entity-edit__kind">{entity.kind}</span>
        <Data>{entity.value}</Data>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={onClose}
          aria-label="Close this editor"
          title="Close"
        >
          <Icon name="close" />
        </button>
      </div>

      {usage?.editable === false && (
        <p className="hint">
          A {entity.kind} value is built from its parts rather than typed, so it cannot be
          re-typed here. Add the corrected one above and remove this one.
        </p>
      )}

      {usage?.editable !== false && (
        <div className="entity-edit__row">
          <input
            className="input input--data"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            aria-label={`New value for ${entity.kind} ${entity.label}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') onClose()
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={!changed || busy !== null}
            data-loading={busy === 'save' ? 'true' : undefined}
            onClick={() => void save()}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {/* The value is re-normalised on the way in, so what is stored is what the store
          would have stored had it been typed correctly the first time. Saying so here is
          the difference between a field that looks like it edits text and one the operator
          understands is editing an identity. */}
      {usage?.editable !== false && (
        <p className="hint">
          Saved through the same normaliser the store uses, so the stored value stays a
          fixed point. A corrected value is a different entity —{' '}
          {usage && usage.findings > 0
            ? `the ${plural(usage.findings, 'finding')} already collected under the old spelling stay in the case and are marked orphaned.`
            : 'nothing has been collected under the old spelling, so nothing is left behind.'}
        </p>
      )}

      <div className="entity-edit__foot">
        {confirming ? (
          <>
            <span className="hint">{consequence(usage)}</span>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void remove()}
              data-loading={busy === 'delete' ? 'true' : undefined}
              disabled={busy !== null}
            >
              {busy === 'delete' ? 'Removing…' : 'Remove it'}
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || usage === null}
              onClick={() => (attached ? setConfirming(true) : void remove())}
            >
              <Icon name="trash" size={11} />
              Remove from this case
            </button>
            <span className="hint">{usage ? consequence(usage) : 'Counting what is attached…'}</span>
          </>
        )}
      </div>

      {usage && usage.findings > 0 && (
        <Notice state="info" label="Kept">
          Findings are never deleted with the entity they were about. A finding is the
          record that a tool, reading a source, asserted something — and the raw capture
          behind it is permanent. Deleting the question does not unobserve the answer, so
          the {plural(usage.findings, 'finding')} stay in the table, marked orphaned.
        </Notice>
      )}
    </div>
  )
}

/** One sentence saying exactly what removing this would do. */
function consequence(usage: EntityUsage | null): string {
  if (!usage) return ''
  if (!usage.attached && !usage.returnsCandidate) {
    return 'Nothing has been collected about it, so nothing is left behind.'
  }
  const parts: string[] = []
  if (usage.findings > 0) parts.push(`${plural(usage.findings, 'finding')} kept and marked orphaned`)
  if (usage.evidence > 0) parts.push(`${plural(usage.evidence, 'captured artifact')} kept`)
  if (usage.activeJobs > 0) parts.push(`${plural(usage.activeJobs, 'run')} cancelled`)
  if (usage.returnsCandidate) parts.push('the discovery it was promoted from returns to the review queue')
  return `${parts.join(', ')}.`
}

function describeRemoval(result: EntityRemoval): string {
  const bits: string[] = [`Removed ${result.kind} ${result.label}.`]
  if (result.orphanedFindings > 0) {
    bits.push(`${plural(result.orphanedFindings, 'finding')} kept and marked orphaned.`)
  } else {
    bits.push('Nothing was left behind.')
  }
  if (result.cancelledJobs > 0) bits.push(`${plural(result.cancelledJobs, 'run')} cancelled.`)
  if (result.candidateReturned) bits.push('It is back in the review queue.')
  return bits.join(' ')
}

function describeEdit(label: string, renamed: boolean, removal: EntityRemoval | null): string {
  if (!renamed) return `Relabelled as ${label}. The canonical value did not change, so nothing moved.`
  const orphans = removal?.orphanedFindings ?? 0
  return orphans > 0
    ? `Now ${label}. ${plural(orphans, 'finding')} collected under the old spelling stay in the case, marked orphaned.`
    : `Now ${label}. Nothing had been collected under the old spelling.`
}

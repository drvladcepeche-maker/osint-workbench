import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SEED_FIELDS,
  type SeedFieldId,
  type SeedUsage,
  type SelfAuditProfile
} from '../../../shared/selfaudit'
import { Data } from './Data'
import { Notice } from './Feedback'
import { Icon } from './Icon'
import { plural } from '../lib/format'

/**
 * The seed vault form.
 *
 * One field per thing an adversary might already know, **one value per line**. A tag input
 * would be prettier and would be worse: several of these fields hold five or six values —
 * he reuses handles — and typing six chips is six interactions where a paste into a
 * textarea is one.
 *
 * That "one value per line" used to be stated once, in a paragraph above eight fields, and
 * that was not enough. The operator entered a single username and assumed one was the
 * limit, which quietly turned every level into an audit of one handle instead of all of
 * them — and since the entire premise of L0 is *"what is one handle worth on its own"*,
 * an audit that only ever had one handle cannot answer its own question. Three things say
 * it now, at three different moments: the placeholder shows **two** example lines, the
 * label carries the rule, and a live count under each field says how many values the form
 * has actually parsed out of what was typed. The last one is the important one, because it
 * responds while he is typing rather than before he starts.
 *
 * Each field also carries the level it enters at and one line saying what it actually buys
 * an adversary. That line is the teaching surface: the form is where the operator decides
 * how much of himself to feed the machine, and he should be reading the consequence while
 * he decides rather than after.
 *
 * The footer is the other half of the flow fix. After a save it stops being a form footer
 * and becomes the launcher for the next level, so the action that follows typing is under
 * the cursor instead of back at the top of the page.
 *
 * **This is real personal data.** The panel says where the file lives so it can be deleted
 * by hand, and "Forget everything" removes that file and nothing else — case folders,
 * findings and raw captures are an audit trail and are not silently destroyed because
 * somebody cleared a form.
 */
export function SelfAuditSeeds({
  profile,
  vaultPath,
  focusField,
  runLabel,
  runHint,
  starting,
  onRun,
  onSaved
}: {
  profile: SelfAuditProfile
  vaultPath: string
  /** Field the step card asked for. Focused and scrolled to when it changes. */
  focusField: SeedFieldId | null
  /** Label for the in-place launcher, or null when nothing is runnable yet. */
  runLabel: string | null
  runHint: string | null
  starting: boolean
  onRun: () => void
  onSaved: (profile: SelfAuditProfile) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Record<SeedFieldId, string>>(() => toDraft(profile))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [removed, setRemoved] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const fields = useRef(new Map<SeedFieldId, HTMLTextAreaElement>())

  // The vault is written by one form and read by five levels; if a run rewrote it the
  // draft has to follow, or the next save would put the stale text back.
  useEffect(() => {
    setDraft(toDraft(profile))
  }, [profile])

  // The step card can point at a specific field ("L1 needs an address"). Land the caret at
  // the end of whatever is already there, so a second value is one Enter away.
  useEffect(() => {
    if (!focusField) return
    const el = fields.current.get(focusField)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [focusField])

  const counts = useMemo(() => {
    const values = Object.fromEntries(
      SEED_FIELDS.map((f) => [f.id, splitLines(draft[f.id] ?? '')])
    ) as Record<SeedFieldId, string[]>
    return {
      values,
      total: Object.values(values).reduce((n, v) => n + v.length, 0)
    }
  }, [draft])

  const dirty = useMemo(() => {
    return SEED_FIELDS.some(
      (f) => splitLines(draft[f.id] ?? '').join('\n') !== (profile.values[f.id] ?? []).join('\n')
    )
  }, [draft, profile])

  const save = async (): Promise<void> => {
    setError(null)
    setSaving(true)
    try {
      const next = await window.osint.selfAudit.saveProfile({
        values: counts.values,
        updatedAt: null
      })
      onSaved(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 4000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const clear = async (): Promise<void> => {
    setError(null)
    try {
      onSaved(await window.osint.selfAudit.clearProfile())
      setConfirmClear(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="panel__body">
      <p className="hint" style={{ marginBottom: 'var(--space-4)' }}>
        Every field takes a list — <strong>one value per line</strong>, as many as you have. A
        handle you reused three years ago is worth more here than the one you use today.
        Everything stays on this machine: it is written to <Data>{vaultPath}</Data> and leaves
        only as an argument to a tool that needs it. A level receives only the fields it is
        entitled to, so L0&rsquo;s case folder never contains your phone number — that is what
        makes L0 an honest simulation of a stranger rather than a filtered view of everything.
      </p>

      {error && (
        <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      <div className="sa-seeds">
        {SEED_FIELDS.map((field) => {
          const n = (counts.values[field.id] ?? []).length
          return (
            <div className="field sa-seed" key={field.id}>
              <div className="sa-seed__head">
                <label className="label" htmlFor={`seed-${field.id}`}>
                  {field.label}
                </label>
                <span className="sa-seed__rule">one per line</span>
                <span className="sa-seed__level">enters at L{field.level}</span>
              </div>
              <textarea
                id={`seed-${field.id}`}
                className="textarea"
                rows={3}
                spellCheck={false}
                value={draft[field.id] ?? ''}
                placeholder={field.hint}
                aria-describedby={`seed-${field.id}-count`}
                ref={(el) => {
                  if (el) fields.current.set(field.id, el)
                  else fields.current.delete(field.id)
                }}
                onChange={(e) => setDraft((prev) => ({ ...prev, [field.id]: e.target.value }))}
              />
              {/* The count is the live half of "one per line": it moves while he types, so
                  a value that was silently dropped for being blank or duplicated is visible
                  immediately rather than at the next run. */}
              <p className="sa-seed__count" id={`seed-${field.id}-count`} data-empty={n === 0}>
                {n === 0 ? 'nothing yet' : plural(n, field.unit)}
              </p>
              {/* The saved values, each removable on its own. Editing the textarea and
                  saving would also drop one, but a line deleted from a block of text is
                  not an affordance — it is something you have to already know is possible,
                  and the operator's actual question was "can I remove entries?". */}
              {(profile.values[field.id] ?? []).length > 0 && (
                <ul className="sa-saved">
                  {(profile.values[field.id] ?? []).map((value) => (
                    <li key={value}>
                      <SavedSeed
                        field={field.id}
                        value={value}
                        onRemoved={(next, message) => {
                          onSaved(next)
                          setRemoved(message)
                        }}
                        onError={setError}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <p className="sa-seed__buys">{field.buys}</p>
            </div>
          )
        })}
      </div>

      {removed && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Notice state="info" label="Removed" onDismiss={() => setRemoved(null)}>
            {removed}
          </Notice>
        </div>
      )}

      <div className="runbar sa-seeds__foot">
        {dirty || !runLabel ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void save()}
            disabled={saving || !dirty}
            data-loading={saving ? 'true' : undefined}
          >
            {saving ? 'Saving…' : dirty ? 'Save the seed vault' : 'Saved'}
          </button>
        ) : (
          /* Nothing left to save, and something is runnable: the footer becomes the
             launcher. This is the whole point — the next action is where the last one
             finished, not back at the top of the page. */
          <button
            type="button"
            className="btn btn--primary"
            onClick={onRun}
            disabled={starting}
            data-loading={starting ? 'true' : undefined}
          >
            {starting ? 'Starting…' : runLabel}
          </button>
        )}
        <span className="hint">
          {dirty
            ? `${plural(counts.total, 'value')} across ${plural(SEED_FIELDS.filter((f) => (counts.values[f.id] ?? []).length > 0).length, 'field')}, unsaved.`
            : (runHint ??
              `${plural(counts.total, 'value')} saved.${profile.updatedAt ? ` Last written ${profile.updatedAt.slice(0, 16).replace('T', ' ')}.` : ''}`)}
        </span>
        <div className="toolbar__spacer" />
        {confirmClear ? (
          <>
            <span className="hint">
              Deletes the vault file. Case folders, findings and raw captures are kept.
            </span>
            <button type="button" className="btn btn--danger" onClick={() => void clear()}>
              Delete it
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => setConfirmClear(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--quiet" onClick={() => setConfirmClear(true)}>
            Forget everything
          </button>
        )}
      </div>

      {saved && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Notice state="success" label="Written">
            The vault is saved. Levels read it at the moment you run them, so a level you
            ran before this edit still holds the seeds it had then.
          </Notice>
        </div>
      )}
    </div>
  )
}

/**
 * One saved seed value, with a way to take it back out.
 *
 * Removing it from the vault is always clean: the file stops holding it, and every level
 * reads the vault at the moment it runs, so the level is immediately re-runnable without
 * it. Nothing stale, nothing re-materialised.
 *
 * The level *case* is the second question, and it is only asked when there is something
 * to ask about. A value that was typed and never run against is in no case at all and
 * goes without a word. A value that produced findings gets the count and a choice: leave
 * the audit trail alone, or delete the entity there too and orphan what it produced. The
 * default is to leave it — a case folder holds raw captures, and destroying those because
 * somebody tidied a form is not a thing this app does.
 */
function SavedSeed({
  field,
  value,
  onRemoved,
  onError
}: {
  field: SeedFieldId
  value: string
  onRemoved: (profile: SelfAuditProfile, message: string) => void
  onError: (message: string | null) => void
}): React.JSX.Element {
  const [usage, setUsage] = useState<SeedUsage | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = async (purgeCases: boolean): Promise<void> => {
    onError(null)
    setBusy(true)
    try {
      const result = await window.osint.selfAudit.removeSeed({ field, value, purgeCases })
      const parts = [`Removed ${value} from the vault. Levels will not seed it again.`]
      if (result.purged.length) {
        const orphans = result.purged.reduce((n, p) => n + p.orphanedFindings, 0)
        parts.push(
          `Deleted from ${result.purged.map((p) => p.code).join(', ')}${
            orphans ? `, orphaning ${plural(orphans, 'finding')}` : ', which had collected nothing'
          }.`
        )
      } else if (result.kept.length) {
        // The consequence, not just the fact. The entity stays `seed: true` in that
        // case's `entities.json`, and every websearch and dork query the level builds
        // still welds it in — so a value typed into the wrong field, which is the mistake
        // this form most invites, keeps being queried on every future run of that level.
        parts.push(
          `${result.kept.map((k) => k.code).join(', ')} still holds it with ${plural(
            result.kept.reduce((n, k) => n + k.findings, 0),
            'finding'
          )}, and will keep using it as a seed on its next run — every search that level builds still welds it in. Remove it from the case too if that is not what you want.`
        )
      }
      onRemoved(result.profile, parts.join(' '))
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
      setUsage(null)
    }
  }

  /** Look before leaping: the count in the confirmation has to be a counted one. */
  const ask = async (): Promise<void> => {
    onError(null)
    setBusy(true)
    try {
      const u = await window.osint.selfAudit.seedUsage(field, value)
      if (u.findings === 0) {
        // Nothing was ever collected under it. Clean out of the vault, and out of any
        // level case still holding the bare entity, with nothing left behind.
        await remove(true)
        return
      }
      setUsage(u)
    } catch (err) {
      onError((err as Error).message)
      setBusy(false)
    }
  }

  if (usage) {
    return (
      <span className="sa-saved__row sa-saved__row--asking">
        <Data>{value}</Data>
        <span className="hint">
          {usage.cases.map((c) => `${c.code}: ${plural(c.findings, 'finding')}`).join(' · ')}. Leaving
          it in the case keeps it a seed there: those levels will still weld it into every
          search they build.
        </span>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy}
          onClick={() => void remove(false)}
          title="Takes it out of the vault only. The levels above keep it as a seed and keep querying it on every future run."
        >
          Vault only
        </button>
        <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void remove(true)}>
          And from the {usage.cases.length === 1 ? 'case' : 'cases'}
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => setUsage(null)}>
          Keep it
        </button>
      </span>
    )
  }

  return (
    <span className="sa-saved__row">
      <Data>{value}</Data>
      <button
        type="button"
        className="sa-saved__remove"
        disabled={busy}
        onClick={() => void ask()}
        title={`Remove ${value} from the seed vault`}
        aria-label={`Remove ${value} from the seed vault`}
      >
        <Icon name="close" size={11} />
      </button>
    </span>
  )
}

function toDraft(profile: SelfAuditProfile): Record<SeedFieldId, string> {
  return Object.fromEntries(
    SEED_FIELDS.map((f) => [f.id, (profile.values[f.id] ?? []).join('\n')])
  ) as Record<SeedFieldId, string>
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

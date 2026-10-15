import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Confidence, ConfidenceChange, Finding } from '../../../shared/types'
// The count on screen is derived with the *same* function the main process refuses on.
// A second local copy of the normalisation would be a second place the rule appears to
// live, and the two would drift the first time a source string got interesting.
import { CORROBORATION_THRESHOLD, independenceKey } from '../../../shared/confidence'
import { stamp } from '../lib/format'
import { Notice } from './Feedback'
import { Icon } from './Icon'
import { LEVELS } from './Confidence'

/**
 * The human half of the confidence ladder.
 *
 * The ramp in `Confidence.tsx` draws four levels; this is the only thing in the renderer
 * that can *move* a finding between them, and it can only do so as a person. Every call
 * it makes carries `actor: 'human'` and a typed note, because the two transitions worth
 * having are exactly the two a tool must never be able to make:
 *
 *   confirmed  "I opened it myself and it is real."
 *   refuted    "I opened it myself and it is wrong."
 *
 * `corroborated` is deliberately absent from *this* control. That level is evidence-driven
 * — two findings with distinct `source` values — so it is not a judgement anyone types a
 * note for. It lives in `CorroborationOffer` below, which does not ask the operator what
 * they think; it asks the rule to run and reports what the rule said.
 *
 * **The note is not a courtesy field.** `promote()` in shared/confidence.ts throws
 * without it, and it is what lands in `confidence-log.jsonl` — the file that answers "why
 * do I believe this". A confirmation with no stated basis is indistinguishable from a
 * guess, so the control refuses to submit an empty one rather than letting the main
 * process reject it a round trip later.
 *
 * Reversal is a first-class action, not an escape hatch. A verification is a human
 * judgement made from a browser tab that may itself have been lying; the operator has to
 * be able to take it back, and taking it back is *also* an audited change with its own
 * note rather than an erasure.
 */

/** The three transitions a person may request. `corroborated` is not one of them. */
export type VerifyAction = Extract<Confidence, 'confirmed' | 'refuted' | 'unverified'>

interface ActionSpec {
  /** The button. */
  verb: string
  /** The heading over the open form, so the note field is never ambiguous. */
  heading: string
  /** The label on the note field, written as the question the note answers. */
  prompt: string
  placeholder: string
  /** Why the note is mandatory. This is the rule, not encouragement. */
  hint: string
  icon: 'developed' | 'refuted' | 'latent'
  /** `--danger` is spent here and only here: refuting is the destructive-looking one. */
  tone?: 'danger'
}

const ACTIONS: Record<VerifyAction, ActionSpec> = {
  confirmed: {
    verb: 'Confirm',
    heading: 'Confirm this finding',
    prompt: 'What did you actually look at?',
    placeholder: 'Opened the profile in a browser. The bio names the same employer as the seed.',
    hint:
      'A confirmation with no stated basis is indistinguishable from a guess, so the note ' +
      'is required. It is written to the case file and it is what the export cites.',
    icon: 'developed'
  },
  refuted: {
    verb: 'Refute',
    heading: 'Refute this finding',
    prompt: 'What disproved it?',
    placeholder: 'The page 404s. The handle was registered in 2011, four years before the seed.',
    hint:
      'A refuted finding is kept, not deleted — knowing something is false is a result, and ' +
      'the raw capture stays on disk either way.',
    icon: 'refuted',
    tone: 'danger'
  },
  unverified: {
    verb: 'Undo',
    heading: 'Take the verification back',
    prompt: 'Why are you withdrawing it?',
    placeholder: 'The profile I checked was a different account with the same avatar.',
    hint:
      'This does not erase anything. The original decision stays in the confidence log and ' +
      'this withdrawal is appended after it, with your reason.',
    icon: 'latent'
  }
}

/**
 * What a person is allowed to do to a finding sitting at this level.
 *
 * Confirm and Refute are offered from anywhere except where the finding already is —
 * `promote()` rejects a no-op transition, so offering it would only produce an error. The
 * withdrawal is offered from every level above the default, `corroborated` included: a
 * human noticing that two "independent" sources are the same site behind a CDN is exactly
 * the correction the rule cannot make for itself.
 */
export function actionsFor(confidence: Confidence): VerifyAction[] {
  const out: VerifyAction[] = []
  if (confidence !== 'confirmed') out.push('confirmed')
  if (confidence !== 'refuted') out.push('refuted')
  if (confidence !== 'unverified') out.push('unverified')
  return out
}

/**
 * Confirm / Refute / Undo, with the mandatory note.
 *
 * Rendered twice per selected finding, in two sizes: full in the margin panel and
 * `compact` in the row that opens under the findings table. They are the same control
 * because they are the same decision — the table is where the operator is looking when
 * they decide, and the panel is where the reasoning lives, and an app that only offers
 * the action in one of those two places is an app where half the sessions never verify
 * anything.
 */
export function VerifyControl({
  finding,
  caseId,
  onVerified,
  compact = false
}: {
  finding: Finding
  caseId: string
  /** Handed the finding as the main process wrote it, never a locally patched copy. */
  onVerified: (updated: Finding) => void
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState<VerifyAction | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A different finding is a different decision. Leaving a half-typed note attached to
  // the next row is the one bug in this control that could put a false note in a case
  // file, so the form is torn down on every identity change.
  useEffect(() => {
    setOpen(null)
    setNote('')
    setBusy(false)
    setError(null)
  }, [finding.id])

  const submit = useCallback(
    async (to: VerifyAction) => {
      const text = note.trim()
      if (!text) return
      setBusy(true)
      setError(null)
      try {
        const updated = await window.osint.findings.promote({
          caseId,
          findingId: finding.id,
          to,
          // Always. This control is the human path and has no other mode; corroboration
          // is evidence-driven and does not come from a button.
          actor: 'human',
          note: text
        })
        setOpen(null)
        setNote('')
        onVerified(updated)
      } catch (err) {
        // ConfidenceError messages already say precisely which rule refused and why.
        // Rewriting them into "Something went wrong" would throw away the only part of
        // this app that explains itself.
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [caseId, finding.id, note, onVerified]
  )

  const spec = open ? ACTIONS[open] : null
  const ready = note.trim().length > 0

  return (
    <div className={compact ? 'verify verify--compact' : 'verify'}>
      {!open && (
        <div className="verify__actions">
          {actionsFor(finding.confidence).map((a) => (
            <button
              key={a}
              type="button"
              className={ACTIONS[a].tone === 'danger' ? 'btn btn--danger' : 'btn'}
              onClick={() => {
                setOpen(a)
                setError(null)
              }}
              title={ACTIONS[a].hint}
            >
              <Icon name={ACTIONS[a].icon} size={11} />
              <span>{ACTIONS[a].verb}</span>
            </button>
          ))}
        </div>
      )}

      {open && spec && (
        <form
          className="verify__form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit(open)
          }}
        >
          <p className="verify__heading">{spec.heading}</p>
          <div className="field">
            <label className="label" htmlFor={`verify-note-${compact ? 'row' : 'panel'}`}>
              {spec.prompt}
            </label>
            <textarea
              id={`verify-note-${compact ? 'row' : 'panel'}`}
              className="textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={spec.placeholder}
              rows={compact ? 2 : 3}
              autoFocus
              disabled={busy}
              onKeyDown={(e) => {
                // Escape backs out. Ctrl/Cmd+Enter commits, because the note is a
                // paragraph and Enter has to stay a newline inside it.
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setOpen(null)
                  setNote('')
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ready) {
                  e.preventDefault()
                  void submit(open)
                }
              }}
            />
            <p className="hint">{spec.hint}</p>
          </div>
          <div className="verify__actions">
            <button
              type="submit"
              className={spec.tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary'}
              disabled={!ready || busy}
              data-loading={busy ? 'true' : undefined}
              title={ready ? undefined : 'The note is required.'}
            >
              {busy ? 'Writing to the case file…' : spec.verb}
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => {
                setOpen(null)
                setNote('')
                setError(null)
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ corroboration */

/**
 * The evidence-driven half: how many independent sources currently stand behind this
 * exact claim, and the offer to act on it when there are enough.
 *
 * This is deliberately *not* shaped like the buttons above it. Confirm and Refute ask the
 * operator what they believe; this asks the index a question with a factual answer and
 * shows the answer whether or not it is good news. The count is on screen even at one
 * source — especially at one source — because "one tool said so, and nothing else has"
 * is the single most useful sentence this app can put next to a claim, and it was
 * previously nowhere in the UI at all.
 *
 * The button, when it appears, carries `actor: 'corroborator'`. That is not a loophole in
 * the human-only rule for `confirmed`: `promote()` refuses `corroborated` to a human
 * actor and refuses it to a corroborator without two distinct `independenceKey(source)`
 * values, so pressing it cannot manufacture a level the evidence does not already
 * support. It re-runs the rule; it does not vouch.
 *
 * Independence is counted by **origin, not by tool**. Sherlock and Maigret both probing
 * github.com is one source, and the copy says so, because the whole reason this level
 * exists is that two wrappers around the same site list agreeing about an anti-bot
 * redirect is the failure mode rather than the guard.
 */
export function CorroborationOffer({
  finding,
  caseId,
  candidates,
  loading,
  onVerified
}: {
  finding: Finding
  caseId: string
  /** Findings making the same claim about the same entity from a different source. */
  candidates: readonly Finding[]
  loading: boolean
  onVerified: (updated: Finding) => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [finding.id])

  // The finding itself is one source; each candidate is counted by origin, so two
  // candidates on the same host still total two.
  const sources = useMemo(() => {
    const keys = new Set<string>([independenceKey(finding.source)])
    for (const c of candidates) keys.add(independenceKey(c.source))
    keys.delete('')
    return [...keys].sort()
  }, [finding.source, candidates])

  const enough = sources.length >= CORROBORATION_THRESHOLD

  const corroborate = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const updated = await window.osint.findings.promote({
        caseId,
        findingId: finding.id,
        to: 'corroborated',
        actor: 'corroborator',
        // Named explicitly rather than left to the main process to rediscover, so what
        // the operator was shown is exactly what the rule is asked to weigh.
        supportingFindingIds: candidates.map((c) => c.id)
      })
      onVerified(updated)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [caseId, finding.id, candidates, onVerified])

  if (loading) return null

  return (
    <div className="corrob">
      <p className="corrob__count">
        <span className="corrob__n conf-ink">{sources.length}</span>
        <span>
          independent source{sources.length === 1 ? '' : 's'} behind this claim, counted by
          origin rather than by tool.
        </span>
      </p>
      <p className="corrob__sources">
        {sources.map((s, i) => (
          <span key={s}>
            {i > 0 && <span className="dot-sep">·</span>}
            <span className="data">{s}</span>
          </span>
        ))}
      </p>

      {/* Offered only where it can succeed: at two sources, and only from below the
          level. Showing a button that the rule is certain to refuse would teach the
          operator that the rule is noise. */}
      {enough && finding.confidence === 'unverified' && (
        <button
          type="button"
          className="btn"
          onClick={() => void corroborate()}
          disabled={busy}
          data-loading={busy ? 'true' : undefined}
          title="Ask the rule to weigh these sources. It refuses unless at least two of them are genuinely distinct origins."
        >
          <Icon name="developing" size={11} />
          <span>{busy ? 'Weighing the sources…' : 'Corroborate'}</span>
        </button>
      )}

      {!enough && finding.confidence === 'unverified' && (
        <p className="hint">
          Corroboration needs a second, independent origin making the same claim. Until then
          this stays unverified, which is where most findings correctly stay.
        </p>
      )}

      {error && (
        <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ history */

/**
 * Every confidence change this finding has been through, oldest first.
 *
 * This exists because `corroborated` was, until it was rendered here, a level with no
 * evidence of itself anywhere in the running app: it is computed from two findings with
 * distinct sources, and the operator saw the word change with no way to ask *which two*.
 * A level that appears without saying what produced it is indistinguishable from a bug,
 * and in an app built around the claim that two tools reading the same site is one
 * source, the sources are the whole substance of the transition.
 *
 * So each entry names the actor, the sources it counted, when, and — for a human — the
 * note that was the evidence. Nothing here is editable; the log is append-only on disk
 * and this is a window onto it.
 */
export function ConfidenceHistory({
  changes,
  loading,
  error
}: {
  changes: readonly ConfidenceChange[]
  loading: boolean
  error: string | null
}): React.JSX.Element | null {
  const ordered = useMemo(
    () => [...changes].sort((a, b) => a.at.localeCompare(b.at)),
    [changes]
  )

  if (error) {
    return (
      <div className="verify-log">
        <h3 className="verify-log__title">How this level was reached</h3>
        <Notice state="danger" label="Unreadable">
          {error} The finding is intact; only its confidence log could not be read.
        </Notice>
      </div>
    )
  }

  // Silence while it loads, and silence when a finding has never moved. An
  // "unverified, never changed" finding is the overwhelming majority of every case and a
  // permanent empty panel section for it would be noise on every row.
  if (loading || ordered.length === 0) return null

  return (
    <div className="verify-log">
      <h3 className="verify-log__title">How this level was reached</h3>
      <ol className="verify-log__list">
        {ordered.map((c) => (
          <li key={c.id} className="verify-log__entry" data-confidence={c.to}>
            <div className="verify-log__head">
              <span className="conf verify-log__level">
                <Icon name={LEVELS[c.to].icon} className="conf__glyph" size={11} />
                <span className="conf__word">{LEVELS[c.to].label}</span>
              </span>
              <span className="verify-log__at data">{stamp(c.at)}</span>
            </div>
            <p className="verify-log__by">{describeChange(c)}</p>
            {/* The sources are the substance of a corroboration and the only way to
                audit one. Shown as data, because they are hostnames you compare
                character by character. */}
            {c.independentSources.length > 0 && (
              <p className="verify-log__sources">
                {c.independentSources.map((s, i) => (
                  <span key={s}>
                    {i > 0 && <span className="dot-sep">·</span>}
                    <span className="data">{s}</span>
                  </span>
                ))}
              </p>
            )}
            {c.note && <p className="verify-log__note">{c.note}</p>}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * One sentence naming who moved it and on what basis.
 *
 * `corroborator` is spelled out as a count of *sources*, never of tools or findings. The
 * distinction is the rule: two tools reading github.com is one source, and a sentence
 * that said "2 tools agreed" would describe the exact failure the level exists to
 * prevent.
 */
function describeChange(c: ConfidenceChange): string {
  const n = c.independentSources.length
  const from = `from ${LEVELS[c.from].label}`
  if (c.actor === 'human') {
    return c.to === 'unverified'
      ? `Withdrawn by you, ${from}.`
      : `Set by you, ${from}. No amount of tool agreement produces this level.`
  }
  if (c.actor === 'corroborator') {
    return (
      `Computed automatically ${from}: ${n} independent source${n === 1 ? '' : 's'} ` +
      `made this claim, counted by origin rather than by tool.`
    )
  }
  return `Changed ${from} by ${c.actor}.`
}

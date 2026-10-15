import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ExposureReport,
  RescanDiff,
  SeedFieldId,
  SelfAuditDelta as Delta,
  SelfAuditLevel,
  SelfAuditState
} from '../../../shared/selfaudit'
import { SELF_AUDIT_LEVELS, seedField } from '../../../shared/selfaudit'
import { Data } from './Data'
import { EmptyState, Loading, Notice } from './Feedback'
import { Icon } from './Icon'
import { SelfAuditDelta } from './SelfAuditDelta'
import { SelfAuditLetters } from './SelfAuditLetters'
import { SelfAuditLevelPanel } from './SelfAuditLevels'
import { SelfAuditReport } from './SelfAuditReport'
import { SelfAuditSeeds } from './SelfAuditSeeds'
import { SelfAuditSpine } from './SelfAuditSpine'
import { nextStep, SelfAuditStep } from './SelfAuditStep'
import { plural, stampMinute } from '../lib/format'

type Tab = 'delta' | 'exposure' | 'rescan' | 'letters'

const TABS: { id: Tab; label: string }[] = [
  { id: 'delta', label: 'Delta' },
  { id: 'exposure', label: 'Exposure' },
  { id: 'rescan', label: 'Re-scan' },
  { id: 'letters', label: 'Letters' }
]

/**
 * Self-Audit: what an adversary finds, at each level of what they already know.
 *
 * The layout is a procedure, top to bottom, and it was not always. It used to be five
 * panels the operator had to assemble in the right order out of his own head — fill the
 * vault, scroll back up past it to the ladder, select a rung, expand a panel, find the run
 * button — and every step sent him backwards to somewhere he had already been. He said so
 * plainly: *"you enter your information, then you have to go up and go to see something,
 * and then you run the thing. Not straightforward to use."*
 *
 * What is on screen now, in reading order:
 *
 *   1. **The rail.** Five rungs, always visible, outside the scrollport. It answers "where
 *      am I and what is next" without scrolling anywhere, which is the question the old
 *      layout made him scroll to answer.
 *   2. **The next step.** One card, one primary button, computed from the state. When a
 *      level needs a seed it asks for that seed and says what it buys; when it has its
 *      seeds it offers to run; when everything has run it points at the delta.
 *   3. **The vault**, open only when it is the thing being asked for — and its own footer
 *      turns into the run button the moment a save lands, so the action after typing is
 *      under the cursor rather than back at the top.
 *   4. **The selected level's detail**, then the delta, and only then the report.
 *      DECISIONS.md is explicit that the delta is the interesting output and the totals
 *      are not, so the delta is the default tab and the report sits behind it.
 *
 * Everything here obeys the same confidence rules as the rest of the app. Nothing is
 * promoted because the subject is you, and a tool that was refused never reads as a tool
 * that found nothing.
 */
export function SelfAuditView(): React.JSX.Element {
  const [state, setState] = useState<SelfAuditState | null>(null)
  const [level, setLevel] = useState<SelfAuditLevel>(0)
  const [tab, setTab] = useState<Tab>('delta')
  const [delta, setDelta] = useState<Delta | null>(null)
  const [report, setReport] = useState<ExposureReport | null>(null)
  const [rescan, setRescan] = useState<RescanDiff | null>(null)
  const [seedsOpen, setSeedsOpen] = useState(false)
  const [focusField, setFocusField] = useState<SeedFieldId | null>(null)
  const [starting, setStarting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const tabsRef = useRef<HTMLDivElement | null>(null)

  const refreshState = useCallback(async () => {
    try {
      setState(await window.osint.selfAudit.state())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshState()
  }, [refreshState])

  // An empty vault is the one state where the form is the whole task, so it opens itself.
  // Once there is something in it the step card drives, and the vault stays out of the way
  // until the card asks for a specific field.
  const hasProfile = state?.hasProfile ?? false
  useEffect(() => {
    if (state && !hasProfile) setSeedsOpen(true)
  }, [state, hasProfile])

  /* A level's sweep pushes state as each check settles. Reloading the whole self-audit
     state on every push is cheap — it reads five small snapshot headers — and it is what
     keeps the rail's counts honest while the run is in flight. */
  useEffect(() => {
    return window.osint.selfAudit.onRun((run) => {
      setState((prev) => (prev ? { ...prev, run } : prev))
      if (run.phase === 'done' || run.phase === 'failed' || run.phase === 'cancelled') {
        void refreshState()
      }
    })
  }, [refreshState])

  const latestAt = state?.levels.find((l) => l.level === level)?.latest?.at ?? null

  useEffect(() => {
    let live = true
    setDelta(null)
    setReport(null)
    setRescan(null)
    if (!latestAt) return
    void Promise.all([
      window.osint.selfAudit.delta(level),
      window.osint.selfAudit.report(level),
      window.osint.selfAudit.lastRescan(level)
    ])
      .then(([d, r, rs]) => {
        if (!live) return
        setDelta(d)
        setReport(r)
        setRescan(rs)
      })
      .catch((err) => {
        if (live) setError((err as Error).message)
      })
    return () => {
      live = false
    }
  }, [level, latestAt])

  const runLevel = useCallback(
    async (target: SelfAuditLevel): Promise<void> => {
      setError(null)
      setLevel(target)
      setStarting(true)
      try {
        await window.osint.selfAudit.run({ level: target })
        await refreshState()
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setStarting(false)
      }
    },
    [refreshState]
  )

  const openSeed = useCallback((field: SeedFieldId, target: SelfAuditLevel): void => {
    setLevel(target)
    setSeedsOpen(true)
    // Re-set on every request, so asking for the same field twice still moves the caret.
    setFocusField(null)
    window.setTimeout(() => setFocusField(field), 0)
  }, [])

  const readDelta = useCallback((target: SelfAuditLevel): void => {
    setLevel(target)
    setTab('delta')
    window.setTimeout(() => tabsRef.current?.scrollIntoView({ block: 'start' }), 0)
  }, [])

  if (loading) {
    return (
      <div className="view">
        <header className="view__head">
          <h1 className="view__title">Self-Audit</h1>
        </header>
        <div className="view__scroll">
          <div className="view__body view__body--pad">
            <Loading what="the seed vault and the five levels" />
          </div>
        </div>
      </div>
    )
  }

  const spec = SELF_AUDIT_LEVELS.find((l) => l.level === level)
  const levelState = state?.levels.find((l) => l.level === level)
  const step = state ? nextStep(state.profile, state.levels, state.run) : { kind: 'empty' as const }
  const stepLevel = step.kind === 'empty' ? 0 : step.level
  const runnable =
    state?.levels.find((l) => l.level === stepLevel)?.missing.length === 0 &&
    step.kind !== 'read' &&
    step.kind !== 'running'

  return (
    <div className="view">
      <header className="view__head">
        <h1 className="view__title">Self-Audit</h1>
        <span className="view__subtitle">
          {state?.hasProfile
            ? `${state.levels.filter((l) => l.latest).length} of 5 levels run`
            : 'the seed vault is empty'}
        </span>
      </header>

      {/* Outside the scrollport on purpose: the ladder is where you are, and where you are
          must not scroll away from you. */}
      {state && (
        <SelfAuditSpine
          levels={state.levels}
          selected={level}
          next={step.kind === 'read' ? null : stepLevel}
          run={state.run}
          onSelect={setLevel}
        />
      )}

      <div className="view__scroll">
        {error && (
          <Notice state="danger" label="Failed" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}

        {state && (
          <SelfAuditStep
            step={step}
            levels={state.levels}
            starting={starting}
            onSeed={openSeed}
            onRun={(l) => void runLevel(l)}
            onRead={readDelta}
          />
        )}

        <section className="panel">
          <div className="panel__head">
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => setSeedsOpen((v) => !v)}
              aria-expanded={seedsOpen}
            >
              <Icon name={seedsOpen ? 'chevron-down' : 'chevron-right'} />
              <span className="panel__title">Seed vault</span>
            </button>
            <span>
              {state && seedTotal(state) > 0
                ? `${plural(seedTotal(state), 'value')} across ${plural(seedFieldsUsed(state), 'field')}`
                : 'what you are willing to tell it about yourself'}
            </span>
          </div>
          {seedsOpen && state && (
            <SelfAuditSeeds
              profile={state.profile}
              vaultPath={state.vaultPath}
              focusField={focusField}
              /* The whole point of the footer: after a save the next action is under the
                 cursor instead of back at the top of the page. */
              runLabel={runnable ? `Run ${SELF_AUDIT_LEVELS[stepLevel]!.code}` : null}
              runHint={
                runnable
                  ? `${SELF_AUDIT_LEVELS[stepLevel]!.code} is the next rung: ${SELF_AUDIT_LEVELS[stepLevel]!.adds}.`
                  : step.kind === 'seed'
                    ? `${SELF_AUDIT_LEVELS[stepLevel]!.code} still needs ${seedField(step.field).label.toLowerCase()}.`
                    : null
              }
              starting={starting}
              onRun={() => void runLevel(stepLevel)}
              onSaved={() => void refreshState()}
            />
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">
              {spec?.code} · {spec?.adds}
            </span>
            <span>{spec?.simulates}</span>
          </div>
          {state && (
            <SelfAuditLevelPanel
              level={level}
              state={levelState ?? null}
              run={state.run && state.run.level === level ? state.run : null}
              onRan={() => void refreshState()}
            />
          )}
        </section>

        <div className="sa-tabs" ref={tabsRef}>
          <div className="segments">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="btn"
                aria-pressed={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="hint">
            {spec?.code}
            {levelState?.latest
              ? ` · last run ${stampMinute(levelState.latest.at)}`
              : ' · never run'}
            {levelState?.caseId ? (
              <>
                {' · '}
                <Data>{levelState.caseId}</Data>
              </>
            ) : null}
          </span>
        </div>

        <div className="view__body">
          {tab === 'delta' && <SelfAuditDelta delta={delta} />}
          {tab === 'exposure' && <SelfAuditReport report={report} />}
          {tab === 'rescan' && (
            <Rescan level={level} diff={rescan} onRan={() => void refreshState()} />
          )}
          {tab === 'letters' && <SelfAuditLetters report={report} />}
        </div>
      </div>
    </div>
  )
}

function seedTotal(state: SelfAuditState): number {
  return Object.values(state.profile.values).reduce((n, v) => n + v.length, 0)
}

function seedFieldsUsed(state: SelfAuditState): number {
  return Object.values(state.profile.values).filter((v) => v.length > 0).length
}

/**
 * The re-scan diff.
 *
 * The only page in the app that can answer "did the removal request work", and the answer
 * is nearly always "we cannot tell yet". A claim that disappeared while its tool was being
 * refused is not a claim that was removed, and the two are kept in separate lists rather
 * than summed into a reassuring number.
 */
function Rescan({
  level,
  diff,
  onRan
}: {
  level: SelfAuditLevel
  diff: RescanDiff | null
  onRan: () => void
}): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setError(null)
    setRunning(true)
    try {
      await window.osint.selfAudit.rescan({ level })
      onRan()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="sa-section">
      <h3 className="sa-section__title">Re-scan</h3>
      <p className="sa-section__lede">
        Runs L{level} again and diffs it against the previous run of the same level. This is
        how you find out whether a deletion request actually took effect — and, more often,
        whether the tool was simply refused this time and the disappearance means nothing.
      </p>

      {error && (
        <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      <div className="runbar" style={{ marginTop: 'var(--space-3)' }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void run()}
          disabled={running}
          data-loading={running ? 'true' : undefined}
        >
          {running ? 'Re-scanning…' : `Re-scan L${level} now`}
        </button>
        <span className="hint">Writes a new snapshot and compares it with the last one.</span>
      </div>

      {!diff ? (
        <div style={{ marginTop: 'var(--space-6)' }}>
          <EmptyState
            title="Only one run of this level so far."
            body={[
              'A diff needs two snapshots of the same level. Run it once, do something about what it found, then run it again — the case folder and the content-addressed finding ids make the comparison exact rather than approximate.',
              'The interesting column is not what disappeared. It is what disappeared while the tool that used to report it was still answering, because that is the only kind of disappearance that supports "the request worked".'
            ]}
            exampleLabel="What a second run tells you"
            example={'3 disappeared — 2 because holehe was refused this time.\n1 while it was answering normally.'}
          />
        </div>
      ) : (
        <>
          <p className="sa-headline" style={{ marginTop: 'var(--space-5)' }}>
            {diff.verdict}
          </p>

          <div className="runbar" style={{ marginTop: 'var(--space-3)' }}>
            <span className="hint">
              {stampMinute(diff.previous.at)} → {stampMinute(diff.current.at)}
            </span>
          </div>

          {diff.unexplained.length > 0 && (
            <>
              <p className="label" style={{ marginTop: 'var(--space-6)' }}>
                Gone while the tool was answering
              </p>
              <div className="sa-section__panel">
                <div className="sa-rows">
                  {diff.unexplained.map((f) => (
                    <div className="sa-row" key={f.id}>
                      <span className="sa-row__lead">
                        <Data>{f.sourceKey}</Data>
                      </span>
                      <span className="sa-row__body">{f.claim}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {diff.explainedBySilence.length > 0 && (
            <>
              <p className="label" style={{ marginTop: 'var(--space-6)' }}>
                Gone because nothing looked
              </p>
              <div className="sa-section__panel">
                <div className="sa-rows">
                  {diff.explainedBySilence.map(({ finding, because }) => (
                    <div className="sa-row sa-row--silent" key={finding.id}>
                      <span className="sa-row__lead">
                        <Data>{finding.sourceKey}</Data>
                      </span>
                      <span className="sa-row__body">
                        {finding.claim} <strong>Not evidence of removal:</strong> {because}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {diff.appeared.length > 0 && (
            <>
              <p className="label" style={{ marginTop: 'var(--space-6)' }}>
                New since last time
              </p>
              <div className="sa-section__panel">
                <div className="sa-rows">
                  {diff.appeared.map((f) => (
                    <div className="sa-row" key={f.id}>
                      <span className="sa-row__lead">
                        <Data>{f.sourceKey}</Data>
                      </span>
                      <span className="sa-row__body">{f.claim}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}

      <div className="sa-foot" />
    </div>
  )
}

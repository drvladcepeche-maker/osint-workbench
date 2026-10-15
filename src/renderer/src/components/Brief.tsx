import { useCallback, useEffect, useState } from 'react'
import type {
  BriefItem,
  BriefQuestion,
  InvestigationBrief,
  InvestigationRunState,
  PlannedAction,
  ProvenanceChain,
  StopCondition
} from '../../../shared/engine'
import { MECHANISM_MEANING, STOP_LABEL } from '../../../shared/engine'
import { plural } from '../lib/format'
import { Data } from './Data'
import { EmptyState, Notice } from './Feedback'
import { Icon } from './Icon'
import { ExternalLink } from './Link'

/**
 * The brief.
 *
 * The whole point of the engine is that this replaces the review queue. The operator
 * should answer two or three questions per investigation, not scroll ninety rows, so the
 * questions come first and everything else is the state summary underneath them.
 *
 * Written in PRODUCT.md's voice throughout: patient, exacting, unimpressed. It never
 * celebrates a lead and never dramatises a contradiction. Every number the engine shows is
 * one it counted, and every automatic decision carries the sentence that explains it —
 * including the ones that decided *against* doing something, because an engine that
 * silently prunes teaches nothing.
 */
export function Brief({
  caseId,
  onChanged
}: {
  caseId: string
  onChanged: () => void
}): React.JSX.Element {
  const [brief, setBrief] = useState<InvestigationBrief | null>(null)
  const [run, setRun] = useState<InvestigationRunState | null>(null)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([window.osint.engine.brief(caseId), window.osint.engine.state()])
      setBrief(b)
      setRun(s && s.caseId === caseId ? s : null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [caseId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The loop settles a run every few seconds for minutes; the state is pushed rather than
  // polled, and the brief is re-read whenever a run finishes so the summary is never a
  // snapshot of a state that has moved on.
  useEffect(() => {
    return window.osint.engine.onRun((state) => {
      if (state.caseId !== caseId) return
      setRun(state)
      if (state.phase === 'done' || state.phase === 'stopped' || state.phase === 'failed') {
        void refresh()
        onChanged()
      }
    })
  }, [caseId, refresh, onChanged])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setRun(await window.osint.engine.run({ caseId }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    try {
      await window.osint.engine.cancel()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /**
   * The one decision that stays a human act, permanently.
   *
   * "Yes" promotes the candidate into the graph — the same explicit promotion the review
   * queue has always required, reached from the question instead of from a table. "No"
   * dismisses it, which is recoverable: the record stays in the case and says a person
   * looked and said no.
   */
  const answer = async (q: BriefQuestion, yes: boolean): Promise<void> => {
    setDeciding(q.node.id)
    setError(null)
    try {
      if (yes) await window.osint.candidates.promote({ caseId, candidateId: q.node.id })
      else await window.osint.candidates.dismiss({ caseId, candidateId: q.node.id })
      setNotice(
        yes
          ? `${q.node.label} is in the case. The claims the engine already wrote about it now belong to it, and it can be expanded one hop further than an unconfirmed lead.`
          : `${q.node.label} dismissed. The record stays in the case; nothing was deleted.`
      )
      await refresh()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeciding(null)
    }
  }

  const prune = async (chain: ProvenanceChain): Promise<void> => {
    setDeciding(chain.node.id)
    try {
      const result = await window.osint.engine.prune({
        caseId,
        nodeId: chain.node.id,
        reason: 'Cut by hand from the routes list.'
      })
      setNotice(
        `Cut ${plural(result.cut.length, 'node')}${result.candidatesDismissed ? `, dismissing ${plural(result.candidatesDismissed, 'candidate')}` : ''}. ` +
          (result.entitiesAffected.length
            ? `${plural(result.entitiesAffected.length, 'entity', 'entities')} under the cut are in the case and were left alone — removing one orphans its findings, and that is yours to decide.`
            : 'Nothing was deleted; restoring the node puts every one of them back.')
      )
      await refresh()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeciding(null)
    }
  }

  const restore = async (chain: ProvenanceChain): Promise<void> => {
    setDeciding(chain.node.id)
    try {
      const result = await window.osint.engine.restore(caseId, chain.node.id)
      setNotice(`Restored ${plural(result.cut.length, 'node')}. The cut said: ${result.reason}`)
      await refresh()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeciding(null)
    }
  }

  const running = run?.phase === 'planning' || run?.phase === 'running' || run?.phase === 'summarising'

  return (
    <section className="panel brief">
      <div className="panel__head">
        <button type="button" className="btn btn--quiet" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="panel__title">Investigation</span>
        </button>
        <span className="brief__headline">{brief?.headline ?? 'Reading the case.'}</span>
        <div className="brief__actions">
          {running ? (
            <button type="button" className="btn" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => void start()} disabled={busy}>
              {brief?.neverRun ? 'Run the engine' : 'Continue'}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="panel__body">
          {error && (
            <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
          {notice && (
            <Notice state="info" label="Done" onDismiss={() => setNotice(null)}>
              {notice}
            </Notice>
          )}

          {running && run && <RunLine run={run} />}

          {!brief && <p className="brief__note">Reading the case.</p>}

          {brief?.neverRun && !running && (
            <EmptyState
              title="The engine has not run on this case"
              body={[
                'It starts from what you supplied and follows what two independent sources agree on — plus one link per route that the subject published as their own, read once to find out whether anything at the far end agrees. It stops when the budget, the depth cap, or the fact that it has stopped finding anything new says so.',
                'It never puts anything in the case. A lead it is sure of gets probed as a provisional subject and stays outside the graph until you promote it, because a wrong promotion poisons everything below it and gets more convincing with depth.'
              ]}
              exampleLabel="What it will bring back"
              example="4 established, 5 pending, 2 contradicted. 2 questions for you."
            />
          )}

          {brief && !brief.neverRun && (
            <>
              <Questions
                questions={brief.questions}
                total={brief.questionsTotal}
                deciding={deciding}
                onAnswer={(q, yes) => void answer(q, yes)}
              />
              <Next actions={brief.next} blocked={brief.blocked} />
              <State brief={brief} />
              <Stops stops={brief.stops.conditions} />
              <Routes
                chains={brief.chains}
                deciding={deciding}
                onPrune={(c) => void prune(c)}
                onRestore={(c) => void restore(c)}
              />
              <Decisions brief={brief} />
            </>
          )}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

/**
 * Honest progress: what has been spent, what is running right now, and the counts. A
 * spinner would be a lie about a loop that takes minutes.
 */
function RunLine({ run }: { run: InvestigationRunState }): React.JSX.Element {
  const now = run.running[0]
  return (
    <div className="brief__live">
      <span className="run__line">
        {run.runsUsed} / {run.budget.maxRuns} runs · {run.depthReached} hops · {run.leads.expanded} expanded ·{' '}
        {run.leads.probed} read once · {run.leads.asked} for you
      </span>
      {now && (
        <span className="run__target">
          {now.adapterId} → {now.nodeLabel}
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * The questions
 * ------------------------------------------------------------------ */

function Questions({
  questions,
  total,
  deciding,
  onAnswer
}: {
  questions: BriefQuestion[]
  total: number
  deciding: string | null
  onAnswer: (q: BriefQuestion, yes: boolean) => void
}): React.JSX.Element {
  if (!questions.length) {
    return (
      <section className="brief__block">
        <h3 className="brief__h">Nothing is waiting on you</h3>
        <p className="brief__note">
          Every lead the engine reached it could settle on its own: corroborated by two independent sources,
          contradicted by your seeds, or read once on a link the subject published and still sitting at one
          source. There is no judgement here that only you can make.
        </p>
      </section>
    )
  }
  return (
    <section className="brief__block">
      <h3 className="brief__h">
        {questions.length === total
          ? `${plural(total, 'question')} for you`
          : `${questions.length} of ${plural(total, 'question')} for you`}
      </h3>
      <p className="brief__note">
        The engine settles what corroboration can settle. Whether an account belongs to the same person has its
        ground truth in your head, and nowhere it can fetch from.
      </p>
      <ul className="brief__questions">
        {questions.map((q) => (
          <li key={q.node.id} className="brief-q">
            <p className="brief-q__ask">{q.question}</p>
            <p className="brief__route">
              <Data title="The route the engine took to reach this, with the mechanism of every hop.">
                {q.route}
              </Data>
            </p>
            <p className="brief__note">{q.why}</p>
            <p className="brief__note">{q.unlocks}</p>
            <div className="brief-q__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={deciding === q.node.id}
                onClick={() => onAnswer(q, true)}
                title="Puts it in the case. This is the promotion the engine is not allowed to make."
              >
                Yes, add it
              </button>
              <button
                type="button"
                className="btn"
                disabled={deciding === q.node.id}
                onClick={() => onAnswer(q, false)}
                title="Records that you looked and said no. The record stays in the case."
              >
                No
              </button>
              {q.url && <ExternalLink href={q.url} title={`Open ${q.url} and look at it yourself — that is the whole of what this question needs`} />}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * What it wants to do next
 * ------------------------------------------------------------------ */

function Next({ actions, blocked }: { actions: PlannedAction[]; blocked: PlannedAction[] }): React.JSX.Element {
  const [shown, setShown] = useState<string | null>(null)
  const [refusals, setRefusals] = useState(false)

  return (
    <section className="brief__block">
      <h3 className="brief__h">What it wants to do next</h3>
      {!actions.length && (
        <p className="brief__note">
          Nothing it is allowed to do. Everything applicable is either already run, past the depth cap, or waiting
          on an answer from you.
        </p>
      )}
      <ul className="brief__list">
        {actions.map((a) => (
          <li key={a.key} className="brief-action">
            <div className="brief-action__head">
              <span className="brief-action__gain" title="Expected gain, 0–100. 40 is “no reason to think either way”.">
                {a.gain}
              </span>
              <span className="brief-action__what">
                {a.adapterTitle} on <Data>{a.node.label || a.node.value}</Data>
              </span>
              <span className="brief-action__meta">
                {a.depth} {a.depth === 1 ? 'hop' : 'hops'} ·{' '}
                <span
                  title={
                    a.basis === 'measured'
                      ? 'Arithmetic over runs this engine has already made in this case.'
                      : 'A documented default written by hand. Nothing has been measured here yet.'
                  }
                >
                  {a.basis}
                </span>
              </span>
              <button
                type="button"
                className="btn btn--quiet"
                aria-expanded={shown === a.key}
                onClick={() => setShown(shown === a.key ? null : a.key)}
              >
                {shown === a.key ? 'Hide the arithmetic' : 'Show the arithmetic'}
              </button>
            </div>
            <p className="brief__note">{a.reason}</p>
            {shown === a.key && (
              <ul className="brief-signals">
                {a.signals.map((s) => (
                  <li key={s.id} className="brief-signal">
                    <span className="brief-signal__points" data-sign={s.points < 0 ? 'minus' : 'plus'}>
                      {s.points > 0 ? `+${s.points}` : s.points}
                    </span>
                    <span className="brief-signal__detail">{s.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {blocked.length > 0 && (
        <>
          <button
            type="button"
            className="btn btn--quiet"
            aria-expanded={refusals}
            onClick={() => setRefusals((v) => !v)}
          >
            <Icon name={refusals ? 'chevron-down' : 'chevron-right'} />
            {plural(blocked.length, 'thing')} it ranked and will not do
          </button>
          {refusals && (
            <ul className="brief__list">
              {blocked.map((a) => (
                <li key={a.key} className="brief-action brief-action--blocked">
                  <div className="brief-action__head">
                    <span className="brief-action__gain">{a.gain}</span>
                    <span className="brief-action__what">
                      {a.adapterTitle} on <Data>{a.node.label || a.node.value}</Data>
                    </span>
                  </div>
                  <p className="brief__note">{a.blocked}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * The state summary
 * ------------------------------------------------------------------ */

const GROUPS: { key: 'established' | 'pending' | 'contradicted' | 'pruned'; title: string; meaning: string }[] = [
  {
    key: 'established',
    title: 'Established',
    meaning:
      'Two independent sources agree, or you confirmed it yourself. Independence is folded to the site operator, so two readings of one site count once.'
  },
  {
    key: 'pending',
    title: 'Pending',
    meaning:
      'Reached, plausible, one source. The honest middle, and where most of a real investigation sits. A lead the engine has been cleared to read once — because the subject published a link to it — is one source too, and stays here until something else agrees.'
  },
  {
    key: 'contradicted',
    title: 'Contradicted',
    meaning:
      'It states something that disagrees with your seeds. Kept and shown, never deleted — the seed could be the thing that is wrong.'
  },
  {
    key: 'pruned',
    title: 'Pruned',
    meaning: 'Cut, with the reason recorded. Restorable from the routes below.'
  }
]

function State({ brief }: { brief: InvestigationBrief }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>('established')
  return (
    <section className="brief__block">
      <h3 className="brief__h">Where the case stands</h3>
      {GROUPS.map((g) => {
        const items = brief[g.key]
        if (!items.length) return null
        const isOpen = open === g.key
        return (
          <div key={g.key} className="brief-group">
            <button
              type="button"
              className="btn btn--quiet brief-group__head"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : g.key)}
            >
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />
              <span className="brief-group__title">{g.title}</span>
              <span className="brief-group__count">{items.length}</span>
            </button>
            {isOpen && (
              <>
                <p className="brief__note">{g.meaning}</p>
                <ul className="brief__list">
                  {items.map((i) => (
                    <Item key={i.node.id} item={i} />
                  ))}
                </ul>
              </>
            )}
          </div>
        )
      })}
    </section>
  )
}

function Item({ item }: { item: BriefItem }): React.JSX.Element {
  return (
    <li className="brief-item">
      <div className="brief-item__head">
        <Data>{item.node.label || item.node.value}</Data>
        <span className="brief-item__meta">
          {item.node.kind} · {item.depth} {item.depth === 1 ? 'hop' : 'hops'} ·{' '}
          {plural(item.independentSources, 'source')}
          {!item.inGraph && ' · not in the case'}
        </span>
      </div>
      {item.route && (
        <p className="brief__route">
          <Data>{item.route}</Data>
        </p>
      )}
      <p className="brief__note">{item.note}</p>
    </li>
  )
}

/* ------------------------------------------------------------------ *
 * Stops
 * ------------------------------------------------------------------ */

/**
 * All four conditions, whether or not they fired, with how close each one is.
 *
 * Headroom rather than only the ending: knowing the run stopped one expansion short of the
 * novelty window is worth more than knowing that it stopped. The bar is a plain rule in
 * neutral ink — this is a budget, not a threat level, and DESIGN.md bans the second.
 */
function Stops({ stops }: { stops: StopCondition[] }): React.JSX.Element {
  const shown = stops.filter((s) => s.id !== 'exhausted' && s.id !== 'cancelled' && s.id !== 'failed')
  return (
    <section className="brief__block">
      <h3 className="brief__h">Where the budget stands</h3>
      <ul className="brief__list">
        {shown.map((s) => (
          <li key={s.id} className="brief-stop" data-fired={s.fired ? 'true' : undefined}>
            <div className="brief-stop__head">
              {s.fired && <Icon name="warning" className="brief-stop__icon" />}
              <span className="brief-stop__name">{STOP_LABEL[s.id]}</span>
              {s.fired && <span className="brief-stop__flag">stopped the run</span>}
            </div>
            <div
              className="brief-stop__rule"
              role="img"
              aria-label={`${Math.round(s.pressure * 100)}% of the way to stopping`}
            >
              <span className="brief-stop__fill" style={{ transform: `scaleX(${s.pressure.toFixed(3)})` }} />
            </div>
            <p className="brief__note">{s.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

function Routes({
  chains,
  deciding,
  onPrune,
  onRestore
}: {
  chains: ProvenanceChain[]
  deciding: string | null
  onPrune: (c: ProvenanceChain) => void
  onRestore: (c: ProvenanceChain) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!chains.length) return null
  return (
    <section className="brief__block">
      <button type="button" className="btn btn--quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {plural(chains.length, 'route')} — how each thing was reached
      </button>
      {open && (
        <>
          <p className="brief__note">
            A finding two hops out is worth nothing unless you can see what carried each hop. Cutting a node here
            cuts everything whose only route ran through it, and says how many that was.
          </p>
          <ul className="brief__list">
            {chains.map((c) => (
              <li key={c.node.id} className="brief-route" data-pruned={c.pruned ? 'true' : undefined}>
                <p className="brief__route">
                  <Data>{c.line}</Data>
                </p>
                <div className="brief-route__meta">
                  <span>
                    {c.depth} {c.depth === 1 ? 'hop' : 'hops'} · weakest link: {c.weakest}
                    {c.alternates > 0 && ` · ${plural(c.alternates, 'other route')}`}
                    {c.rootIsAnchor && ' · rooted in an anchor'}
                  </span>
                  {c.pruned ? (
                    <button
                      type="button"
                      className="btn btn--quiet"
                      disabled={deciding === c.node.id}
                      onClick={() => onRestore(c)}
                    >
                      Restore
                    </button>
                  ) : (
                    c.depth > 0 && (
                      <button
                        type="button"
                        className="btn btn--quiet"
                        disabled={deciding === c.node.id}
                        onClick={() => onPrune(c)}
                        title="Cuts this node and everything whose only route ran through it. Recoverable."
                      >
                        Cut this branch
                      </button>
                    )
                  )}
                </div>
                {c.hops.length > 1 && (
                  <p className="brief__note">
                    {MECHANISM_MEANING[c.hops[c.hops.length - 1]?.mechanism ?? 'tool-claim']}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * The log
 * ------------------------------------------------------------------ */

function Decisions({ brief }: { brief: InvestigationBrief }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!brief.decisions.length) return null
  return (
    <section className="brief__block">
      <button type="button" className="btn btn--quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        {plural(brief.decisions.length, 'decision')} it made on its own
      </button>
      {open && (
        <ul className="brief__list">
          {brief.decisions.map((d) => (
            <li key={d.id} className="brief-decision">
              <span className="brief-decision__kind">{d.kind}</span>
              <span className="brief-decision__reason">{d.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

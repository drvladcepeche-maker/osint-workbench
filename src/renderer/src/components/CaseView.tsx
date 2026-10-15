import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AdapterInfo,
  CandidateView,
  Entity,
  Finding,
  Job,
  RemovedEntity
} from '../../../shared/types'
import type { CaseSummary, RunPlan, RunPlanRequest } from '../../../shared/ipc'
import {
  anchorEntityIds,
  rankCandidates,
  rankFindings,
  seedContextFrom
} from '../../../shared/ranking'
import {
  handleAdvice,
  seedContextIsEmpty,
  type RelevanceAssessment,
  type SubjectProfile
} from '../../../shared/relevance'
import { plural } from '../lib/format'
import { useNow } from '../lib/hooks'
import { readProgress } from '../lib/progress'
import { Brief } from './Brief'
import { CandidatesPanel } from './Candidates'
import { ConfidenceCount } from './Confidence'
import { CopyValue, Tag } from './Data'
import { EntityAdd } from './EntityAdd'
import { EntityStrip } from './Entities'
import { ExportButton, ExportPanel } from './ExportPanel'
import { EmptyState, Notice } from './Feedback'
import { FindingsTable } from './FindingsTable'
import { Icon } from './Icon'
import { hasRunForm, RunOptionsForm } from './RunOptions'
import { RunLauncher, RunPlanPreview } from './RunPlan'
import { RunProgress } from './RunProgress'
import { RunQueue, waveOf } from './RunQueue'
import { SubjectPanel } from './Subject'
import { CommonHandleNotice } from './CommonHandle'

/**
 * What the margin panel is annotating: one finding and the relevance the case's seeds give
 * it. They travel together so the two cannot disagree by a render — the score is a
 * function of the seeds, and this view is what holds them.
 */
export interface FindingSelection {
  finding: Finding
  relevance: RelevanceAssessment
  /** False when nothing is seeded, so the panel says that instead of showing a number. */
  scored: boolean
}

/**
 * A case: its seeds, the adapters that can be pointed at them, and everything they have
 * asserted so far.
 *
 * The layout puts findings first and keeps them first. Seeds and the adapter launcher
 * are a single collapsible panel above the table rather than a third column, because at
 * 1280px a third column costs the claim text exactly the width it needs to be readable —
 * and the claim is the thing the operator came to read.
 */
export function CaseView({
  summary,
  adapters,
  selectedFindingId,
  onSelectFinding,
  onChanged,
  onVerified,
  verifyEpoch,
  onBack
}: {
  summary: CaseSummary
  adapters: AdapterInfo[]
  selectedFindingId: string | null
  onSelectFinding: (selection: FindingSelection | null) => void
  onChanged: () => void
  /** A finding's confidence changed, here or in the margin panel. */
  onVerified: (updated: Finding) => void
  /**
   * Bumped by the shell on every confidence change, including ones made in the margin
   * panel, which this view does not render and cannot otherwise hear about.
   *
   * A counter rather than a callback ref because the promotion also moves things this
   * view derives from the whole set — the confirmed-candidate count under the review
   * queue, and the planner's reading of the case — so the honest response is to re-read
   * the case, not to patch one row in place.
   */
  verifyEpoch: number
  onBack: () => void
}): React.JSX.Element {
  const [entities, setEntities] = useState<Entity[]>([])
  const [removed, setRemoved] = useState<RemovedEntity[]>([])
  const [candidates, setCandidates] = useState<CandidateView[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  /**
   * The entities a tool button acts on. Multiple, so "Blackbird on the handle and the
   * address" is one action rather than two trips around the launcher.
   *
   * It starts as the first entity, which is exactly the old single-selection behaviour —
   * one entity selected, one click on a tool, one run. Everything wider is opt-in.
   */
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [seedsOpen, setSeedsOpen] = useState(true)
  /**
   * What the operator states about the subject, mirrored locally so the panel does not
   * wait on a round trip to redraw. The case file is the truth; this is the draft between
   * a keystroke and the write settling.
   */
  const [subject, setSubject] = useState<SubjectProfile | undefined>(summary.subject)
  const [error, setError] = useState<string | null>(null)
  /** What the last edit or removal did, in the units it promised. */
  const [notice, setNotice] = useState<string | null>(null)
  /** The adapter whose per-run options are open, if any. */
  const [runForm, setRunForm] = useState<string | null>(null)
  /**
   * The adapters a run will use, once "Pick tools" is on. Null is the default one-click
   * mode, where a tool button runs that tool rather than selecting it.
   *
   * A mode rather than the default, because the default has to stay one click: making the
   * common case cost three clicks to buy the rare intersection case its two is a worse
   * launcher than the one being replaced.
   */
  const [pickedTools, setPickedTools] = useState<ReadonlySet<string> | null>(null)
  /**
   * A staged plan, shown before anything that would start more than one run.
   *
   * The request is kept beside it so committing re-plans the *same question* rather than
   * a reconstruction of its answer. Re-planning is deliberate: a pair that was already
   * queued when the preview was drawn and has since finished should run now, and the
   * preview said so.
   */
  const [staged, setStaged] = useState<{ request: RunPlanRequest; plan: RunPlan } | null>(null)
  const [launching, setLaunching] = useState(false)
  const [decidingId, setDecidingId] = useState<string | null>(null)

  /** Findings produced per job, last seen. See the job-update effect below. */
  const hitCounts = useRef(new Map<string, number>())

  const refresh = useCallback(async () => {
    try {
      const [e, c, f, j, r] = await Promise.all([
        window.osint.entities.list(summary.id),
        window.osint.candidates.list(summary.id, 'pending'),
        query.trim()
          ? window.osint.findings.search(summary.id, query)
          : window.osint.findings.list(summary.id),
        window.osint.jobs.list(summary.id),
        window.osint.entities.removed(summary.id)
      ])
      setEntities(e)
      setCandidates(c)
      setFindings(f)
      setJobs(j)
      setRemoved(r)
      // Keep the selection pointed at things that still exist, and seed it with the first
      // entity so a fresh case behaves exactly as it did before selection was a set.
      setSelection((prev) => {
        const live = new Set(e.map((x) => x.id))
        const kept = new Set([...prev].filter((id) => live.has(id)))
        if (kept.size === 0 && e[0]) kept.add(e[0].id)
        return kept
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
    // `verifyEpoch` is a read trigger, not a value this body uses: a confidence change
    // rewrites findings.jsonl and the index, and every derived count in this view has to
    // be re-read from the same source the table is.
  }, [summary.id, query, verifyEpoch])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    setSubject(summary.subject)
  }, [summary.subject])

  /*
   * Progress is pushed, never polled.
   *
   * Findings are re-read on two triggers: when a job settles, and when a running job's
   * `findingIds` grows. The second is what lets results appear while a tool is still
   * working — and it costs nothing for an adapter that produces everything at once,
   * because the array simply does not grow until the end.
   *
   * Worth being straight about: with the current orchestrator, `parse()` runs after the
   * child process exits, so a spawn-based adapter like maigret cannot in fact emit
   * findings mid-run. The 20ms stagger then plays over the batch that lands when the job
   * settles, in the order the parser emitted them — which is the order the tool found
   * them, so it is still arrival order and not decoration. An adapter that reports
   * incrementally will stream properly through the same path with no change here.
   */
  useEffect(() => {
    return window.osint.jobs.onUpdate((job) => {
      if (job.caseId !== summary.id) return

      // Growth is measured against a ref rather than inside the state updater: React
      // invokes updaters twice in StrictMode, and the second pass would compare the job
      // against itself and always report no growth.
      const before = hitCounts.current.get(job.id) ?? 0
      const grew = job.findingIds.length > before
      hitCounts.current.set(job.id, job.findingIds.length)

      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id)
        if (idx < 0) return [job, ...prev]
        const next = [...prev]
        next[idx] = job
        return next
      })
      if (grew || ['done', 'failed', 'cancelled', 'timeout'].includes(job.state)) {
        void refresh()
        onChanged()
      }
    })
  }, [summary.id, refresh, onChanged])

  const activeJobs = useMemo(
    () => jobs.filter((j) => j.state === 'queued' || j.state === 'running'),
    [jobs]
  )
  const now = useNow(activeJobs.length > 0)

  /* The safelight lands on the row for the site being hit right now — when that site has
     already produced a finding. No live run, no amber anywhere. */
  const probingId = useMemo(() => {
    const running = activeJobs.find((j) => j.state === 'running')
    if (!running) return null
    const target = readProgress(running).target
    if (!target) return null
    const hit = findings.find((f) => f.source.toLowerCase().includes(target.toLowerCase()))
    return hit?.id ?? null
  }, [activeJobs, findings])

  /* The most recent run that ended badly. Failure is the common case in this domain and
     is itself informative, so it is reported in the tool's own words rather than
     swallowed. */
  const lastFailure = useMemo(
    () => jobs.find((j) => j.state === 'failed' || j.state === 'timeout'),
    [jobs]
  )

  /** The wave: everything queued at or after the oldest job still in flight. */
  const wave = useMemo(() => waveOf(jobs), [jobs])
  const adapterTitles = useMemo(
    () => new Map(adapters.map((a) => [a.id, a.title])),
    [adapters]
  )
  const entityLabels = useMemo(
    () =>
      new Map([
        ...entities.map((e) => [e.id, e.label] as const),
        // A run whose entity was removed under it still has to name what it was about.
        ...removed.map((r) => [r.entityId, `${r.label} (removed)`] as const)
      ]),
    [entities, removed]
  )

  /**
   * Findings pointing at an entity the case no longer holds.
   *
   * Derived rather than stored: an orphan is exactly a finding whose entity is gone, so
   * computing it from the two lists already on screen means they can never disagree.
   */
  const orphanLabels = useMemo(() => {
    const live = new Set(entities.map((e) => e.id))
    const out = new Map<string, string>()
    for (const f of findings) {
      if (live.has(f.entityId)) continue
      const tomb = removed.find((r) => r.entityId === f.entityId)
      if (tomb) {
        out.set(f.entityId, `${tomb.kind} ${tomb.label}`)
        continue
      }
      // The engine probes a corroborated lead as a provisional subject rather than
      // promoting it, so a claim about a *pending candidate* is orphaned for the opposite
      // reason a removed entity's claims are: it has not been let into the case yet, not
      // taken out of it. Saying "no longer in this case" about it would be false, and
      // `EntityCandidate.id` shares the entity formula, so the two are distinguishable by
      // primary key alone.
      const lead = candidates.find((c) => c.id === f.entityId)
      out.set(
        f.entityId,
        lead ? `${lead.kind} ${lead.label}, which the engine reached and you have not promoted` : 'an entity no longer in this case'
      )
    }
    return out
  }, [entities, findings, removed, candidates])

  /*
   * Relevance, derived on every render from the seeds and never stored.
   *
   * A score is a function of the seed set, and the seed set changes — he adds the real
   * name after the first sweep, states the gender when it comes back full of the wrong
   * people, corrects a city. A stored score would be a number that used to be true, which
   * is the failure this codebase avoids everywhere else by deriving orphans, candidate
   * confidence and independence counts at read time.
   *
   * Cheap enough to do that way: one pass over the findings with a folded string search
   * per seed. A case with a few thousand rows re-ranks inside a frame.
   */
  const seeds = useMemo(() => seedContextFrom(entities, subject), [entities, subject])
  const scored = useMemo(() => !seedContextIsEmpty(seeds), [seeds])
  const anchors = useMemo(() => anchorEntityIds(entities), [entities])
  const rankedFindings = useMemo(
    () => rankFindings(findings, seeds, { anchors }),
    [findings, seeds, anchors]
  )
  const rankedCandidates = useMemo(
    () => rankCandidates(candidates, seeds),
    [candidates, seeds]
  )

  /*
   * When the technique itself is the problem, say so.
   *
   * Username enumeration on a common handle is low-yield as a property of the technique,
   * not as a bug in this build, and the operator is entitled to be told that rather than
   * left to conclude the tool is broken. Computed over the seeded handles and the rows
   * they produced, so it fires on evidence — a short or dictionary handle, or a run where
   * a quarter of the results state attributes that contradict each other.
   */
  const advice = useMemo(() => {
    const scoredRows = rankedFindings.map((r) => r.relevance)
    for (const handle of seeds.handles) {
      const a = handleAdvice(handle, scoredRows)
      if (a) return a
    }
    return null
  }, [seeds.handles, rankedFindings])

  // Keep the context panel showing the *current* state of the selected finding. A
  // promotion changes the row and the margin annotation at the same moment, which is the
  // point of the developing transition — the two must not disagree for a render.
  useEffect(() => {
    if (!selectedFindingId) return
    const fresh = rankedFindings.find((r) => r.item.id === selectedFindingId)
    if (fresh) onSelectFinding({ finding: fresh.item, relevance: fresh.relevance, scored })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSelectFinding is a stable
    // setter; adding it would re-run this on every parent render.
  }, [rankedFindings, scored, selectedFindingId])

  const saveSubject = async (next: SubjectProfile): Promise<void> => {
    setSubject(next)
    try {
      await window.osint.cases.setSubject(summary.id, next)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const chosen = entities.filter((e) => selection.has(e.id))
  const formAdapter = runForm ? (adapters.find((a) => a.id === runForm) ?? null) : null

  const [reviewOpened, setReviewOpened] = useState(false)
  useEffect(() => {
    if (candidates.length > 0 || summary.counts.candidates > 0) setReviewOpened(true)
  }, [candidates.length, summary.counts.candidates])

  /**
   * Launch one adapter against the selection.
   *
   * An adapter with per-run options opens its form instead of starting immediately —
   * `hibp-passwords` cannot run without a candidate password, that password is typed at
   * the moment of use rather than stored anywhere, and there is nowhere in a batch to
   * type it. So it stays a one-entity action and says so.
   *
   * One run starts on the click, exactly as it always did. More than one stages the plan
   * first: the difference between a click that hits one site list and a click that hits
   * six of them is worth one confirmation.
   */
  const runAdapter = async (adapterId: string, options?: Record<string, unknown>): Promise<void> => {
    setError(null)
    setNotice(null)
    if (!selection.size) {
      setError('Select an entity first — a tool has to be pointed at something.')
      return
    }
    if (options === undefined && hasRunForm(adapterId)) {
      if (selection.size > 1) {
        setError(
          `${adapterId} takes a secret typed at the moment of use, so it runs against one entity at a time. Select just one.`
        )
        return
      }
      setRunForm((prev) => (prev === adapterId ? null : adapterId))
      return
    }
    const request: RunPlanRequest = {
      caseId: summary.id,
      entityIds: [...selection],
      adapterIds: [adapterId]
    }
    setLaunching(true)
    try {
      // An explicit option set is a form submission for one entity; it bypasses the
      // planner because the planner has nowhere to carry the option.
      if (options !== undefined) {
        const only = [...selection][0]
        if (!only) throw new Error('Select an entity first.')
        await window.osint.jobs.run({ caseId: summary.id, entityId: only, adapterId, options })
        setRunForm(null)
        return
      }
      const plan = await window.osint.jobs.plan(request)
      if (plan.runs.length === 1) {
        await window.osint.jobs.runPlan(request)
        setRunForm(null)
        await refresh()
        return
      }
      setStaged({ request, plan })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  /**
   * Every entity in the case against every adapter that accepts its kind.
   *
   * Deliberately ignores the selection: the button says *everything*, and a label that
   * quietly means "everything you happen to have highlighted" is the kind of small lie
   * that makes a launcher untrustworthy. The plan is always shown — this is the action
   * most likely to be minutes of real traffic.
   */
  const runEverything = async (): Promise<void> => {
    await stage({ caseId: summary.id })
  }

  /**
   * Every adapter that accepts what is selected — the per-entity fan-out.
   *
   * The same call as "run everything", narrowed by the entity half. With one entity
   * selected this is "every tool that accepts this handle", which is precisely the thing
   * he was doing by hand one button at a time.
   */
  const runApplicable = async (): Promise<void> => {
    if (!selection.size) {
      setError('Select an entity first — a tool has to be pointed at something.')
      return
    }
    await stage({ caseId: summary.id, entityIds: [...selection] })
  }

  /** The intersection of two hand-made selections. */
  const runPicked = async (): Promise<void> => {
    if (!pickedTools?.size || !selection.size) return
    await stage({
      caseId: summary.id,
      entityIds: [...selection],
      adapterIds: [...pickedTools]
    })
  }

  /** Ask what a request would do, and put it in front of him before it does any of it. */
  const stage = async (request: RunPlanRequest): Promise<void> => {
    setError(null)
    setNotice(null)
    setLaunching(true)
    try {
      setStaged({ request, plan: await window.osint.jobs.plan(request) })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  /** Queue the staged plan. The orchestrator's caps and rate limits do the throttling. */
  const commitPlan = async (): Promise<void> => {
    if (!staged) return
    setLaunching(true)
    try {
      const started = await window.osint.jobs.runPlan(staged.request)
      setStaged(null)
      setNotice(
        `${plural(started.length, 'run')} queued. They start as the per-adapter caps and rate limits allow, not all at once.`
      )
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  const cancelAll = async (): Promise<void> => {
    try {
      const n = await window.osint.jobs.cancelCase(summary.id)
      setNotice(
        n
          ? `${plural(n, 'run')} cancelled. Output captured before each stop is kept on disk.`
          : 'Nothing was running.'
      )
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /* Promotion is the only way a discovery becomes an entity, and it is a person doing
     it. See CandidatesPanel for why nothing here happens on its own. */
  const decide = async (id: string, action: 'promote' | 'dismiss'): Promise<void> => {
    setError(null)
    setDecidingId(id)
    try {
      if (action === 'promote') {
        await window.osint.candidates.promote({ caseId: summary.id, candidateId: id })
      } else {
        await window.osint.candidates.dismiss({ caseId: summary.id, candidateId: id })
      }
      await refresh()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDecidingId(null)
    }
  }

  /**
   * Promote a whole band in one action.
   *
   * Sequential rather than parallel: promotion is a read-modify-write over
   * `entities.json` and `candidates.jsonl`, and the store serialises those per file
   * anyway. One at a time means a failure halfway leaves a coherent case and a readable
   * error rather than an unordered pile of half-applied writes.
   */
  const promoteMany = async (ids: string[]): Promise<void> => {
    setError(null)
    try {
      for (const id of ids) {
        setDecidingId(id)
        await window.osint.candidates.promote({ caseId: summary.id, candidateId: id })
      }
      await refresh()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
      await refresh()
    } finally {
      setDecidingId(null)
    }
  }

  const promoteConfirmed = async (): Promise<void> => {
    setError(null)
    try {
      const added = await window.osint.candidates.promoteConfirmed(summary.id)
      if (added.length) {
        await refresh()
        onChanged()
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const counts = summary.counts

  return (
    <div className="view">
      <header className="view__head">
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={onBack}
          title="Back to all cases"
          aria-label="Back to all cases"
        >
          <Icon name="chevron-left" />
        </button>
        <h1 className="view__title" title={summary.name}>
          {summary.name}
        </h1>
        <Tag title={`Basis: ${summary.basis}. This decides whether an export may be published.`}>
          {summary.basis}
        </Tag>
        <Tag
          strong={!summary.publishable}
          title={
            summary.publishable
              ? 'Exports from this case may be published: the subject is fictional, a place, or a public entity.'
              : 'Exports from this case stay private. Publishing personal data — even your own, even with consent — makes you a controller with notice duties (Lindqvist, C-101/01).'
          }
        >
          {summary.publishable ? 'publishable' : 'private only'}
        </Tag>
        <div className="view__actions">
          <ExportButton open={exportOpen} onToggle={() => setExportOpen((v) => !v)} />
          <CopyValue value={summary.id} title="Copy the case id — it is also the folder name on disk" />
        </div>
      </header>

      <div className="view__scroll">
        {exportOpen && (
          <ExportPanel caseId={summary.id} onClose={() => setExportOpen(false)} />
        )}
        {/* No headline count. "47 candidate accounts. 3 corroborated, 44 unverified." */}
        <div className="toolbar">
          <span className="toolbar__count">{plural(counts.findings, 'finding')}</span>
          {/* The breakdown only when there is something to break down. Four zeroes in a row
              is chrome pretending to be information. */}
          {counts.findings > 0 && (
            <>
              <span className="dot-sep">·</span>
              <ConfidenceCount confidence="confirmed" n={counts.confirmed} />
              <ConfidenceCount confidence="corroborated" n={counts.corroborated} />
              <ConfidenceCount confidence="unverified" n={counts.unverified} />
              {counts.refuted > 0 && <ConfidenceCount confidence="refuted" n={counts.refuted} />}
            </>
          )}
          {/* Counted separately from findings on purpose: a candidate is not a finding and
              is not in the case. Folding it into the total would be the app claiming to
              hold something it has not been given. */}
          {counts.candidates > 0 && (
            <>
              <span className="dot-sep">·</span>
              <span
                className="stat"
                title="Discovered by an adapter and not yet in the case. Nothing enters the graph without you."
              >
                <span className="stat__n">{counts.candidates}</span>
                <span>awaiting review</span>
              </span>
            </>
          )}
          <div className="toolbar__spacer" />
          <input
            className="input"
            style={{ width: 260 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search claims, sources and raw output"
            aria-label="Search findings, including the unparsed tool output"
          />
        </div>

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

        {lastFailure?.error && (
          <Notice state="warning" label={lastFailure.adapterId}>
            {lastFailure.error} Output captured before the failure is kept on disk.
          </Notice>
        )}

        {/* The engine's running state, above everything.

            It goes first because it is the answer to the question the table cannot answer:
            what is established, what is still open, and which two or three calls only he
            can make. The table below it is the evidence, and evidence is what you read
            second. */}
        <Brief
          caseId={summary.id}
          onChanged={() => {
            void refresh()
            onChanged()
          }}
        />

        {/* Seeds and the launcher. One panel, collapsible, above the table. */}
        <section className="panel">
          <div className="panel__head">
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => setSeedsOpen((v) => !v)}
              aria-expanded={seedsOpen}
            >
              <Icon name={seedsOpen ? 'chevron-down' : 'chevron-right'} />
              <span className="panel__title">Entities</span>
            </button>
            <span>{plural(entities.length, 'entity', 'entities')}</span>
          </div>

          {seedsOpen && (
            <div className="panel__body">
              <EntityStrip
                caseId={summary.id}
                entities={entities}
                selected={selection}
                onToggle={(id) =>
                  setSelection((prev) => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                    return next
                  })
                }
                onSelectAll={() => setSelection(new Set(entities.map((e) => e.id)))}
                onClear={() => setSelection(new Set())}
                onChanged={(message) => {
                  setNotice(message)
                  // A staged plan is a promise about entities that existed when it was
                  // drawn. Editing or removing one makes it a promise about something
                  // else, and a preview naming a value that is no longer in the case is
                  // worse than no preview at all.
                  setStaged(null)
                  void refresh()
                  onChanged()
                }}
                onError={setError}
              />

              {/* What the operator knows that no adapter accepts. It sits with the seeds
                  because it is seed data — it just is not a thing a tool can be pointed
                  at, so it lives on the case rather than in the entity list. */}
              <SubjectPanel
                subject={subject}
                seededNames={seeds.names}
                busy={launching}
                onChange={(next) => void saveSubject(next)}
              />

              <div style={{ marginTop: entities.length ? 'var(--space-4)' : 0 }}>
                <EntityAdd
                  caseId={summary.id}
                  onAdded={(created) => {
                    setSelection(new Set([created.id]))
                    setStaged(null)
                    void refresh()
                    onChanged()
                  }}
                  onError={setError}
                />
              </div>

              {entities.length > 0 && (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <RunLauncher
                    adapters={adapters}
                    entities={entities}
                    selected={selection}
                    pickedTools={pickedTools}
                    busy={launching}
                    hasActiveRuns={activeJobs.length > 0}
                    runFormId={runForm}
                    onRunEverything={() => void runEverything()}
                    onRunApplicable={() => void runApplicable()}
                    onRunAdapter={(id) => void runAdapter(id)}
                    onPickTools={(on) => {
                      setPickedTools(on ? new Set() : null)
                      setStaged(null)
                      setRunForm(null)
                    }}
                    onToggleTool={(id) =>
                      setPickedTools((prev) => {
                        const next = new Set(prev ?? [])
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }
                    onRunPicked={() => void runPicked()}
                    onCancelAll={() => void cancelAll()}
                  />
                </div>
              )}

              {/* Per-run options, inline under the launcher rather than in a dialog. */}
              {chosen.length === 1 && formAdapter && (
                <RunOptionsForm
                  adapter={formAdapter}
                  entityLabel={`${chosen[0]?.kind} ${chosen[0]?.label}`}
                  busy={launching}
                  onRun={(options) => void runAdapter(formAdapter.id, options)}
                  onCancel={() => setRunForm(null)}
                />
              )}
            </div>
          )}
        </section>

        {/* What a click is about to do, before it does it. */}
        {staged && (
          <RunPlanPreview
            plan={staged.plan}
            busy={launching}
            onRun={() => void commitPlan()}
            onCancel={() => setStaged(null)}
          />
        )}

        {/* The review queue appears the first time an adapter finds something new — a
            permanent zero on a case that has never run anything is chrome pretending to be
            information. Once it has appeared it stays for the rest of the visit, so clearing
            the last candidate leaves the panel explaining what it was rather than the row
            vanishing under the pointer with nothing in its place. */}
        {reviewOpened && (
          <CandidatesPanel
            ranked={rankedCandidates}
            scored={scored}
            busyId={decidingId}
            onPromote={(id) => void decide(id, 'promote')}
            onDismiss={(id) => void decide(id, 'dismiss')}
            onPromoteConfirmed={() => void promoteConfirmed()}
            onPromoteMany={(ids) => void promoteMany(ids)}
          />
        )}

        {/* One run keeps its full card: for a single maigret sweep that card is exactly
            the right amount of screen, and it is where "never a bare spinner" lives. Two
            or more collapse into the wave, because fourteen stacked cards is a wall that
            hides the only number worth having — how far through the batch it is. */}
        {activeJobs.length === 1 && activeJobs[0] && (
          <RunProgress
            job={activeJobs[0]}
            title={adapterTitles.get(activeJobs[0].adapterId) ?? activeJobs[0].adapterId}
            now={now}
            onCancel={(id) => void window.osint.jobs.cancel(id)}
          />
        )}
        {activeJobs.length > 1 && (
          <RunQueue
            jobs={wave}
            titles={adapterTitles}
            labels={entityLabels}
            now={now}
            onCancel={(id) => void window.osint.jobs.cancel(id)}
            onCancelAll={() => void cancelAll()}
          />
        )}

        {/* Beside the results, at the moment he is reading them — not in a doc panel. */}
        {advice && <CommonHandleNotice advice={advice} />}

        <div className="view__body">
          <FindingsTable
            ranked={rankedFindings}
            scored={scored}
            loading={loading}
            selectedId={selectedFindingId}
            probingId={probingId}
            orphanLabels={orphanLabels}
            caseId={summary.id}
            onSelect={(id) => {
              const hit = rankedFindings.find((r) => r.item.id === id)
              onSelectFinding(hit ? { finding: hit.item, relevance: hit.relevance, scored } : null)
            }}
            onVerified={onVerified}
            empty={
              query.trim() ? (
                <EmptyState
                  title="Nothing matches that search."
                  body={[
                    `The index searches claims, sources, tool ids and the first 2 KB of every tool's unparsed output — so a term that appears only in raw text a parser skipped will still find its finding.`,
                    'Terms are quoted before they reach FTS5, so pasted text containing a hyphen, a colon or a quote is searched literally instead of becoming an operator.'
                  ]}
                  exampleLabel="Searching raw output rather than claims"
                  example="cloudflare"
                  actions={
                    <button type="button" className="btn" onClick={() => setQuery('')}>
                      Clear the search
                    </button>
                  }
                />
              ) : entities.length === 0 ? (
                <EmptyState
                  title="This case has no seeds yet."
                  body={[
                    'A case starts from something you already know: a username, an email address, a domain. That is a seed. Everything an adapter discovers hangs off it, and the seed flag is what lets the self-audit later ask which single piece of starting information unlocked the most.',
                    'Add one above, then point an adapter at it.'
                  ]}
                  exampleLabel="A first seed"
                  example="username · exampleuser"
                />
              ) : (
                <EmptyState
                  title="No findings yet."
                  body={[
                    'Select a seed above and run an adapter against it. Each one writes its unparsed output to disk before anything is interpreted, so a parser bug later is a re-parse rather than a lost run.',
                    'Everything arrives as unverified, including things that are obviously true. Two independent sources make a claim corroborated; only you, with a note, can make one confirmed.'
                  ]}
                  exampleLabel="What a first result looks like"
                  example="An account named exampleuser exists — github.com — unverified"
                />
              )
            }
          />
        </div>
      </div>
    </div>
  )
}

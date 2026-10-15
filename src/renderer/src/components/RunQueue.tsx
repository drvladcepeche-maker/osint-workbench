import type { Job } from '../../../shared/types'
import { isTerminalJobState } from '../../../shared/types'
import { elapsed } from '../lib/format'
import { progressLine, readProgress } from '../lib/progress'
import { Icon } from './Icon'

/**
 * Many runs at once, kept legible.
 *
 * One run gets the full `RunProgress` card and always will — that card is where DESIGN.md's
 * "never a bare spinner" lives, and for a single maigret sweep it is exactly the right
 * amount of screen. Fourteen of them stacked is not fourteen times as informative; it is a
 * wall, and the one number the operator actually wants — how far through the batch is it —
 * appears nowhere on it.
 *
 * So above two jobs this replaces them: one aggregate line with a real denominator, then
 * one 30px row per job on hairlines, matching the findings table's density. The running
 * rows carry their own count and the site being hit; the queued ones say what they are
 * waiting for. Cancel is per row and for the whole wave.
 *
 * ## What counts as one wave
 *
 * The orchestrator has no concept of a batch — every job is independent, which is what
 * makes the concurrency caps simple. So the wave is derived: every job queued at or after
 * the oldest job still in flight. That is the honest reading of "what is going on right
 * now", it needs nothing stored, and it survives a window that was closed and reopened
 * mid-run because it is computed from the job list rather than from anything the renderer
 * remembered.
 */
export function waveOf(jobs: readonly Job[]): Job[] {
  const active = jobs.filter((j) => !isTerminalJobState(j.state))
  if (!active.length) return []
  const since = active.reduce((min, j) => (j.queuedAt < min ? j.queuedAt : min), active[0]!.queuedAt)
  return jobs.filter((j) => j.queuedAt >= since).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
}

export function RunQueue({
  jobs,
  titles,
  labels,
  now,
  onCancel,
  onCancelAll
}: {
  /** The wave, oldest first. */
  jobs: Job[]
  /** Adapter id -> display title. */
  titles: Map<string, string>
  /** Entity id -> display label. An entity removed mid-run is not in here. */
  labels: Map<string, string>
  now: number
  onCancel: (jobId: string) => void
  onCancelAll: () => void
}): React.JSX.Element {
  const running = jobs.filter((j) => j.state === 'running')
  const queued = jobs.filter((j) => j.state === 'queued')
  const done = jobs.filter((j) => j.state === 'done')
  const bad = jobs.filter((j) => j.state === 'failed' || j.state === 'timeout')
  const cancelled = jobs.filter((j) => j.state === 'cancelled')
  const settled = jobs.length - running.length - queued.length
  const oldest = jobs[0]?.startedAt ?? jobs[0]?.queuedAt ?? null

  const line = [
    `${settled} of ${jobs.length} finished`,
    `${running.length} running`,
    `${queued.length} queued`,
    bad.length ? `${bad.length} failed` : null,
    cancelled.length ? `${cancelled.length} cancelled` : null,
    elapsed(oldest, now)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="queue" aria-label="Runs in progress">
      <div className="queue__head">
        <span className="run__live" aria-hidden="true" />
        <span className="queue__title">Running</span>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--quiet"
          onClick={onCancelAll}
          title="Stop every queued and running job in this case. Output captured so far is kept."
        >
          Cancel all
        </button>
      </div>

      {/* Ticks once a second; announcing that every second would make a screen reader
          unusable, so the live region below carries the wave's state instead. */}
      <div className="run__line" aria-live="off">
        {line}
      </div>
      <span className="sr-only" role="status">
        {settled} of {jobs.length} runs finished, {running.length} running.
      </span>

      {/* A real denominator: the wave's own size. Nothing here is estimated — a queued job
          is 0 and a settled one is 1, and no partial credit is invented from a tool that
          has not said how far along it is. */}
      <div className="run__bar">
        <div
          className="run__bar-fill"
          style={{ '--run-progress': jobs.length ? settled / jobs.length : 0 } as React.CSSProperties}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={jobs.length}
          aria-valuenow={settled}
          aria-label="Runs finished in this wave"
        />
      </div>

      <ul className="queue__list">
        {jobs.map((job) => {
          const p = readProgress(job)
          const live = job.state === 'running'
          return (
            <li key={job.id} className="queue__row" data-state={job.state}>
              <span className="queue__tool">{titles.get(job.adapterId) ?? job.adapterId}</span>
              <span className="queue__entity data">
                {labels.get(job.entityId) ?? job.entityId}
              </span>
              <span className="queue__line">
                {live
                  ? progressLine(p, job.findingIds.length, elapsed(job.startedAt, now))
                  : job.state === 'queued'
                    ? `waiting for a ${job.adapterId} slot`
                    : (job.error?.split('\n')[0] ??
                      `${job.findingIds.length} ${job.findingIds.length === 1 ? 'finding' : 'findings'}`)}
              </span>
              <span className="queue__state">{job.state}</span>
              {!isTerminalJobState(job.state) ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--icon"
                  onClick={() => onCancel(job.id)}
                  title={`Cancel this ${job.adapterId} run. Output captured so far is kept.`}
                  aria-label={`Cancel the ${job.adapterId} run`}
                >
                  <Icon name="close" />
                </button>
              ) : (
                <span className="queue__spacer" aria-hidden="true" />
              )}
            </li>
          )
        })}
      </ul>

      {done.length > 0 && bad.length > 0 && (
        <p className="hint">
          A failure is not the end of the wave. Every run persists its unparsed output
          before anything is interpreted, so what failed is on disk and can be re-read.
        </p>
      )}
    </section>
  )
}

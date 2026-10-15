import type { Job } from '../../../shared/types'
import { elapsed } from '../lib/format'
import { progressLine, readProgress } from '../lib/progress'
import { Icon } from './Icon'

/**
 * Honest progress for a tool run.
 *
 * DESIGN.md: never a bare spinner. Maigret probes 3000 sites and takes minutes — a
 * spinner asserts that something is happening and offers no evidence, which in a tool
 * whose whole subject is evidence is the wrong first impression to give.
 *
 * So: the real count, the site being hit right now, the hits so far, elapsed time. When
 * the adapter reports no denominator, there is no progress bar at a made-up position —
 * an indeterminate rule says "still moving", which is the only thing actually known.
 *
 * Those numbers come from `JobProgress`'s own fields, which the adapters that can count
 * fill in from their tool's output as it arrives. They are the tool's claims about
 * itself, not the app's: maigret's `12/38` is maigret's counter, and a run whose tool
 * says nothing shows nothing rather than a plausible-looking guess.
 *
 * The safelight sweep runs across the current target and **only while the job is
 * running**. A queued job is not live, so it gets no amber; that is what makes amber
 * appearing mean something.
 */
export function RunProgress({
  job,
  title,
  now,
  onCancel
}: {
  job: Job
  title: string
  now: number
  onCancel: (jobId: string) => void
}): React.JSX.Element {
  const p = readProgress(job)
  const running = job.state === 'running'
  const hits = job.findingIds.length
  const line = running
    ? progressLine(p, hits, elapsed(job.startedAt, now))
    : `queued · waiting for a ${job.adapterId} slot`

  return (
    <div className="run">
      <div className="run__head">
        {running && <span className="run__live" aria-hidden="true" />}
        <span className="run__tool">{title}</span>
        <span className="run__state">{job.state}</span>
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={() => onCancel(job.id)}
          title={`Cancel this ${job.adapterId} run. Output captured so far is kept.`}
          aria-label={`Cancel the ${title} run`}
        >
          <Icon name="close" />
        </button>
      </div>

      {/* The numbers tick once a second. Announcing that to a screen reader every second
          would be unusable, so the live region below carries state changes only. */}
      <div className="run__line" aria-live="off">
        {line}
      </div>
      <span className="sr-only" role="status">
        {title} is {job.state}.
      </span>

      {running && (
        <div className={p.fraction === null ? 'run__bar run__bar--unknown' : 'run__bar'}>
          <div
            className="run__bar-fill"
            style={{ '--run-progress': p.fraction ?? 1 } as React.CSSProperties}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={p.total ?? 100}
            aria-valuenow={p.fraction === null ? undefined : (p.done ?? Math.round(p.fraction * 100))}
            aria-valuetext={p.fraction === null ? 'in progress, no total reported' : line}
            aria-label={`${title} progress`}
          />
        </div>
      )}

      {/* A tool that counts but never states a denominator — Sherlock does exactly this —
          gets no percentage and no bar position. Saying how far along it is would be an
          invention; saying how many sites it has finished is what it actually told us. */}
      {running && p.done !== null && p.total === null && (
        <span className="sr-only" role="status">
          {p.done} sites probed. {title} does not report a total.
        </span>
      )}

      {/* The safelight. Amber, moving, and only while something is genuinely running. */}
      {running && p.target && (
        <div className="run__target is-probing">
          <span>{p.target}</span>
        </div>
      )}

      {/* Whatever the numbers could not carry, in the adapter's own words: the phase
          before a count exists, and the one thing a count actively misreports — maigret's
          bar restarting from zero when it recurses into a handle it just discovered.
          Adapters that can count clear this the moment they can, so it never sits under
          the numbers saying less than they already do. */}
      {running && p.note && (
        <div className="run__line" aria-live="off">
          {p.note}
        </div>
      )}
    </div>
  )
}

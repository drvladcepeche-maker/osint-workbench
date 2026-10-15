import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * `prefers-reduced-motion`, live.
 *
 * Most of the compliance is done in CSS by zeroing the duration tokens, which keeps one
 * code path per component. This hook exists for the three places where reduced motion
 * has to change *behaviour* rather than speed: the stagger has to stop allocating
 * delays at all, the safelight has to become a static marker, and the elapsed clock
 * must not be mistaken for an animation.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/**
 * A clock that only runs while something needs it.
 *
 * Elapsed time is the honest part of a progress readout, but a timer that keeps ticking
 * on an idle window is a renderer that never sleeps. `active` is the set of running
 * jobs, so when the last one settles the interval is cleared.
 */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(id)
  }, [active, everyMs])

  return now
}

/**
 * Which items are new since the previous render.
 *
 * Findings stream in as a tool reports them, and the 20ms stagger is meant to reflect
 * genuine arrival order — so only the items that actually just arrived may animate. A
 * re-sort, a search, or returning to a case must not replay the whole table.
 *
 * `ready` is the load gate, and it is the whole correctness of this hook. Without it the
 * baseline is taken on the first render, when the list is still empty because the IPC
 * call has not resolved — and then all 300 existing findings count as "new" and the
 * table plays a two-second wave every time a case is opened. The baseline is therefore
 * taken on the first render *after* the initial load settles, empty or not.
 *
 * Returns a map from id to its position within the arriving batch, capped so a parse
 * that yields 400 findings does not take eight seconds to finish drawing: everything
 * past the cap lands on the last delay rather than an ever-growing one. The map is
 * cleared once the batch has played, so a later re-render cannot replay it.
 */
export function useArrivals(ids: string[], ready: boolean, maxSteps = 24): Map<string, number> {
  const seen = useRef<Set<string> | null>(null)
  const [arrivals, setArrivals] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    if (!ready) return
    // Opening a case with 300 existing findings is a page load, not a run.
    if (seen.current === null) {
      seen.current = new Set(ids)
      return
    }
    const fresh = ids.filter((id) => !seen.current?.has(id))
    if (fresh.length === 0) return
    const next = new Map<string, number>()
    fresh.forEach((id, i) => next.set(id, Math.min(i, maxSteps)))
    for (const id of ids) seen.current?.add(id)
    setArrivals(next)

    const played = (Math.min(fresh.length, maxSteps) + 1) * 20 + 400
    const timer = window.setTimeout(() => setArrivals(new Map()), played)
    return () => window.clearTimeout(timer)
  }, [ids, ready, maxSteps])

  return arrivals
}

/**
 * A shell zone that yields to the window until the operator says otherwise.
 *
 * Responsive behaviour in a product UI is structural — collapse the sidebar, close the
 * panel — not fluid type. Below `breakpoint` the zone folds on its own, because three
 * fixed columns in an 800px window leave the findings table narrower than a single
 * claim. Above it, the zone comes back.
 *
 * The moment the operator touches the toggle, the automatic behaviour stops for the rest
 * of the session. An interface that keeps reopening a panel you just closed is arguing
 * with you.
 */
export function useAutoFold(breakpoint: number, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState(
    () => defaultOpen && (window.innerWidth ?? 0) >= breakpoint
  )
  const touched = useRef(false)

  useEffect(() => {
    if (touched.current) return
    const onResize = (): void => {
      if (touched.current) return
      setOpen(defaultOpen && window.innerWidth >= breakpoint)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [breakpoint, defaultOpen])

  const toggle = useCallback(() => {
    touched.current = true
    setOpen((v) => !v)
  }, [])

  return [open, toggle]
}

/** Copy, with a real confirmation and a real failure. Never a silent success. */
export function useCopy(resetMs = 1600): {
  state: 'idle' | 'true' | 'error'
  copy: (text: string) => void
} {
  const [state, setState] = useState<'idle' | 'true' | 'error'>('idle')
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(
    (text: string) => {
      const settle = (s: 'true' | 'error'): void => {
        setState(s)
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setState('idle'), resetMs)
      }
      navigator.clipboard.writeText(text).then(
        () => settle('true'),
        () => settle('error')
      )
    },
    [resetMs]
  )

  return { state, copy }
}

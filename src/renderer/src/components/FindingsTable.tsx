import { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import type { Confidence, Finding } from '../../../shared/types'
import { contradictionSummary, type Ranked } from '../../../shared/ranking'
import { RELEVANCE_BAND_LABEL, RELEVANCE_BAND_MEANING } from '../../../shared/relevance'
import { stamp, stampMinute } from '../lib/format'
import { useArrivals } from '../lib/hooks'
import { ConfidenceMark, LEVELS } from './Confidence'
import { Loading } from './Feedback'
import { Icon } from './Icon'
import { RowClaim, SourceLink } from './Link'
import { RelevanceMark, RelevanceWhy } from './Relevance'
import { VerifyControl } from './Verify'

/**
 * The findings table.
 *
 * Dense: 30px rows, 1px hairlines, no card, no zebra. The confidence ramp already varies
 * the ink row to row, and stripes would fight it for the same channel.
 *
 * Two of the app's three sanctioned motions live here:
 *
 *   - **Streaming in.** Rows that arrived since the last render animate with a 20ms
 *     stagger, in the order the parser emitted them, which is the order the tool found
 *     them. It is information, not decoration: a batch that lands all at once hides
 *     which site answered first. Only genuinely new ids animate — re-sorting, searching,
 *     or returning to a case does not replay the table.
 *   - **The safelight.** The row being probed right now carries a moving amber gradient,
 *     and only while a run is actually in progress.
 *
 * Keyboard: the table is a grid with a roving tabindex. Up/Down move the selection, Home
 * and End jump to the ends, and the selected row drives the context panel — so the doc
 * for the tool that produced a finding is always one arrow key away.
 *
 * ## Ordering
 *
 * The default order is **relevance**, as soon as anything is seeded. That is the whole
 * point of the ranking work: a sweep over a common handle returns fifty rows, and reading
 * them in the order the site list happened to be in is what made the app useless on a
 * common name. Sorting is per column and reversible, so arrival order is one click away
 * and is still the default when there is nothing to rank against.
 *
 * The `contradicted` group collapses at the bottom, **with a count and a reason**, and
 * expands in one click. Nothing is ever removed: the seeds could be the thing that is
 * wrong, and a self-audit that quietly hides rows gives false comfort.
 *
 * ## Verifying from the table
 *
 * The confidence cell is a button, and it opens the verification form in a row directly
 * under the finding. Two reasons it is the confidence cell rather than a seventh column:
 * the cell already *is* the thing being changed, so there is nothing to learn about where
 * to click; and at 1280px with the margin panel open this table has about 760px, of which
 * the claim column gets whatever the fixed columns leave. A new column would come
 * straight out of the claim, and the claim is what the operator came to read.
 *
 * The same control is in the margin panel. That is not an accident of two implementations
 * — it is one component rendered twice — and it is deliberate: the panel folds on its own
 * below 980px, and a verification path that disappears with the panel is a verification
 * path that half the sessions never see.
 */

export type FindingSort = 'relevance' | 'arrival' | 'confidence' | 'first-seen'

const CONFIDENCE_RANK: Record<Confidence, number> = {
  confirmed: 0,
  corroborated: 1,
  unverified: 2,
  refuted: 3
}

export function FindingsTable({
  ranked,
  scored,
  loading,
  selectedId,
  probingId,
  orphanLabels,
  caseId,
  onSelect,
  onVerified,
  empty
}: {
  /** Findings with their relevance already computed, in relevance order. */
  ranked: Ranked<Finding>[]
  /** False when nothing is seeded, so the relevance column has nothing to say. */
  scored: boolean
  loading: boolean
  selectedId: string | null
  /** The finding whose source is being probed right now. Null unless a run is live. */
  probingId: string | null
  /**
   * Entity ids the case no longer holds, mapped to what they were.
   *
   * A finding whose entity was removed is **kept**, because a finding is the record that a
   * tool asserted something and its raw capture is permanent — deleting the question does
   * not unobserve the answer. Keeping it silently would be the other failure though: a row
   * about a value nobody can name any more. So it is marked, and the mark says what it was
   * about.
   */
  orphanLabels: ReadonlyMap<string, string>
  caseId: string
  onSelect: (id: string) => void
  /** Called with the finding as the main process wrote it, after a confidence change. */
  onVerified: (updated: Finding) => void
  empty: React.ReactNode
}): React.JSX.Element {
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const [sort, setSort] = useState<FindingSort | null>(null)
  const [reversed, setReversed] = useState(false)
  const [showContradicted, setShowContradicted] = useState(false)
  /**
   * The finding whose verification form is open under it, if any.
   *
   * One at a time, by id rather than by index: the row order changes under a sort and a
   * half-typed note that reattached itself to a different claim would be the one bug in
   * this feature capable of writing a false statement into a case file.
   */
  const [verifying, setVerifying] = useState<string | null>(null)

  const mode: FindingSort = sort ?? (scored ? 'relevance' : 'arrival')

  /**
   * The rows in display order, plus the ones held back.
   *
   * Held back, not filtered: `contradicted` is the only group that collapses, it only
   * collapses in relevance order, and its count and reason are rendered whether it is open
   * or shut. Every other order shows everything inline.
   */
  const { rows, contradicted, foldAt } = useMemo(() => {
    const all = [...ranked]
    if (mode === 'relevance') {
      // `ranked` already arrives in band-then-score order from shared/ranking.ts.
      const held = all.filter((r) => r.relevance.band === 'contradicted')
      const kept = all.filter((r) => r.relevance.band !== 'contradicted')
      const shown = reversed ? [...kept].reverse() : kept
      return {
        rows: showContradicted ? [...shown, ...held] : shown,
        contradicted: held,
        // Where the disclosure row goes: after the last row that is not contradicted, so
        // the group's own header sits above its contents whether it is open or shut.
        foldAt: held.length ? shown.length : -1
      }
    }
    if (mode === 'confidence') {
      all.sort(
        (a, b) =>
          CONFIDENCE_RANK[a.item.confidence] - CONFIDENCE_RANK[b.item.confidence] ||
          a.item.id.localeCompare(b.item.id)
      )
    } else if (mode === 'first-seen') {
      all.sort((a, b) => b.item.firstSeen.localeCompare(a.item.firstSeen))
    }
    // Every other order shows everything inline: a contradicted row is still a row, and
    // hiding it outside the one place the grouping is explained would be exactly the
    // silent filtering this is built to avoid.
    return { rows: reversed ? all.reverse() : all, contradicted: [] as Ranked<Finding>[], foldAt: -1 }
  }, [ranked, mode, reversed, showContradicted])

  const ids = useMemo(() => rows.map((r) => r.item.id), [rows])
  const arrivals = useArrivals(ids, !loading)

  const move = useCallback(
    (from: number, delta: number | 'home' | 'end') => {
      const to =
        delta === 'home'
          ? 0
          : delta === 'end'
            ? rows.length - 1
            : Math.min(rows.length - 1, Math.max(0, from + delta))
      const next = rows[to]
      if (!next) return
      onSelect(next.item.id)
      // Focus follows selection so the ring and the context panel never disagree.
      const row = bodyRef.current?.querySelector<HTMLTableRowElement>(`[data-id="${next.item.id}"]`)
      row?.focus()
      row?.scrollIntoView({ block: 'nearest' })
    },
    [rows, onSelect]
  )

  const sortBy = useCallback(
    (next: FindingSort) => {
      if (mode === next) setReversed((v) => !v)
      else {
        setSort(next)
        setReversed(false)
      }
    },
    [mode]
  )

  if (loading) return <Loading what="findings" />
  if (!ranked.length) return <>{empty}</>

  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.item.id === selectedId)
  )

  const header = (
    key: FindingSort,
    label: string,
    title: string,
    width?: number,
    className?: string
  ): React.JSX.Element => (
    <th
      scope="col"
      style={width ? { width } : undefined}
      className={className}
      aria-sort={mode === key ? (reversed ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="th-sort" onClick={() => sortBy(key)} title={title}>
        {label}
        {mode === key && (
          <Icon name={reversed ? 'chevron-down' : 'chevron-right'} size={10} className="th-sort__mark" />
        )}
      </button>
    </th>
  )

  return (
    <div className="table-wrap">
      <table className="table table--ranked" role="grid" aria-label="Findings">
        <thead>
          <tr>
            {header(
              'relevance',
              'Relevance',
              'How the row sits against what you seeded — and whether anything on it actively contradicts you. Independent of confidence.',
              84
            )}
            {header(
              'confidence',
              'Confidence',
              'How many independent sources stand behind the claim, and whether a human vouched for it. Independent of relevance.',
              124
            )}
            {/* The one column with no width: under `table-layout: fixed` it takes whatever
                the others leave, so every pixel trimmed above and below lands here. The
                widths around it are measured against their longest real content rather
                than rounded up — `corroborated` plus its glyph is 128px, a timestamp is
                150 — because at 1280 with the margin panel open this table gets a 760px
                container, and `Claim` was coming out narrower than `First seen`. The
                claim is the finding; it should not be the narrowest thing on the row. */}
            <th scope="col">Claim</th>
            <th scope="col" style={{ width: 136 }}>
              Source
            </th>
            <th scope="col" className="col--tool" style={{ width: 72 }}>
              Tool
            </th>
            {header('first-seen', 'First seen', 'When this claim was first observed.', 152, 'col--seen')}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {rows.map((r, i) => {
            const f = r.item
            const arriving = arrivals.get(f.id)
            const orphanOf = orphanLabels.get(f.entityId)
            // Deliberately not `.row`: that class is the flex layout for the app's
            // non-tabular lists and would collapse a table row's cells.
            const classes: string[] = []
            if (arriving !== undefined) classes.push('is-arriving')
            if (probingId === f.id) classes.push('is-probing')
            const fold =
              i === foldAt ? (
                <tr className="band-row" key="band-contradicted">
                  <td colSpan={6}>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      onClick={() => setShowContradicted((v) => !v)}
                      aria-expanded={showContradicted}
                      title={RELEVANCE_BAND_MEANING.contradicted}
                    >
                      <Icon name={showContradicted ? 'chevron-down' : 'chevron-right'} />
                      <span>
                        {RELEVANCE_BAND_LABEL.contradicted} · {contradicted.length}
                      </span>
                    </button>
                    <span className="band-row__why">{contradictionSummary(contradicted)}</span>
                  </td>
                </tr>
              ) : null
            return (
              <Fragment key={f.id}>
              {fold}
              <tr
                data-id={f.id}
                data-confidence={f.confidence}
                data-band={scored ? r.relevance.band : undefined}
                className={classes.join(' ') || undefined}
                style={
                  arriving !== undefined
                    ? ({ '--arrive-index': arriving } as React.CSSProperties)
                    : undefined
                }
                aria-selected={f.id === selectedId}
                tabIndex={i === focusIndex ? 0 : -1}
                onClick={() => onSelect(f.id)}
                onFocus={() => onSelect(f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    move(i, 1)
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    move(i, -1)
                  } else if (e.key === 'Home') {
                    e.preventDefault()
                    move(i, 'home')
                  } else if (e.key === 'End') {
                    e.preventDefault()
                    move(i, 'end')
                  }
                }}
              >
                <td>
                  <RelevanceMark relevance={r.relevance} scored={scored} />
                </td>
                <td>
                  {/* The cell is the control. `conf-cell` is a bare button wrapper: it
                      adds a hit area and a focus ring and changes nothing about the mark
                      itself, so the ramp's lightness and weight still read exactly as
                      they do everywhere else. */}
                  <button
                    type="button"
                    className="conf-cell"
                    aria-expanded={verifying === f.id}
                    title={`${LEVELS[f.confidence].title}\n\nClick to confirm, refute, or take back a verification.`}
                    onClick={(e) => {
                      // The row's own click already selects; stopping propagation here
                      // would break that, so it selects first and toggles second.
                      e.stopPropagation()
                      onSelect(f.id)
                      setVerifying((prev) => (prev === f.id ? null : f.id))
                    }}
                  >
                    <ConfidenceMark confidence={f.confidence} />
                  </button>
                </td>
                <td>
                  {/* One line, always: the marks sit beside the claim rather than under it,
                      so a row that carries one is still a 30px row. The claim gives up the
                      width instead. */}
                  <span className="claim-cell">
                    {/* Sans, not mono: a claim is a sentence someone wrote, not a value.
                        Any URL inside it is mono and clickable — that is what mono is
                        rationed for, and the link is why the row exists. The address the
                        claim ends with is pinned, so the sentence gives up the width and
                        the URL never disappears into the ellipsis. */}
                    <RowClaim text={f.claim} source={f.source} className="claim" />
                    {/* A word, not a colour: the confidence ramp already owns lightness and
                        weight in this row, and orphaned is orthogonal to how believable the
                        claim is. It says the subject left, not that the evidence weakened. */}
                    {orphanOf && (
                      <span
                        className="orphan"
                        title={`This claim was about ${orphanOf}, which is no longer in the case. The finding is kept: the observation happened, and its raw capture is on disk.`}
                      >
                        orphaned
                      </span>
                    )}
                    {scored && <RelevanceWhy relevance={r.relevance} />}
                  </span>
                </td>
                {/* Source, tool and timestamp are literals you might copy or compare
                    character by character. That is exactly what mono is rationed for. */}
                <td>
                  <SourceLink source={f.source} />
                </td>
                <td className="data col--tool" title={f.tool}>
                  {f.tool}
                </td>
                <td className="data col--seen" title={stamp(f.firstSeen)}>
                  {stampMinute(f.firstSeen)}
                </td>
              </tr>
              {verifying === f.id && (
                <tr className="verify-row" data-confidence={f.confidence}>
                  <td colSpan={6}>
                    <VerifyControl
                      finding={f}
                      caseId={caseId}
                      compact
                      onVerified={(updated) => {
                        setVerifying(null)
                        onVerified(updated)
                      }}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
            )
          })}
          {/* The group is empty-ended when every row in it is already shown above, and
              when the fold sits past the last row — a case with nothing but contradicted
              rows in it. */}
          {foldAt >= 0 && foldAt >= rows.length && (
            <tr className="band-row">
              <td colSpan={6}>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => setShowContradicted((v) => !v)}
                  aria-expanded={showContradicted}
                  title={RELEVANCE_BAND_MEANING.contradicted}
                >
                  <Icon name={showContradicted ? 'chevron-down' : 'chevron-right'} />
                  <span>
                    {RELEVANCE_BAND_LABEL.contradicted} · {contradicted.length}
                  </span>
                </button>
                <span className="band-row__why">{contradictionSummary(contradicted)}</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

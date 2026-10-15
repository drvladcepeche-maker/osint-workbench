import { useMemo, useState } from 'react'
import type { CandidateView } from '../../../shared/types'
import { PIVOT_SIGNAL_LABEL } from '../../../shared/pivot'
import { contradictionSummary, type Ranked } from '../../../shared/ranking'
import {
  RELEVANCE_BAND_LABEL,
  RELEVANCE_BAND_MEANING,
  unscored,
  type RelevanceAssessment
} from '../../../shared/relevance'
import { plural } from '../lib/format'
import {
  groupCandidates,
  pivotMeaning,
  triage,
  TRIAGE_LABEL,
  TRIAGE_MEANING,
  type Triage,
  type TriageBand
} from '../lib/triage'
import { LEVELS } from './Confidence'
import { Data } from './Data'
import { EmptyState } from './Feedback'
import { Icon } from './Icon'
import { RelevanceMark, RelevanceWhy } from './Relevance'

/**
 * The review queue: things adapters discovered that are **not in the case**.
 *
 * Adapters declare what they can discover (`produces`) and say what they actually found
 * (`propose`). Neither adds anything. This panel is where the difference between those
 * two and an entity gets settled, by a person.
 *
 * It used to be a flat list of up to a hundred identical rows with two unlabelled buttons
 * on each, and the operator's two questions about it were fair: *"what does promote and
 * dismiss mean?"* and *"I don't wanna click promote on fucking everything."* Nothing on
 * screen said what promoting did, and nothing distinguished a reciprocal link between two
 * profiles from a 200 off a shared AJAX endpoint.
 *
 * So the queue is now triaged (`lib/triage.ts`), and the asymmetry there is the whole
 * design: **noise is hidden automatically, and nothing is ever promoted automatically.**
 * A wrongly hidden candidate costs one click to recover. A wrongly promoted one becomes a
 * real entity that later runs are pointed at, so the second generation of findings is
 * about a stranger while carrying the subject's name — and because promotion is also what
 * makes something look established, that mistake gets more convincing the deeper it goes.
 *
 * What the operator gets instead is a group with one button on it. Each band says what it
 * means, each row says which signals fired and how strong each was, and each hidden row
 * says the rule that hid it.
 */

export function CandidatesPanel({
  ranked,
  scored,
  busyId,
  onPromote,
  onDismiss,
  onPromoteConfirmed,
  onPromoteMany
}: {
  /** Candidates with their relevance already computed. */
  ranked: Ranked<CandidateView>[]
  /** False when nothing is seeded, so the relevance column has nothing to say. */
  scored: boolean
  busyId: string | null
  onPromote: (id: string) => void
  onDismiss: (id: string) => void
  onPromoteConfirmed: () => void
  /** Promote a whole band. Still one deliberate human action, just not ninety of them. */
  onPromoteMany: (ids: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)

  /*
   * Two orthogonal judgements, applied in the right order.
   *
   * Triage asks *how good is the evidence behind this proposal* — a reciprocal link, two
   * independent sources, a weak probe. Relevance asks *is this about the subject at all*.
   * A candidate can have excellent evidence for being somebody else's account, and that is
   * exactly the case the operator hit: two Facebook profiles, cleanly detected, carrying a
   * completely different personal name.
   *
   * So a **contradicted** candidate leaves the triage bands entirely and goes to its own
   * group at the bottom, with its count and its reason on the header. Everything else stays
   * triaged by evidence quality and is ordered by relevance inside its band.
   */
  const contradicted = useMemo(
    () => ranked.filter((r) => r.relevance.band === 'contradicted'),
    [ranked]
  )
  const relevanceOf = useMemo(
    () => new Map(ranked.map((r) => [r.item.id, r.relevance] as const)),
    [ranked]
  )
  const candidates = useMemo(
    () => ranked.filter((r) => r.relevance.band !== 'contradicted').map((r) => r.item),
    [ranked]
  )
  const groups = useMemo(() => {
    const raw = groupCandidates(candidates)
    return raw.map((g) => ({
      ...g,
      items: [...g.items].sort(
        (a, b) =>
          (relevanceOf.get(b.candidate.id)?.score ?? 0) -
            (relevanceOf.get(a.candidate.id)?.score ?? 0) ||
          b.triage.score - a.triage.score ||
          a.candidate.value.localeCompare(b.candidate.value)
      )
    }))
  }, [candidates, relevanceOf])
  const confirmed = candidates.filter((c) => c.bestConfidence === 'confirmed')
  const hidden = groups.find((g) => g.band === 'noise')?.items.length ?? 0
  const shown = candidates.length - hidden

  return (
    <section className="panel">
      <div className="panel__head">
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="panel__title">Discovered, not yet in the case</span>
        </button>
        <span>
          {plural(shown, 'to review')}
          {hidden > 0 ? ` · ${hidden} hidden as noise` : ''}
          {contradicted.length > 0 ? ` · ${contradicted.length} contradicting your seeds` : ''}
        </span>
        <div className="toolbar__spacer" />
        {/* Safe as a bulk action for exactly one reason: `confirmed` cannot be reached
            without a human and a written note, so this promotes nothing nobody vouched
            for. */}
        <button
          type="button"
          className="btn"
          onClick={onPromoteConfirmed}
          disabled={confirmed.length === 0 || busyId !== null}
          title={
            confirmed.length
              ? `Promote the ${confirmed.length} candidate${confirmed.length === 1 ? '' : 's'} whose proposing finding you have already confirmed.`
              : 'Nothing here is backed by a confirmed finding. Confirm the finding first, or promote a candidate individually.'
          }
        >
          Promote {confirmed.length} confirmed
        </button>
      </div>

      {open && (
        <div className="panel__body">
          {ranked.length === 0 ? (
            <EmptyState
              title="Nothing waiting to be reviewed."
              body={[
                'When an adapter finds something that is not in this case — an account on a site, a subdomain, an address printed on a profile — it proposes it here instead of adding it. Nothing enters the graph without you.',
                'That is not caution for its own sake. Every proposal descends from an unverified finding, and a username hit can be a site answering a bot challenge with a 200. Adding those automatically would mean later runs were pointed at accounts that never existed.'
              ]}
              exampleLabel="What a proposal looks like"
              example="account · github.com/exampleuser — proposed by sherlock, unverified"
            />
          ) : (
            <>
              {/* Said once, at the top, in the operator's own terms. The buttons on every
                  row below are the same two words and they never explained themselves. */}
              <p className="cands__legend">
                <strong>Promote</strong> means: this is them. It becomes a real entity in the
                case, tools can be pointed at it, and the pivot search can follow it further.{' '}
                <strong>Dismiss</strong> means: not them. The record stays on disk as part of
                the audit trail and stops being asked about.
              </p>

              {groups.map((group) => (
                <BandGroup
                  key={group.band}
                  band={group.band}
                  items={group.items}
                  relevanceOf={relevanceOf}
                  scored={scored}
                  busyId={busyId}
                  onPromote={onPromote}
                  onDismiss={onDismiss}
                  onPromoteMany={onPromoteMany}
                />
              ))}

              {contradicted.length > 0 && (
                <ContradictedGroup
                  items={contradicted}
                  busyId={busyId}
                  onPromote={onPromote}
                  onDismiss={onDismiss}
                />
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** How many rows a band shows before it asks. Noise starts collapsed entirely. */
const VISIBLE = 8

function BandGroup({
  band,
  items,
  relevanceOf,
  scored,
  busyId,
  onPromote,
  onDismiss,
  onPromoteMany
}: {
  band: TriageBand
  items: { candidate: CandidateView; triage: Triage }[]
  relevanceOf: ReadonlyMap<string, RelevanceAssessment>
  scored: boolean
  busyId: string | null
  onPromote: (id: string) => void
  onDismiss: (id: string) => void
  onPromoteMany: (ids: string[]) => void
}): React.JSX.Element {
  const noise = band === 'noise'
  const [open, setOpen] = useState(!noise)
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? items : items.slice(0, VISIBLE)
  const rest = items.length - shown.length

  return (
    <section className="cands__band" data-band={band}>
      <div className="cands__band-head">
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="cands__band-name">{TRIAGE_LABEL[band]}</span>
          <span className="cands__band-count">{items.length}</span>
        </button>
        <div className="toolbar__spacer" />
        {/* Only the top band gets a bulk promote. "Probably them" is exactly the band
            where a wrong one is plausible enough to slip through unread. */}
        {band === 'almost-certain' && (
          <button
            type="button"
            className="btn"
            disabled={busyId !== null}
            onClick={() => onPromoteMany(items.map((i) => i.candidate.id))}
            title="Adds all of these to the case as discovered entities. Still your decision — this button is the decision."
          >
            Promote all {items.length}
          </button>
        )}
      </div>

      {open && (
        <>
          <p className="cands__band-meaning">{TRIAGE_MEANING[band]}</p>
          <ul className="cands">
            {shown.map(({ candidate, triage }) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                triage={triage}
                relevance={relevanceOf.get(candidate.id) ?? unscored()}
                scored={scored}
                busy={busyId === candidate.id}
                disabled={busyId !== null && busyId !== candidate.id}
                onPromote={() => onPromote(candidate.id)}
                onDismiss={() => onDismiss(candidate.id)}
              />
            ))}
          </ul>
          {(rest > 0 || showAll) && (
            <div className="cands__more">
              <button type="button" className="btn btn--quiet" onClick={() => setShowAll((v) => !v)}>
                {showAll ? `Show the first ${VISIBLE}` : `Show all ${items.length}`}
              </button>
              {!showAll && <span className="hint">{rest} more in this band.</span>}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function CandidateRow({
  candidate,
  triage,
  relevance,
  scored,
  busy,
  disabled,
  onPromote,
  onDismiss
}: {
  candidate: CandidateView
  triage: Triage
  relevance: RelevanceAssessment
  scored: boolean
  busy: boolean
  disabled: boolean
  onPromote: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const [showEvidence, setShowEvidence] = useState(false)
  const level = LEVELS[candidate.bestConfidence]
  const n = candidate.proposals.length
  const weak = candidate.claims.find((c) => c.matcher?.strength === 'weak')?.matcher

  return (
    <li className="cand" data-confidence={candidate.bestConfidence} data-band={triage.band}>
      <div className="cand__main">
        {/* Relevance first, because it answers the question that comes before the
            evidence question: is this about the subject at all. */}
        <RelevanceMark relevance={relevance} scored={scored} />
        <span className="cand__kind">{candidate.kind}</span>
        <Data className="cand__value" title={candidate.value}>
          {candidate.label || candidate.value}
        </Data>

        {/* The confidence of the *evidence*, not of the candidate — a candidate has no
            confidence of its own, and giving it one would invent a fact. */}
        <span className="conf cand__conf" title={level.title}>
          <Icon name={level.icon} className="conf__glyph" size={11} />
          <span className="conf__word">{level.label}</span>
        </span>

        {weak && (
          <span className="cand__weak" title={weak.why}>
            <Icon name="warning" size={11} />
            {weak.label}
          </span>
        )}

        <button
          type="button"
          className="btn btn--quiet cand__why"
          onClick={() => setShowEvidence((v) => !v)}
          aria-expanded={showEvidence}
          title="Show the findings that proposed this, where they came from, and which signals fired."
        >
          <Icon name={showEvidence ? 'chevron-down' : 'chevron-right'} size={11} />
          {triage.pivot
            ? `${triage.pivot.signals.length} signal${triage.pivot.signals.length === 1 ? '' : 's'} · ${triage.score}/100`
            : n === 1
              ? '1 proposal'
              : `${n} proposals · ${candidate.independentSources} independent ${candidate.independentSources === 1 ? 'source' : 'sources'}`}
        </button>

        <div className="cand__actions">
          <button
            type="button"
            className="btn"
            onClick={onPromote}
            disabled={disabled || busy}
            data-loading={busy ? 'true' : undefined}
            title="This is them. Adds it to the case as a discovered entity so tools can be pointed at it and the pivot search can follow it."
          >
            {busy ? 'Adding…' : 'Promote'}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={onDismiss}
            disabled={disabled || busy}
            title="Not them. The record stays on disk as part of the audit trail and stops being asked about."
          >
            Dismiss
          </button>
        </div>
      </div>

      {/* One line of reasoning on every row, always — the operator is building this to
          understand mechanisms, and a triage that only sorts teaches nothing. */}
      <p className="cand__reason">
        {triage.hiddenBecause ?? triage.reasons[0] ?? 'One source said so and nothing else has.'}
        {scored && <RelevanceWhy relevance={relevance} />}
      </p>

      {showEvidence && (
        <div className="cand__evidence-wrap">
          {triage.pivot && (
            <>
              <p className="cand__meaning">{pivotMeaning(triage.pivot)}</p>
              <ul className="cand__signals">
                {triage.pivot.signals.map((s) => (
                  <li className="cand__signal" key={s.id} data-strength={s.strength}>
                    <span className="cand__signal-name">{PIVOT_SIGNAL_LABEL[s.id]}</span>
                    <span className="cand__signal-weight">
                      {s.strength} · +{s.points}
                    </span>
                    <span className="cand__signal-detail">{s.detail}</span>
                  </li>
                ))}
                {/* What could not be checked, never rendered as what was not there. */}
                {triage.pivot.unevaluated.map((g, i) => (
                  <li className="cand__signal cand__signal--gap" key={`${g.id}-${i}`}>
                    <span className="cand__signal-name">{PIVOT_SIGNAL_LABEL[g.id]}</span>
                    <span className="cand__signal-weight">could not check</span>
                    <span className="cand__signal-detail">{g.why}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <ol className="cand__evidence">
            {candidate.claims.map((claim) => (
              <li key={claim.findingId} className="cand__claim" data-confidence={claim.confidence}>
                <span className="cand__claim-text">{claim.claim}</span>
                <span className="cand__claim-meta">
                  <Data>{claim.source}</Data>
                  <span className="dot-sep">·</span>
                  {claim.tool}
                  <span className="dot-sep">·</span>
                  {LEVELS[claim.confidence].label}
                  {claim.matcher && (
                    <>
                      <span className="dot-sep">·</span>
                      <span title={claim.matcher.why}>{claim.matcher.label}</span>
                    </>
                  )}
                </span>
                {claim.matcher && <span className="cand__claim-why">{claim.matcher.why}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  )
}

/**
 * Candidates whose own content disagrees with the seeds.
 *
 * Its own group rather than a triage band, because triage judges the *evidence* — how many
 * sources, how good the probe — and this judges the *subject*. A candidate can be cleanly
 * detected, corroborated by two sites, and still be somebody else: two Facebook profiles
 * in the operator's first real run carried a completely different Bulgarian personal name
 * from the seeded one, and under evidence-only triage they sat near the top.
 *
 * Collapsed by default and **never emptied**. The header carries a count and the reason
 * they were set aside, so what is inside is predictable before it is opened — "4 hidden"
 * tells him nothing about whether to look, "4 carry a different personal name" tells him
 * exactly. Promote and Dismiss are on every row, unchanged: the seed can be the thing that
 * is wrong, and the app has no standing to make that call.
 */
function ContradictedGroup({
  items,
  busyId,
  onPromote,
  onDismiss
}: {
  items: Ranked<CandidateView>[]
  busyId: string | null
  onPromote: (id: string) => void
  onDismiss: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <section className="cands__band" data-band="contradicted">
      <div className="cands__band-head">
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="cands__band-name">{RELEVANCE_BAND_LABEL.contradicted}</span>
          <span className="cands__band-count">{items.length}</span>
        </button>
      </div>
      <p className="cands__band-meaning">{contradictionSummary(items)}</p>
      {open && (
        <>
          <p className="cands__band-meaning">{RELEVANCE_BAND_MEANING.contradicted}</p>
          <ul className="cands">
            {items.map(({ item, relevance }) => (
              <CandidateRow
                key={item.id}
                candidate={item}
                triage={triage(item)}
                relevance={relevance}
                scored
                busy={busyId === item.id}
                disabled={busyId !== null && busyId !== item.id}
                onPromote={() => onPromote(item.id)}
                onDismiss={() => onDismiss(item.id)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

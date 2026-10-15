import { useCallback, useEffect, useState } from 'react'
import type { AdapterInfo, ConfidenceChange, Finding } from '../../../shared/types'
import { bytes, stamp } from '../lib/format'
import type { RelevanceAssessment } from '../../../shared/relevance'
import { firstLink, trailingLink } from '../../../shared/links'
import { ConfidenceMark, LEVELS } from './Confidence'
import { CopyValue, Data } from './Data'
import { ClaimText, ExternalLink, SourceLink } from './Link'
import { RelevanceDetail } from './Relevance'
import { HowThisWorks } from './HowThisWorks'
import { Notice } from './Feedback'
import { ConfidenceHistory, CorroborationOffer, VerifyControl } from './Verify'

/**
 * One finding, in the margin.
 *
 * A Finding is not a fact — it is "tool X, reading source Y, asserted Z" — so this panel
 * is laid out to keep those three separable: the claim, then who said it and where they
 * read it, then the unparsed bytes they actually returned, then how that tool lies.
 *
 * Raw output opens inline in a well rather than a modal. It is the evidence; putting it
 * behind a dialog would make the parsed sentence the primary artifact and the bytes the
 * footnote, which is backwards.
 *
 * Below the bytes sits the only place in the app where a person can move a finding up or
 * down the confidence ladder. It belongs here rather than anywhere else for the same
 * reason the raw well does: the decision to vouch for a claim should be taken next to the
 * evidence for it, with the tool's own "how it lies to you" block on the same screen.
 */
export function FindingDetail({
  finding,
  relevance,
  scored,
  adapter,
  caseId,
  onVerified
}: {
  finding: Finding
  /** How the case's seeds rank this row. Orthogonal to confidence, and kept that way. */
  relevance: RelevanceAssessment
  scored: boolean
  adapter: AdapterInfo | undefined
  caseId: string
  /** Called with the finding as the main process wrote it, after a confidence change. */
  onVerified: (updated: Finding) => void
}): React.JSX.Element {
  const [raw, setRaw] = useState<string | null>(null)
  const [rawError, setRawError] = useState<string | null>(null)
  const [rawLoading, setRawLoading] = useState(false)

  /**
   * The audit trail and the standing corroboration count.
   *
   * Both are re-read whenever this finding's confidence changes, not just when the
   * selection does: a promotion appends to the log and moves the count, and a panel still
   * showing the pre-promotion story would be lying about the thing it exists to explain.
   */
  const [changes, setChanges] = useState<ConfidenceChange[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [logError, setLogError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Finding[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(true)

  // A different finding is a different well. Without this the previous finding's bytes
  // would sit under the new one's claim, which is the worst possible bug in this app.
  useEffect(() => {
    setRaw(null)
    setRawError(null)
    setRawLoading(false)
  }, [finding.id])

  useEffect(() => {
    // `cancelled` rather than an AbortController: these are IPC round trips, not fetches,
    // and the only failure mode that matters is a slow answer for a finding the operator
    // has already clicked away from landing in the panel for the new one.
    let cancelled = false
    setLogLoading(true)
    setCandidatesLoading(true)
    setLogError(null)
    void (async () => {
      try {
        const [log, cands] = await Promise.all([
          window.osint.confidence.log(caseId),
          window.osint.findings.corroborationCandidates(caseId, finding.id)
        ])
        if (cancelled) return
        setChanges(log.filter((c) => c.findingId === finding.id))
        setCandidates(cands)
      } catch (err) {
        if (cancelled) return
        setLogError((err as Error).message)
        setChanges([])
        setCandidates([])
      } finally {
        if (!cancelled) {
          setLogLoading(false)
          setCandidatesLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [caseId, finding.id, finding.confidence])

  const loadRaw = useCallback(async () => {
    if (raw !== null) {
      setRaw(null)
      return
    }
    setRawLoading(true)
    setRawError(null)
    try {
      setRaw(await window.osint.findings.raw(caseId, finding.id))
    } catch (err) {
      setRawError((err as Error).message)
    } finally {
      setRawLoading(false)
    }
  }, [caseId, finding.id, raw])

  // The page this claim is about. Adapters put it last in the sentence and never punctuate
  // it, so the trailing address is the one the row pins — and the margin must name the same
  // page the row does, or the two disagree on a claim that carries more than one URL.
  // `firstLink` is the fallback for a claim written the other way round.
  const profileUrl = trailingLink(finding.claim)?.link.href ?? firstLink(finding.claim)

  return (
    <div data-confidence={finding.confidence}>
      <ClaimText text={finding.claim} className="detail__claim claim" />

      <div className="detail">
        <div className="detail__row">
          <span className="detail__key">Confidence</span>
          <span className="detail__value">
            <ConfidenceMark confidence={finding.confidence} />
          </span>
        </div>
        <div className="detail__row">
          <span className="detail__key">Source</span>
          <span className="detail__value">
            <SourceLink source={finding.source} />
            <span className="dot-sep">·</span>
            <CopyValue value={finding.source} label="copy" title={`Copy ${finding.source}`} />
          </span>
        </div>
        {/* The page this claim is about, when the tool reported one. Straight to the
            browser, and copyable as an address with no sentence punctuation on it. */}
        {profileUrl && (
          <div className="detail__row">
            <span className="detail__key">Page</span>
            <span className="detail__value">
              <ExternalLink href={profileUrl} />
            </span>
          </div>
        )}
        <div className="detail__row">
          <span className="detail__key">Tool</span>
          <span className="detail__value">
            <Data>{finding.tool}</Data>
          </span>
        </div>
        <div className="detail__row">
          <span className="detail__key">First seen</span>
          <span className="detail__value">
            <Data>{stamp(finding.firstSeen)}</Data>
          </span>
        </div>
        <div className="detail__row">
          <span className="detail__key">Re-observed</span>
          <span className="detail__value">
            <Data
              title={
                finding.lastVerified
                  ? 'The same claim was seen again by a later run.'
                  : 'No later run has produced this claim a second time.'
              }
            >
              {stamp(finding.lastVerified)}
            </Data>
          </span>
        </div>
        <div className="detail__row">
          <span className="detail__key">Raw</span>
          <span className="detail__value">
            <CopyValue value={finding.raw.sha256} label={finding.raw.sha256.slice(0, 12)} title="Copy the full sha256 of the stored output" />
            <span className="dot-sep">·</span>
            <Data>{bytes(finding.raw.bytes)}</Data>
          </span>
        </div>

        <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
          {LEVELS[finding.confidence].title}
        </p>

        <button
          type="button"
          className="btn"
          onClick={() => void loadRaw()}
          data-loading={rawLoading ? 'true' : undefined}
          disabled={rawLoading}
          style={{ marginTop: 'var(--space-3)' }}
          aria-expanded={raw !== null}
        >
          {rawLoading ? 'Reading from disk…' : raw !== null ? 'Hide raw output' : 'Read raw output'}
        </button>

        {/* Deliberately under the raw button rather than over it. Reading the bytes is
            what makes a confirmation worth anything, so the order on screen is the order
            the operator should work in: claim, provenance, evidence, then the judgement. */}
        <CorroborationOffer
          finding={finding}
          caseId={caseId}
          candidates={candidates}
          loading={candidatesLoading}
          onVerified={onVerified}
        />

        <VerifyControl finding={finding} caseId={caseId} onVerified={onVerified} />
      </div>

      {rawError && (
        <Notice state="danger" label="Unreadable">
          {rawError} The finding is intact; only the stored bytes could not be opened.
        </Notice>
      )}

      {raw !== null && (
        <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
          <pre className="raw">{raw}</pre>
        </div>
      )}

      <ConfidenceHistory changes={changes} loading={logLoading} error={logError} />

      <RelevanceDetail relevance={relevance} scored={scored} />

      <HowThisWorks doc={adapter?.doc} toolId={finding.tool} version={adapter?.version} />
    </div>
  )
}

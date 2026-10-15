import { useState } from 'react'
import type { CaseBasis } from '../../../shared/types'
import { CASE_BASES } from '../../../shared/types'
import type { CaseSummary } from '../../../shared/ipc'
import { day, group } from '../lib/format'
import { Data } from './Data'
import { EmptyState, Loading, Notice } from './Feedback'

/**
 * Every case, as a table.
 *
 * Not a list of cards. A card per case would give each one a box, a shadow and a
 * rounded corner in exchange for showing four fewer of them, and the thing worth
 * comparing across cases — how much of each is still unverified — is a column.
 *
 * `basis` leads the row after the name because it is the app's legal spine: it decides
 * whether an export may leave the machine, and `createCase` enforces that at creation
 * rather than trusting this screen.
 */
export function CasesView({
  cases,
  loading,
  onOpen,
  onCreated
}: {
  cases: CaseSummary[]
  loading: boolean
  onOpen: (id: string) => void
  onCreated: () => void
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [basis, setBasis] = useState<CaseBasis>('self')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const created = await window.osint.cases.create({
        name: name.trim(),
        basis,
        subjectConsent: consent
      })
      setCreating(false)
      setName('')
      setConsent(false)
      onCreated()
      onOpen(created.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="view">
      <header className="view__head">
        <h1 className="view__title">Cases</h1>
        <div className="view__actions">
          <button
            type="button"
            className={creating ? 'btn' : 'btn btn--primary'}
            onClick={() => setCreating((v) => !v)}
            aria-expanded={creating}
          >
            {creating ? 'Cancel' : 'New case'}
          </button>
        </div>
      </header>

      <div className="view__scroll">
        {error && (
          <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}

        {/* Inline disclosure, not a dialog. DESIGN.md: exhaust the panel and inline
            disclosure before reaching for a modal. */}
        {creating && (
          <section className="panel">
            <div className="panel__body" style={{ maxWidth: 640 }}>
              <div className="field">
                <label className="label" htmlFor="case-name">
                  Name
                </label>
                <input
                  id="case-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Self-audit L0 — one username"
                  autoFocus
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="case-basis">
                  Basis
                </label>
                <select
                  id="case-basis"
                  className="select"
                  value={basis}
                  onChange={(e) => setBasis(e.target.value as CaseBasis)}
                >
                  {CASE_BASES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <p className="hint">{BASIS_HELP[basis]}</p>
              </div>

              {basis === 'consent' && (
                <div className="field">
                  <label className="check">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span className="check__box" aria-hidden="true">
                      <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2.5 7.5 5.5 10.5 11.5 4" />
                      </svg>
                    </span>
                    <span className="check__label">
                      The subject has explicitly consented to being investigated, and I can say
                      when and how they said so.
                    </span>
                  </label>
                </div>
              )}

              <div className="empty__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void create()}
                  disabled={!name.trim() || (basis === 'consent' && !consent) || busy}
                  data-loading={busy ? 'true' : undefined}
                >
                  {busy ? 'Creating…' : 'Create case'}
                </button>
                {basis === 'consent' && !consent && (
                  <span className="hint">
                    A consent case cannot be created without this. It is checked in the main
                    process, not here.
                  </span>
                )}
              </div>
            </div>
          </section>
        )}

        <div className="view__body">
          {loading ? (
            <Loading what="cases" />
          ) : cases.length === 0 ? (
            <EmptyState
              title="No cases yet."
              body={[
                'A case is a folder on disk under cases/ — case.json, entities.json, findings.jsonl, and every byte any tool ever printed. Nothing is trapped in a database: the SQLite index is derived and can be deleted at any time without losing a thing.',
                'Every case declares why you are allowed to look. That basis is checked at creation and decides whether an export may ever be published, so start with the one you actually mean.'
              ]}
              exampleLabel="A first case"
              example={'Self-audit L0 — one username\nbasis: self · exports stay private'}
              actions={
                <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
                  New case
                </button>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Cases">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col" style={{ width: 112 }}>
                      Basis
                    </th>
                    <th scope="col" className="col--num" style={{ width: 76 }}>
                      Findings
                    </th>
                    {/* Not a badge and not a score: the one number that says what kind of
                        case this is. 44 of 47 still unverified is a starting point; 3 of 47
                        is a finished piece of work. The full breakdown is on the row's
                        title and in the case itself. */}
                    <th scope="col" style={{ width: 176 }}>
                      Standing
                    </th>
                    <th scope="col" className="col--seen" style={{ width: 120 }}>
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => (
                    <tr
                      key={c.id}
                      tabIndex={0}
                      onClick={() => onOpen(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpen(c.id)
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <td title={c.name}>{c.name}</td>
                      <td>
                        <span title={BASIS_HELP[c.basis]}>{c.basis}</span>
                      </td>
                      <td
                        className="col--num data"
                        title={`${c.counts.findings} findings across ${c.counts.entities} entities`}
                      >
                        {group(c.counts.findings)}
                      </td>
                      <td>
                        <Data
                          title={`${c.counts.confirmed} confirmed, ${c.counts.corroborated} corroborated, ${c.counts.unverified} unverified, ${c.counts.refuted} refuted`}
                        >
                          {c.counts.findings === 0 ? (
                            <span className="hint">nothing yet</span>
                          ) : (
                            /* The number is what the eye wants; the words are the label.
                               Deliberately not on the confidence ramp — the ramp says how
                               sure one finding is, and borrowing it here would make the
                               most important figure in the cell the dimmest thing in it. */
                            <span className="stat">
                              <span className="stat__n">{c.counts.unverified}</span> of{' '}
                              <span className="stat__n">{c.counts.findings}</span> unverified
                            </span>
                          )}
                        </Data>
                      </td>
                      <td className="data col--seen">{day(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const BASIS_HELP: Record<CaseBasis, string> = {
  self: 'The subject is you. Exports stay private — a self-audit report is by definition a complete dossier on yourself.',
  consent:
    'A real person who has explicitly agreed. Consent to be investigated is not consent to be published, so exports stay private.',
  'ctf-fictional':
    'An invented persona from a challenge set. No real subject exists, so exports are publishable.',
  'public-entity':
    'A company, domain or organisation. Not personal data, so exports are publishable.',
  training:
    'A geolocation or verification drill. The subject is a place or an artifact, so exports are publishable.'
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuditEntry, ScrubEnv, ScrubResult } from '../../../../shared/ipc'
import { CopyValue, Data, Tag } from '../Data'
import { EmptyState, Loading, Notice } from '../Feedback'
import { Icon } from '../Icon'

/**
 * The Scrub view — metadata inspection and stripping, with no terminal.
 *
 * The work is done by the opsec-kit checkout, a Python toolkit that is deliberately not
 * reimplemented here. It already gets three things right that are easy to get wrong:
 * Cyrillic filenames survive because every ExifTool call goes through a UTF-8 argfile
 * rather than argv; `-all=` is paired with `--icc_profile:all` so stripping a photo does
 * not also strip the colour profile and wreck how it looks; and after writing, the
 * output is re-read *and* scanned as raw bytes, which is the only way to catch ExifTool's
 * incremental PDF edits leaving deleted values recoverable in the file.
 *
 * This view's job is to make all of that visible and safe to press. Two rules follow
 * from that and both shape the layout:
 *
 *  - **Inspect before acting.** Nothing is written until the operator has seen the field
 *    list, its risk classes and the plain-English reason each one matters. The "why" text
 *    is the Python's own, quoted, never paraphrased.
 *  - **A written file is not a clean file.** `VERIFIED` is one of four verification
 *    outcomes and the other three are all reported as `ok`. The result line says which.
 */

const RISK_LABEL: Record<string, string> = {
  SENSITIVE: 'sensitive',
  IDENTIFYING: 'identifying'
}

/** `"48.858400 N, 2.294500 E"` → signed decimals. The sign lives in the letter. */
export function parseGps(s: string): [number, number] | null {
  const m = /^\s*([\d.]+)\s*([NS])\s*,\s*([\d.]+)\s*([EW])\s*$/.exec(s)
  if (!m) return null
  const lat = Number(m[1]) * (m[2] === 'S' ? -1 : 1)
  const lon = Number(m[3]) * (m[4] === 'W' ? -1 : 1)
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null
}

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p

type Mode = 'files' | 'folder'

export function ScrubView(): React.JSX.Element {
  const [env, setEnv] = useState<ScrubEnv | null>(null)
  const [mode, setMode] = useState<Mode>('files')
  const [paths, setPaths] = useState<string[]>([])
  const [inspection, setInspection] = useState<ScrubResult[] | null>(null)
  const [outcome, setOutcome] = useState<ScrubResult[] | null>(null)
  const [audit, setAudit] = useState<{ path: string; entries: AuditEntry[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [confirmInPlace, setConfirmInPlace] = useState(false)

  useEffect(() => {
    window.osint.scrub
      .env()
      .then(setEnv)
      .catch((e: Error) => setError(e.message))
  }, [])

  const inspect = useCallback(async (next: string[]) => {
    setPaths(next)
    setOutcome(null)
    setInspection(null)
    setConfirmInPlace(false)
    if (!next.length) return
    setError(null)
    setBusy(`Reading metadata from ${next.length} file${next.length === 1 ? '' : 's'}…`)
    try {
      setInspection(await window.osint.scrub.inspect(next))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

  /* Drag and drop onto the window is the primary way in. `File.path` was removed in
     Electron 32, so the absolute path comes from `webUtils.getPathForFile` in the
     preload — the page itself never learns a path it did not already have. */
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    const next = files.map((f) => window.osint.scrub.pathForFile(f)).filter(Boolean)
    if (!next.length) {
      setError('Nothing usable was dropped. Drop files from Explorer rather than from another application.')
      return
    }
    if (mode === 'folder') void runAudit(next[0])
    else void inspect(next)
  }

  const runAudit = async (folder: string): Promise<void> => {
    setError(null)
    setInspection(null)
    setOutcome(null)
    setBusy(`Auditing ${folder}. ExifTool reads in batches of 200, so nothing appears until the sweep finishes.`)
    try {
      setAudit({ path: folder, entries: await window.osint.scrub.audit({ path: folder, recursive: true, gpsOnly: false }) })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const run = async (kind: 'copy' | 'in-place'): Promise<void> => {
    setError(null)
    setConfirmInPlace(false)
    setBusy(kind === 'copy' ? 'Writing cleaned copies and verifying them…' : 'Replacing in place and verifying…')
    try {
      setOutcome(await window.osint.scrub.run({ paths, mode: kind }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const totals = useMemo(() => {
    const rows = inspection ?? []
    let sensitive = 0
    let identifying = 0
    let gps = false
    for (const r of rows) {
      for (const f of r.findings) {
        if (f.category === 'SENSITIVE') sensitive++
        else if (f.category === 'IDENTIFYING') identifying++
        if (f.field.startsWith('GPS:')) gps = true
      }
    }
    return { sensitive, identifying, gps, files: rows.length }
  }, [inspection])

  /* ------------------------------------------------------ the toolchain gate */

  if (env && !env.ok) {
    return (
      <div className="view">
        <header className="view__head">
          <h1 className="view__title">Scrub</h1>
          <span className="view__subtitle">not ready</span>
        </header>

        <div className="view__scroll">
          <div className="view__body view__body--pad">
            <Notice state="danger" label="Cannot run">
              The scrubber could not be started. Each problem below has to be fixed before
              anything can be inspected.
            </Notice>
            <ul className="scrub__problems">
              {env.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <Toolchain env={env} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEnv(null)
                void window.osint.scrub.env().then(setEnv)
              }}
            >
              Check again
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="view scrub"
      data-dropping={dropping ? 'true' : undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false)
      }}
      onDrop={onDrop}
    >
      <header className="view__head">
        <h1 className="view__title">Scrub</h1>
        <span className="view__subtitle">
          {mode === 'files' ? 'inspect, then strip' : 'audit a folder'}
        </span>
        <div className="view__actions">
          <div className="segments" role="tablist" aria-label="Mode">
            <button
              type="button"
              className="btn"
              role="tab"
              aria-selected={mode === 'files'}
              onClick={() => {
                setMode('files')
                setAudit(null)
              }}
            >
              Files
            </button>
            <button
              type="button"
              className="btn"
              role="tab"
              aria-selected={mode === 'folder'}
              onClick={() => {
                setMode('folder')
                setInspection(null)
                setOutcome(null)
              }}
            >
              Audit a folder
            </button>
          </div>
          {mode === 'files' ? (
            <button
              type="button"
              className="btn"
              onClick={() => void window.osint.scrub.pick().then((p) => {
                if (p.length) void inspect(p)
              })}
            >
              Choose files
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() =>
                void window.osint.scrub.pickFolder('Choose a folder to audit').then((p) => {
                  if (p) void runAudit(p)
                })
              }
            >
              Choose a folder
            </button>
          )}
        </div>
      </header>

      <div className="view__scroll">
        <div className="view__body view__body--pad">
          {error && (
            <Notice state="danger" label="Failed" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}

          {busy && (
            <div className="scrub__busy">
              <p className="scrub__busy-line">{busy}</p>
              <Loading what="metadata" />
            </div>
          )}

          {!busy && mode === 'files' && !inspection && !outcome && (
            <EmptyState
              title="Every photograph you have ever sent someone carried more than the picture."
              body={[
                'A phone camera writes the exact coordinates, to a few metres, into the file. It also writes the body and lens, a serial number, the capture time to the second, and often the owner name from the phone settings. A PDF carries the author and the software. An Office document carries every person who edited it. None of it is visible when you look at the file, and all of it survives being emailed.',
                'Drop files onto this window and nothing is written. You get the field list first: what is in there, how bad each field is, and why it matters. Only then do you choose whether to write a cleaned copy or replace the original — and replacing always keeps a backup.',
                'After a scrub the output is re-read and its raw bytes are searched for the values that were supposed to be gone. That last step is not paranoia: ExifTool edits PDFs incrementally, so a PDF can report clean while the old author name is still sitting in the file.'
              ]}
              exampleLabel="What one holiday photo gives away"
              example={
                'GPS:GPSLatitude        48.8584         sensitive   exact capture location, to a few metres\nExifIFD:SerialNumber   XA7B2299110     sensitive   ties every photo you have ever posted together\nIFD0:Artist            Alex Example identifying your name, written by the camera'
              }
              actions={
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void window.osint.scrub.pick().then((p) => {
                  if (p.length) void inspect(p)
                })}
                >
                  Choose files
                </button>
              }
            />
          )}

          {!busy && mode === 'folder' && !audit && (
            <EmptyState
              title="Which files in this folder would give away where you live."
              body={[
                'A folder audit reads every supported file and ranks them worst first, by how much each one carries and how identifying it is. It writes nothing at all — this is the read-only half of the tool.',
                'The ranking exists because the answer is never uniform. A camera roll copied off a phone is mostly harmless landscape shots and then four files with your street on them. Those four are the ones worth finding, and scrolling a flat list will not find them.',
                'GPS is called out separately with the actual coordinates, because it is the one field that locates you rather than describing you.'
              ]}
              exampleLabel="What comes back"
              example={
                'score 482  IMG_4471.jpg   GPS 48.858400 N, 2.294500 E   18 sensitive · 6 identifying\nscore 310  scan.pdf       no GPS                          9 sensitive · 2 identifying\nscore  45  render.png     no GPS                          1 sensitive · 3 identifying'
              }
              actions={
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() =>
                    void window.osint.scrub.pickFolder('Choose a folder to audit').then((p) => {
                      if (p) void runAudit(p)
                    })
                  }
                >
                  Choose a folder
                </button>
              }
            />
          )}

          {!busy && mode === 'files' && inspection && !outcome && (
            <>
              <div className="panel">
                <div className="panel__head">
                  <h2 className="panel__title">
                    {totals.files} file{totals.files === 1 ? '' : 's'} · {totals.sensitive} sensitive,{' '}
                    {totals.identifying} identifying
                  </h2>
                  <span className="toolbar__spacer" />
                  {totals.gps && (
                    <span className="state-warning">
                      <Icon name="warning" size={12} /> carries GPS
                    </span>
                  )}
                </div>
                <div className="panel__body">
                  <p className="scrub__lede">
                    Nothing has been written. This is what is in the files right now, and
                    what each field means — the wording is the scrubber's own.
                  </p>
                </div>
              </div>

              {inspection.map((file) => (
                <FileFindings key={file.path} file={file} />
              ))}

              <div className="scrub__actions">
                <button type="button" className="btn btn--primary" onClick={() => void run('copy')}>
                  Scrub a copy
                </button>
                <button type="button" className="btn btn--danger" onClick={() => setConfirmInPlace(true)}>
                  Scrub in place
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => void inspect([])}>
                  Clear
                </button>
              </div>
              <p className="scrub__hint">
                A copy is written beside each original as{' '}
                <Data>name.scrubbed.ext</Data>, and the original is never opened for
                writing.
              </p>

              {confirmInPlace && (
                <div className="scrub__confirm" role="alertdialog" aria-label="Confirm scrubbing in place">
                  <h3 className="scrub__confirm-title">
                    <Icon name="warning" size={14} /> Replace {paths.length} original
                    {paths.length === 1 ? '' : 's'}?
                  </h3>
                  <p className="scrub__confirm-body">
                    Each file is copied to <Data>name.ext.bak</Data> in the same folder
                    first, the clean version is written and verified in a temporary file,
                    and only then does it replace the original. If verification fails the
                    original is left exactly as it was.
                  </p>
                  <p className="scrub__confirm-body">
                    The backup is not optional here. The scrubber skips its own
                    confirmation prompt when it is not run from a terminal, so the only
                    safe way to offer this from a window is to always keep one.
                  </p>
                  <div className="dialog__actions">
                    <button type="button" className="btn btn--danger" onClick={() => void run('in-place')}>
                      Replace, keeping backups
                    </button>
                    <button type="button" className="btn" onClick={() => setConfirmInPlace(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {!busy && outcome && <Outcome results={outcome} onAgain={() => void inspect([])} />}

          {!busy && mode === 'folder' && audit && (
            <AuditTable
              folder={audit.path}
              entries={audit.entries}
              onScrub={(p) => {
                setMode('files')
                setAudit(null)
                void inspect([p])
              }}
              onClear={() => setAudit(null)}
            />
          )}

          {env && <Toolchain env={env} />}
        </div>

        {dropping && (
          <div className="scrub__drop" aria-hidden="true">
            <p className="scrub__drop-text">
              {mode === 'folder' ? 'Drop a folder to audit it' : 'Drop to read what these files carry'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- inspection */

function FileFindings({ file }: { file: ScrubResult }): React.JSX.Element {
  if (file.error) {
    return (
      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{basename(file.path)}</h3>
        </div>
        <div className="panel__body">
          <Notice state="warning" label="Skipped">
            {file.error}
          </Notice>
        </div>
      </div>
    )
  }

  if (!file.findings.length) {
    return (
      <div className="panel">
        <div className="panel__head">
          <h3 className="panel__title">{basename(file.path)}</h3>
          <span className="toolbar__spacer" />
          <span className="state-success">
            <Icon name="success" size={12} /> nothing sensitive or identifying
          </span>
        </div>
        <div className="panel__body">
          <p className="scrub__lede">
            {file.handler
              ? 'Read as a ' + file.handler + '. Colour profile, orientation and dimensions are the only metadata in it, and those are kept deliberately — stripping them changes how the file looks.'
              : 'The scrubber has no handler for this file type, so it can read it but not strip it.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel__head panel__head--sticky">
        <h3 className="panel__title">{basename(file.path)}</h3>
        <span className="toolbar__spacer" />
        {typeof file.risk === 'number' && <span className="toolbar__count">risk {file.risk}</span>}
        <span className="toolbar__count">
          {file.findings.length} field{file.findings.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="table-wrap">
        <table className="table scrub__table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Class</th>
              <th scope="col">Value</th>
              <th scope="col">Why it matters</th>
            </tr>
          </thead>
          <tbody>
            {file.findings.map((f) => (
              <tr key={f.field} data-risk={f.category}>
                <td>
                  <Data>{f.field}</Data>
                </td>
                <td>
                  <Tag strong={f.category === 'SENSITIVE'}>
                    {RISK_LABEL[f.category] ?? f.category.toLowerCase()}
                  </Tag>
                </td>
                <td className="scrub__value">
                  <CopyValue value={String(f.value ?? '')} />
                </td>
                <td className="scrub__why">{f.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ outcome */

const VERIFY: Record<string, { state: 'success' | 'warning' | 'danger'; icon: 'success' | 'warning' | 'danger'; word: string }> = {
  VERIFIED: { state: 'success', icon: 'success', word: 'Verified' },
  RECOVERABLE: { state: 'warning', icon: 'warning', word: 'Partially clean' },
  FAILED: { state: 'danger', icon: 'danger', word: 'Verification failed' },
  unverifiable: { state: 'warning', icon: 'warning', word: 'Could not verify' }
}

function Outcome({ results, onAgain }: { results: ScrubResult[]; onAgain: () => void }): React.JSX.Element {
  return (
    <>
      {results.map((r) => {
        const v = r.verification
        const shown = VERIFY[v?.status ?? ''] ?? VERIFY.unverifiable
        return (
          <div className="panel" key={r.path}>
            <div className="panel__head">
              <h3 className="panel__title">{basename(r.path)}</h3>
              <span className="toolbar__spacer" />
              <span className={`state-${shown.state}`}>
                <Icon name={shown.icon} size={12} /> {shown.word}
              </span>
            </div>
            <div className="panel__body">
              {r.action === 'skipped' || r.action === 'failed' || r.action === 'aborted' ? (
                <Notice state="warning" label={r.action === 'skipped' ? 'Skipped' : 'Not written'}>
                  {r.error ?? 'The scrubber declined to write this file. The original is unchanged.'}
                </Notice>
              ) : (
                <>
                  <p className="scrub__result-line">
                    {v?.status === 'VERIFIED' &&
                      (v.checked === 0 ? (
                        // Saying "0 fields gone, none remaining" about a file that never
                        // carried anything is technically true and reads as a malfunction.
                        <>
                          There was nothing sensitive or identifying in this one to
                          remove. The copy was written and re-read anyway, and it is
                          clean.
                        </>
                      ) : (
                        <>
                          Re-read the output: <strong>{v.checked}</strong> sensitive or
                          identifying field{v.checked === 1 ? '' : 's'} gone, none remaining.
                        </>
                      ))}
                    {v?.status === 'RECOVERABLE' && (
                      <>
                        The fields no longer read back, but{' '}
                        <strong>{v.recoverable_values.length}</strong> of their values are
                        still findable in the raw bytes and can be recovered. This is
                        normal for a PDF — ExifTool edits them incrementally. Re-export
                        the PDF from its source application for a real clean.
                      </>
                    )}
                    {v?.status === 'FAILED' && (
                      <>
                        <strong>{v.remaining.length}</strong> field
                        {v.remaining.length === 1 ? '' : 's'} survived the scrub and still
                        read back. Nothing was replaced.
                      </>
                    )}
                    {v?.status === 'unverifiable' && (
                      <>The output could not be re-read, so nothing about it can be confirmed.</>
                    )}
                  </p>

                  {!!v?.recoverable_values.length && (
                    <ul className="scrub__residue">
                      {v.recoverable_values.map((val) => (
                        <li key={val}>
                          <Data>{val}</Data>
                        </li>
                      ))}
                    </ul>
                  )}

                  {r.action === 'in-place' ? (
                    <dl className="detail">
                      <div className="detail__row">
                        <dt className="detail__key">replaced</dt>
                        <dd className="detail__value">
                          <Data>{r.path}</Data>
                        </dd>
                      </div>
                      {r.backup && (
                        <div className="detail__row">
                          <dt className="detail__key">backup</dt>
                          <dd className="detail__value">
                            <Data>{r.backup}</Data>
                          </dd>
                        </div>
                      )}
                    </dl>
                  ) : (
                    r.output && (
                      <dl className="detail">
                        <div className="detail__row">
                          <dt className="detail__key">written</dt>
                          <dd className="detail__value">
                            <Data>{r.output}</Data>
                          </dd>
                        </div>
                        <div className="detail__row">
                          <dt className="detail__key">original</dt>
                          <dd className="detail__value">untouched</dd>
                        </div>
                      </dl>
                    )
                  )}

                  {!!r.warnings.length && (
                    <Notice state="warning" label="ExifTool said">
                      {r.warnings.join(' · ')}
                    </Notice>
                  )}

                  <div className="scrub__actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void window.osint.app.revealInFolder(r.output ?? r.path)}
                    >
                      Show in Explorer
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })}
      <div className="scrub__actions">
        <button type="button" className="btn btn--primary" onClick={onAgain}>
          Scrub something else
        </button>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------- audit */

function AuditTable({
  folder,
  entries,
  onScrub,
  onClear
}: {
  folder: string
  entries: AuditEntry[]
  onScrub: (path: string) => void
  onClear: () => void
}): React.JSX.Element {
  const withGps = entries.filter((e) => e.gps).length
  return (
    <div className="panel">
      <div className="panel__head panel__head--sticky">
        <h2 className="panel__title">
          {entries.length} file{entries.length === 1 ? '' : 's'} carrying metadata
        </h2>
        <span className="toolbar__spacer" />
        {withGps > 0 && (
          <span className="state-warning">
            <Icon name="warning" size={12} /> {withGps} with GPS
          </span>
        )}
        <button type="button" className="btn btn--quiet" onClick={onClear}>
          Clear
        </button>
      </div>

      <div className="panel__body">
        <p className="scrub__lede">
          <Data>{folder}</Data>, read recursively. Worst first, ranked by the scrubber.
          Files carrying nothing sensitive or identifying are not listed at all.
        </p>
      </div>

      {!entries.length ? (
        <div className="panel__body">
          <p className="scrub__lede">
            Nothing in this folder carries a sensitive or identifying field. That is a
            real result, not an empty one — it usually means the files were exported by
            software rather than written by a camera.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table scrub__audit">
            <thead>
              <tr>
                <th scope="col" className="col--num">
                  Score
                </th>
                <th scope="col">File</th>
                <th scope="col">Location</th>
                <th scope="col">Carries</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const gps = parseGps(e.gps_position)
                return (
                  <tr key={e.path}>
                    <td className="col--num">
                      <Data>{e.score}</Data>
                    </td>
                    <td>
                      <Data title={e.path}>{basename(e.path)}</Data>
                    </td>
                    <td>
                      {gps ? (
                        <span className="scrub__gps">
                          <CopyValue value={`${gps[0]}, ${gps[1]}`} label={e.gps_position} />
                          <button
                            type="button"
                            className="link"
                            onClick={() =>
                              void window.osint.app.openExternal(
                                `https://www.openstreetmap.org/#map=16/${gps[0]}/${gps[1]}`
                              )
                            }
                          >
                            map
                          </button>
                        </span>
                      ) : e.gps ? (
                        <span className="state-warning">
                          <Icon name="warning" size={12} /> GPS, no readable position
                        </span>
                      ) : (
                        <span className="scrub__nogps">no GPS</span>
                      )}
                    </td>
                    <td>
                      {e.sensitive_count} sensitive · {e.identifying_count} identifying
                      {!!e.top.length && <div className="scrub__top">{e.top.join(', ')}</div>}
                    </td>
                    <td>
                      <button type="button" className="btn btn--quiet" onClick={() => onScrub(e.path)}>
                        Inspect
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- toolchain */

/** What is actually being run. Visible always, so a wrong interpreter is diagnosable. */
function Toolchain({ env }: { env: ScrubEnv }): React.JSX.Element {
  return (
    <details className="scrub__toolchain">
      <summary className="scrub__toolchain-head">
        Toolchain
        <span className={env.ok ? 'state-success' : 'state-danger'}>
          <Icon name={env.ok ? 'success' : 'danger'} size={12} />
          {env.ok ? 'ready' : 'not ready'}
        </span>
      </summary>
      <dl className="detail">
        <div className="detail__row">
          <dt className="detail__key">python</dt>
          <dd className="detail__value">
            {env.python.path ? (
              <>
                <Data>{env.python.path}</Data> {env.python.version} · found via {env.python.how}
              </>
            ) : (
              'not found'
            )}
          </dd>
        </div>
        <div className="detail__row">
          <dt className="detail__key">scrubber</dt>
          <dd className="detail__value">
            <Data>{env.kitRoot.path}</Data> {env.kitRoot.present ? '' : '· missing'}
          </dd>
        </div>
        <div className="detail__row">
          <dt className="detail__key">exiftool</dt>
          <dd className="detail__value">
            {env.exiftool.path ? <Data>{env.exiftool.path}</Data> : 'not configured'}
            {env.exiftool.path && !env.exiftool.present ? ' · missing' : ''}
          </dd>
        </div>
        <div className="detail__row">
          <dt className="detail__key">ffmpeg</dt>
          <dd className="detail__value">
            {env.ffmpeg.path ? <Data>{env.ffmpeg.path}</Data> : 'not configured — video and audio will fail'}
            {env.ffmpeg.path && !env.ffmpeg.present ? ' · missing' : ''}
          </dd>
        </div>
      </dl>
      <p className="scrub__toolchain-note">
        ExifTool and ffmpeg are resolved by the scrubber itself from{' '}
        <Data>config.json</Data> in its own folder, not passed on the command line. They
        are checked here so a missing binary is named before a run rather than during
        one.
      </p>
    </details>
  )
}

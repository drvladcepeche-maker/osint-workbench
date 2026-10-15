import { useState } from 'react'
import type { ExportFormat, ExportLang, ExportResult } from '../../../shared/ipc'
import { Notice } from './Feedback'

/**
 * Handing the case to the person it is about.
 *
 * Inline rather than a modal: the options are four fields and the reader needs the case
 * still visible behind them, because "who is this for" is answered by what is on screen.
 *
 * The noise section ships ON. A report that silently drops what it discarded asks the
 * subject to trust a filter they cannot see — and the whole point of giving it to them
 * is that they can check the work.
 */
export function ExportButton({
  open,
  onToggle
}: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="btn" aria-expanded={open} onClick={onToggle}>
      Export
    </button>
  )
}

export function ExportPanel({
  caseId,
  onClose
}: {
  caseId: string
  onClose: () => void
}): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('html')
  const [lang, setLang] = useState<ExportLang>('en')
  const [subjectName, setSubjectName] = useState('')
  const [preparedBy, setPreparedBy] = useState('')
  const [includeNoise, setIncludeNoise] = useState(true)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const req = { caseId, format, lang, subjectName, preparedBy, includeNoise }

  async function run(action: 'preview' | 'write'): Promise<void> {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      if (action === 'preview') {
        const text = await window.osint.exports.preview(req)
        setPreview(format === 'html' ? text : `<pre>${escapeHtml(text)}</pre>`)
      } else {
        setDone(await window.osint.exports.write(req))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="runform">
      <div className="runform__head">
        <span className="runform__title">Export this case</span>
        <button type="button" className="btn btn--quiet" onClick={onClose}>
          Close
        </button>
      </div>

      <p className="runform__note">
        Written for the person the case is about, not for an investigator. Every row carries
        the confidence it actually earned — two sites agreeing is labelled as two sites
        agreeing, and only a check you made by hand reads as certain. A run that failed or
        was killed is listed as a gap, never as a question nobody asked, and what could not
        be checked is kept apart from what was not found.
      </p>

      <div className="runform__wire">
        <label className="field">
          <span className="label">Format</span>
          <select
            className="select"
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
          >
            <option value="html">HTML — one file, opens anywhere, pictures included</option>
            <option value="markdown">Markdown — text only, no pictures</option>
          </select>
        </label>

        <label className="field">
          <span className="label">Language</span>
          <select
            className="select"
            value={lang}
            onChange={(e) => setLang(e.target.value as ExportLang)}
          >
            <option value="en">English</option>
            <option value="bg">Български</option>
          </select>
        </label>

        <label className="field">
          <span className="label">Subject</span>
          <input
            className="input"
            value={subjectName}
            onChange={(e) => setSubjectName(e.target.value)}
            placeholder="How they would like to be named"
          />
        </label>

        <label className="field">
          <span className="label">Prepared by</span>
          <input
            className="input"
            value={preparedBy}
            onChange={(e) => setPreparedBy(e.target.value)}
            placeholder="Your name — printed beside the declared basis"
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            className="check__box"
            checked={includeNoise}
            onChange={(e) => setIncludeNoise(e.target.checked)}
          />
          <span>
            Include what was set aside as noise
            <span className="hint">
              Collapsed, but present — it is how the reader checks the filter instead of
              trusting it. Turn it off only when you want the clean version; the file still
              states how many rows it left out.
            </span>
          </span>
        </label>
      </div>

      <div className="runform__actions">
        <button type="button" className="btn" disabled={busy} onClick={() => run('preview')}>
          Preview
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => run('write')}
        >
          {busy ? 'Writing…' : 'Save file'}
        </button>
      </div>

      {error && <Notice state="danger">{error}</Notice>}
      {done && (
        <Notice state="success">
          Written to <span className="mono">{done.path}</span>
          {typeof done.bytes === 'number' && ` · ${Math.round(done.bytes / 1024)} kB`}
        </Notice>
      )}

      {preview !== null && (
        <div className="export-preview">
          <div className="export-preview__head">
            <span className="label">Preview</span>
            <button type="button" className="btn btn--quiet" onClick={() => setPreview(null)}>
              Close preview
            </button>
          </div>
          {/*
            `sandbox` with no allow-scripts, and no allow-same-origin. The document embeds
            bios, display names and links harvested from arbitrary third-party sites — text
            this app never wrote and cannot vouch for. Rendered any other way, a script in a
            scraped bio would run with the renderer's own privileges. Inert here.
          */}
          <iframe
            className="export-preview__frame"
            title="Export preview"
            sandbox=""
            srcDoc={preview}
          />
        </div>
      )}
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string
  )
}

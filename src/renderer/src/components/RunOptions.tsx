import { useEffect, useState } from 'react'
import type { AdapterInfo } from '../../../shared/types'
import { Data } from './Data'
import { Icon } from './Icon'

/**
 * Per-run adapter options.
 *
 * Most adapters take a seed and nothing else, and clicking their button runs them. A few
 * cannot work that way: `hibp-passwords` tests a *string* rather than an identity, and
 * that string is a live password which must never be written to a config file, a case
 * file, or anything else on disk. It therefore has to be typed at the moment of use and
 * forgotten immediately afterwards.
 *
 * This is inline disclosure under the launcher rather than a dialog. DESIGN.md bans
 * modal-as-first-thought, and it is right to: a modal would hide the entity the run is
 * pointed at behind the form asking what to run against it.
 *
 * `hasRunForm` is what the launcher uses to decide whether a click runs or opens. There
 * is deliberately no generic options-schema system behind it — one adapter needs a form,
 * one form exists, and inventing a schema language for a set of size one would be
 * guessing at the shape of the next four.
 */

export function hasRunForm(adapterId: string): boolean {
  return adapterId === 'hibp-passwords'
}

export function RunOptionsForm({
  adapter,
  entityLabel,
  busy,
  onRun,
  onCancel
}: {
  adapter: AdapterInfo
  entityLabel: string
  busy: boolean
  onRun: (options: Record<string, unknown>) => void
  onCancel: () => void
}): React.JSX.Element | null {
  if (adapter.id === 'hibp-passwords') {
    return (
      <PwnedPasswordsForm
        adapter={adapter}
        entityLabel={entityLabel}
        busy={busy}
        onRun={onRun}
        onCancel={onCancel}
      />
    )
  }
  return null
}

/* ------------------------------------------------------------------ *
 * hibp-passwords
 * ------------------------------------------------------------------ */

/**
 * The k-anonymity mechanism, shown where it is being used.
 *
 * The operator's stated reason for building this app is understanding mechanisms rather
 * than pressing buttons, and this is the best mechanism in the whole toolbelt: a query
 * designed so that answering it teaches the answerer nothing. Burying that in the doc
 * panel would make this look like every other "check your password" box on the internet,
 * which is exactly the class of thing nobody should ever type a real password into.
 *
 * So the prefix is computed here, in this process, from what has been typed, and shown
 * as it changes. `5BAA6` appears the moment you finish typing `password`, and the five
 * characters on screen are literally the entire request. That is the difference between
 * being told the mechanism is safe and watching it be safe.
 */
function PwnedPasswordsForm({
  adapter,
  entityLabel,
  busy,
  onRun,
  onCancel
}: {
  adapter: AdapterInfo
  entityLabel: string
  busy: boolean
  onRun: (options: Record<string, unknown>) => void
  onCancel: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const { prefix, available } = useSha1Prefix(password)
  const secret = adapter.secretOptions.includes('password')

  const submit = (): void => {
    if (!password || busy) return
    onRun({ password })
    // Held only as long as the run needs it. The field is not repopulated, there is no
    // history, and nothing downstream keeps a copy.
    setPassword('')
  }

  return (
    <div className="runform">
      <div className="runform__head">
        <Icon name="key" size={11} />
        <span className="runform__title">{adapter.title}</span>
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={onCancel}
          aria-label="Close the Pwned Passwords form"
          title="Close without running"
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="field">
        <label className="label" htmlFor="hibp-password">
          Candidate password to test against the breach corpus
        </label>
        <input
          id="hibp-password"
          className="input"
          // A password field, never a text input: it must not be shoulder-readable, must
          // not land in a screenshot of this window, and must not be offered to the
          // browser's autofill store.
          type={secret ? 'password' : 'text'}
          value={password}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="typed here, never saved"
          aria-describedby="hibp-mechanism"
        />
      </div>

      {/* The mechanism, at the point of use. */}
      <div className="runform__mech" id="hibp-mechanism">
        <div className="runform__wire">
          <span className="runform__wire-label">leaves this machine</span>
          {available ? (
            <Data className="runform__prefix">{prefix || '·····'}</Data>
          ) : (
            <Data className="runform__prefix">·····</Data>
          )}
          <span className="runform__wire-rest">
            {password ? '+ 35 characters compared here, never sent' : '5 hex characters, and nothing else'}
          </span>
        </div>
        <p className="runform__note">
          The password is hashed with SHA-1 in this process. Only the first five characters
          of that hash are sent, as <Data>GET /range/{prefix || '5BAA6'}</Data>. The server
          replies with every hash suffix it holds beginning with those five — around 800 of
          them — and the remaining 35 characters are compared here, in memory. It learns
          that somebody asked about one of roughly 800 passwords and cannot tell which.
          <br />
          <br />
          Nothing about the password is written down. Not the password, not its hash, not
          in <Data>findings.jsonl</Data>, not in <Data>raw/</Data>, not in the index. The
          finding records the result — how many times that string appears in the corpus —
          and the prefix above, which is the only part that was ever transmitted.
          {!available && (
            <>
              <br />
              <br />
              This build cannot show the live prefix — the browser refused a SHA-1 digest.
              The mechanism is unchanged; the hashing happens in the main process either
              way.
            </>
          )}
        </p>
      </div>

      <div className="runform__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={!password || busy}
          data-loading={busy ? 'true' : undefined}
        >
          {busy ? 'Checking…' : `Check against the corpus`}
        </button>
        <span className="hint">
          Recorded against {entityLabel}. A hit means the string is known to attackers, not
          that this account was breached.
        </span>
      </div>
    </div>
  )
}

/**
 * The first five hex characters of the SHA-1 of what has been typed — the entire request.
 *
 * `crypto.subtle` is unavailable outside a secure context, and rather than shipping a
 * second SHA-1 implementation into the renderer to cover that, the component says so and
 * drops the live readout. The check itself is unaffected: the hashing that matters
 * happens in the main process.
 */
function useSha1Prefix(value: string): { prefix: string; available: boolean } {
  const available = typeof crypto !== 'undefined' && !!crypto.subtle
  const [prefix, setPrefix] = useState('')

  useEffect(() => {
    if (!available || !value) {
      setPrefix('')
      return
    }
    let cancelled = false
    void crypto.subtle
      .digest('SHA-1', new TextEncoder().encode(value))
      .then((buf) => {
        if (cancelled) return
        const bytes = new Uint8Array(buf).subarray(0, 3)
        const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
        setPrefix(hex.slice(0, 5).toUpperCase())
      })
      .catch(() => {
        if (!cancelled) setPrefix('')
      })
    return () => {
      cancelled = true
    }
  }, [value, available])

  return { prefix, available }
}

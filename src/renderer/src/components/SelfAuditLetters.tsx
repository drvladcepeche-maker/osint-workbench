import { useEffect, useMemo, useState } from 'react'
import type {
  ExposureReport,
  GdprArticle,
  GdprLang,
  GdprLetter,
  PlatformContact
} from '../../../shared/selfaudit'
import { Data } from './Data'
import { Icon } from './Icon'
import { Notice } from './Feedback'
import { useCopy } from '../lib/hooks'

/**
 * The letter generator: Article 17 (erasure) and Article 21 (objection, AI training
 * included), in Bulgarian and English.
 *
 * The UI stays English per DECISIONS.md #8. The letters are not UI — they are documents
 * sent to a controller, and a Bulgarian data subject writing to an Irish or Luxembourg
 * establishment may reasonably do either. Both are offered and neither is a translation of
 * the other; each is written in its own register with its own citations.
 *
 * Two things are deliberately outside the letter body:
 *
 *  - **The warnings.** A letter with a bracketed placeholder in the middle of a legal
 *    request reads as a template someone forgot to finish, and gives a controller an easy
 *    reason to ask for clarification instead of complying. So what is missing is said
 *    above the letter, and the letter itself stays sendable.
 *  - **The escalation paragraph.** It goes in the saved file under a rule, because it is
 *    what happens *after* silence rather than part of the request.
 *
 * This view takes no level, and that is the point. It used to pass the level on screen to
 * `saveLetter`, which wrote the file into that level's case folder — and a letter is
 * completed from the vault, so it carries the operator's real name, his address and his
 * postal address. Saving one while L0 was selected put all three inside the folder whose
 * whole value is that it can be grepped as proof of what L0 never saw. Letters live in
 * `cases/_selfaudit/letters/` now, beside the profile that filled them in. The platforms
 * offered first still come from the report the caller hands in.
 */
export function SelfAuditLetters({ report }: { report: ExposureReport | null }): React.JSX.Element {
  const [contacts, setContacts] = useState<PlatformContact[]>([])
  const [platform, setPlatform] = useState('')
  const [article, setArticle] = useState<GdprArticle>('erasure')
  const [lang, setLang] = useState<GdprLang>('en')
  const [handle, setHandle] = useState('')
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [postalAddress, setPostalAddress] = useState('')
  const [minor, setMinor] = useState(false)
  const [ai, setAi] = useState(true)
  const [extra, setExtra] = useState('')
  const [letter, setLetter] = useState<GdprLetter | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const copy = useCopy()

  useEffect(() => {
    void window.osint.selfAudit
      .contacts()
      .then(setContacts)
      .catch((err) => setError((err as Error).message))
  }, [])

  /* The platforms this level actually turned up, ahead of the full contact book. The
     useful list is the one that came out of his own audit; the rest is a reference. */
  const found = useMemo(() => {
    const keys = new Set((report?.appearances ?? []).map((a) => a.sourceKey).filter(Boolean))
    for (const e of report?.resetPaths.edges ?? []) keys.add(e.platform)
    return [...keys].sort()
  }, [report])

  /* Default to the first platform this level found that the contact book actually covers.
     Alphabetical order otherwise picks something like bit.ly, and a letter to a URL
     shortener is the least useful first draft the page could offer. */
  useEffect(() => {
    if (platform || !found.length) return
    const keys = new Set(contacts.flatMap((c) => [c.key, c.name.toLowerCase()]))
    const known = found.find((f) => keys.has(f) || contacts.some((c) => c.name.toLowerCase().includes(f.split('.')[0] ?? '')))
    setPlatform(known ?? (found[0] as string))
  }, [found, platform, contacts])

  const build = async (): Promise<void> => {
    setError(null)
    setSavedTo(null)
    try {
      setLetter(
        await window.osint.selfAudit.letter({
          platform,
          article,
          lang,
          ...(handle.trim() ? { handle: handle.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(fullName.trim() ? { fullName: fullName.trim() } : {}),
          ...(postalAddress.trim() ? { postalAddress: postalAddress.trim() } : {}),
          minorWhenCreated: minor,
          includeAiTraining: ai,
          ...(extra.trim() ? { extra: extra.trim() } : {})
        })
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const save = async (): Promise<void> => {
    setError(null)
    try {
      const saved = await window.osint.selfAudit.saveLetter({
        platform,
        article,
        lang,
        ...(handle.trim() ? { handle: handle.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(fullName.trim() ? { fullName: fullName.trim() } : {}),
        ...(postalAddress.trim() ? { postalAddress: postalAddress.trim() } : {}),
        minorWhenCreated: minor,
        includeAiTraining: ai,
        ...(extra.trim() ? { extra: extra.trim() } : {})
      })
      setSavedTo(saved.path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="sa-section">
      <h3 className="sa-section__title">Erasure and objection letters</h3>
      <p className="sa-section__lede">
        Article 17 asks a controller to delete what it holds about you. Article 21 objects
        to processing it does on the basis of its own legitimate interests — which is the
        basis most platforms claim for training models on what you posted, so that objection
        is a separate switch below rather than an afterthought in the erasure letter.
      </p>

      {error && (
        <Notice state="danger" label="Refused" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      <div className="sa-letter" style={{ marginTop: 'var(--space-4)' }}>
        <div className="sa-letter__form">
          <div className="field">
            <label className="label" htmlFor="letter-platform">
              Platform
            </label>
            <input
              id="letter-platform"
              className="input input--data"
              list="letter-platforms"
              value={platform}
              spellCheck={false}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder="reddit.com"
            />
            <datalist id="letter-platforms">
              {found.map((f) => (
                <option key={f} value={f} />
              ))}
              {contacts.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </datalist>
            <p className="hint">
              {found.length
                ? `${found.length} came out of this level’s run. Anything else in the contact book works too.`
                : 'No platforms from a run yet — type a host or a contact-book key.'}
            </p>
          </div>

          <div className="field">
            <span className="label">Request</span>
            <div className="segments">
              <button
                type="button"
                className="btn"
                aria-pressed={article === 'erasure'}
                onClick={() => setArticle('erasure')}
              >
                Art. 17 erasure
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={article === 'objection'}
                onClick={() => setArticle('objection')}
              >
                Art. 21 objection
              </button>
            </div>
          </div>

          <div className="field">
            <span className="label">Language</span>
            <div className="segments">
              <button type="button" className="btn" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
                English
              </button>
              <button type="button" className="btn" aria-pressed={lang === 'bg'} onClick={() => setLang('bg')}>
                Български
              </button>
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="letter-handle">
              Username on that platform
            </label>
            <input
              id="letter-handle"
              className="input input--data"
              value={handle}
              spellCheck={false}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="torvalds"
            />
            <p className="hint">Left blank, the first username in the vault is used.</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="letter-email">
              Registered email
            </label>
            <input
              id="letter-email"
              className="input input--data"
              value={email}
              spellCheck={false}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
            <p className="hint">Left blank, the first address in the vault is used.</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="letter-name">
              Your name
            </label>
            <input
              id="letter-name"
              className="input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your full legal name"
            />
            <p className="hint">
              Left blank, the first name in the vault is used. A letter that ends in a
              placeholder is one a controller can ignore.
            </p>
          </div>

          <div className="field">
            <label className="label" htmlFor="letter-address">
              Postal address
            </label>
            <textarea
              id="letter-address"
              className="textarea"
              rows={2}
              value={postalAddress}
              onChange={(e) => setPostalAddress(e.target.value)}
              placeholder="Street, city, postcode"
            />
            <p className="hint">Only needed if you send it on paper.</p>
          </div>

          <label className="check">
            <input
              type="checkbox"
              className="sr-only"
              checked={minor}
              onChange={(e) => setMinor(e.target.checked)}
            />
            <span className="check__box" aria-hidden="true">
              <Icon name="check" size={10} />
            </span>
            <span className="check__label">
              The account was created before I turned 18
              <br />
              <span className="hint">
                Adds Art. 17(1)(f) with Art. 8(1): data collected in relation to information
                society services offered to a child. Recital 65 says the erasure right is of
                particular relevance there, which makes it harder to refuse than the general
                ground.
              </span>
            </span>
          </label>

          {article === 'objection' && (
            <label className="check">
              <input type="checkbox" className="sr-only" checked={ai} onChange={(e) => setAi(e.target.checked)} />
              <span className="check__box" aria-hidden="true">
                <Icon name="check" size={10} />
              </span>
              <span className="check__label">
                Name AI and model training explicitly
                <br />
                <span className="hint">
                  Without this it is a general objection, and a controller can answer about
                  advertising and say nothing about training.
                </span>
              </span>
            </label>
          )}

          <div className="field">
            <label className="label" htmlFor="letter-extra">
              Anything to add, verbatim
            </label>
            <textarea
              id="letter-extra"
              className="textarea"
              rows={3}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="e.g. the specific posts, or a server name where the content lives"
            />
          </div>

          <div className="runbar">
            <button type="button" className="btn btn--primary" onClick={() => void build()} disabled={!platform.trim()}>
              {letter ? 'Rebuild' : 'Write the letter'}
            </button>
          </div>
        </div>

        <div className="sa-letter__body">
          {!letter ? (
            <p className="hint">
              Fill in the platform and press the button. Your own details are filled in from
              the vault where you leave a field blank, so nothing has to be typed twice.
            </p>
          ) : (
            <>
              {/* One notice, not one per line. These are a pre-flight checklist and three
                  stacked banners pushed the letter itself off the screen. */}
              {letter.warnings.length > 0 && (
                <div style={{ marginBottom: 'var(--space-3)' }}>
                  <Notice state={letter.contact ? 'info' : 'warning'} label="Before sending">
                    <ul className="sa-caveats">
                      {letter.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </Notice>
                </div>
              )}

              {letter.contact && (
                <p className="hint" style={{ marginBottom: 'var(--space-3)' }}>
                  {letter.contact.controller && (
                    <>
                      Controller: {letter.contact.controller}
                      <br />
                    </>
                  )}
                  {letter.contact.email && (
                    <>
                      <Data>{letter.contact.email}</Data>
                      <br />
                    </>
                  )}
                  {letter.contact.form && (
                    <>
                      <Data>{letter.contact.form}</Data>
                      <br />
                    </>
                  )}
                  Recorded from published documentation and never verified — privacy contacts
                  move.
                </p>
              )}

              <div className="sa-letter__actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void copy.copy(`${letter.subject}\n\n${letter.body}\n\n--\n${letter.escalation}`)}
                >
                  {copy.state === 'true' ? 'Copied.' : copy.state === 'error' ? 'Clipboard refused.' : 'Copy'}
                </button>
                <button type="button" className="btn" onClick={() => void save()}>
                  Save into the case folder
                </button>
                {savedTo && (
                  <span className="hint">
                    Written to <Data>{savedTo}</Data>
                  </span>
                )}
              </div>

              <pre className="raw sa-letter__text">{letter.subject}
{'='.repeat(Math.min(letter.subject.length, 78))}

{letter.body}</pre>

              <p className="label" style={{ marginTop: 'var(--space-4)' }}>
                If they do not answer
              </p>
              <pre className="raw sa-letter__text">{letter.escalation}</pre>
            </>
          )}
        </div>
      </div>

      <div className="sa-foot" />
    </div>
  )
}

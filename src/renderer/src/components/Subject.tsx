import { useMemo, useState } from 'react'
import { allCountries, countryName } from '../../../shared/geo'
import {
  AGE_BANDS,
  AGE_BAND_LABEL,
  emptySubject,
  resolveSubject,
  type AgeBand,
  type SubjectProfile
} from '../../../shared/relevance'
import { Icon } from './Icon'

/**
 * What the operator knows about the subject that is not a thing a tool can be pointed at.
 *
 * ## Why this is not three more entities
 *
 * You cannot run a username sweep against "male, 25 – 34, Bulgaria". These three exist for
 * one purpose — ranking, and specifically **contradicting** — so they live on the case
 * rather than in the entity list, where every row is something an adapter accepts.
 *
 * ## The inference is pre-filled and overridable, in that order
 *
 * His words: *"From the name it should know it's a male, or at least let me enter that."*
 * Both halves. The gender field opens showing what `shared/names.ts` reads off the seeded
 * name, labelled as an inference and with the rule that produced it written underneath, so
 * he can see *why* the app thinks so. Choosing a value replaces the inference with a
 * statement, and a statement always wins — he may simply know, and a heuristic that cannot
 * be overruled by knowledge is a bad heuristic.
 *
 * ## What these can and cannot do
 *
 * A gender or a name contradiction sinks a row to the bottom group. A **country never
 * does**, and the panel says so where he is choosing one. That is measured rather than
 * cautious: on his first real run the best hit in the case was a profile that was
 * genuinely his with a location field naming a city he has never lived in. A country filter
 * would have deleted the best row in the run, which is why nothing here is a filter.
 */
export function SubjectPanel({
  subject,
  seededNames,
  busy,
  onChange
}: {
  subject: SubjectProfile | undefined
  /** Seeded `person` values, so the gender inference can be shown before it is used. */
  seededNames: string[]
  busy: boolean
  onChange: (next: SubjectProfile) => void
}): React.JSX.Element {
  const current = subject ?? emptySubject()
  const [countryQuery, setCountryQuery] = useState('')

  const inferred = useMemo(
    () => resolveSubject({ ...current, gender: null }, seededNames),
    [current, seededNames]
  )
  const countries = useMemo(() => allCountries(), [])
  const matches = useMemo(() => {
    const q = countryQuery.trim().toLowerCase()
    if (!q) return []
    return countries
      .filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q)
      .slice(0, 6)
  }, [countries, countryQuery])

  const set = (patch: Partial<SubjectProfile>): void => onChange({ ...current, ...patch })

  return (
    <div className="subject">
      <div className="subject__grid">
        {/* --- gender ------------------------------------------------------- */}
        <div className="field">
          <label className="label" htmlFor="subject-gender">
            Gender the subject reads as
          </label>
          <select
            id="subject-gender"
            className="select"
            disabled={busy}
            value={current.gender ?? ''}
            onChange={(e) =>
              set({ gender: e.target.value === '' ? null : (e.target.value as 'masculine' | 'feminine') })
            }
          >
            <option value="">
              {inferred.gender === 'masculine' || inferred.gender === 'feminine'
                ? `Use the inference — ${inferred.gender}`
                : 'Not stated'}
            </option>
            <option value="masculine">Masculine</option>
            <option value="feminine">Feminine</option>
          </select>
          <p className="hint">
            {current.gender ? (
              <>You stated this, so it overrides whatever the name reads as.</>
            ) : inferred.genderWhy ? (
              <>
                <Icon name="info" size={11} /> {inferred.genderWhy}. A reading of the name,
                not of the person — override it if you know better.
              </>
            ) : seededNames.length ? (
              <>
                Nothing in the name tables recognises the seeded name, so no gender is
                inferred. Stating one switches the signal on.
              </>
            ) : (
              <>Seed a real name above, or state the gender here. Either turns the signal on.</>
            )}
          </p>
          <p className="hint">
            A profile whose name reads the other way sorts to the bottom and says so. It is
            never deleted — the seed could be the thing that is wrong.
          </p>
        </div>

        {/* --- age band ----------------------------------------------------- */}
        <div className="field">
          <label className="label" htmlFor="subject-age">
            Age band
          </label>
          <select
            id="subject-age"
            className="select"
            disabled={busy}
            value={current.ageBand ?? ''}
            onChange={(e) => set({ ageBand: e.target.value === '' ? null : (e.target.value as AgeBand) })}
          >
            <option value="">Not stated</option>
            {AGE_BANDS.map((b) => (
              <option key={b} value={b}>
                {AGE_BAND_LABEL[b]}
              </option>
            ))}
          </select>
          <p className="hint">
            Every one of these platforms requires 13 at sign-up, so an account&rsquo;s
            creation date bounds its holder&rsquo;s age from below. A profile opened in 2009
            belongs to somebody who is at least 30 today.
          </p>
        </div>

        {/* --- countries ---------------------------------------------------- */}
        <div className="field">
          <label className="label" htmlFor="subject-country">
            Countries
          </label>
          <div className="subject__chips">
            {current.countries.map((code) => (
              <button
                key={code}
                type="button"
                className="subject__chip"
                disabled={busy}
                onClick={() => set({ countries: current.countries.filter((c) => c !== code) })}
                title={`Remove ${countryName(code)}`}
              >
                <span>{countryName(code)}</span>
                <Icon name="close" size={10} />
              </button>
            ))}
            {!current.countries.length && <span className="hint">None seeded.</span>}
          </div>
          <input
            id="subject-country"
            className="input"
            disabled={busy}
            value={countryQuery}
            onChange={(e) => setCountryQuery(e.target.value)}
            placeholder="Bulgaria"
            aria-label="Add a country the subject lives in"
          />
          {matches.length > 0 && (
            <div className="subject__matches">
              {matches.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  className="btn btn--quiet"
                  disabled={busy || current.countries.includes(c.code)}
                  onClick={() => {
                    if (!current.countries.includes(c.code)) {
                      set({ countries: [...current.countries, c.code] })
                    }
                    setCountryQuery('')
                  }}
                >
                  {c.name} <span className="data">{c.code}</span>
                </button>
              ))}
            </div>
          )}
          <p className="hint">
            Read from a profile&rsquo;s location field, its country field, the site&rsquo;s
            national domain, and platforms used in one country only.
          </p>
          <p className="hint">
            A country that disagrees lowers a row and states why; it can never sink one on
            its own. Location fields are stale, ironic or deliberately false often enough
            that a country filter deletes true positives.
          </p>
        </div>
      </div>
    </div>
  )
}

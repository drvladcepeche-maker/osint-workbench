import { useMemo, useState } from 'react'
import type { AtlasData } from '../../../../shared/ipc'
import { Data } from '../Data'
import { Icon } from '../Icon'

/**
 * The clue atlas: 15 categories, 151 clues, 20 countries.
 *
 * It is the reference library the drills assume you have, and it is browsable before,
 * during and after a round — hint tier 3 deep-links into it, and the post-round lesson
 * links the specific pages that decide that frame.
 *
 * `unverified` clues carry a visible badge. geoint spike notes §7.4 is blunt about why: the
 * atlas is a content problem, its value is proportional to how specific and accurate it
 * is, and accuracy there cannot be checked by running the app. An unverified clue is a
 * lead to check, never a fact to guess on, and the interface has to say so.
 */

export type AtlasSelection = string | null

/** Accepts a bare category id, `c:<id>`, or `n:<country>`. */
export const atlasKey = (key: string): string => (/^[cn]:/.test(key) ? key : `c:${key}`)

export function Atlas({
  data,
  selection,
  onSelect,
  onClose
}: {
  data: AtlasData | null
  selection: AtlasSelection
  onSelect: (key: AtlasSelection) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')

  const { categories, countries } = useMemo(() => {
    const f = query.trim().toLowerCase()
    const match = (o: unknown): boolean => !f || JSON.stringify(o).toLowerCase().includes(f)
    return {
      categories: (data?.categories ?? []).filter(match),
      countries: (data?.countries ?? []).filter(match)
    }
  }, [data, query])

  const category = selection?.startsWith('c:')
    ? data?.categories.find((c) => c.id === selection.slice(2))
    : undefined
  const country = selection?.startsWith('n:')
    ? data?.countries.find((c) => c.name === selection.slice(2))
    : undefined

  return (
    <div className="atlas" role="dialog" aria-modal="true" aria-label="Clue atlas">
      <div className="atlas__nav">
        <div className="atlas__nav-head">
          <h2 className="atlas__title">Clue atlas</h2>
          <button type="button" className="btn btn--quiet btn--icon" onClick={onClose} aria-label="Close the atlas">
            <Icon name="close" />
          </button>
        </div>
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clues, countries, tells…"
          aria-label="Search the atlas"
        />
        <div className="atlas__list">
          <h3 className="atlas__group">Clue categories</h3>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className="atlas__item"
              aria-current={selection === `c:${c.id}` ? 'true' : undefined}
              onClick={() => onSelect(`c:${c.id}`)}
            >
              {c.name}
            </button>
          ))}
          <h3 className="atlas__group">Countries</h3>
          {countries.map((c) => (
            <button
              key={c.name}
              type="button"
              className="atlas__item"
              aria-current={selection === `n:${c.name}` ? 'true' : undefined}
              onClick={() => onSelect(`n:${c.name}`)}
            >
              {c.name}
            </button>
          ))}
          {!categories.length && !countries.length && (
            <p className="atlas__none">Nothing in the atlas matches “{query}”.</p>
          )}
        </div>
      </div>

      <div className="atlas__body">
        {!data && (
          <p className="atlas__none">
            The atlas could not be loaded. Regenerate it with{' '}
            <Data>node scripts/build-range-resources.mjs</Data>.
          </p>
        )}

        {data && !category && !country && (
          <div className="prose">
            <h3 className="atlas__heading">Pick a clue family, or a country.</h3>
            <p className="doc__text">
              Read these <em>before</em> drilling. Geolocation is recognition, and
              recognition needs a reference library — the drills assume you have one and
              the atlas is it. The category pages teach one clue family at a time in
              isolation; the country pages answer every family at once for one place.
            </p>
            <p className="doc__text">
              Anything the spike could not confirm is marked unverified and stays that
              way. Treat those as leads to check against a photograph you already know,
              not as facts to guess on.
            </p>
          </div>
        )}

        {category && (
          <article className="prose">
            <h3 className="atlas__heading">{category.name}</h3>
            {category.why && <p className="atlas__why">{category.why}</p>}
            {category.how && (
              <p className="atlas__how">
                <strong>How to read it:</strong> {category.how}
              </p>
            )}
            {(category.clues ?? []).map((clue) => (
              <section className="clue" key={clue.value}>
                <h4 className="clue__value">
                  {clue.value}
                  {clue.unverified && (
                    <span className="clue__unverified">
                      <Icon name="warning" size={11} /> unverified
                    </span>
                  )}
                </h4>
                {clue.meansWhat && <p className="clue__means">{clue.meansWhat}</p>}
                {!!clue.where?.length && (
                  <p className="clue__where">
                    <Data>{clue.where.join(' · ')}</Data>
                  </p>
                )}
                {clue.note && <p className="clue__note">{clue.note}</p>}
              </section>
            ))}
          </article>
        )}

        {country && (
          <article className="prose">
            <h3 className="atlas__heading">
              {country.name}
              {country.code && <Data className="atlas__code">{country.code}</Data>}
            </h3>
            {!!country.tells?.length && (
              <ul className="atlas__tells">
                {country.tells.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            <dl className="atlas__facts">
              {(
                [
                  ['Script', country.script],
                  ['Plates', country.plate],
                  ['Road lines', country.roadLines],
                  ['Bollards', country.bollard],
                  ['Poles', country.poles],
                  ['Architecture', country.architecture],
                  ['Vegetation', country.vegetation],
                  ['Domain', country.domain],
                  ['Phone', country.phone]
                ] as const
              )
                .filter(([, v]) => !!v)
                .map(([k, v]) => (
                  <div className="atlas__fact" key={k}>
                    <dt className="atlas__fact-key">{k}</dt>
                    <dd className="atlas__fact-value">{v}</dd>
                  </div>
                ))}
            </dl>
          </article>
        )}
      </div>
    </div>
  )
}

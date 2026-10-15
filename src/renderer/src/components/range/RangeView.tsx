import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RangeData, RangeFrame, RangeIndex } from '../../../../shared/ipc'
import { CopyValue, Data } from '../Data'
import { EmptyState, Notice } from '../Feedback'
import { Icon } from '../Icon'
import { Atlas, atlasKey, type AtlasSelection } from './Atlas'
import { GuessMap } from './GuessMap'
import { Stage } from './Imagery'
import {
  answerableCountries,
  atlasTargetForRound,
  CONF_PCT,
  COUNTRY_POINTS,
  CALIB_K,
  DIST_MAX,
  fmtKm,
  haversine,
  hintText,
  KIND_HINT,
  LEVELS,
  PEN,
  pickFromIndex,
  scorePin,
  SCALES,
  sliderToKm,
  sunAt,
  type Level
} from './model'

/**
 * The Range — geolocation training, ported from `spikes/geoint/`.
 *
 * The shape of it is the spike's and so are its decisions; the geoint spike notes is the record
 * of why each one is what it is, and none of them were re-derived here. What changed in
 * the port is only what had to: imagery comes through the main process instead of the
 * page, the basemap is bundled vector geometry instead of remote tiles, and the panorama
 * viewer is written rather than fetched from a CDN.
 *
 * The one thing worth restating, because it is the whole point of the redesign the spike
 * went through: **a uniformly random street-level frame is almost always featureless.**
 * Everything here — the signal filter behind the index, the country-first difficulty
 * ramp, the 20 reviewed rounds, the atlas — exists to solve that, not to decorate it.
 */

const MAX_SKIPS = 4

interface Run {
  total: number
  rounds: number
  hits: number
  correct: number
}

const EMPTY_RUN: Run = { total: 0, rounds: 0, hits: 0, correct: 0 }

export function RangeView(): React.JSX.Element {
  const [data, setData] = useState<RangeData | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)

  const [level, setLevel] = useState<Level>(LEVELS[1])
  const [index, setIndex] = useState<RangeIndex | null>(null)
  const [frame, setFrame] = useState<RangeFrame | null>(null)
  const [loading, setLoading] = useState(false)
  const [stageError, setStageError] = useState<string | null>(null)

  const [guess, setGuess] = useState<[number, number] | null>(null)
  const [guessCountry, setGuessCountry] = useState<string | null>(null)
  const [radius, setRadius] = useState(SCALES.global.radiusDefault)
  const [revealed, setRevealed] = useState(false)
  const [hintsUsed, setHintsUsed] = useState<number[]>([])
  const [run, setRun] = useState<Run>(EMPTY_RUN)

  const [atlasOpen, setAtlasOpen] = useState(false)
  const [atlasSel, setAtlasSel] = useState<AtlasSelection>(null)

  /* Frames already served this session, and where in the reviewed set we are. Refs, not
     state: changing either must never re-render, and `newRound` reads them while it runs. */
  const seen = useRef(new Set<string>())
  const curatedPos = useRef(0)
  const skips = useRef(0)
  /** The scrolling right-hand column, so a new round can start at the top of it. */
  const side = useRef<HTMLDivElement>(null)

  const scale = SCALES[level.scale ?? 'global']
  const radiusKm = sliderToKm(radius)

  useEffect(() => {
    window.osint.range
      .data()
      .then(setData)
      .catch((err: Error) => setDataError(err.message))
  }, [])

  const answerable = useMemo(
    () => [...answerableCountries(index, data?.curated ?? null)].sort(),
    [index, data]
  )

  /**
   * Named places for the pin map, averaged from the index's own coverage areas.
   *
   * A country outline with nothing written on it is a shape, not a map — at 300 km
   * reference scale the question is "north-central or south-west", and that is not
   * answerable without Sofia and Varna on screen. These come from data already bundled,
   * so nothing is fetched and nothing is invented.
   */
  const anchors = useMemo(() => {
    const sums = new Map<string, { lon: number; lat: number; n: number }>()
    for (const c of index?.candidates ?? []) {
      if (!c.area) continue
      const a = sums.get(c.area) ?? { lon: 0, lat: 0, n: 0 }
      a.lon += c.c[0]
      a.lat += c.c[1]
      a.n++
      sums.set(c.area, a)
    }
    return [...sums.entries()]
      // A handful of frames is a cluster, not a place worth labelling.
      .filter(([, a]) => a.n >= 10)
      .map(([name, a]) => ({ name, c: [a.lon / a.n, a.lat / a.n] as [number, number] }))
  }, [index])

  /**
   * The reviewed set is played **in order**, and that is the whole design of L1: every
   * frame was opened by a human, rejected unless a beginner could actually name the
   * country from something visible, and given a written lesson. The first three are
   * meant to be impossible to get wrong. Random sampling would destroy the ramp, and the
   * ramp is what teaches (geoint spike notes §8.2).
   */
  const nextCurated = useCallback((): RangeFrame | null => {
    const rounds = data?.curated.rounds ?? []
    if (!rounds.length) return null
    const r = rounds[curatedPos.current % rounds.length]
    curatedPos.current++
    return r
  }, [data])

  const newRound = useCallback(
    async (isRetry = false): Promise<void> => {
      if (!isRetry) skips.current = 0
      setRevealed(false)
      setGuess(null)
      setGuessCountry(null)
      setHintsUsed([])
      setStageError(null)
      setFrame(null)
      setLoading(true)
      /* The reveal is long, so by the end of a round this column is scrolled well down.
         A new round has to start at the top of it — otherwise the next question opens
         somewhere in the middle of the last answer, and in the stacked layout the map
         you are meant to click is scrolled half out of view. */
      side.current?.scrollTo({ top: 0 })

      try {
        let idx = index
        if (level.index && (!idx || idx.region !== level.index)) {
          idx = await window.osint.range.index(level.index)
          setIndex(idx)
        }
        let next: RangeFrame | null = null
        if (level.source === 'live') next = await window.osint.range.live()
        else if (level.source === 'curated') {
          next = nextCurated() ?? (idx ? pickFromIndex(idx, level, seen.current, data?.curated ?? null) : null)
        } else if (idx) next = pickFromIndex(idx, level, seen.current, data?.curated ?? null)

        if (!next) {
          setStageError('No imagery came back for this tier. Try another one, or try again.')
          setLoading(false)
          return
        }
        setFrame(next)
      } catch (err) {
        setStageError((err as Error).message)
        setLoading(false)
      }
    },
    [index, level, nextCurated, data]
  )

  /** A frame that will not load is not a round. Skip to another, up to four times. */
  const onImageryFailed = useCallback(
    (why: string) => {
      if (revealed) return
      if (skips.current < MAX_SKIPS) {
        skips.current++
        setStageError(null)
        void newRound(true)
      } else {
        setLoading(false)
        setStageError(
          `Imagery ${why}, and ${MAX_SKIPS} further locations also failed. Panoramax may be unreachable. Press Next round to try again.`
        )
      }
    },
    [revealed, newRound]
  )

  const start = (l: Level): void => {
    setLevel(l)
    setStarted(true)
    setRun(EMPTY_RUN)
    seen.current.clear()
    curatedPos.current = 0
    setIndex(null)
    setRadius(SCALES[l.scale ?? 'global'].radiusDefault)
  }

  /* Starting, or switching tier, begins a round. Keyed on the level so a tier change is
     the only thing that triggers it — a re-render must not reshuffle the frame. */
  useEffect(() => {
    if (started) void newRound()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, level])

  const hintPenalty = hintsUsed.reduce((s, t) => s + (level.hintCost[t - 1] ?? 0), 0)

  const useHint = (tier: 1 | 2 | 3): void => {
    if (revealed || hintsUsed.includes(tier) || level.noHints || !frame) return
    setHintsUsed((h) => [...h, tier])
    if (tier === 3) {
      setAtlasSel(atlasKey(atlasTargetForRound(frame)[0]))
      setAtlasOpen(true)
    }
  }

  /* ------------------------------------------------------------ the reveal */

  const result = useMemo(() => {
    if (!revealed || !frame) return null
    if (level.mode === 'country') {
      const ok = guessCountry === frame.country
      return { kind: 'country' as const, ok, points: (ok ? COUNTRY_POINTS : 0) - hintPenalty }
    }
    if (!guess) return null
    const d = haversine(guess, frame.c)
    const s = scorePin(d, radiusKm, scale)
    return { kind: 'pin' as const, d, r: radiusKm, s, points: s.total - hintPenalty }
  }, [revealed, frame, level.mode, guessCountry, guess, radiusKm, scale, hintPenalty])

  const submit = (): void => {
    if (!frame || revealed) return
    if (level.mode === 'pin' && !guess) return
    if (level.mode === 'country' && !guessCountry) return
    setRevealed(true)

    if (level.mode === 'country') {
      const ok = guessCountry === frame.country
      setRun((r) => ({
        ...r,
        rounds: r.rounds + 1,
        correct: r.correct + (ok ? 1 : 0),
        total: r.total + (ok ? COUNTRY_POINTS : 0) - hintPenalty
      }))
    } else if (guess) {
      const s = scorePin(haversine(guess, frame.c), radiusKm, scale)
      setRun((r) => ({
        ...r,
        rounds: r.rounds + 1,
        hits: r.hits + (s.hit ? 1 : 0),
        total: r.total + s.total - hintPenalty
      }))
    }
  }

  /* ------------------------------------------------------------ empty state */

  if (!started) {
    return (
      <div className="view">
        <header className="view__head">
          <h1 className="view__title">Range</h1>
          <span className="view__subtitle">
            {data ? `${data.curated.count} reviewed rounds · ${data.atlas.categories.length} clue families` : 'loading'}
          </span>
        </header>

        <div className="view__scroll">
          <div className="view__body view__body--pad">
            {dataError && (
              <Notice state="danger" label="Failed">
                {dataError}
              </Notice>
            )}
            <EmptyState
              title="Reading a photograph for where it was taken."
              body={[
                'Geolocation is narrowing an image to a place from what is inside the frame: the shape of a road sign, the language and typeface on it, kerb and bollard styles, utility pole hardware, vegetation, the sun angle against the shadows, licence plate proportions, which side traffic drives on. None of it is metadata. The drill is reading the picture.',
                'A uniformly random street-level frame is almost always featureless — a hedge, a wall, an empty road — so nothing here is uniformly random. Every frame comes from an index filtered to those within 60 m of something readable, the first tier is 20 frames a human opened and wrote a lesson for, and the answer starts as "which country" rather than a pin.',
                'Pin tiers score on distance and on calibration together: being 50 km out but honest about a 60 km radius beats being 5 km out by luck with a 2 km claim. Overconfidence is the failure mode this trains against, and it is the same failure mode that makes an unverified finding look like a fact.'
              ]}
              exampleLabel="The four tiers"
              example={
                'L1  Curated   which country · 20 reviewed frames, written lessons, free hints\nL2  Filtered  which country · the full 15,232-frame index, 18 countries\nL3  Home pin  pin + radius · Bulgaria only, 300 km reference\nL4  Wild      pin + radius · live, unfiltered, worldwide, no hints'
              }
              actions={
                <>
                  <button type="button" className="btn btn--primary" onClick={() => start(LEVELS[1])} disabled={!data}>
                    Start at L1
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setAtlasSel(null)
                      setAtlasOpen(true)
                    }}
                    disabled={!data}
                  >
                    Read the atlas first
                  </button>
                </>
              }
            />
            {atlasOpen && (
              <Atlas
                data={data?.atlas ?? null}
                selection={atlasSel}
                onSelect={setAtlasSel}
                onClose={() => setAtlasOpen(false)}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  /* ------------------------------------------------------------ the drill */

  const target = atlasTargetForRound(frame)
  const nCurated = data?.curated.rounds.length ?? 0

  return (
    <div className="view range">
      <header className="view__head">
        <h1 className="view__title">Range</h1>
        <span className="view__subtitle">
          L{level.key} {level.name}
        </span>
        <div className="view__actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAtlasSel(null)
              setAtlasOpen(true)
            }}
          >
            Clue atlas
          </button>
        </div>
      </header>

      <div className="range__tiers" role="tablist" aria-label="Difficulty tier">
        {Object.values(LEVELS).map((l) => (
          <button
            key={l.key}
            type="button"
            role="tab"
            className="range__tier"
            aria-selected={l.key === level.key}
            onClick={() => l.key !== level.key && start(l)}
          >
            <span className="range__tier-name">
              L{l.key} {l.name}
            </span>
            <span className="range__tier-sub">{l.sub}</span>
          </button>
        ))}
      </div>

      <div className="range__grid">
        <Stage
          src={frame ? window.osint.range.imageUrl(frame.url) : ''}
          pano={!!frame?.pano}
          loading={loading && !stageError}
          error={stageError}
          onLoaded={() => setLoading(false)}
          onFailed={onImageryFailed}
          badges={
            frame && (
              <>
                <span className="badge">{frame.pano ? '360° panorama' : 'flat photo'}</span>
                {frame.lesson ? (
                  <span className="badge badge--strong">reviewed</span>
                ) : frame.signal ? (
                  <span className="badge badge--strong">signal {frame.signal}</span>
                ) : null}
                <span className="badge">
                  {frame.lesson && nCurated
                    ? `round ${((curatedPos.current - 1) % nCurated) + 1} of ${nCurated}`
                    : `round ${run.rounds + 1}`}
                </span>
              </>
            )
          }
        />

        <div className="range__side" ref={side}>
          <div className="range__guess">
            {level.mode === 'country' ? (
              <div className="range__countries">
                <h2 className="range__prompt">Which country is this?</h2>
                <div className="range__cgrid">
                  {answerable.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="range__country"
                      aria-pressed={guessCountry === c}
                      data-verdict={
                        !revealed
                          ? undefined
                          : c === frame?.country
                            ? 'truth'
                            : c === guessCountry
                              ? 'wrong'
                              : undefined
                      }
                      disabled={revealed}
                      onClick={() => setGuessCountry(c)}
                    >
                      {c}
                      {revealed && c === frame?.country && <Icon name="success" size={12} />}
                      {revealed && c === guessCountry && c !== frame?.country && <Icon name="danger" size={12} />}
                    </button>
                  ))}
                </div>
                {!answerable.length && (
                  <p className="range__note">
                    The frame index has not loaded, so there is nothing to answer with yet.
                  </p>
                )}
              </div>
            ) : (
              <GuessMap
                shapes={data?.basemap.shapes ?? []}
                anchors={anchors}
                scale={scale}
                guess={guess}
                truth={revealed && frame ? frame.c : null}
                radiusKm={radiusKm}
                revealed={revealed}
                onGuess={setGuess}
              />
            )}
          </div>

          <div className="range__controls">
            {!level.noHints && (
              <div className="range__hints">
                {([1, 2, 3] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="range__hint-btn"
                    disabled={revealed || hintsUsed.includes(t) || !frame}
                    onClick={() => useHint(t)}
                  >
                    Hint {t}
                    <span className="range__hint-cost">
                      {level.hintCost[t - 1] ? `−${level.hintCost[t - 1]}` : 'free'}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {!!hintsUsed.length && frame && (
              <div className="range__hint-out">
                {hintsUsed.map((t) =>
                  t === 3 ? (
                    <p key={t} className="range__hint-line">
                      Open the atlas at the category that decides this one:{' '}
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          setAtlasSel(atlasKey(target[0]))
                          setAtlasOpen(true)
                        }}
                      >
                        {target[1]}
                      </button>
                      .
                    </p>
                  ) : (
                    hintText(t as 1 | 2, frame, data?.atlas ?? null).map((p, i) => (
                      <p key={`${t}-${i}`} className="range__hint-line">
                        {p.lead && <strong>{p.lead}</strong>}
                        {p.lead && p.body ? ' ' : ''}
                        {p.body}
                      </p>
                    ))
                  )
                )}
              </div>
            )}

            {level.mode === 'pin' && (
              <div className="range__radius">
                <label className="label" htmlFor="range-radius">
                  Confidence radius — be about {CONF_PCT}% sure the truth is inside
                </label>
                <div className="range__radius-row">
                  <input
                    id="range-radius"
                    className="range__slider"
                    type="range"
                    min={0}
                    max={1000}
                    value={radius}
                    disabled={revealed}
                    onChange={(e) => setRadius(Number(e.target.value))}
                  />
                  <Data className="range__radius-value">{fmtKm(radiusKm)}</Data>
                </div>
              </div>
            )}

            {!revealed ? (
              <button
                type="button"
                className="btn btn--primary btn--wide"
                disabled={!frame || (level.mode === 'pin' ? !guess : !guessCountry)}
                onClick={submit}
              >
                Submit guess
              </button>
            ) : (
              <button type="button" className="btn btn--primary btn--wide" onClick={() => void newRound()}>
                Next round
              </button>
            )}
          </div>

          {revealed && frame && result && (
            <div className="range__result">
              {result.kind === 'country' ? (
                <>
                  <p className="range__score" data-verdict={result.ok ? 'good' : 'bad'}>
                    <Icon name={result.ok ? 'success' : 'danger'} size={18} />
                    {result.ok ? 'Correct' : 'Wrong'}
                  </p>
                  <p className="range__score-sub">
                    It was <strong>{frame.country}</strong>
                    {frame.area ? ` — ${frame.area}` : ''}
                    {result.ok ? '' : `, you said ${guessCountry}`}.
                  </p>
                  <dl className="range__breakdown">
                    <div>
                      <dt>country</dt>
                      <dd>{result.ok ? `+${COUNTRY_POINTS}` : '0'}</dd>
                    </div>
                    {!!hintPenalty && (
                      <div>
                        <dt>hints used ({hintsUsed.length})</dt>
                        <dd>−{hintPenalty}</dd>
                      </div>
                    )}
                    <div>
                      <dt>round</dt>
                      <dd>{Math.round(result.points)}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <>
                  <p className="range__score">
                    <Data className="range__score-n">{Math.round(result.points).toLocaleString()}</Data>
                    <span className="range__score-unit">pts</span>
                  </p>
                  <p className="range__score-sub">
                    Off by <Data>{fmtKm(result.d)}</Data> · radius {fmtKm(result.r)}
                    {frame.country ? ` · ${frame.country}` : ''}
                  </p>
                  <dl className="range__breakdown">
                    <div>
                      <dt>
                        distance {DIST_MAX}·e^(−{result.d.toFixed(0)}/{scale.D})
                      </dt>
                      <dd>{Math.round(result.s.distance)}</dd>
                    </div>
                    <div>
                      <dt>W = r + {PEN}·max(0, d−r)</dt>
                      <dd>{result.s.W.toFixed(0)} km</dd>
                    </div>
                    <div>
                      <dt>
                        calibration {CALIB_K}·(1 − W/{scale.Rref})
                      </dt>
                      <dd>
                        {result.s.calibration >= 0 ? '+' : ''}
                        {Math.round(result.s.calibration)}
                      </dd>
                    </div>
                    {!!hintPenalty && (
                      <div>
                        <dt>hints used ({hintsUsed.length})</dt>
                        <dd>−{hintPenalty}</dd>
                      </div>
                    )}
                  </dl>
                  <Verdict d={result.d} r={result.r} s={result.s} rref={scale.Rref} />
                </>
              )}

              <Lesson frame={frame} onAtlas={(k) => {
                setAtlasSel(atlasKey(k))
                setAtlasOpen(true)
              }} />

              <SunAid frame={frame} />

              <p className="range__run">
                Run total <strong>{Math.round(run.total).toLocaleString()}</strong> over {run.rounds}{' '}
                round{run.rounds === 1 ? '' : 's'} ·{' '}
                {level.mode === 'country' ? (
                  <>
                    accuracy <strong>{Math.round((100 * run.correct) / Math.max(1, run.rounds))}%</strong>
                  </>
                ) : (
                  <>
                    hit rate <strong>{Math.round((100 * run.hits) / Math.max(1, run.rounds))}%</strong> —
                    well-calibrated play converges on {CONF_PCT}%
                  </>
                )}
              </p>
            </div>
          )}

          {!revealed && <p className="range__about">{level.about}</p>}
        </div>
      </div>

      {atlasOpen && (
        <Atlas
          data={data?.atlas ?? null}
          selection={atlasSel}
          onSelect={setAtlasSel}
          onClose={() => setAtlasOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * What the number means, said in words.
 *
 * The distinction that matters and is easy to miss from the arithmetic alone: being
 * inside your radius is not automatically good. A radius wider than the tier's reference
 * earns a negative calibration term even on a hit, which is the rule telling you that a
 * safe answer bought nothing.
 */
function Verdict({
  d,
  r,
  s,
  rref
}: {
  d: number
  r: number
  s: { hit: boolean; calibration: number }
  rref: number
}): React.JSX.Element {
  if (!s.hit) {
    return (
      <p className="range__verdict" data-verdict="bad">
        <Icon name="danger" size={13} />
        Outside by {fmtKm(d - r)}. Overconfidence costs {PEN}× the shortfall.
      </p>
    )
  }
  if (r <= rref * 0.35) {
    return (
      <p className="range__verdict" data-verdict="good">
        <Icon name="success" size={13} />
        Inside your radius and you kept it tight — that is good calibration.
      </p>
    )
  }
  return (
    <p className="range__verdict" data-verdict="warn">
      <Icon name="warning" size={13} />
      {s.calibration >= 0
        ? `Inside, but wide: it only earned ${Math.round(s.calibration)} points. A safe radius buys almost nothing.`
        : `Inside — but ${fmtKm(r)} is wider than the ${fmtKm(rref)} reference, so it cost you ${Math.abs(Math.round(s.calibration))} points.`}
    </p>
  )
}

/**
 * "How to read this one".
 *
 * A reviewed round carries a written lesson: a human looked at that exact frame and
 * wrote down which clue to find first, where in the image it is, what it rules out on
 * its own, and what confirms it. Everything else falls back to text assembled from the
 * frame's OSM signal — weaker, and honestly so, because proximity only says something
 * readable is *nearby*, not that it is in shot.
 */
function Lesson({ frame, onAtlas }: { frame: RangeFrame; onAtlas: (key: string) => void }): React.JSX.Element | null {
  const L = frame.lesson
  if (L) {
    const step = (label: string, body?: string, where?: string): React.JSX.Element | null =>
      body ? (
        <div className="lesson__step" key={label}>
          <span className="lesson__label">{label}</span>
          <span className="lesson__body">
            {body}
            {where && <span className="lesson__where"> {where}</span>}
          </span>
        </div>
      ) : null
    return (
      <section className="lesson">
        <h3 className="lesson__title">How to read this one</h3>
        {step('Look here first', L.first, L.firstWhere)}
        {step('That alone narrows it to', L.narrows)}
        {step('Confirm with', L.second, L.secondWhere)}
        {step('Worth knowing', L.note)}
        {!!L.atlas?.length && (
          <p className="lesson__atlas">
            Atlas:{' '}
            {L.atlas.map((a, i) => (
              <span key={a.key}>
                {i ? ' · ' : ''}
                <button type="button" className="link" onClick={() => onAtlas(a.key)}>
                  {a.label}
                </button>
              </span>
            ))}
          </p>
        )}
      </section>
    )
  }

  const reads = (frame.kinds ?? []).map((k) => KIND_HINT[k]?.[1]).filter(Boolean)
  if (!reads.length) return null
  return (
    <section className="lesson">
      <h3 className="lesson__title">How to read this one</h3>
      <p className="lesson__caveat">
        Nobody reviewed this frame. These come from the OSM features near it, which say
        something readable is within 60 m — not that it is in shot.
      </p>
      {reads.map((t) => (
        <div className="lesson__step" key={t}>
          <span className="lesson__body">{t}</span>
        </div>
      ))}
    </section>
  )
}

/** Sun altitude, azimuth and shadow geometry, from the frame's own capture timestamp. */
function SunAid({ frame }: { frame: RangeFrame }): React.JSX.Element | null {
  if (!frame.t) return null
  const when = new Date(frame.t)
  if (Number.isNaN(when.getTime())) return null
  const { altitude, azimuth } = sunAt(when, frame.c[1], frame.c[0])
  const shadow = (azimuth + 180) % 360
  const ratio = altitude > 1 ? (1 / Math.tan((altitude * Math.PI) / 180)).toFixed(2) : '∞'
  const osm = `https://www.openstreetmap.org/#map=17/${frame.c[1].toFixed(5)}/${frame.c[0].toFixed(5)}`

  return (
    <section className="aid">
      <h3 className="aid__title">Sun at capture</h3>
      <dl className="aid__rows">
        <div>
          <dt>when</dt>
          <dd>
            <Data>{when.toISOString().replace('T', ' ').slice(0, 16)} UTC</Data>
          </dd>
        </div>
        <div>
          <dt>altitude</dt>
          <dd>
            <Data>{altitude.toFixed(1)}°</Data>
          </dd>
        </div>
        <div>
          <dt>solar azimuth</dt>
          <dd>
            <Data>{azimuth.toFixed(0)}°</Data>
          </dd>
        </div>
        <div>
          <dt>shadows point</dt>
          <dd>
            <Data>
              {shadow.toFixed(0)}°, {ratio}× object height
            </Data>
          </dd>
        </div>
        <div>
          <dt>truth</dt>
          <dd>
            <CopyValue value={`${frame.c[1].toFixed(5)}, ${frame.c[0].toFixed(5)}`} />
          </dd>
        </div>
      </dl>
      <button type="button" className="link" onClick={() => void window.osint.app.openExternal(osm)}>
        Open the true location in OpenStreetMap
      </button>
    </section>
  )
}

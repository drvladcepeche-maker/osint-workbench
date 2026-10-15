import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { circleRing, fmtKm, type Scale } from './model'

/**
 * The map you drop a pin on.
 *
 * The spike used MapLibre against OpenFreeMap's vector tiles. Neither survives the port
 * and the reason is in the spike's own report: the renderer's CSP forbids remote loads,
 * and geoint spike notes §2.1 rules out OSM's raster tiles outright because their policy
 * forbids offline use — which is precisely what a bundled desktop app is. §2.2's answer
 * for that case is a local extract, so this draws one: Natural Earth's 110m boundaries,
 * public domain, 284 rings, bundled as `resources/geoint/basemap.json`.
 *
 * What is lost is street-level detail, and it is not needed here. The pin tiers score at
 * 300 km (Bulgaria) and 2000 km (worldwide) reference scale — coastlines and borders are
 * the whole of what you reason against at either.
 */

/** A named place from the frame index, used purely for orientation. */
export interface MapAnchor {
  name: string
  c: [number, number]
}

export interface GuessMapProps {
  shapes: number[][]
  anchors: MapAnchor[]
  scale: Scale
  guess: [number, number] | null
  truth: [number, number] | null
  radiusKm: number
  revealed: boolean
  onGuess: (c: [number, number]) => void
}

/* Web Mercator, in degree-like units so a span reads as a longitude width. Clamped short
   of the poles, where the projection runs to infinity and there is nothing to guess at. */
const MAX_LAT = 82
const toY = (lat: number): number => {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  return (-Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) * 180) / Math.PI
}
const fromY = (y: number): number => (2 * Math.atan(Math.exp((-y * Math.PI) / 180)) * 180) / Math.PI - 90

const path = (points: [number, number][]): string =>
  points.map(([lon, lat], i) => `${i ? 'L' : 'M'}${lon.toFixed(2)} ${toY(lat).toFixed(2)}`).join('')

export function GuessMap({
  shapes,
  anchors,
  scale,
  guess,
  truth,
  radiusKm,
  revealed,
  onGuess
}: GuessMapProps): React.JSX.Element {
  const svg = useRef<SVGSVGElement>(null)
  const [box, setBox] = useState({ w: 1, h: 1 })
  const [view, setView] = useState(() => ({ cx: scale.center[0], cy: toY(scale.center[1]), span: scale.span }))

  /* A new tier means a new scale, and the view has to follow it rather than keeping
     wherever the last round was left. */
  useEffect(() => {
    setView({ cx: scale.center[0], cy: toY(scale.center[1]), span: scale.span })
  }, [scale])

  useEffect(() => {
    const el = svg.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth || 1, h: el.clientHeight || 1 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const aspect = box.h / box.w
  const viewBox = `${view.cx - view.span} ${view.cy - view.span * aspect} ${view.span * 2} ${view.span * 2 * aspect}`

  /** Screen point to lon/lat, via the viewBox rather than a stored transform. */
  const locate = useCallback(
    (e: React.PointerEvent): [number, number] => {
      const el = svg.current
      if (!el) return [0, 0]
      const r = el.getBoundingClientRect()
      const x = view.cx - view.span + ((e.clientX - r.left) / r.width) * view.span * 2
      const y = view.cy - view.span * aspect + ((e.clientY - r.top) / r.height) * view.span * 2 * aspect
      return [((x + 180) % 360 + 360) % 360 - 180, fromY(y)]
    },
    [view, aspect]
  )

  /* Drag to pan, wheel to zoom about the cursor. A click that did not move is a guess. */
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    d.x = e.clientX
    d.y = e.clientY
    const el = svg.current
    if (!el) return
    setView((v) => ({
      ...v,
      cx: v.cx - (dx / el.clientWidth) * v.span * 2,
      cy: Math.max(-200, Math.min(200, v.cy - (dy / el.clientHeight) * v.span * 2 * aspect))
    }))
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved || revealed) return
    onGuess(locate(e))
  }
  const onWheel = (e: React.WheelEvent): void => {
    const at = locate(e as unknown as React.PointerEvent)
    setView((v) => {
      const span = Math.max(0.25, Math.min(180, v.span * (e.deltaY < 0 ? 1 / 1.25 : 1.25)))
      // Keep the point under the cursor fixed while the span changes.
      const k = span / v.span
      return { cx: at[0] + (v.cx - at[0]) * k, cy: toY(at[1]) + (v.cy - toY(at[1])) * k, span }
    })
  }

  const ring = useMemo(
    () => (guess && radiusKm > 0 ? path(circleRing(guess, radiusKm)) : null),
    [guess, radiusKm]
  )

  /* At a country span a 30 degree graticule is invisible and at a world span a 5 degree
     one is a grey wash, so the step follows the zoom. */
  const step = view.span > 60 ? 30 : view.span > 20 ? 10 : view.span > 6 ? 5 : 1
  const graticule: string[] = []
  for (let lon = -180; lon <= 180; lon += step) graticule.push(`M${lon} -200V200`)
  for (let lat = -80; lat <= 80; lat += step) graticule.push(`M-180 ${toY(lat).toFixed(2)}H180`)

  return (
    <div className="gmap">
      <svg
        ref={svg}
        className="gmap__svg"
        viewBox={viewBox}
        preserveAspectRatio="none"
        data-revealed={revealed ? 'true' : undefined}
        role="application"
        aria-label={
          revealed
            ? 'Map showing your guess, its radius and the true location.'
            : 'Map. Click to place your guess; drag to pan and scroll to zoom.'
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      >
        <path className="gmap__graticule" d={graticule.join('')} />
        {shapes.map((flat, i) => {
          const pts: [number, number][] = []
          for (let j = 0; j < flat.length; j += 2) pts.push([flat[j], flat[j + 1]])
          return <path key={i} className="gmap__land" d={`${path(pts)}Z`} />
        })}

        {/* Only close in, where they are legible and where a country outline alone is
            not enough to navigate by. */}
        {view.span < 20 &&
          anchors.map((a) => (
            <g key={a.name} transform={`translate(${a.c[0]} ${toY(a.c[1])})`}>
              <circle className="gmap__anchor-dot" r={view.span * 0.006} />
              <text
                className="gmap__anchor-label"
                x={view.span * 0.016}
                y={view.span * 0.012}
                style={{ fontSize: `${view.span * 0.042}px` }}
              >
                {/* Index area names are single tokens: `VelikoTarnovo`. */}
                {a.name.replace(/([a-z])([A-Z])/g, '$1 $2')}
              </text>
            </g>
          ))}

        {ring && <path className="gmap__radius" d={`${ring}Z`} />}

        {revealed && guess && truth && (
          <path
            className="gmap__link"
            d={`M${guess[0]} ${toY(guess[1])}L${truth[0]} ${toY(truth[1])}`}
          />
        )}

        {guess && (
          <g className="gmap__pin gmap__pin--guess" transform={`translate(${guess[0]} ${toY(guess[1])})`}>
            <circle className="gmap__pin-halo" r={view.span * 0.024} />
            <circle className="gmap__pin-dot" r={view.span * 0.011} />
          </g>
        )}
        {revealed && truth && (
          <g className="gmap__pin gmap__pin--truth" transform={`translate(${truth[0]} ${toY(truth[1])})`}>
            <circle className="gmap__pin-halo" r={view.span * 0.024} />
            <circle className="gmap__pin-dot" r={view.span * 0.011} />
          </g>
        )}
      </svg>

      <p className="gmap__legend">
        {revealed ? (
          <>
            <span className="gmap__key gmap__key--guess" /> your guess
            <span className="gmap__key gmap__key--truth" /> actual
          </>
        ) : guess ? (
          <>Radius {fmtKm(radiusKm)}. Click again to move the pin.</>
        ) : (
          <>Click the map to place your guess.</>
        )}
      </p>
    </div>
  )
}

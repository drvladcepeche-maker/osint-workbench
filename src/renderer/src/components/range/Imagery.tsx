import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'

/**
 * The imagery half of the Range: a pan/zoom viewer for flat photographs, a 360 viewer
 * for equirectangular panoramas, and the failover that keeps a bad frame from becoming a
 * dead round.
 *
 * Both viewers are written here rather than pulled in. The spike used Pannellum from a
 * CDN, which this app cannot load and would not want to: the renderer's CSP forbids
 * remote scripts, and a WebGL equirectangular viewer is a fragment shader and a drag
 * handler. Nothing in Pannellum's feature set was being used beyond that.
 */

const LOAD_TIMEOUT_MS = 12_000

export interface ImageryProps {
  /** A `pano:` URL. Changing it starts a new load. */
  src: string
  pano: boolean
  /** Raised when the image did not arrive. The caller decides whether to skip. */
  onFailed: (why: string) => void
  onLoaded: () => void
}

/**
 * A load that never resolves and never errors.
 *
 * In the spike this was CORS: one Panoramax instance sends no `Access-Control-Allow-Origin`
 * and a CORS rejection fires no error event, so the viewer sat on a spinner forever
 * (geoint spike notes §6). Fetching through the main process removed that cause entirely — but
 * not the class. A dead link, a stalled transfer or an instance that has left the
 * federation still produce exactly the same silence, so the timeout stays.
 */
function useLoadTimeout(src: string, onFailed: (why: string) => void): () => void {
  const timer = useRef<number | null>(null)
  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => {
    clear()
    if (!src) return
    timer.current = window.setTimeout(() => onFailed('timed out'), LOAD_TIMEOUT_MS)
    return clear
  }, [src, onFailed, clear])

  return clear
}

/* -------------------------------------------------------------- flat photos */

export function FlatViewer({ src, onFailed, onLoaded }: Omit<ImageryProps, 'pano'>): React.JSX.Element {
  const wrap = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const view = useRef({ z: 1, x: 0, y: 0 })
  /* Set when a fit was asked for before the wrapper had a box. The ResizeObserver below
     is what eventually clears it. */
  const pending = useRef(false)
  const clearTimer = useLoadTimeout(src, onFailed)

  const apply = useCallback(() => {
    const el = img.current
    if (!el) return
    const v = view.current
    el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`
  }, [])

  /**
   * Fit the photo to the viewer.
   *
   * This has to be retried rather than computed once. The wrapper is switched from
   * hidden to shown immediately before the image is requested, and **a cached image
   * fires `load` before the browser has laid the wrapper out** — so `clientWidth` and
   * `clientHeight` are still 0, the scale factor computes as `scale(0)`, and the round
   * renders as a black rectangle. It reproduces only on a warm cache, which is exactly
   * the state a returning player is in (geoint spike notes §8.4).
   */
  const fit = useCallback(() => {
    const w = wrap.current
    const el = img.current
    if (!w || !el) return
    const rw = w.clientWidth
    const rh = w.clientHeight
    if (!rw || !rh || !el.naturalWidth) {
      pending.current = true
      return
    }
    pending.current = false
    const z = Math.min(rw / el.naturalWidth, rh / el.naturalHeight)
    view.current = {
      z,
      x: (rw - el.naturalWidth * z) / 2,
      y: (rh - el.naturalHeight * z) / 2
    }
    apply()
  }, [apply])

  /* A ResizeObserver, not a requestAnimationFrame retry: rAF is throttled while the
     window is not painting, so a backgrounded app would sit on an unfitted image until
     it was looked at. ResizeObserver fires as soon as the wrapper actually has a box. */
  useEffect(() => {
    const w = wrap.current
    if (!w) return
    // Refit on every box change, not only the pending one: the wrapper also resizes when
    // the window does, and a photo that stayed at its old scale would sit off-centre.
    const ro = new ResizeObserver(() => fit())
    ro.observe(w)
    return () => ro.disconnect()
  }, [fit])

  useEffect(() => {
    pending.current = true
  }, [src])

  /* Pointer drag to pan, wheel to zoom about the cursor. */
  useEffect(() => {
    const w = wrap.current
    if (!w) return
    let down = false
    let sx = 0
    let sy = 0

    const onDown = (e: PointerEvent): void => {
      down = true
      sx = e.clientX - view.current.x
      sy = e.clientY - view.current.y
      w.setPointerCapture(e.pointerId)
      w.dataset.dragging = 'true'
    }
    const onMove = (e: PointerEvent): void => {
      if (!down) return
      view.current.x = e.clientX - sx
      view.current.y = e.clientY - sy
      apply()
    }
    const onUp = (): void => {
      down = false
      delete w.dataset.dragging
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = w.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const v = view.current
      const k = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const nz = Math.max(0.4, Math.min(8, v.z * k))
      v.x = mx - (mx - v.x) * (nz / v.z)
      v.y = my - (my - v.y) * (nz / v.z)
      v.z = nz
      apply()
    }

    w.addEventListener('pointerdown', onDown)
    w.addEventListener('pointermove', onMove)
    w.addEventListener('pointerup', onUp)
    w.addEventListener('pointercancel', onUp)
    w.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      w.removeEventListener('pointerdown', onDown)
      w.removeEventListener('pointermove', onMove)
      w.removeEventListener('pointerup', onUp)
      w.removeEventListener('pointercancel', onUp)
      w.removeEventListener('wheel', onWheel)
    }
  }, [apply])

  return (
    <div className="stage__flat" ref={wrap}>
      <img
        ref={img}
        className="stage__img"
        src={src}
        alt="Street-level photograph. Where it was taken is the question; nothing outside the frame will tell you."
        draggable={false}
        onLoad={() => {
          clearTimer()
          fit()
          onLoaded()
        }}
        onError={() => onFailed('failed to load')}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- panoramas */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

/**
 * One ray per pixel, straight into the equirectangular projection.
 *
 * Cheaper and more exact than texturing a sphere: there is no geometry to tessellate and
 * no interpolation error near the poles, which is where a low-poly sphere looks worst.
 */
const FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uYaw;
uniform float uPitch;
uniform float uFov;
const float PI = 3.14159265359;
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float f = 0.5 / tan(uFov * 0.5);
  vec3 dir = normalize(vec3(p.x, p.y, -f));
  float cp = cos(uPitch), sp = sin(uPitch);
  dir = vec3(dir.x, dir.y * cp - dir.z * sp, dir.y * sp + dir.z * cp);
  float cy = cos(uYaw), sy = sin(uYaw);
  dir = vec3(dir.x * cy + dir.z * sy, dir.y, -dir.x * sy + dir.z * cy);
  float lon = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  gl_FragColor = texture2D(uTex, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('the GPU refused to create a shader')
  gl.shaderSource(sh, source)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) ?? 'shader failed to compile')
  }
  return sh
}

export function PanoViewer({ src, onFailed, onLoaded }: Omit<ImageryProps, 'pano'>): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const look = useRef({ yaw: 0, pitch: 0, fov: (100 * Math.PI) / 180 })
  const clearTimer = useLoadTimeout(src, onFailed)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let raf = 0
    let disposed = false

    /* WebGL 2 for one specific reason: it allows REPEAT wrapping on a non-power-of-two
       texture, and a 3840x1920 panorama is exactly that. Under WebGL 1 the seam at
       longitude ±180 has to be clamped and shows. */
    const gl2 = el.getContext('webgl2') as WebGLRenderingContext | null
    const gl = gl2 ?? (el.getContext('webgl') as WebGLRenderingContext | null)
    if (!gl) {
      setFallback(true)
      return
    }
    const isGl2 = gl === gl2

    let program: WebGLProgram | null = null
    try {
      program = gl.createProgram()
      if (!program) throw new Error('the GPU refused to create a program')
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? 'program failed to link')
      }
    } catch {
      setFallback(true)
      return
    }
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(program, 'uRes')
    const uYaw = gl.getUniformLocation(program, 'uYaw')
    const uPitch = gl.getUniformLocation(program, 'uPitch')
    const uFov = gl.getUniformLocation(program, 'uFov')

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, isGl2 ? gl.REPEAT : gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    let ready = false
    const draw = (): void => {
      if (disposed || !ready) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(el.clientWidth * dpr))
      const h = Math.max(1, Math.round(el.clientHeight * dpr))
      if (el.width !== w || el.height !== h) {
        el.width = w
        el.height = h
      }
      gl.viewport(0, 0, el.width, el.height)
      gl.uniform2f(uRes, el.width, el.height)
      gl.uniform1f(uYaw, look.current.yaw)
      gl.uniform1f(uPitch, look.current.pitch)
      gl.uniform1f(uFov, look.current.fov)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(draw)
    }

    const image = new Image()
    // Required: an image the browser treats as cross-origin and untainted-unknown throws
    // SecurityError on texImage2D. The pano: handler answers with `access-control-allow-origin`.
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (disposed) return
      clearTimer()
      try {
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image)
      } catch {
        onFailed('could not be read into the panorama viewer')
        return
      }
      ready = true
      look.current = { yaw: 0, pitch: 0, fov: (100 * Math.PI) / 180 }
      schedule()
      onLoaded()
    }
    image.onerror = () => onFailed('failed to load')
    image.src = src

    /* Drag to look, wheel to change the field of view. Pitch is clamped just short of
       the poles, where an equirectangular projection degenerates. */
    let down = false
    let lx = 0
    let ly = 0
    const onDown = (e: PointerEvent): void => {
      down = true
      lx = e.clientX
      ly = e.clientY
      el.setPointerCapture(e.pointerId)
      el.dataset.dragging = 'true'
    }
    const onMove = (e: PointerEvent): void => {
      if (!down) return
      const scale = look.current.fov / Math.max(1, el.clientHeight)
      look.current.yaw -= (e.clientX - lx) * scale
      look.current.pitch = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, look.current.pitch + (e.clientY - ly) * scale)
      )
      lx = e.clientX
      ly = e.clientY
      schedule()
    }
    const onUp = (): void => {
      down = false
      delete el.dataset.dragging
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const k = e.deltaY < 0 ? 1 / 1.12 : 1.12
      look.current.fov = Math.max((18 * Math.PI) / 180, Math.min((120 * Math.PI) / 180, look.current.fov * k))
      schedule()
    }
    const onKey = (e: KeyboardEvent): void => {
      const step = look.current.fov / 8
      if (e.key === 'ArrowLeft') look.current.yaw -= step
      else if (e.key === 'ArrowRight') look.current.yaw += step
      else if (e.key === 'ArrowUp') look.current.pitch = Math.min(Math.PI / 2 - 0.01, look.current.pitch + step)
      else if (e.key === 'ArrowDown') look.current.pitch = Math.max(-Math.PI / 2 + 0.01, look.current.pitch - step)
      else return
      e.preventDefault()
      schedule()
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('keydown', onKey)
    const ro = new ResizeObserver(schedule)
    ro.observe(el)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      image.onload = null
      image.onerror = null
      image.src = ''
      gl.deleteTexture(texture)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    }
  }, [src, onFailed, onLoaded, clearTimer])

  /* No WebGL means the panorama still has to be readable. Shown flat, an equirectangular
     frame is distorted at the edges but perfectly legible along the horizon band, which
     is where the signs are. */
  if (fallback) return <FlatViewer src={src} onFailed={onFailed} onLoaded={onLoaded} />

  return (
    <canvas
      ref={canvas}
      className="stage__pano"
      tabIndex={0}
      role="img"
      aria-label="360 degree panorama. Drag or use the arrow keys to look around; scroll to zoom."
    />
  )
}

/* -------------------------------------------------------------------- stage */

export function Stage({
  src,
  pano,
  loading,
  error,
  badges,
  onFailed,
  onLoaded
}: ImageryProps & {
  loading: boolean
  error: string | null
  badges: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="stage">
      {src && !error ? (
        pano ? (
          <PanoViewer key={src} src={src} onFailed={onFailed} onLoaded={onLoaded} />
        ) : (
          <FlatViewer key={src} src={src} onFailed={onFailed} onLoaded={onLoaded} />
        )
      ) : null}

      {badges && <div className="stage__badges">{badges}</div>}

      {(loading || error) && (
        <div className="stage__msg" role="status">
          {error ? (
            <>
              <Icon name="warning" size={16} className="stage__msg-icon" />
              <p className="stage__msg-text">{error}</p>
            </>
          ) : (
            <p className="stage__msg-text">Loading imagery…</p>
          )}
        </div>
      )}

      <p className="stage__attrib">
        Imagery ©{' '}
        <button
          type="button"
          className="link"
          onClick={() => void window.osint.app.openExternal('https://panoramax.xyz')}
        >
          Panoramax
        </button>{' '}
        contributors, CC-BY-SA 4.0 · signal data ©{' '}
        <button
          type="button"
          className="link"
          onClick={() => void window.osint.app.openExternal('https://www.openstreetmap.org/copyright')}
        >
          OpenStreetMap
        </button>
      </p>
    </div>
  )
}

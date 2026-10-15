import { useCallback, useEffect, useRef } from 'react'
import { Icon } from './Icon'

export const CONTEXT_MIN = 320
export const CONTEXT_MAX = 560

/**
 * The right context panel.
 *
 * DESIGN.md: a persistent margin annotation, not a modal. It holds the adapter `doc`
 * block and the detail of whatever is selected, and it is on screen by default because
 * the mechanism is the product — burying the explanation behind a click would make
 * "understand how this works" an optional extra in an app whose entire premise is that
 * it isn't.
 *
 * 320px is the specified width and the default. It is also narrow for six paragraphs of
 * prose, so the edge is a real separator: drag it, or focus it and use the arrow keys.
 * Home returns it to the specified width. Nothing persists — renderer state does not
 * survive a window close by design, and anything worth keeping belongs in the case file.
 */
export function ContextPanel({
  title,
  width,
  open,
  onWidth,
  onToggle,
  onDragging,
  children
}: {
  title: string
  width: number
  open: boolean
  onWidth: (px: number) => void
  onToggle: () => void
  onDragging: (dragging: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  const dragging = useRef(false)

  const clamp = (px: number): number => Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, px))

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragging.current = true
      onDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [onDragging]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      // The panel is anchored right, so its width is the distance from the pointer to
      // the window's right edge.
      onWidth(clamp(window.innerWidth - e.clientX))
    },
    [onWidth]
  )

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      dragging.current = false
      onDragging(false)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    },
    [onDragging]
  )

  // A drag that ends outside the window still has to end.
  useEffect(() => {
    const stop = (): void => {
      if (!dragging.current) return
      dragging.current = false
      onDragging(false)
    }
    window.addEventListener('blur', stop)
    return () => window.removeEventListener('blur', stop)
  }, [onDragging])

  return (
    <aside className="context" aria-label="Context">
      <div
        className="context__grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the context panel"
        aria-valuenow={width}
        aria-valuemin={CONTEXT_MIN}
        aria-valuemax={CONTEXT_MAX}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            onWidth(clamp(width + 16))
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            onWidth(clamp(width - 16))
          } else if (e.key === 'Home') {
            e.preventDefault()
            onWidth(CONTEXT_MIN)
          }
        }}
      />

      <div className="context__head">
        <h2 className="context__title">{title}</h2>
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Hide the context panel' : 'Show the context panel'}
          aria-label={open ? 'Hide the context panel' : 'Show the context panel'}
        >
          <Icon name={open ? 'chevron-right' : 'chevron-left'} />
        </button>
      </div>

      <div className="context__body">{children}</div>
    </aside>
  )
}

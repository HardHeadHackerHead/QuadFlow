import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

type ClassValue = string | false | null | undefined | 0

/** Join class names, skipping falsy values. */
export function cx(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ')
}

/** Controlled/uncontrolled state helper. */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (v: T) => void,
): [T, (v: T) => void] {
  const [inner, setInner] = useState(defaultValue)
  const controlled = value !== undefined
  const current = controlled ? (value as T) : inner
  const set = useCallback(
    (v: T) => {
      if (!controlled) setInner(v)
      onChange?.(v)
    },
    [controlled, onChange],
  )
  return [current, set]
}

/** Call `handler` on pointerdown outside every given element. */
export function useClickOutside(
  refs: RefObject<HTMLElement | null>[],
  handler: () => void,
  enabled = true,
) {
  const h = useRef(handler)
  h.current = handler
  useEffect(() => {
    if (!enabled) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (refs.some((r) => r.current?.contains(t))) return
      h.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
}

// Escape closes only the top-most open layer (menu inside a modal, …).
const escapeStack: { current: () => void }[] = []
let escapeListening = false
function onEscapeKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !escapeStack.length) return
  e.stopPropagation()
  escapeStack[escapeStack.length - 1].current()
}

/** Call `handler` on Escape while enabled and top-most. */
export function useEscape(handler: () => void, enabled = true) {
  const h = useRef(handler)
  h.current = handler
  useEffect(() => {
    if (!enabled) return
    const entry = h
    escapeStack.push(entry)
    if (!escapeListening) {
      document.addEventListener('keydown', onEscapeKey, true)
      escapeListening = true
    }
    return () => {
      const i = escapeStack.lastIndexOf(entry)
      if (i >= 0) escapeStack.splice(i, 1)
    }
  }, [enabled])
}

export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top' | 'right-start' | 'left-start'

export interface Point {
  x: number
  y: number
}

/**
 * Position a fixed-position floating element next to an anchor rect (or point),
 * flipping vertically/horizontally and clamping to the viewport.
 */
export function computePosition(
  anchor: DOMRect | Point,
  floating: { width: number; height: number },
  placement: Placement,
  offset = 4,
): Point {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const r =
    'width' in anchor
      ? anchor
      : ({ left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 } as DOMRect)
  const [side, align] = placement.split('-') as [string, string | undefined]
  let x: number
  let y: number
  if (side === 'bottom' || side === 'top') {
    x = align === 'end' ? r.right - floating.width : align === 'start' ? r.left : r.left + r.width / 2 - floating.width / 2
    y = side === 'bottom' ? r.bottom + offset : r.top - offset - floating.height
    if (side === 'bottom' && y + floating.height > vh && r.top - offset - floating.height >= 0) y = r.top - offset - floating.height
    if (side === 'top' && y < 0 && r.bottom + offset + floating.height <= vh) y = r.bottom + offset
  } else {
    y = r.top
    x = side === 'right' ? r.right + offset : r.left - offset - floating.width
    if (side === 'right' && x + floating.width > vw) x = r.left - offset - floating.width
    if (side === 'left' && x < 0) x = r.right + offset
  }
  x = Math.max(4, Math.min(x, vw - floating.width - 4))
  y = Math.max(4, Math.min(y, vh - floating.height - 4))
  return { x, y }
}

/** Track a floating element's position relative to an anchor element or point. */
export function useFloatingPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null> | Point | null,
  floating: RefObject<HTMLElement | null>,
  placement: Placement,
  offset?: number,
): Point | null {
  const [pos, setPos] = useState<Point | null>(null)
  const update = useCallback(() => {
    const f = floating.current
    if (!f || !anchor) return
    const a = 'current' in anchor ? anchor.current?.getBoundingClientRect() : anchor
    if (!a) return
    const next = computePosition(a, { width: f.offsetWidth, height: f.offsetHeight }, placement, offset)
    setPos((p) => (p && p.x === next.x && p.y === next.y ? p : next))
  }, [anchor, floating, placement, offset])
  useIsoLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (floating.current) ro?.observe(floating.current)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      ro?.disconnect()
    }
  }, [open, update])
  return pos
}

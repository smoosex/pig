import { useCallback, useEffect, useRef, useState, type ComponentProps, type FocusEvent, type PointerEvent } from 'react'
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { cn } from '../../lib/utils'

const GLIDE = { type: 'spring', visualDuration: 0.22, bounce: 0 } as const
const FADE = { duration: 0.12, ease: 'easeOut' } as const
const ROW_SELECTOR = '[data-sidebar-hover-row]'

export function SidebarHoverHighlight({ className, children, ...props }: ComponentProps<'div'>) {
  const areaRef = useRef<HTMLDivElement>(null)
  const pointerInsideRef = useRef(false)
  const pointerRowRef = useRef<HTMLElement | null>(null)
  const focusRowRef = useRef<HTMLElement | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const reduced = useReducedMotion() ?? false
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const width = useMotionValue(0)
  const height = useMotionValue(0)
  const opacity = useMotionValue(0)

  const rowFrom = useCallback((node: EventTarget | null) => {
    if (!(node instanceof Element)) return null
    const row = node.closest<HTMLElement>(ROW_SELECTOR)
    return row && areaRef.current?.contains(row) ? row : null
  }, [])

  const moveTo = useCallback(
    (row: HTMLElement | null) => {
      const area = areaRef.current
      const nextTarget = row && area?.contains(row) ? row : null
      if (targetRef.current !== nextTarget) {
        targetRef.current?.removeAttribute('data-sidebar-hover-target')
        nextTarget?.setAttribute('data-sidebar-hover-target', '')
        targetRef.current = nextTarget
      }
      if (!nextTarget || !area) {
        setTarget(null)
        animate(opacity, 0, reduced ? { duration: 0 } : FADE)
        return
      }
      setTarget(nextTarget)

      const areaRect = area.getBoundingClientRect()
      const rowRect = nextTarget.getBoundingClientRect()
      const next = {
        x: rowRect.left - areaRect.left,
        y: rowRect.top - areaRect.top,
        width: rowRect.width,
        height: rowRect.height
      }
      const jump = reduced || opacity.get() < 0.05

      for (const [value, destination] of [
        [x, next.x],
        [y, next.y],
        [width, next.width],
        [height, next.height]
      ] as const) {
        if (jump) value.jump(destination)
        else animate(value, destination, GLIDE)
      }
      animate(opacity, 1, reduced ? { duration: 0 } : FADE)
    },
    [height, opacity, reduced, width, x, y]
  )

  useEffect(() => {
    if (!target) return
    const measure = () => moveTo(target)
    const observer = new ResizeObserver(measure)
    if (areaRef.current) observer.observe(areaRef.current)
    observer.observe(target)
    return () => observer.disconnect()
  }, [moveTo, target])

  useEffect(
    () => () => targetRef.current?.removeAttribute('data-sidebar-hover-target'),
    []
  )

  const handlePointerOver = (event: PointerEvent<HTMLDivElement>) => {
    pointerInsideRef.current = true
    const row = rowFrom(event.target)
    if (row === pointerRowRef.current) return
    pointerRowRef.current = row
    moveTo(row)
  }

  const handlePointerLeave = () => {
    pointerInsideRef.current = false
    pointerRowRef.current = null
    moveTo(focusRowRef.current)
  }

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = rowFrom(event.target)
    focusRowRef.current = row
    if (!pointerInsideRef.current) moveTo(row)
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    focusRowRef.current = rowFrom(event.relatedTarget)
    if (!pointerInsideRef.current) moveTo(focusRowRef.current)
  }

  return (
    <div
      ref={areaRef}
      className={cn('relative', className)}
      onPointerOver={handlePointerOver}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      {...props}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-md bg-sidebar-accent will-change-transform"
        style={{ x, y, width, height, opacity }}
      />
      {children}
    </div>
  )
}

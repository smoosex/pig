import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type PointerEvent
} from 'react'
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { cn } from '../../lib/utils'

const GLIDE = { type: 'spring', visualDuration: 0.22, bounce: 0 } as const
const FADE = { duration: 0.12, ease: 'easeOut' } as const

export function SmoothHoverHighlight({
  activeKey,
  className,
  highlightClassName,
  rowSelector = '[data-hover-highlight-row]',
  targetAttribute = 'data-hover-highlight-target',
  children,
  ...props
}: ComponentProps<'div'> & {
  activeKey?: string | number | null
  highlightClassName?: string
  rowSelector?: string
  targetAttribute?: string
}) {
  const areaRef = useRef<HTMLDivElement>(null)
  const pointerInsideRef = useRef(false)
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null)
  const pointerRowRef = useRef<HTMLElement | null>(null)
  const focusRowRef = useRef<HTMLElement | null>(null)
  const activeRowRef = useRef<HTMLElement | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const reduced = useReducedMotion() ?? false
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const width = useMotionValue(0)
  const height = useMotionValue(0)
  const opacity = useMotionValue(0)

  const rowFrom = useCallback(
    (node: EventTarget | null) => {
      if (!(node instanceof Element)) return null
      const row = node.closest<HTMLElement>(rowSelector)
      return row && areaRef.current?.contains(row) ? row : null
    },
    [rowSelector]
  )

  const moveTo = useCallback(
    (row: HTMLElement | null, immediate = false) => {
      const area = areaRef.current
      const nextTarget = row && area?.contains(row) ? row : null
      if (targetRef.current !== nextTarget) {
        targetRef.current?.removeAttribute(targetAttribute)
        nextTarget?.setAttribute(targetAttribute, '')
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
      const jump = immediate || reduced || opacity.get() < 0.05

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
    [height, opacity, reduced, targetAttribute, width, x, y]
  )

  useEffect(() => {
    if (!target) return
    const measure = () => moveTo(target)
    const observer = new ResizeObserver(measure)
    if (areaRef.current) observer.observe(areaRef.current)
    observer.observe(target)
    return () => observer.disconnect()
  }, [moveTo, target])

  useEffect(() => {
    let frame = 0
    const retarget = () => {
      frame = 0
      const position = pointerPositionRef.current
      if (!pointerInsideRef.current || !position) return
      const row = rowFrom(document.elementFromPoint(position.x, position.y))
      pointerRowRef.current = row
      moveTo(row, true)
    }
    const handleScroll = () => {
      if (!frame && pointerInsideRef.current) frame = requestAnimationFrame(retarget)
    }
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [moveTo, rowFrom])

  useEffect(() => {
    const row = areaRef.current?.querySelector<HTMLElement>('[data-hover-highlight-active]') ?? null
    activeRowRef.current = row
    if (!pointerInsideRef.current) moveTo(row ?? focusRowRef.current)
  }, [activeKey, moveTo])

  useEffect(
    () => () => targetRef.current?.removeAttribute(targetAttribute),
    [targetAttribute]
  )

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    pointerInsideRef.current = true
    pointerPositionRef.current = { x: event.clientX, y: event.clientY }
    const row = rowFrom(event.target)
    if (row === pointerRowRef.current) return
    pointerRowRef.current = row
    moveTo(row)
  }

  const handlePointerLeave = () => {
    pointerInsideRef.current = false
    pointerPositionRef.current = null
    pointerRowRef.current = null
    moveTo(activeRowRef.current ?? focusRowRef.current)
  }

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = rowFrom(event.target)
    focusRowRef.current = row
    if (!pointerInsideRef.current) moveTo(activeRowRef.current ?? row)
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    focusRowRef.current = rowFrom(event.relatedTarget)
    if (!pointerInsideRef.current) moveTo(activeRowRef.current ?? focusRowRef.current)
  }

  return (
    <div
      ref={areaRef}
      className={cn('relative', className)}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      {...props}
    >
      <motion.span
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-0 left-0 rounded-md bg-accent will-change-transform',
          highlightClassName
        )}
        style={{ x, y, width, height, opacity }}
      />
      {children}
    </div>
  )
}

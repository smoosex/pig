import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react'
import { cn } from '@/lib/utils'

/**
 * The googly-eyes toggle: the pupils follow the cursor and the eyes narrow into a smirk with the
 * label swapped when `pressed`. Every dimension is a multiple of `--u`, one design pixel of the
 * 58px-tall original, so the caller picks a height and the button keeps its proportions. The label
 * keeps a legible size instead of shrinking with the geometry.
 *
 * The pill is a quiet surface and the eyes carry the ink, like an inverted button would: the eyeball
 * is always the light surface and the pupil always the ink, so the googly look survives a dark
 * palette where the page itself is dark. Only the smirk pupil is an accent (destructive).
 */
const DESIGN_HEIGHT = 58
const DESIGN_FONT_SIZE = 14
const MIN_FONT_SIZE = 12
const LABEL_DESIGN_HEIGHT = 20
const EYE_DESIGN_SIZE = 38
const LABEL_LINE_HEIGHT = 1.2
const PUPIL_TRAVEL = 12
const BORDER_PX = 1
const MIN_PAD_PX = 0.5

function Eye({
  smirking,
  side,
  scale,
  reduced
}: {
  smirking: boolean
  side: 'left' | 'right'
  /** One design pixel of the eye's own 38px box, in px. */
  scale: number
  /** Reduced motion: the eyes still narrow, but they do not chase the cursor. */
  reduced: boolean
}) {
  const eyeRef = useRef<HTMLDivElement>(null)
  const pupilX = useMotionValue(0)
  const pupilY = useMotionValue(0)
  const springX = useSpring(pupilX, { stiffness: 300, damping: 20 })
  const springY = useSpring(pupilY, { stiffness: 300, damping: 20 })

  useEffect(() => {
    if (reduced) return
    const onMouseMove = (event: MouseEvent) => {
      const rect = eyeRef.current?.getBoundingClientRect()
      if (!rect) return
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX)
      // The pupil slides toward the cursor but stays inside the eye.
      const distance = Math.min(
        PUPIL_TRAVEL * scale,
        Math.hypot(event.clientX - centerX, event.clientY - centerY) / 10
      )
      pupilX.set(Math.cos(angle) * distance)
      pupilY.set(Math.sin(angle) * distance)
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [pupilX, pupilY, reduced, scale])

  const spring = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 260, damping: 20 }

  return (
    <motion.div
      ref={eyeRef}
      animate={
        smirking
          ? { scaleY: 0.42, rotate: side === 'left' ? -4 : 4 }
          : { scaleY: 1, rotate: 0 }
      }
      transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 18 }}
      className="relative flex h-[calc(38*var(--e))] w-[calc(38*var(--e))] items-center justify-center overflow-hidden rounded-full border border-border bg-background inset-shadow-sm dark:bg-foreground"
    >
      {/* The smirk's drop owns its own element: the pupil's transform belongs to the cursor springs, and
          two writers of one property would each steer the other's animation. */}
      <motion.div
        animate={{ y: smirking ? 2 * scale : 0 }}
        transition={spring}
        className="absolute h-[calc(14*var(--e))] w-[calc(14*var(--e))]"
      >
        <motion.div
          style={{ x: springX, y: springY }}
          animate={{ scaleX: smirking ? 0.5 : 1, scaleY: smirking ? 1.6 : 1 }}
          transition={spring}
          className={cn(
            'h-full w-full rounded-full transition-colors duration-300',
            smirking
              ? 'bg-destructive shadow-[0_0_6px_1px_color-mix(in_srgb,var(--destructive)_65%,transparent)]'
              : 'bg-foreground dark:bg-background'
          )}
        />
      </motion.div>
      {/* A lid slanting inward toward the middle of the face, which is what reads as a glare. */}
      <motion.div
        initial={false}
        animate={{
          height: smirking ? 22 * scale : 0,
          rotate: smirking ? (side === 'left' ? 14 : -14) : 0
        }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 22 }}
        style={{ transformOrigin: side === 'left' ? 'top right' : 'top left' }}
        className="pointer-events-none absolute -top-[calc(6*var(--e))] -right-[calc(8*var(--e))] -left-[calc(8*var(--e))] bg-foreground dark:bg-background"
      />
    </motion.div>
  )
}

export function GooglyEyesButton({
  label,
  alternateLabel,
  pressed,
  onClick,
  ariaLabel,
  height = DESIGN_HEIGHT
}: {
  /** The text for the state the button is in. */
  label: string
  /** The other state's text: only used to keep the label box wide enough for either one. */
  alternateLabel: string
  pressed: boolean
  onClick: () => void
  ariaLabel: string
  /** Rendered height in px; width follows from the design's proportions. */
  height?: number
}) {
  const unit = height / DESIGN_HEIGHT
  const fontSize = Math.max(MIN_FONT_SIZE, DESIGN_FONT_SIZE * unit)
  // The label stops shrinking at a legible size, so below a certain height it is the tallest thing in
  // the pill: it is clipped to the space the border and a hair of padding leave, the eyes grow to
  // match it, and the padding takes the rest. That keeps the outer height exactly `height` instead of
  // letting the line box push the pill open.
  const inner = Math.max(0, height - 2 * BORDER_PX - 2 * MIN_PAD_PX)
  const labelHeight = Math.min(
    Math.max(LABEL_DESIGN_HEIGHT * unit, fontSize * LABEL_LINE_HEIGHT),
    inner
  )
  const eyeSize = Math.max(EYE_DESIGN_SIZE * unit, labelHeight)
  const eyeScale = eyeSize / EYE_DESIGN_SIZE
  const padY = Math.max(MIN_PAD_PX, (height - 2 * BORDER_PX - Math.max(eyeSize, labelHeight)) / 2)
  const style = {
    '--u': `${unit}px`,
    '--e': `${eyeScale}px`,
    '--label-h': `${labelHeight}px`,
    '--pad-y': `${padY}px`,
    fontSize
  } as CSSProperties
  const widest = label.length >= alternateLabel.length ? label : alternateLabel
  const reduced = useReducedMotion() ?? false

  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      whileHover={reduced ? undefined : { scale: 1.02 }}
      whileTap={reduced ? undefined : { scale: 0.98 }}
      style={style}
      className="no-drag relative flex cursor-pointer items-center gap-[calc(12*var(--u))] rounded-full border border-border bg-card py-[var(--pad-y)] pr-[calc(12*var(--u))] pl-[calc(24*var(--u))] shadow-2xl select-none"
    >
      <div className="relative mr-[calc(8*var(--u))] h-[var(--label-h)] min-w-[calc(100*var(--u))] overflow-hidden">
        <span aria-hidden className="invisible block whitespace-nowrap">
          {widest}
        </span>
        <AnimatePresence mode="wait">
          <motion.span
            key={label}
            initial={reduced ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={reduced ? { duration: 0 } : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 flex items-center font-semibold tracking-tight whitespace-nowrap text-foreground"
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="flex items-center gap-[calc(8*var(--e))]">
        <Eye smirking={pressed} side="left" scale={eyeScale} reduced={reduced} />
        <Eye smirking={pressed} side="right" scale={eyeScale} reduced={reduced} />
      </div>
    </motion.button>
  )
}

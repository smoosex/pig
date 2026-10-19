/**
 * The native material can disappear only after the opaque background has finished and painted.
 * A reversed choice cancels this barrier; hidden windows finish the background without waiting for RAF.
 *
 * A material change is revealed as a circle growing from the control that requested it. The view
 * transition snapshots only web content, so the native material must stay on for the whole reveal:
 * glass is enabled before its reveal starts, and solid removes it only after the reveal finished.
 */
import type { SurfaceStyle } from '../../../shared/api'

const REVEAL_MS = 500

let revealOrigin: { x: number; y: number } | undefined
let revealTarget: SurfaceStyle | undefined
let reveal: ViewTransition | undefined

export function setSurfaceRevealOrigin(element: Element): void {
  const rect = element.getBoundingClientRect()
  revealOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

export function applySurfaceStyle(root: HTMLElement, style: SurfaceStyle): void {
  if (style === revealTarget && (reveal || root.dataset.surfaceStyle === style)) return
  revealTarget = style
  const origin = revealOrigin ?? { x: innerWidth / 2, y: innerHeight / 2 }
  revealOrigin = undefined
  if (
    root.dataset.surfaceStyle === undefined || typeof document.startViewTransition !== 'function' ||
    document.visibilityState !== 'visible' || matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    // A skipped earlier reveal still runs its update later; it reads the same latest target.
    root.dataset.surfaceStyle = style
    return
  }
  const radius = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y))
  root.style.setProperty('--surface-reveal-x', `${origin.x}px`)
  root.style.setProperty('--surface-reveal-y', `${origin.y}px`)
  root.dataset.surfaceReveal = ''
  const transition = document.startViewTransition(() => { root.dataset.surfaceStyle = revealTarget })
  reveal = transition
  transition.ready.then(() => {
    for (const pseudoElement of ['::view-transition-old(root)', '::view-transition-new(root)']) {
      root.animate(
        { '--surface-reveal-radius': ['0px', `${radius}px`] },
        { duration: REVEAL_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards', pseudoElement }
      )
    }
  }, () => {})
  const settle = () => {
    if (reveal !== transition) return
    reveal = undefined
    delete root.dataset.surfaceReveal
  }
  transition.finished.then(settle, settle)
}

function backgroundTransitions(surface: HTMLElement): CSSTransition[] {
  return surface.getAnimations().filter((animation): animation is CSSTransition =>
    'transitionProperty' in animation &&
    animation.transitionProperty === 'background-color' &&
    animation.playState !== 'finished' && animation.playState !== 'idle'
  )
}

export function waitForSurfacePaint(signal: AbortSignal): Promise<void> | undefined {
  const surface = document.querySelector<HTMLElement>('[data-app-surface]')
  if (!surface || signal.aborted) return
  return waitForPaint(surface, signal)
}

async function waitForPaint(surface: HTMLElement, signal: AbortSignal): Promise<void> {
  let frame = 0
  let interrupt!: () => void
  const interrupted = new Promise<void>((resolve) => { interrupt = resolve })
  const stop = () => {
    if (frame) cancelAnimationFrame(frame)
    interrupt()
  }
  const hidden = () => {
    if (document.visibilityState === 'hidden') {
      for (const animation of backgroundTransitions(surface)) animation.finish()
      reveal?.skipTransition()
      stop()
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  document.addEventListener('visibilitychange', hidden)
  try {
    hidden()
    while (!signal.aborted && document.visibilityState !== 'hidden') {
      const pending: Promise<unknown>[] = backgroundTransitions(surface).map((animation) => animation.finished)
      if (reveal) pending.push(reveal.finished)
      if (!pending.length) break
      await Promise.race([Promise.allSettled(pending), interrupted])
    }
    if (signal.aborted || document.visibilityState === 'hidden') return
    // Two frames also cover reduced-motion's immediate style change and the last transition frame.
    await Promise.race([
      new Promise<void>((resolve) => {
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => { frame = 0; resolve() })
        })
      }),
      interrupted
    ])
  } finally {
    if (frame) cancelAnimationFrame(frame)
    signal.removeEventListener('abort', stop)
    document.removeEventListener('visibilitychange', hidden)
  }
}

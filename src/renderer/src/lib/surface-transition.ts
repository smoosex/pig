/**
 * The native material can disappear only after the opaque background has finished and painted.
 * A reversed choice cancels this barrier; hidden windows finish the background without waiting for RAF.
 */
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
      stop()
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  document.addEventListener('visibilitychange', hidden)
  try {
    hidden()
    while (!signal.aborted && document.visibilityState !== 'hidden') {
      const animations = backgroundTransitions(surface)
      if (!animations.length) break
      await Promise.race([Promise.allSettled(animations.map((animation) => animation.finished)), interrupted])
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

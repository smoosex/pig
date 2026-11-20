/**
 * Shared View-Transition radial reveal helpers for Pig's surface style switch and Bot page transition.
 * Includes Chromium's non-editable-island selection safeguard, reduced-motion fallback, and rapid-toggle cancellation.
 */
import { flushSync } from 'react-dom'

const BOT_EXPAND_MS = 380
const BOT_COLLAPSE_MS = 300

export interface RadialOrigin {
  x: number
  y: number
}

/**
 * The renderer crashes (a Chromium CHECK, SIGTRAP) when a view transition snapshots a selection that
 * covers a non-editable island inside an editor, such as a chip the composer selected on click. The
 * editor keeps its own selection state and restores it on focus, so only the DOM range is dropped.
 */
export function dropNonEditableSelection(): void {
  const selection = getSelection()
  if (!selection?.rangeCount) return
  const range = selection.getRangeAt(0)
  const islands = document.querySelectorAll('[contenteditable="true"] [contenteditable="false"]')
  if ([...islands].some((island) => range.intersectsNode(island))) selection.removeAllRanges()
}

export function elementCenterOrigin(element: Element | null | undefined): RadialOrigin {
  if (!element) return { x: 112, y: 20 }
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return { x: 112, y: 20 }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

let activeBotReveal: ViewTransition | undefined

/**
 * Animate switching between Workspace and Bot Page radially from/to the BotOrbButton center.
 * Falls back synchronously to instant state update under prefers-reduced-motion, hidden tab, or unsupported APIs.
 */
export function runBotRadialReveal(
  direction: 'expand' | 'collapse',
  origin: RadialOrigin,
  applyState: () => void
): void {
  const root = document.documentElement
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  if (
    reduced ||
    typeof document.startViewTransition !== 'function' ||
    document.visibilityState !== 'visible'
  ) {
    activeBotReveal?.skipTransition()
    activeBotReveal = undefined
    delete root.dataset.botReveal
    applyState()
    return
  }

  activeBotReveal?.skipTransition()
  dropNonEditableSelection()

  const radius =
    Math.ceil(
      Math.hypot(
        Math.max(origin.x, window.innerWidth - origin.x),
        Math.max(origin.y, window.innerHeight - origin.y)
      )
    ) + 2
  root.style.setProperty('--bot-reveal-x', `${origin.x}px`)
  root.style.setProperty('--bot-reveal-y', `${origin.y}px`)
  root.dataset.botReveal = direction

  const transition = document.startViewTransition(() => {
    flushSync(() => {
      applyState()
    })
  })
  activeBotReveal = transition

  transition.ready.then(() => {
    if (activeBotReveal !== transition) return
    const radii = direction === 'expand' ? ['0px', `${radius}px`] : [`${radius}px`, '0px']
    const duration = direction === 'expand' ? BOT_EXPAND_MS : BOT_COLLAPSE_MS
    const easing = direction === 'expand' ? 'cubic-bezier(0.22, 1, 0.36, 1)' : 'cubic-bezier(0.4, 0, 0.2, 1)'
    for (const pseudoElement of ['::view-transition-old(root)', '::view-transition-new(root)']) {
      root.animate(
        { '--bot-reveal-radius': radii },
        {
          duration,
          easing,
          fill: 'forwards',
          pseudoElement
        }
      )
    }
  }, () => {})

  const settle = () => {
    if (activeBotReveal !== transition) return
    activeBotReveal = undefined
    delete root.dataset.botReveal
  }
  transition.finished.then(settle, settle)
}

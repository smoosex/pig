/** Native views sit above DOM overlays. One ordered queue owns all renderer visibility transitions. */
import { useLayoutEffect, type RefObject } from 'react'
import type { BrowserBounds, BrowserFrame } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { waitForBrowserPaint } from './browser-frame'

let writes: Promise<void> = Promise.resolve()
const owners = new Map<string, object>()

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="tooltip-content"], [data-slot="hover-card-content"], [data-split-drop-preview], [data-sidebar-overlay]'
const REVEAL = '[data-surface-reveal]'
/** Zero-height marker at the top of docked DevTools; everything below it is DevTools. */
const DIVIDER = '[data-devtools-divider]'
// Positioning wrappers trigger remeasurement, but their boxes are not visible occluders.
const RELEVANT = `${OVERLAY}, ${REVEAL}, ${DIVIDER}, [data-radix-popper-content-wrapper]`

export function useBrowserBounds(
  browserId: string,
  visible: boolean,
  viewport: RefObject<HTMLDivElement | null>,
  onError: (error: unknown) => void,
  onFreeze: (frame: BrowserFrame | null, signal: AbortSignal) => void | Promise<void>
): void {
  useLayoutEffect(() => {
    const token = {}
    if (visible) owners.set(browserId, token)
    let last = ''
    let applied: string | undefined
    let captured: string | undefined
    let appliedOccluded = false
    let frame = 0
    let pending: AbortController | undefined
    const movesViewport = (target: EventTarget | null) => target instanceof Element &&
      target.matches('[data-pane-frame]') && target.contains(viewport.current)
    const enqueue = (bounds: BrowserBounds | null, freeze: boolean, key: string, signal: AbortSignal) => {
      const current = () => !signal.aborted && owners.get(browserId) === token
      writes = writes.then(async () => {
        if (!current()) return
        let captureFailure: { error: unknown } | undefined
        const needsCapture = freeze && captured !== key
        const apply = async () => {
          if (applied === key) return
          await api.browser.setBounds(browserId, bounds)
          applied = key
          appliedOccluded = bounds?.occluded ?? false
          if (!appliedOccluded) captured = undefined
        }
        // The first hide preserves the visible frame's paint barrier. Subsequent overlay resizes
        // lay out the already-hidden native views first, then capture their new responsive layout.
        if (needsCapture && appliedOccluded) await apply()
        if (needsCapture) {
          try {
            const snapshot = await api.browser.snapshot(browserId)
            if (!current()) return
            // A page already hidden by the previous owner may have no new frame. Keep its placeholder.
            if (snapshot !== null) {
              // onFreeze can replace the image before its paint barrier finishes or is cancelled.
              captured = undefined
              await onFreeze(snapshot, signal)
              if (current()) captured = key
            }
          } catch (error) { captureFailure = { error } }
        }
        if (!current()) return
        // A failed capture/decode cannot prevent mandatory occlusion. Report it after attempting
        // to hide, including when setBounds also fails, without caching failed native writes.
        try {
          await apply()
          if (bounds !== null && !bounds.occluded && current()) {
            // IPC acknowledgement is not a native presentation acknowledgement. Keep the decoded
            // frame across the next paint opportunity rather than removing it in the IPC microtask.
            await waitForBrowserPaint(signal)
            if (current()) await onFreeze(null, signal)
          }
        } finally {
          if (captureFailure) onError(captureFailure.error)
        }
      }).catch(error => {
        if (current()) last = ''
        onError(error)
      })
    }
    const update = () => {
      frame = 0
      const element = viewport.current
      const rect = element?.getBoundingClientRect()
      const surface = element?.closest<HTMLElement>('[data-split-pane], [data-content-surface]')
      const surfaceRect = surface?.getBoundingClientRect()
      let bottomLeftRadius = 0
      let bottomRightRadius = 0
      if (rect && surface && surfaceRect) {
        const style = getComputedStyle(surface)
        const bottomBorder = parseFloat(style.borderBottomWidth) || 0
        const leftBorder = parseFloat(style.borderLeftWidth) || 0
        const rightBorder = parseFloat(style.borderRightWidth) || 0
        // The native viewport meets the pane's inner border box, not the outer workspace card.
        if (Math.abs(rect.bottom - (surfaceRect.bottom - bottomBorder)) < 1) {
          if (Math.abs(rect.left - (surfaceRect.left + leftBorder)) < 1) {
            bottomLeftRadius = Math.max(0, (parseFloat(style.borderBottomLeftRadius) || 0) - Math.max(bottomBorder, leftBorder))
          }
          if (Math.abs(rect.right - (surfaceRect.right - rightBorder)) < 1) {
            bottomRightRadius = Math.max(0, (parseFloat(style.borderBottomRightRadius) || 0) - Math.max(bottomBorder, rightBorder))
          }
        }
      }
      if (element) {
        element.style.borderBottomLeftRadius = `${bottomLeftRadius}px`
        element.style.borderBottomRightRadius = `${bottomRightRadius}px`
      }
      const blocked = document.documentElement.matches(REVEAL) || [...document.querySelectorAll<HTMLElement>(OVERLAY)]
        .some((element) => {
          const style = getComputedStyle(element)
          if (element.dataset.state === 'closed' || element.hidden || style.display === 'none' || style.visibility === 'hidden') return false
          if (style.opacity === '0' && (!style.animationName || style.animationName === 'none')) return false
          if (element.matches('[role="dialog"], [role="alertdialog"]')) return true
          const overlay = element.getBoundingClientRect()
          return rect && overlay.width > 0 && overlay.height > 0 && overlay.left < rect.right &&
            overlay.right > rect.left && overlay.top < rect.bottom && overlay.bottom > rect.top
        })
      const divider = element?.querySelector(DIVIDER)?.getBoundingClientRect()
      const devtools = rect && divider ? { height: Math.max(0, rect.bottom - Math.max(divider.top, rect.top)) } : undefined
      const bounds = visible && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          ...(blocked ? { occluded: true } : {}),
          ...(bottomLeftRadius || bottomRightRadius ? { bottomLeftRadius, bottomRightRadius } : {}),
          ...(devtools ? { devtools } : {}) } : null
      // Equal-size pane movement does not notify ResizeObserver. Track its own native/WAAPI
      // animation too; the next sample after it stops captures the final position.
      const pane = element?.closest<HTMLElement>('[data-pane-frame]')
      if (pane?.getAnimations().some(animation => animation.playState === 'running') ||
        [...document.querySelectorAll<HTMLElement>(RELEVANT)].some(element =>
        element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'))) schedule()
      const key = JSON.stringify(bounds)
      if (last === key) return
      last = key
      pending?.abort()
      pending = new AbortController()
      enqueue(bounds, visible && blocked && !!rect && rect.width > 0 && rect.height > 0, key, pending.signal)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const layoutMotion = (event: Event) => {
      if (movesViewport(event.target) || (event.target instanceof Element && event.target.closest(RELEVANT))) schedule()
    }
    const motionEvents = ['animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel']
    for (const event of motionEvents) document.addEventListener(event, layoutMotion, true)
    const observer = new ResizeObserver(schedule)
    if (viewport.current) observer.observe(viewport.current)
    // Ignore streaming text and unrelated panes; inspect overlays and the viewport's own frame.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes'
        ? record.attributeName === 'data-surface-reveal' || record.attributeName === 'data-sidebar-overlay' ||
          (record.attributeName === 'style' && movesViewport(record.target)) ||
          (record.target instanceof Element && record.target.matches(RELEVANT))
        : [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element &&
          (node.matches(RELEVANT) || node.querySelector(RELEVANT))))) schedule()
    })
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-state', 'hidden', 'style', 'data-surface-reveal', 'data-sidebar-overlay'] })
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['data-surface-reveal', 'style'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      pending?.abort()
      if (owners.get(browserId) === token) owners.delete(browserId)
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      for (const event of motionEvents) document.removeEventListener(event, layoutMotion, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      writes = writes.then(async () => {
        const owner = owners.get(browserId)
        if (!owner || owner === token) await api.browser.setBounds(browserId, null)
      }).catch(onError)
    }
  }, [browserId, visible, viewport, onError, onFreeze])
}

/** Native views sit above DOM overlays. One ordered queue owns all renderer visibility transitions. */
import { useLayoutEffect, type RefObject } from 'react'
import type { BrowserBounds } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { waitForBrowserPaint } from './browser-frame'

let writes: Promise<void> = Promise.resolve()
const owners = new Map<string, object>()

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="tooltip-content"], [data-slot="hover-card-content"], [data-split-drop-preview]'
const REVEAL = '[data-surface-reveal]'
// Positioning wrappers trigger remeasurement, but their boxes are not visible occluders.
const RELEVANT = `${OVERLAY}, ${REVEAL}, [data-radix-popper-content-wrapper]`

export function useBrowserBounds(
  browserId: string,
  visible: boolean,
  viewport: RefObject<HTMLDivElement | null>,
  onError: (error: unknown) => void,
  onFreeze: (frame: string | null, signal: AbortSignal) => void | Promise<void>
): void {
  useLayoutEffect(() => {
    const token = {}
    if (visible) owners.set(browserId, token)
    let last = ''
    let applied: string | undefined
    let frame = 0
    let pending: AbortController | undefined
    const enqueue = (bounds: BrowserBounds | null, freeze: boolean, key: string, signal: AbortSignal) => {
      const current = () => !signal.aborted && owners.get(browserId) === token
      writes = writes.then(async () => {
        if (!current()) return
        let captureFailure: { error: unknown } | undefined
        if (freeze && applied !== key) {
          try {
            const snapshot = await api.browser.snapshot(browserId)
            if (!current()) return
            // A page already hidden by the previous owner may have no new frame. Keep its placeholder.
            if (snapshot !== null) await onFreeze(snapshot, signal)
          } catch (error) { captureFailure = { error } }
        }
        if (!current()) return
        // A failed capture/decode cannot prevent mandatory occlusion. Report it after attempting
        // to hide, including when setBounds also fails, without caching failed native writes.
        try {
          if (applied !== key) {
            await api.browser.setBounds(browserId, bounds)
            applied = key
          }
          if (bounds !== null && current()) {
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
      const surface = element?.closest<HTMLElement>('[data-content-surface]')
      const surfaceRect = surface?.getBoundingClientRect()
      let bottomLeftRadius = 0
      let bottomRightRadius = 0
      if (rect && surface && surfaceRect && Math.abs(rect.bottom - surfaceRect.bottom) < 1) {
        const style = getComputedStyle(surface)
        if (Math.abs(rect.left - surfaceRect.left) < 1) bottomLeftRadius = parseFloat(style.borderBottomLeftRadius) || 0
        if (Math.abs(rect.right - surfaceRect.right) < 1) bottomRightRadius = parseFloat(style.borderBottomRightRadius) || 0
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
      const bounds = visible && !blocked && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          ...(bottomLeftRadius || bottomRightRadius ? { bottomLeftRadius, bottomRightRadius } : {}) } : null
      const key = JSON.stringify(bounds)
      if (last === key) return
      last = key
      pending?.abort()
      pending = new AbortController()
      enqueue(bounds, visible && blocked && !!rect && rect.width > 0 && rect.height > 0, key, pending.signal)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const observer = new ResizeObserver(schedule)
    if (viewport.current) observer.observe(viewport.current)
    // Ignore streaming text and unrelated row mutations; inspect only overlay roots and their state.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes'
        ? record.attributeName === 'data-surface-reveal' || (record.target instanceof Element && record.target.matches(RELEVANT))
        : [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element &&
          (node.matches(RELEVANT) || node.querySelector(RELEVANT))))) schedule()
    })
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-state', 'hidden', 'style', 'data-surface-reveal'] })
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
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      writes = writes.then(async () => {
        const owner = owners.get(browserId)
        if (!owner || owner === token) await api.browser.setBounds(browserId, null)
      }).catch(onError)
    }
  }, [browserId, visible, viewport, onError, onFreeze])
}

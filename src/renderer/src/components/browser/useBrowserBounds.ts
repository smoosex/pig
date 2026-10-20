/** Native views sit above DOM overlays. One ordered queue owns all renderer visibility transitions. */
import { useLayoutEffect, type RefObject } from 'react'
import type { BrowserBounds } from '../../../../shared/browser'
import { api } from '../../ipc/api'

let writes: Promise<void> = Promise.resolve()
const owners = new Map<string, object>()

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="tooltip-content"], [data-slot="hover-card-content"], [data-radix-popper-content-wrapper]'
const REVEAL = '[data-surface-reveal]'
const RELEVANT = `${OVERLAY}, ${REVEAL}`

export function useBrowserBounds(
  browserId: string,
  visible: boolean,
  viewport: RefObject<HTMLDivElement | null>,
  onError: (error: unknown) => void,
  onFreeze: (frame: string | null) => void
): void {
  useLayoutEffect(() => {
    const token = {}
    if (visible) owners.set(browserId, token)
    let last = ''
    let frame = 0
    const enqueue = (bounds: BrowserBounds | null, hide = false, freeze = false, key?: string) => {
      writes = writes.then(async () => {
        const owner = owners.get(browserId)
        if (hide ? owner && owner !== token : owner !== token) return
        // A failed capture cannot prevent mandatory occlusion. Report it after attempting to hide,
        // including when setBounds also fails; neither IPC failure is translated into success.
        let captureFailure: { error: unknown } | undefined
        if (freeze) {
          try { onFreeze(await api.browser.snapshot(browserId)) }
          catch (error) { captureFailure = { error } }
        }
        try {
          await api.browser.setBounds(browserId, bounds)
          if (!freeze) onFreeze(null)
        } finally {
          if (captureFailure) onError(captureFailure.error)
        }
      }).catch(error => {
        if (key !== undefined && last === key) last = ''
        onError(error)
      })
    }
    const update = () => {
      frame = 0
      const rect = viewport.current?.getBoundingClientRect()
      const blocked = document.documentElement.matches(REVEAL) || [...document.querySelectorAll<HTMLElement>(OVERLAY)]
        .some((element) => {
          const style = getComputedStyle(element)
          if (element.dataset.state === 'closed' || element.hidden || style.display === 'none' || style.visibility === 'hidden') return false
          if (element.matches('[role="dialog"], [role="alertdialog"]')) return true
          const overlay = element.getBoundingClientRect()
          return rect && overlay.width > 0 && overlay.height > 0 && overlay.left < rect.right &&
            overlay.right > rect.left && overlay.top < rect.bottom && overlay.bottom > rect.top
        })
      const bounds = visible && !blocked && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
      const key = JSON.stringify(bounds)
      if (last === key) return
      last = key
      enqueue(bounds, false, visible && blocked && !!rect && rect.width > 0 && rect.height > 0, key)
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
      if (owners.get(browserId) === token) owners.delete(browserId)
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      enqueue(null, true)
    }
  }, [browserId, visible, viewport, onError, onFreeze])
}

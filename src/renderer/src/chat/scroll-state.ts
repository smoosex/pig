import type { VirtualItem } from '@tanstack/react-virtual'

export const TURN_ALIGN = 12
export const SCROLL_END = 32

export type ScrollSnapshot = {
  scrollTop: number
  following: boolean
  width: number
  measurements: VirtualItem[]
  anchor: { key: VirtualItem['key']; offset: number } | null
}

export function captureAnchor(
  items: Array<Pick<VirtualItem, 'key' | 'start' | 'end'>>,
  scrollTop: number
): ScrollSnapshot['anchor'] {
  const hit = items.find((item) => item.start <= scrollTop + TURN_ALIGN && item.end > scrollTop)
  return hit ? { key: hit.key, offset: scrollTop - hit.start } : null
}

export function pruneMeasurements(
  items: VirtualItem[],
  keys: ReadonlySet<VirtualItem['key']>
): VirtualItem[] {
  return items.filter((item) => keys.has(item.key))
}

type ViewportSize = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>
type Bounds = Pick<DOMRect, 'top' | 'bottom'>

function clampOffset(viewport: ViewportSize, offset: number): number {
  return Math.max(0, Math.min(Math.max(0, viewport.scrollHeight - viewport.clientHeight), offset))
}

export function turnScrollOffset(viewport: ViewportSize, bounds: Bounds, target: Bounds): number {
  const toTop = viewport.scrollTop + target.top - bounds.top - TURN_ALIGN
  const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  return clampOffset(
    viewport,
    toTop <= maxScroll + 1
      ? toTop
      : viewport.scrollTop + target.bottom - bounds.bottom + TURN_ALIGN
  )
}

export function restoredScrollOffset(
  viewport: ViewportSize,
  bounds: Bounds,
  target: Bounds,
  offset: number
): number {
  return clampOffset(viewport, viewport.scrollTop + target.top - bounds.top + offset)
}

import type { VirtualItem } from '@tanstack/react-virtual'

export const TURN_ALIGN = 12
export const SCROLL_END = 32

export type ScrollSnapshot = {
  scrollTop: number
  following: boolean
  anchoredMessageId: string | null
  measurements: VirtualItem[]
  anchor: { key: VirtualItem['key']; offset: number } | null
}

export function captureAnchor(
  items: Array<Pick<VirtualItem, 'key' | 'start' | 'end'>>,
  scrollTop: number
): ScrollSnapshot['anchor'] {
  const probe = scrollTop + TURN_ALIGN
  const hit = items.find((item) => item.start <= probe && item.end > probe)
  return hit ? { key: hit.key, offset: scrollTop - hit.start } : null
}

export function pruneMeasurements(
  items: VirtualItem[],
  keys: ReadonlySet<VirtualItem['key']>
): VirtualItem[] {
  return items.filter((item) => keys.has(item.key))
}

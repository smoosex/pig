import type { OpenTab } from '../../stores/sessions/types'
import { tabMentions } from './tab-mentions'

export const TAB_REFERENCE_DROP = 'pig:tab-reference-drop'

export function composerAtPoint(x: number, y: number): Element | null {
  if (typeof document.elementsFromPoint !== 'function') return null
  return document.elementsFromPoint(x, y)[0]?.closest('[data-tab-reference-target]') ?? null
}

export function dropTabReference(target: Element, tab: OpenTab, x: number, y: number, tabs: OpenTab[] = [tab]): void {
  const reference = tabMentions(tabs).find((item) => item.id === tab.id)
  if (reference) target.dispatchEvent(new CustomEvent(TAB_REFERENCE_DROP, { detail: { reference, x, y } }))
}

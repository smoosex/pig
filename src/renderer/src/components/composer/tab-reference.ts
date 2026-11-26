import type { OpenTab } from '../../stores/sessions/types'
import { tabMentions } from './tab-mentions'

export const TAB_REFERENCE_DROP = 'pig:tab-reference-drop'
export const TAB_REFERENCE_DRAG = 'pig:tab-reference-drag'

let hoveredComposer: Element | null = null

export function composerAtPoint(x: number, y: number): Element | null {
  if (typeof document.elementsFromPoint !== 'function') return null
  return document.elementsFromPoint(x, y)[0]?.closest('[data-tab-reference-target]') ?? null
}

export function hoverTabReference(
  target: Element | null,
  tab: OpenTab | null,
  tabs: OpenTab[] = tab ? [tab] : []
): void {
  const reference = target && tab ? (tabMentions(tabs).find((item) => item.id === tab.id) ?? null) : null
  const nextTarget = reference ? target : null
  if (hoveredComposer && hoveredComposer !== nextTarget) {
    hoveredComposer.dispatchEvent(new CustomEvent(TAB_REFERENCE_DRAG, { detail: { reference: null } }))
  }
  hoveredComposer = nextTarget
  if (hoveredComposer && reference) {
    hoveredComposer.dispatchEvent(new CustomEvent(TAB_REFERENCE_DRAG, { detail: { reference } }))
  }
}

export function dropTabReference(target: Element, tab: OpenTab, x: number, y: number, tabs: OpenTab[] = [tab]): void {
  hoverTabReference(null, null)
  const reference = tabMentions(tabs).find((item) => item.id === tab.id)
  if (reference) target.dispatchEvent(new CustomEvent(TAB_REFERENCE_DROP, { detail: { reference, x, y } }))
}

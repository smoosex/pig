/** Pane transitions move rectangle edges; text is never scaled with a FLIP transform. */
export interface PaneRect {
  left: number
  top: number
  width: number
  height: number
}

export function samePaneRect(a: PaneRect | undefined, b: PaneRect): boolean {
  return a?.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

export function collapsedPaneRect(rect: PaneRect, neighbors: readonly PaneRect[]): PaneRect {
  let reference: PaneRect | undefined
  let overlap = 0
  for (const candidate of neighbors) {
    const area = Math.max(0, Math.min(rect.left + rect.width, candidate.left + candidate.width) - Math.max(rect.left, candidate.left)) *
      Math.max(0, Math.min(rect.top + rect.height, candidate.top + candidate.height) - Math.max(rect.top, candidate.top))
    if (area > overlap) { reference = candidate; overlap = area }
  }
  if (!reference) return rect
  const dx = (rect.left + rect.width / 2 - reference.left - reference.width / 2) / Math.max(reference.width, 1)
  const dy = (rect.top + rect.height / 2 - reference.top - reference.height / 2) / Math.max(reference.height, 1)
  return Math.abs(dx) >= Math.abs(dy)
    ? { ...rect, left: dx < 0 ? rect.left : rect.left + rect.width, width: 0 }
    : { ...rect, top: dy < 0 ? rect.top : rect.top + rect.height, height: 0 }
}

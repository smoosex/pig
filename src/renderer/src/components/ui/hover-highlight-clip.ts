/** Rectangle cutouts for a moving decoration; overlapping exclusions must stay hidden, not XOR. */
export type HighlightRect = Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>

export function subtractHighlightRect(rect: HighlightRect, cut: HighlightRect): HighlightRect[] {
  const left = Math.max(rect.left, cut.left)
  const top = Math.max(rect.top, cut.top)
  const right = Math.min(rect.right, cut.right)
  const bottom = Math.min(rect.bottom, cut.bottom)
  if (left >= right || top >= bottom) return [rect]
  return [
    { left: rect.left, top: rect.top, right: rect.right, bottom: top },
    { left: rect.left, top: bottom, right: rect.right, bottom: rect.bottom },
    { left: rect.left, top, right: left, bottom },
    { left: right, top, right: rect.right, bottom }
  ].filter((part) => part.left < part.right && part.top < part.bottom)
}

export function highlightClipPath(area: HighlightRect, exclusions: HighlightRect[]): string {
  const holes: HighlightRect[] = []
  for (const rect of exclusions) {
    const bounded = {
      left: Math.max(area.left, rect.left),
      top: Math.max(area.top, rect.top),
      right: Math.min(area.right, rect.right),
      bottom: Math.min(area.bottom, rect.bottom)
    }
    if (bounded.left >= bounded.right || bounded.top >= bounded.bottom) continue
    let parts = [bounded]
    for (const hole of holes) parts = parts.flatMap((part) => subtractHighlightRect(part, hole))
    holes.push(...parts)
  }
  if (!holes.length) return ''
  const path = (rect: HighlightRect) =>
    `M${rect.left - area.left} ${rect.top - area.top}H${rect.right - area.left}V${rect.bottom - area.top}H${rect.left - area.left}Z`
  return `path(evenodd, "${[area, ...holes].map(path).join(' ')}")`
}

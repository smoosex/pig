/**
 * A shared hover surface glides behind sidebar rows: glass uses 6%/12%, solid uses sidebar-accent.
 * Cutouts keep selection stable and prevent clipped file rows leaking through sticky titles.
 */
import type { ComponentProps } from 'react'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'
import { highlightClipPath, subtractHighlightRect } from '../ui/hover-highlight-clip'

function clipHighlight(area: HTMLElement, target: HTMLElement | null): string {
  const bounds = area.getBoundingClientRect()
  const occlusions = [...area.querySelectorAll<HTMLElement>('[data-sidebar-hover-occlusion]')]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
  const selections = [...area.querySelectorAll<HTMLElement>('[data-sidebar-selected]')].map((row) => {
    const rect = row.getBoundingClientRect()
    // Selected file backgrounds are only painted below their own transparent sticky title.
    const headers = occlusions.filter(({ element }) =>
      element.parentElement!.contains(row) && !element.contains(row)
    )
    return {
      left: rect.left,
      top: Math.max(rect.top, ...headers.map(({ rect: header }) => header.bottom)),
      right: rect.right,
      bottom: rect.bottom
    }
  })
  const headers = occlusions.flatMap(({ element, rect }) =>
    target && element.contains(target)
      ? subtractHighlightRect(rect, target.getBoundingClientRect())
      : [rect]
  )
  return highlightClipPath(bounds, [...selections, ...headers])
}

export function SidebarHoverHighlight(props: ComponentProps<typeof SmoothHoverHighlight>) {
  return (
    <SmoothHoverHighlight
      rowSelector="[data-sidebar-hover-row]"
      activeAttribute="data-sidebar-selected"
      targetAttribute="data-sidebar-hover-target"
      highlightClassName="bg-sidebar-foreground/6 solid:bg-sidebar-accent"
      highlightClip={clipHighlight}
      {...props}
    />
  )
}

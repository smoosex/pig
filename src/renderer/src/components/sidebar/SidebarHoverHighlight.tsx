import type { ComponentProps } from 'react'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'

export function SidebarHoverHighlight(props: ComponentProps<typeof SmoothHoverHighlight>) {
  return (
    <SmoothHoverHighlight
      rowSelector="[data-sidebar-hover-row]"
      targetAttribute="data-sidebar-hover-target"
      highlightClassName="bg-sidebar-accent"
      {...props}
    />
  )
}

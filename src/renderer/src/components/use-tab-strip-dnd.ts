import { useRef, useState } from 'react'
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useSessionsStore } from '../stores/sessions'
import type { OpenTab } from '../stores/sessions/types'

/**
 * Drag order for the tab strip. The strip lists one half of the switcher at a time, so the sequence this
 * works on is that half's visible tabs, and a drop hands over that sequence rearranged.
 *
 * The sensor needs a 6px move to start a drag, so a click still selects and a right click still opens its
 * menu — the same contract the project list holds itself to. A pointer released after a drag is still a
 * click, and it lands on whichever tab the strip moved out from under it, so `clickGuard` is how the strip
 * declines that one: dragging a tab onto another must leave the reader reading the tab they dragged.
 */
export function useTabStripDnd(visibleTabs: OpenTab[]) {
  const reorderTabs = useSessionsStore((state) => state.reorderTabs)
  const [activeId, setActiveId] = useState<string | null>(null)
  const clickGuard = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const activeTab = activeId ? visibleTabs.find((tab) => tab.id === activeId) : undefined

  const clearDrag = () => {
    setActiveId(null)
    requestAnimationFrame(() => {
      clickGuard.current = false
    })
  }

  const handleDragStart = ({ active }: DragStartEvent) => {
    clickGuard.current = true
    setActiveId(String(active.id))
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    clearDrag()
    if (!over || active.id === over.id) return
    const ids = visibleTabs.map((tab) => tab.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    reorderTabs(arrayMove(ids, from, to))
  }

  return {
    sensors,
    activeTab,
    clickGuard,
    handleDragStart,
    handleDragEnd,
    handleDragCancel: clearDrag
  }
}

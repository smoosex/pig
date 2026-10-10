import { useEffect, useRef, useState } from 'react'
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useSessionsStore } from '../stores/sessions'
import {
  collectPaneNodes,
  findPaneNode,
  useSplitLayoutStore,
  type SplitDropPosition
} from '../stores/split-layout'
import type { OpenTab } from '../stores/sessions/types'

export type TabStripDropTarget =
  | 'tab-strip-reintegrate'
  | { paneId: string; position: SplitDropPosition }
  | null

export function computeSplitPosition(rect: DOMRect, clientX: number, clientY: number): SplitDropPosition | null {
  if (rect.width <= 0 || rect.height <= 0 || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
  const relX = (clientX - rect.left) / rect.width
  const relY = (clientY - rect.top) / rect.height

  if (relY < 0.25) return 'top'
  if (relY > 0.75) return 'bottom'
  return relX < 0.5 ? 'left' : 'right'
}

function getSourcePaneId(
  active: { id: string | number; data?: { current?: unknown } } | null | undefined
): string | null {
  if (!active) return null
  const data = active.data?.current as Record<string, unknown> | undefined
  if (data) {
    if (typeof data.sourcePaneId === 'string') return data.sourcePaneId
    if (typeof data.paneId === 'string') return data.paneId
    if (typeof data.fromPaneId === 'string') return data.fromPaneId
    if (data.type === 'pane' || data.isPane || data.fromPane) {
      if (typeof data.id === 'string') return data.id
      if (typeof data.tabId === 'string') {
        const root = useSplitLayoutStore.getState().root
        const matched = collectPaneNodes(root).find((p) => p.tabId === data.tabId)
        if (matched) return matched.id
      }
    }
  }

  const idStr = String(active.id)
  if (idStr.startsWith('pane-') || idStr.startsWith('pane:')) {
    return idStr.slice(5)
  }

  const root = useSplitLayoutStore.getState().root
  const pane = findPaneNode(root, idStr)
  if (pane) {
    return pane.id
  }

  return null
}

function getTabBarElement(): Element | null {
  if (typeof document === 'undefined') return null
  return (
    document.querySelector('[data-tab-strip]') ??
    document.querySelector('.overflow-x-auto') ??
    document.querySelector('.group\\/tab')?.parentElement ??
    null
  )
}

function getTabBarRect(): DOMRect | null {
  const el = getTabBarElement()
  if (el && typeof el.getBoundingClientRect === 'function') {
    return el.getBoundingClientRect()
  }
  return null
}

function isPointerOverTabBar(clientX: number, clientY: number): boolean {
  if (typeof document === 'undefined') return false

  const rect = getTabBarRect()
  if (rect) {
    return (
      clientY >= rect.top &&
      clientY <= rect.bottom &&
      clientX >= rect.left &&
      clientX <= rect.right
    )
  }

  return clientY <= 40
}

/**
 * Drag order for the tab strip. The strip lists one half of the switcher at a time, so the sequence this
 * works on is that half's visible tabs, and a drop hands over that sequence rearranged.
 * Also supports dragging a tab down into the conversation pane to trigger split-screen previews and docking.
 */
export function useTabStripDnd(visibleTabs: OpenTab[], groupedTabIds: Readonly<Record<string, readonly string[]>> = {}) {
  const reorderTabs = useSessionsStore((state) => state.reorderTabs)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<TabStripDropTarget>(null)
  const dropTargetRef = useRef<TabStripDropTarget>(null)
  const sourcePaneIdRef = useRef<string | null>(null)
  const activeDataRef = useRef<Record<string, unknown> | undefined>(undefined)
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const clickGuard = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const activeTab = activeId
    ? visibleTabs.find((tab) => tab.id === activeId) ??
      (() => {
        const root = useSplitLayoutStore.getState().root
        const sourcePaneId =
          sourcePaneIdRef.current ??
          getSourcePaneId({ id: activeId, data: { current: activeDataRef.current } })
        if (sourcePaneId) {
          const pane = findPaneNode(root, sourcePaneId)
          if (pane) {
            return visibleTabs.find((tab) => tab.id === pane.tabId)
          }
        }
        return undefined
      })()
    : undefined

  const clearDrag = () => {
    setActiveId(null)
    dropTargetRef.current = null
    setDropTarget(null)
    sourcePaneIdRef.current = null
    activeDataRef.current = undefined
    lastPointerRef.current = null
    useSplitLayoutStore.getState().setDragOver(null)
    requestAnimationFrame(() => {
      clickGuard.current = false
    })
  }

  useEffect(() => {
    if (!activeId) return

    const handlePointerMove = (e: PointerEvent) => {
      lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY }

      const sourcePaneId =
        sourcePaneIdRef.current ??
        getSourcePaneId({ id: activeId, data: { current: activeDataRef.current } })

      if (isPointerOverTabBar(e.clientX, e.clientY)) {
        if (sourcePaneId) {
          dropTargetRef.current = 'tab-strip-reintegrate'
          setDropTarget('tab-strip-reintegrate')
        } else {
          dropTargetRef.current = null
          setDropTarget(null)
        }
        useSplitLayoutStore.getState().setDragOver(null)
        return
      }

      const tabBarRect = getTabBarRect()
      const tabBarBottom = tabBarRect ? tabBarRect.bottom : 40

      if (e.clientY <= tabBarBottom) {
        if (!sourcePaneId) {
          dropTargetRef.current = null
          setDropTarget(null)
        }
        useSplitLayoutStore.getState().setDragOver(null)
        return
      }

      const elements =
        typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(e.clientX, e.clientY)
          : []
      const tabStripEl = getTabBarElement()

      let paneEl: Element | null = null
      for (const el of elements) {
        if (el.closest?.('[data-tab-strip]') || (tabStripEl && tabStripEl.contains(el))) {
          continue
        }
        const found = el.closest?.('[data-pane-id]')
        if (found && found.getAttribute('data-pane-id')) {
          if (found.closest?.('[data-tab-strip]') || (tabStripEl && tabStripEl.contains(found))) {
            continue
          }
          paneEl = found
          break
        }
      }

      if (!paneEl) {
        const fallbackPane = document.querySelector('[data-pane-id]')
        if (fallbackPane && typeof fallbackPane.getBoundingClientRect === 'function') {
          const rect = fallbackPane.getBoundingClientRect()
          if (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
          ) {
            paneEl = fallbackPane
          }
        }
      }

      const pos = paneEl ? computeSplitPosition(paneEl.getBoundingClientRect(), e.clientX, e.clientY) : null
      if (paneEl && pos) {
        const nextDrop = { paneId: paneEl.getAttribute('data-pane-id')!, position: pos }
        dropTargetRef.current = nextDrop
        setDropTarget(nextDrop)
        useSplitLayoutStore.getState().setDragOver(nextDrop)
      } else {
        dropTargetRef.current = null
        setDropTarget(null)
        useSplitLayoutStore.getState().setDragOver(null)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      useSplitLayoutStore.getState().setDragOver(null)
    }
  }, [activeId])

  const handleDragStart = ({ active }: DragStartEvent) => {
    clickGuard.current = true
    setActiveId(String(active.id))
    activeDataRef.current = active.data?.current as Record<string, unknown> | undefined
    sourcePaneIdRef.current = getSourcePaneId(active)
    lastPointerRef.current = null
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const currentDropTarget = dropTargetRef.current
    const dragOver = useSplitLayoutStore.getState().dragOver
    const root = useSplitLayoutStore.getState().root
    const sourcePaneId = sourcePaneIdRef.current ?? getSourcePaneId(active)

    const targetSplit =
      currentDropTarget && typeof currentDropTarget === 'object'
        ? currentDropTarget
        : dragOver

    const tabBarRect = getTabBarRect()
    const tabBarBottom = tabBarRect ? tabBarRect.bottom : 40
    const isInContentArea = lastPointerRef.current
      ? lastPointerRef.current.clientY > tabBarBottom
      : Boolean(targetSplit)

    if (isInContentArea && targetSplit && active.id) {
      clearDrag()

      const currentActiveTab = useSessionsStore.getState().activeTabId
      const sourceNode = sourcePaneId ? findPaneNode(root, sourcePaneId) : null
      const tabId =
        sourceNode?.tabId ??
        (typeof (active.data?.current as Record<string, unknown> | undefined)?.tabId === 'string'
          ? ((active.data?.current as Record<string, unknown>).tabId as string)
          : String(active.id))

      if (!useSessionsStore.getState().openTabs.some((tab) => tab.id === tabId)) return
      const layout = useSplitLayoutStore.getState()
      const rootPanes = collectPaneNodes(root)
      const layoutVisible = rootPanes.some((pane) => pane.tabId === currentActiveTab)
      let target = layoutVisible ? findPaneNode(root, targetSplit.paneId) : null
      if (!target) {
        // A standalone tab is the visible base, not an old group's focused pane.
        if (currentActiveTab !== targetSplit.paneId || currentActiveTab === tabId ||
          !useSessionsStore.getState().openTabs.some((tab) => tab.id === currentActiveTab) ||
          (layoutVisible && rootPanes.length > 1)) return
        const baseId = layout.initLayout(currentActiveTab)
        target = findPaneNode(useSplitLayoutStore.getState().root, baseId)!
      }
      const source = collectPaneNodes(useSplitLayoutStore.getState().root).find((pane) => pane.tabId === tabId)
      if (source?.id === target.id || target.tabId === tabId) return
      if (source) layout.closePane(source.id)
      layout.splitPane(target.id, tabId, targetSplit.position)
      useSessionsStore.getState().setActive(tabId)
      return
    }

    clearDrag()

    const isOverTop =
      currentDropTarget === 'tab-strip-reintegrate' ||
      Boolean(over && visibleTabs.some((tab) => tab.id === over.id))

    if (sourcePaneId && isOverTop) {
      const sourceNode = findPaneNode(root, sourcePaneId)
      const tabId =
        sourceNode?.tabId ??
        (typeof (active.data?.current as Record<string, unknown> | undefined)?.tabId === 'string'
          ? ((active.data?.current as Record<string, unknown>).tabId as string)
          : undefined)
      if (tabId) {
        useSessionsStore.getState().setActive(tabId)
      }
      useSplitLayoutStore.getState().closePane(sourcePaneId)
      return
    }

    if (!over || active.id === over.id) return
    const ids = visibleTabs.map((tab) => tab.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    reorderTabs(arrayMove(ids, from, to).flatMap((id) => groupedTabIds[id] ?? [id]))
  }

  return {
    sensors,
    activeTab,
    clickGuard,
    dropTarget,
    handleDragStart,
    handleDragEnd,
    handleDragCancel: clearDrag
  }
}

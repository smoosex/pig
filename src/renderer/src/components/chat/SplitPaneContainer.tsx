import {
  Fragment,
  useEffect,
  useRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { X } from 'lucide-react'
import { Group, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels'
import {
  useSplitLayoutStore,
  isSplitNode,
  findPaneNode,
  type LayoutNode,
  type PaneNode
} from '../../stores/split-layout'
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { computeSplitPosition } from '../use-tab-strip-dnd'
import { SplitPaneOverlay } from './SplitPaneOverlay'

export interface SplitPaneContainerProps {
  root?: LayoutNode | null
  className?: string
  renderPane: (node: PaneNode, isActive: boolean) => ReactNode
}

export function SplitPaneContainer({
  root: propRoot,
  className,
  renderPane
}: SplitPaneContainerProps) {
  const t = useT()
  const storeRoot = useSplitLayoutStore((state) => state.root)
  const activePaneId = useSplitLayoutStore((state) => state.activePaneId)
  const setActivePane = useSplitLayoutStore((state) => state.setActivePane)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const dragOver = useSplitLayoutStore((state) => state.dragOver)
  const openTabs = useSessionsStore((state) => state.openTabs)
  const cancelDrag = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cancelDrag.current?.()
    },
    []
  )

  const root = propRoot !== undefined ? propRoot : storeRoot
  if (!root) return null

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>, pane: PaneNode) => {
    if (event.button !== 0) return
    cancelDrag.current?.()
    const { clientX: startX, clientY: startY, pointerId } = event
    let dragging = false

    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', drop)
      window.removeEventListener('pointercancel', cancel)
      useSplitLayoutStore.getState().setReintegratingTab(null)
      useSplitLayoutStore.getState().setDragOver(null)
      cancelDrag.current = null
    }
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) cleanup()
    }
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) > 5)
        dragging = true
      if (!dragging) return
      const layout = useSplitLayoutStore.getState()
      const elements = document.elementsFromPoint(event.clientX, event.clientY)
      if (elements.some((element) => element.closest('[data-tab-strip]'))) {
        layout.setReintegratingTab({ paneId: pane.id, tabId: pane.tabId })
        layout.setDragOver(null)
        return
      }
      layout.setReintegratingTab(null)
      // Only actual leaf panes are targets. The content wrapper and the source are not panes to dock into.
      const target = elements
        .map((element) => element.closest('[data-split-pane]'))
        .find(
          (element) =>
            element &&
            element.getAttribute('data-pane-id') !== pane.id &&
            findPaneNode(layout.root, element.getAttribute('data-pane-id')!)
        )
      const position = target
        ? computeSplitPosition(target.getBoundingClientRect(), event.clientX, event.clientY)
        : null
      layout.setDragOver(
        target && position ? { paneId: target.getAttribute('data-pane-id')!, position } : null
      )
    }
    const drop = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      if (!dragging) {
        cleanup()
        return
      }
      move(event)
      const layout = useSplitLayoutStore.getState()
      const { dragOver, reintegratingTab } = layout
      cleanup()
      // The source may have closed while the pointer was held.
      if (
        !findPaneNode(layout.root, pane.id) ||
        !useSessionsStore.getState().openTabs.some((tab) => tab.id === pane.tabId)
      )
        return
      if (reintegratingTab) {
        layout.closePane(pane.id)
        useSessionsStore.getState().setActive(pane.tabId)
      } else if (
        dragOver &&
        dragOver.paneId !== pane.id &&
        findPaneNode(layout.root, dragOver.paneId)
      ) {
        layout.closePane(pane.id)
        layout.splitPane(dragOver.paneId, pane.tabId, dragOver.position)
        useSessionsStore.getState().setActive(pane.tabId)
      }
    }
    cancelDrag.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', drop)
    window.addEventListener('pointercancel', cancel)
  }

  const renderLayoutNode = (node: LayoutNode): ReactNode => {
    if (isSplitNode(node)) {
      const isVertical = node.direction === 'vertical'
      return (
        <Group
          key={node.id}
          id={node.id}
          orientation={node.direction}
          onLayoutChanged={(layout, meta) => {
            if (!meta.isUserInteraction) return
            const requested = meta.requestedLayout ?? layout
            useSplitLayoutStore.getState().setSplitSizes(
              node.id,
              node.children.map((child) => requested[child.id])
            )
          }}
          className="h-full w-full"
        >
          {node.children.map((child, index) => (
            <Fragment key={child.id}>
              {index > 0 && (
                <PanelResizeHandle
                  className={cn(
                    'transition-colors',
                    isVertical
                      ? 'h-1 w-full cursor-row-resize bg-transparent hover:bg-primary'
                      : 'h-full w-1 cursor-col-resize bg-transparent hover:bg-primary'
                  )}
                />
              )}
              <Panel
                id={child.id}
                defaultSize={`${node.sizes[index]}%`}
                minSize="10%"
                className="h-full w-full min-h-0 min-w-0"
              >
                {renderLayoutNode(child)}
              </Panel>
            </Fragment>
          ))}
        </Group>
      )
    }
    const isActive = activePaneId === node.id
    const isDraggingOver = dragOver?.paneId === node.id
    const paneTab = openTabs.find((tab) => tab.id === node.tabId)
    const tabTitle = paneTab?.title || node.tabId
    return (
      <div
        key={node.id}
        data-split-pane="true"
        data-pane-id={node.id}
        data-active={isActive ? 'true' : 'false'}
        onClick={() => {
          setActivePane(node.id)
          useSessionsStore.getState().setActive(node.tabId)
        }}
        className={cn(
          'relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border shadow-xs transition-[background-color,border-color] duration-200 ease-in-out motion-reduce:transition-none',
          paneTab?.kind === 'project' || paneTab?.kind === 'chat' ? 'bg-transparent solid:bg-card' : 'bg-card',
          isActive ? 'border-primary/80' : 'border-border/60'
        )}
      >
        <div
          data-pane-header="true"
          onPointerDown={(event) => handleHeaderPointerDown(event, node)}
          className="flex h-7 shrink-0 cursor-grab items-center justify-between border-b border-border/40 bg-muted/20 px-2 select-none active:cursor-grabbing"
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {tabTitle}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              closeTab(node.tabId)
            }}
            aria-label={t('sessions.close', { title: tabTitle })}
          >
            <X />
          </Button>
        </div>
        {renderPane(node, isActive)}
        <SplitPaneOverlay position={isDraggingOver ? dragOver.position : null} />
      </div>
    )
  }

  return (
    <div
      className={cn('relative h-full w-full min-h-0 min-w-0 overflow-hidden p-1', className)}
    >
      {renderLayoutNode(root)}
    </div>
  )
}

export default SplitPaneContainer

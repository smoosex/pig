import {
  Fragment,
  useEffect,
  useRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { CircleAlert, X } from 'lucide-react'
import { Group, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels'
import {
  useSplitLayoutStore,
  isSplitNode,
  findPaneNode,
  groupOfPane,
  groupOfTab,
  type LayoutNode,
  type PaneNode
} from '../../stores/split-layout'
import { useSessionsStore, type OpenTab } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { computeSplitPosition } from '../use-tab-strip-dnd'
import { SplitPaneOverlay } from './SplitPaneOverlay'
import { TabContextMenu } from '../TabContextMenu'
import { TabKindIcon } from '../TabKindIcon'
import { SessionRenameField, useSessionRename } from '../SessionRenameField'
import { useProjectAction } from '../sidebar/project-action'

export interface SplitPaneContainerProps {
  /** Any tab in the group to show; the container follows that group as panes move in and out of it. */
  tabId: string
  className?: string
  renderPane: (node: PaneNode, isActive: boolean) => ReactNode
}

export function SplitPaneContainer({
  tabId,
  className,
  renderPane
}: SplitPaneContainerProps) {
  const group = useSplitLayoutStore((state) => groupOfTab(state.groups, tabId))
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

  if (!group) return null
  const { root, activePaneId } = group

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
      // The whole header row takes the pane back: the strip itself shrinks to one merged tab while split.
      if (elements.some((element) => element.closest('[data-app-header]'))) {
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
            findPaneNode(groupOfTab(layout.groups, pane.tabId)?.root ?? null, element.getAttribute('data-pane-id')!)
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
      const current = groupOfPane(layout.groups, pane.id)
      if (
        !current ||
        !useSessionsStore.getState().openTabs.some((tab) => tab.id === pane.tabId)
      )
        return
      if (reintegratingTab) {
        layout.closePane(pane.id)
        useSessionsStore.getState().setActive(pane.tabId)
      } else if (
        dragOver &&
        dragOver.paneId !== pane.id &&
        findPaneNode(current.root, dragOver.paneId)
      ) {
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
          style={{ overflow: 'visible' }}
          className="h-full w-full"
        >
          {node.children.map((child, index) => (
            <Fragment key={child.id}>
              {index > 0 && (
                <PanelResizeHandle
                  className={cn(
                    'group relative flex shrink-0 items-center justify-center bg-transparent',
                    isVertical
                      ? 'h-2 w-full cursor-row-resize'
                      : 'h-full w-2 cursor-col-resize'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'pointer-events-none absolute rounded-full bg-glass-prompt-foreground/10 transition-colors duration-150 group-hover:bg-glass-prompt-foreground/25 group-data-[separator=active]:bg-glass-prompt-foreground/35 group-data-[separator=focus]:bg-glass-prompt-foreground/35 solid:bg-border solid:group-hover:bg-primary/50 solid:group-data-[separator=active]:bg-primary solid:group-data-[separator=focus]:bg-primary motion-reduce:transition-none',
                      isVertical ? 'inset-x-2 h-px' : 'inset-y-2 w-px'
                    )}
                  />
                </PanelResizeHandle>
              )}
              <Panel
                id={child.id}
                defaultSize={`${node.sizes[index]}%`}
                minSize="10%"
                style={{ overflow: 'visible' }}
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
          'relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border shadow-glass-pane transition-[background-color,border-color] duration-200 ease-in-out motion-reduce:transition-none',
          'border-border/60 bg-glass-pane-background bg-(image:--glass-pane-sheen) solid:bg-card solid:bg-none solid:shadow-md'
        )}
      >
        <PaneHeader
          isActive={isActive}
          tab={paneTab}
          tabId={node.tabId}
          title={tabTitle}
          renameValue={paneTab?.title ?? ''}
          onPointerDown={(event) => handleHeaderPointerDown(event, node)}
          onSelect={() => {
            setActivePane(node.id)
            useSessionsStore.getState().setActive(node.tabId)
          }}
          onClose={() => closeTab(node.tabId)}
        />
        {renderPane(node, isActive)}
        <SplitPaneOverlay position={isDraggingOver ? dragOver.position : null} />
      </div>
    )
  }

  return (
    <div
      className={cn('relative h-full w-full min-h-0 min-w-0 overflow-hidden p-2', className)}
    >
      {renderLayoutNode(root)}
    </div>
  )
}

/** Each pane's header owns the right-click actions of the tab it shows. */
function PaneHeader({
  isActive,
  tab,
  tabId,
  title,
  renameValue,
  onPointerDown,
  onSelect,
  onClose
}: {
  isActive: boolean
  tab: OpenTab | undefined
  tabId: string
  title: string
  /** Untitled sessions start renaming from an empty name, never from the id shown as their title. */
  renameValue: string
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onSelect: () => void
  onClose: () => void
}) {
  const t = useT()
  const rename = useSessionRename(tabId, tab?.meta?.path)
  const action = useProjectAction()
  const failure = action.error ?? rename.error ?? undefined
  const header = (
    <div
      data-pane-header="true"
      onPointerDown={rename.editing ? undefined : onPointerDown}
      className={cn(
        'flex h-7 shrink-0 cursor-grab items-center justify-between gap-1.5 border-b border-border/40 px-4 select-none transition-colors duration-200 motion-reduce:transition-none active:cursor-grabbing',
        isActive ? 'bg-glass-prompt-foreground/10 solid:bg-primary/10' : 'bg-muted/20'
      )}
    >
      {tab ? <TabKindIcon kind={tab.kind} path={tab.path} className="text-muted-foreground" /> : null}
      {rename.editing ? (
        <SessionRenameField className="h-5 flex-1 select-text" value={renameValue} onCommit={rename.commit} onCancel={rename.cancel} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{title}</span>
      )}
      {failure ? <CircleAlert role="img" aria-label={failure} className="size-3.5 shrink-0 text-destructive" /> : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        aria-label={t('sessions.close', { title })}
      >
        <X />
      </Button>
    </div>
  )
  if (!tab) return header
  return (
    <TabContextMenu
      tabId={tabId}
      kind={tab.kind}
      action={action}
      editing={rename.editing}
      onRename={() => { onSelect(); rename.start() }}
    >
      {header}
    </TabContextMenu>
  )
}

export default SplitPaneContainer

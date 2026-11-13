/** Stable tab-keyed pane content overlays the resize tree; only lightweight frames animate. */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { CircleAlert, X } from 'lucide-react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { Group, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels'
import {
  useSplitLayoutStore,
  collectPaneNodes,
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
import { collapsedPaneRect, samePaneRect, type PaneRect } from './split-pane-geometry'

export interface SplitPaneContainerProps {
  /** The visible tab; standalone pages and split groups share the same stable content hosts. */
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
  const area = useRef<HTMLDivElement>(null)
  const panes = group ? collectPaneNodes(group.root) : [{ id: tabId, tabId }]
  const measuredPanes = useRef(panes)
  const topology = group ? JSON.stringify(group.root, (key, value) => key === 'sizes' ? undefined : value) : tabId
  const [scene, setScene] = useState<PaneScene>({ rects: {}, previous: {}, topology: '', animate: false })
  const reduced = useReducedMotion()
  useLayoutEffect(() => {
    const element = area.current!
    const slots = [...element.querySelectorAll<HTMLElement>('[data-pane-slot]')]
    let active = true
    const measure = () => {
      if (!active) return
      const bounds = element.getBoundingClientRect()
      const rects = Object.fromEntries(slots.map(slot => {
        const rect = slot.getBoundingClientRect()
        return [slot.dataset.paneSlot!, { left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height }]
      }))
      setScene(current => {
        const ids = Object.keys(rects)
        for (const id of ids) if (samePaneRect(current.rects[id], rects[id])) rects[id] = current.rects[id]
        if (current.topology === topology && ids.length === Object.keys(current.rects).length &&
          ids.every(id => rects[id] === current.rects[id])) return current
        return { rects, previous: current.rects, topology,
          animate: current.topology !== topology && Object.keys(rects).some(id => current.rects[id]) }
      })
    }
    // Panel registration causes nested synchronous commits. Reading inside the parent layout
    // effect catches a temporary flex layout and briefly animates an otherwise untouched pane.
    let queued = false
    const schedule = () => {
      if (!active || queued) return
      queued = true
      queueMicrotask(() => { queued = false; measure() })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    for (const slot of slots) observer.observe(slot)
    schedule()
    return () => { active = false; observer.disconnect() }
  }, [group?.root, tabId, topology])
  useLayoutEffect(() => {
    if (scene.topology === topology) measuredPanes.current = panes
  })
  const cancelDrag = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cancelDrag.current?.()
    },
    []
  )

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
        const survivor = layout.closePane(pane.id)
        if (survivor) useSessionsStore.getState().setActive(survivor)
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
    return <div data-pane-slot={node.tabId} className="h-full w-full" />
  }

  const renderFrame = (node: PaneNode) => {
    const isActive = !group || group.activePaneId === node.id
    const isDraggingOver = dragOver?.paneId === node.id
    const paneTab = openTabs.find((tab) => tab.id === node.tabId)
    const tabTitle = paneTab?.title || node.tabId
    const rect = scene.rects[node.tabId] ?? { left: 0, top: 0, width: 0, height: 0 }
    return (
      <PaneFrame key={node.tabId} paneId={node.id} isActive={isActive} rect={rect} scene={scene}
        animate={scene.animate && !samePaneRect(scene.previous[node.tabId], rect) && !reduced}
        entering={!scene.previous[node.tabId]} split={Boolean(group)} native={paneTab?.kind === 'browser'}
        onSelect={() => {
          if (!group) return
          setActivePane(node.id)
          useSessionsStore.getState().setActive(node.tabId)
        }}>
        <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden">
        {group ? <PaneHeader
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
        /> : null}
        {renderPane(node, isActive)}
        <SplitPaneOverlay position={isDraggingOver ? dragOver.position : null} />
      </div>
      </PaneFrame>
    )
  }

  return (
    <div ref={area}
      className={cn('relative h-full w-full min-h-0 min-w-0 overflow-hidden', group && 'p-2', className)}
    >
      {group ? renderLayoutNode(group.root) : <div data-pane-slot={tabId} className="h-full w-full" />}
      <AnimatePresence initial={false} custom={{ ...scene, animate: scene.animate && !reduced }}>
        {(scene.topology === topology ? panes : measuredPanes.current).filter(node => scene.rects[node.tabId]).map(renderFrame)}
      </AnimatePresence>
    </div>
  )
}

interface PaneScene {
  rects: Record<string, PaneRect>
  previous: Record<string, PaneRect>
  topology: string
  animate: boolean
}

/** Content stays a flat, tab-keyed sibling while the resize tree only measures empty slots. */
function PaneFrame({ paneId, isActive, rect, scene, animate, entering, split, native, onSelect, children }: {
  paneId: string; isActive: boolean; rect: PaneRect; scene: PaneScene; animate: boolean; entering: boolean; split: boolean;
  native: boolean; onSelect: () => void; children: ReactNode
}) {
  const present = useIsPresent()
  const initial = animate ? collapsedPaneRect(rect, Object.values(scene.previous)) : rect
  // Existing content follows its frame continuously. Only incoming/exiting DOM content clips a
  // fixed viewport; native browser views must always track their actual bounds.
  const clip = !native && ((entering && animate) || !present)
  const right = entering && initial.left !== rect.left
  const bottom = entering && initial.top !== rect.top
  return <motion.div data-pane-frame data-pane-id={paneId} data-split-pane={split ? 'true' : undefined}
    data-active={isActive ? 'true' : 'false'} onClick={onSelect}
    initial={animate ? { ...initial } : false}
    animate={{ ...rect, transition: { duration: animate ? 0.2 : 0, ease: [0.22, 1, 0.36, 1] } }}
    variants={{ exit: (next: PaneScene) => ({
      ...collapsedPaneRect(rect, Object.values(next.rects)), transition: { duration: next.animate ? 0.2 : 0 }
    }) }}
    exit="exit"
    inert={!present || undefined} aria-hidden={!present || undefined}
    className={cn('absolute min-h-0 min-w-0 overflow-hidden transition-[background-color,border-color] duration-200 motion-reduce:transition-none',
      split && 'rounded-lg border border-border/60 bg-glass-pane-background bg-(image:--glass-pane-sheen) shadow-glass-pane solid:bg-card solid:bg-none solid:shadow-md')}>
    <div className="absolute top-0 left-0 h-full w-full" style={clip ? {
      width: Math.max(0, rect.width - (split ? 2 : 0)), height: Math.max(0, rect.height - (split ? 2 : 0)),
      left: right ? 'auto' : 0, right: right ? 0 : undefined,
      top: bottom ? 'auto' : 0, bottom: bottom ? 0 : undefined
    } : undefined}>{children}</div>
  </motion.div>
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

import { useState, type HTMLAttributes, type Ref } from 'react'
import { ArrowUpToLine, CircleAlert, Dog, Download, FileDiff, LoaderCircle, PenLine, Plus } from 'lucide-react'
import { closestCenter, DndContext, DragOverlay } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useSessionsStore } from '../stores/sessions'
import { api } from '../ipc/api'
import { useProjectAction } from './sidebar/project-action'
import type { OpenTab } from '../stores/sessions'
import { fileKey, isDirty, useFilesStore } from '../stores/files'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from './ui/context-menu'
import { SessionRenameField, useSessionRename } from './SessionRenameField'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'
import { CloseButton } from './CloseButton'
import { FileTypeIcon } from './files/FileTypeIcon'
import type { SidebarTab } from '../../../shared/api'
import { stripShowsChats, visibleTabsFor } from './tab-strip'
import { useTabStripDnd } from './use-tab-strip-dnd'
import { useSplitLayoutStore, collectPaneNodes } from '../stores/split-layout'

/** The strip follows the sidebar switcher, not the workspace: the projects half lists the open
 * worktree's tabs, the chats half the chats, and outside a project it falls back to chats. */
export function TabBar({ sidebarTab }: { sidebarTab: SidebarTab }) {
  const t = useT()
  const openTabs = useSessionsStore((state) => state.openTabs)
  const activeTabId = useSessionsStore((state) => state.activeTabId)
  const currentProjectCwd = useSessionsStore((state) => state.currentProjectCwd)
  const workspaceError = useSessionsStore((state) => state.workspaceError)
  const setActive = useSessionsStore((state) => state.setActive)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const newSession = useSessionsStore((state) => state.newSession)
  const newChat = useSessionsStore((state) => state.newChat)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const root = useSplitLayoutStore((state) => state.root)
  const activePaneId = useSplitLayoutStore((state) => state.activePaneId)
  const reintegratingTab = useSplitLayoutStore((state) => state.reintegratingTab)
  const ghostTab = reintegratingTab
    ? openTabs.find((t) => t.id === reintegratingTab.tabId)
    : undefined

  const paneNodes = root ? collectPaneNodes(root) : []
  const isMultiPane = paneNodes.length > 1
  const splitTabIds = paneNodes.map((p) => p.tabId)
  const splitTabIdSet = new Set(splitTabIds)

  const visibleTabs = visibleTabsFor(openTabs, sidebarTab, currentProjectCwd)

  const uniqueSplitTabs: OpenTab[] = []
  if (isMultiPane) {
    for (const p of paneNodes) {
      const tab = openTabs.find((t) => t.id === p.tabId)
      if (tab && !uniqueSplitTabs.some((u) => u.id === tab.id)) {
        uniqueSplitTabs.push(tab)
      }
    }
  }

  const splitVisibleTabs = visibleTabs.filter((tab) => splitTabIdSet.has(tab.id))
  const isSplit = isMultiPane && splitVisibleTabs.length > 0
  const activePane = paneNodes.find((p) => p.id === activePaneId)
  const focusedTabId = activePane?.tabId ?? activeTabId
  const representativeTab = isSplit
    ? (splitVisibleTabs.find((tab) => tab.id === focusedTabId) ?? splitVisibleTabs[0])
    : undefined

  const combinedTitle = uniqueSplitTabs.length > 0
    ? uniqueSplitTabs.map((t) => t.title).join(' / ')
    : ''
  const splitDogCount = isSplit ? Math.max(2, uniqueSplitTabs.length) : undefined

  let displayTabs: OpenTab[] = visibleTabs
  if (isSplit && representativeTab) {
    let representativePlaced = false
    displayTabs = []
    for (const tab of visibleTabs) {
      if (splitTabIdSet.has(tab.id)) {
        if (!representativePlaced) {
          displayTabs.push(representativeTab)
          representativePlaced = true
        }
      } else {
        displayTabs.push(tab)
      }
    }
  }

  const { sensors, activeTab, clickGuard, handleDragStart, handleDragEnd, handleDragCancel } =
    useTabStripDnd(displayTabs, representativeTab
      ? { [representativeTab.id]: splitVisibleTabs.map((tab) => tab.id) }
      : {})
  // The pointer released at the end of a drag belongs to whatever tab the strip moved under it, so that
  // one click is not a selection; a click that never moved the tab still is.
  const selectTab = (tabId: string) => {
    if (clickGuard.current) return
    setActive(tabId)
    const { root, setActivePane } = useSplitLayoutStore.getState()
    if (root) {
      const paneNodes = collectPaneNodes(root)
      const existingPane = paneNodes.find((p) => p.tabId === tabId)
      if (existingPane) {
        setActivePane(existingPane.id)
      }
    }
  }

  const createTab = async () => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    try {
      // The button makes whatever the strip is listing, so the projects half only creates a session
      // once there is a worktree for it to belong to.
      if (stripShowsChats(sidebarTab, currentProjectCwd)) await newChat()
      else if (currentProjectCwd) await newSession(currentProjectCwd)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-1 items-stretch transition-colors',
        reintegratingTab && 'bg-primary/5 ring-1 ring-inset ring-primary/30 rounded-md'
      )}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        autoScroll={{ threshold: { x: 0.15, y: 0.15 } }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={displayTabs.map((tab) => tab.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {displayTabs.map((tab) => {
              const isCombined = isSplit && tab.id === representativeTab?.id
              return (
                <Tab
                  key={tab.id}
                  tabId={tab.id}
                  cwd={tab.cwd}
                  title={isCombined ? combinedTitle : tab.title}
                  kind={tab.kind}
                  path={tab.path}
                  sessionPath={tab.meta?.path}
                  active={
                    isCombined
                      ? Boolean(activeTabId && splitTabIdSet.has(activeTabId))
                      : tab.id === activeTabId
                  }
                  loading={
                    isCombined
                      ? uniqueSplitTabs.some((t) => t.loadState === 'opening')
                      : tab.loadState === 'opening'
                  }
                  error={
                    isCombined
                      ? uniqueSplitTabs.find((t) => t.loadState === 'error')?.loadError
                      : (tab.loadState === 'error' ? tab.loadError : undefined)
                  }
                  splitDogCount={isCombined ? splitDogCount : undefined}
                  splitTabIds={isCombined ? splitTabIds : undefined}
                  onSelect={() => selectTab(tab.id)}
                  onClose={() => {
                    // The same released pointer can land on the neighbour's close slot, which the drag it
                    // just ended has revealed by hovering it: that click closes nothing.
                    if (clickGuard.current) return
                    if (isCombined) {
                      for (const splitTab of uniqueSplitTabs) {
                        closeTab(splitTab.id)
                      }
                      useSplitLayoutStore.getState().reset()
                    } else {
                      closeTab(tab.id)
                    }
                  }}
                />
              )
            })}
            {reintegratingTab ? (
              <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-primary/60 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary animate-pulse select-none">
                <ArrowUpToLine className="size-3.5" />
                <span>{ghostTab?.title ?? t('tabBar.reintegrate')}</span>
              </div>
            ) : null}
          </div>
        </SortableContext>
        {/* The floating tab is drawn outside the strip, so its width follows the name rather than the
            strip's limit: a tab held in the hand should say what it is. `w-max` is what lets it outgrow
            the overlay's own box, which is measured from the tab the pointer grabbed. */}
        <DragOverlay dropAnimation={null} className="pointer-events-none">
          {activeTab ? (
            <TabFace
              label={isSplit && activeTab.id === representativeTab?.id ? combinedTitle : activeTab.title}
              kind={activeTab.kind}
              path={activeTab.path}
              splitDogCount={isSplit && activeTab.id === representativeTab?.id ? splitDogCount : undefined}
              dragging
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <div className="no-drag relative flex shrink-0 items-center gap-0.5 px-1.5 before:absolute before:top-2 before:bottom-2 before:left-0 before:w-px before:bg-border">
        {workspaceError ? (
          <span title={workspaceError} role="alert" className="text-destructive">
            <CircleAlert />
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('tabBar.new')}
          aria-busy={creating}
          title={createError ?? t('tabBar.new')}
          disabled={creating}
          onClick={() => void createTab()}
        >
          {creating ? (
            <LoaderCircle className="animate-spin" />
          ) : createError ? (
            <CircleAlert className="text-destructive" />
          ) : (
            <Plus />
          )}
        </Button>
      </div>
    </div>
  )
}

interface TabFaceProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  label: string
  kind: OpenTab['kind']
  path?: string
  active?: boolean
  loading?: boolean
  dirty?: boolean
  streaming?: boolean
  /** The floating copy: no pointer affordances, wider name, and it keeps its own background. */
  dragging?: boolean
  editing?: boolean
  error?: string
  splitDogCount?: number
  onSelect?: () => void
  onClose?: () => void
  onRenameCommit?: (name: string) => void
  onRenameCancel?: () => void
  ref?: Ref<HTMLDivElement>
}

/**
 * One tab's face, holding no store hooks of its own: the strip draws it in place, the drag overlay draws
 * it floating above the window. `title` is the tooltip, which is why the tab's own name is `label`.
 */
function TabFace({
  label,
  kind,
  path,
  active = false,
  loading = false,
  dirty = false,
  streaming = false,
  dragging = false,
  editing = false,
  error,
  splitDogCount,
  className,
  onSelect,
  onClose,
  onRenameCommit,
  onRenameCancel,
  ref,
  ...rest
}: TabFaceProps) {
  const t = useT()
  return (
    <div
      ref={ref}
      className={cn(
        'close-reveal group/tab no-drag relative flex touch-none select-none items-center gap-1.5 px-2.5 py-1.5 text-xs whitespace-nowrap after:absolute after:top-2 after:right-0 after:bottom-2 after:w-px after:bg-border last:after:hidden',
        // The floating copy is the tab held in the hand, not the tab the pane is showing: it keeps the
        // card background so it reads above the strip, but not the active underline, which on a ghost
        // would claim the tab had become the selection while it is still in the air.
        dragging
          ? 'pointer-events-none w-max rounded-t bg-card text-foreground shadow-md'
          : [
            'cursor-pointer',
            active
              ? 'bg-card text-foreground before:absolute before:right-2 before:bottom-0 before:left-2 before:h-0.5 before:bg-primary'
              : 'text-muted-foreground'
          ],
        className
      )}
      onClick={onSelect}
      {...rest}
    >
      <span
        className={cn(
          'group/close-slot relative flex shrink-0 items-center justify-center',
          splitDogCount && splitDogCount > 1 ? 'h-6 min-w-6' : 'size-6'
        )}
      >
        {splitDogCount && splitDogCount > 1 ? (
          <span className="flex items-center transition-opacity group-hover/tab:opacity-0 group-focus-within/close-slot:opacity-0">
            {Array.from({ length: splitDogCount }).map((_, index) => (
              <Dog
                key={index}
                className={cn('size-3.5', index > 0 && '-ml-1.5')}
                aria-hidden
              />
            ))}
          </span>
        ) : kind === 'diff' ? (
          <FileDiff className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/close-slot:opacity-0" aria-hidden />
        ) : kind === 'file' ? (
          <FileTypeIcon path={path ?? ''} className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/close-slot:opacity-0" />
        ) : (
          <Dog className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/close-slot:opacity-0" aria-hidden />
        )}
        {onClose ? (
          <CloseButton
            streaming={streaming}
            ariaLabel={t('sessions.close', { title: label })}
            className="no-drag transition-opacity group-hover/tab:opacity-100 group-focus-within/close-slot:opacity-100 text-muted-foreground hover:text-foreground"
            onClose={onClose}
          />
        ) : null}
      </span>
      {editing && onRenameCommit && onRenameCancel ? (
        <SessionRenameField
          // The tab cannot be selected text, since dragging it is; the name being typed is the exception.
          className="h-5 w-35 select-text"
          value={label}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <span className={dragging || (splitDogCount && splitDogCount > 1) ? 'max-w-60 truncate' : 'max-w-35 truncate'}>{label}</span>
      )}
      {dirty ? <span role="img" aria-label={t('tabBar.unsaved')} className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
      {loading ? <LoaderCircle className="animate-spin" aria-label={t('tabBar.loading')} /> : null}
      {error ? <CircleAlert role="img" aria-label={error} className="size-3.5 shrink-0 text-destructive" /> : null}
    </div>
  )
}

function Tab({
  tabId,
  cwd,
  title,
  kind,
  path,
  sessionPath,
  active,
  loading,
  error,
  splitDogCount,
  splitTabIds,
  onSelect,
  onClose
}: {
  tabId: string
  cwd: string
  title: string
  kind: OpenTab['kind']
  path?: string
  sessionPath?: string
  active: boolean
  loading: boolean
  error?: string
  splitDogCount?: number
  splitTabIds?: string[]
  onSelect: () => void
  onClose: () => void
}) {
  const streaming = useSessionsStore((state) => {
    if (splitTabIds && splitTabIds.length > 0) {
      return splitTabIds.some((id) => state.runtime[id]?.isStreaming ?? false)
    }
    return state.runtime[tabId]?.isStreaming ?? false
  })
  const t = useT()
  const dirty = useFilesStore((state) => {
    const document = path ? state.documents[fileKey(cwd, path)] : undefined
    return document ? isDirty(document) : false
  })
  const rename = useSessionRename(tabId, sessionPath)
  const { pending, error: exportError, runAction } = useProjectAction()
  // A changes or file tab holds no session, so there is no name to write for it.
  const renamable = kind === 'project' || kind === 'chat'
  const failure = error ?? exportError ?? rename.error ?? undefined
  // Only the pointer listeners are handed to the face, not dnd-kit's `attributes`: those make a tab
  // focusable and role="button", and a drag that answers to no key would then be reachable by keyboard
  // and dead. The 6px activation distance is what keeps a click selecting and a right click opening its
  // menu; a tab being renamed cannot be dragged at all, since selecting its text is itself a pointer move.
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tabId, disabled: rename.editing })
  const body = (
    <TabFace
      ref={setNodeRef}
      {...(listeners as unknown as HTMLAttributes<HTMLDivElement>)}
      className={cn(isDragging && 'opacity-40')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      label={title}
      kind={kind}
      path={path}
      active={active}
      loading={loading}
      dirty={dirty}
      streaming={streaming}
      splitDogCount={splitDogCount}
      editing={rename.editing}
      error={failure}
      title={failure ?? title}
      onSelect={onSelect}
      onClose={onClose}
      onRenameCommit={rename.commit}
      onRenameCancel={rename.cancel}
    />
  )

  if (!renamable) return body
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={rename.editing}>
        {body}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={rename.start}>
          <PenLine data-icon="inline-start" />
          {t('common.rename')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={pending !== null}
          onSelect={() => void runAction('export', () => api.exportSession(tabId))}
        >
          <Download data-icon="inline-start" />
          {t('sessions.export')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

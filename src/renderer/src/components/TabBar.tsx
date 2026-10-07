import { useState, type HTMLAttributes, type Ref } from 'react'
import { CircleAlert, Download, FileDiff, LoaderCircle, PenLine, Plus, SquareText } from 'lucide-react'
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
  const visibleTabs = visibleTabsFor(openTabs, sidebarTab, currentProjectCwd)
  const { sensors, activeTab, clickGuard, handleDragStart, handleDragEnd, handleDragCancel } =
    useTabStripDnd(visibleTabs)
  // The pointer released at the end of a drag belongs to whatever tab the strip moved under it, so that
  // one click is not a selection; a click that never moved the tab still is.
  const selectTab = (tabId: string) => {
    if (clickGuard.current) return
    setActive(tabId)
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
    <div className="flex h-full min-w-0 flex-1 items-stretch">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        autoScroll={{ threshold: { x: 0.15, y: 0.15 } }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={visibleTabs.map((tab) => tab.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleTabs.map((tab) => (
              <Tab
                key={tab.id}
                tabId={tab.id}
                cwd={tab.cwd}
                title={tab.title}
                kind={tab.kind}
                path={tab.path}
                sessionPath={tab.meta?.path}
                active={tab.id === activeTabId}
                loading={tab.loadState === 'opening'}
                error={tab.loadState === 'error' ? tab.loadError : undefined}
                onSelect={() => selectTab(tab.id)}
                onClose={() => {
                  // The same released pointer can land on the neighbour's close slot, which the drag it
                  // just ended has revealed by hovering it: that click closes nothing.
                  if (clickGuard.current) return
                  closeTab(tab.id)
                }}
              />
            ))}
          </div>
        </SortableContext>
        {/* The floating tab is drawn outside the strip, so its width follows the name rather than the
            strip's limit: a tab held in the hand should say what it is. `w-max` is what lets it outgrow
            the overlay's own box, which is measured from the tab the pointer grabbed. */}
        <DragOverlay dropAnimation={null}>
          {activeTab ? <TabFace label={activeTab.title} kind={activeTab.kind} path={activeTab.path} dragging /> : null}
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
          ? 'w-max rounded-t bg-card text-foreground shadow-md'
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
      <span className="group/close-slot relative flex size-6 shrink-0 items-center justify-center">
        {kind === 'diff' ? (
          <FileDiff className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/close-slot:opacity-0" aria-hidden />
        ) : kind === 'file' ? (
          <FileTypeIcon path={path ?? ''} className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/close-slot:opacity-0" />
        ) : (
          <SquareText className="size-3.5 transition-opacity group-hover/tab:opacity-0 group-focus-within/close-slot:opacity-0" aria-hidden />
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
        <span className={dragging ? 'max-w-60 truncate' : 'max-w-35 truncate'}>{label}</span>
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
  onSelect: () => void
  onClose: () => void
}) {
  const streaming = useSessionsStore((state) => state.runtime[tabId]?.isStreaming ?? false)
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
      editing={rename.editing}
      error={failure}
      title={failure}
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

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type Ref } from 'react'
import { ArrowUpToLine, CircleAlert, Globe, LoaderCircle, Plus, LayoutPanelLeft, SquareDashedText, SquareTerminal } from 'lucide-react'
import { closestCenter, DndContext, DragOverlay } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useSessionsStore } from '../stores/sessions'
import { useProjectAction } from './sidebar/project-action'
import type { OpenTab } from '../stores/sessions'
import { fileKey, isDirty, useFilesStore } from '../stores/files'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuShortcut } from './ui/dropdown-menu'
import { TabContextMenu } from './TabContextMenu'
import { SessionRenameField, useSessionRename } from './SessionRenameField'
import { cn } from '../lib/utils'
import { shortcutText, useShortcut } from '../lib/shortcuts'
import { useT } from '../hooks/useT'
import { CloseButton } from './CloseButton'
import { TabKindIcon } from './TabKindIcon'
import type { SidebarTab } from '../../../shared/api'
import { stripShowsChats, stripSlots, visibleTabsFor } from './tab-strip'
import { useTabStripDnd } from './use-tab-strip-dnd'
import { collapseLeavingTab, interleave, useTabStripMotion, type LeavingTab } from './use-tab-strip-motion'
import { useSplitLayoutStore, allPanes, paneOfTab } from '../stores/split-layout'

/** The strip follows the sidebar switcher, not the workspace: the projects half lists the open
 * worktree's tabs, the chats half the chats, and outside a project it falls back to chats. */
export function TabBar({ sidebarTab }: { sidebarTab: SidebarTab }) {
  const t = useT()
  const openTabs = useSessionsStore((state) => state.openTabs)
  const activeTabId = useSessionsStore((state) => state.activeTabId)
  const currentProjectCwd = useSessionsStore((state) => state.currentProjectCwd)
  const setActive = useSessionsStore((state) => state.setActive)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const tabListRef = useRef<HTMLDivElement>(null)
  const revealActiveTab = useCallback(() => {
    tabListRef.current?.querySelector<HTMLElement>('[data-tab-active]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    })
  }, [])

  const groups = useSplitLayoutStore((state) => state.groups)
  const reintegratingTab = useSplitLayoutStore((state) => state.reintegratingTab)
  const ghostTab = reintegratingTab
    ? openTabs.find((t) => t.id === reintegratingTab.tabId)
    : undefined

  const visibleTabs = visibleTabsFor(openTabs, sidebarTab, currentProjectCwd)

  const splitTabIdSet = new Set(allPanes(groups).map((pane) => pane.tabId))
  const slots = stripSlots(visibleTabs, groups)
  const merges = new Map<string, MergedTab>()
  for (const { tabId, group } of slots) {
    if (!group) continue
    const tabs = group.paneTabIds.flatMap((id) => openTabs.find((tab) => tab.id === id) ?? [])
    merges.set(tabId, {
      paneTabIds: group.paneTabIds,
      memberIds: group.memberIds,
      tabs,
      title: tabs.map((tab) => tab.title).join(' / '),
      merged: tabs.length > 1
    })
  }
  const displayTabs: OpenTab[] = slots.map((slot) => openTabs.find((item) => item.id === slot.tabId)!)

  // One face per strip slot, shared by the live tab and the copy that collapses when it closes.
  const entries = displayTabs.map((tab) => {
    const merge = merges.get(tab.id)
    return {
      key: tab.id,
      tab,
      merge,
      snapshot: {
        label: merge ? merge.title : tab.title,
        kind: tab.kind,
        path: tab.path,
        active: merge ? Boolean(activeTabId && merge.paneTabIds.includes(activeTabId)) : tab.id === activeTabId,
        split: Boolean(merge?.merged)
      } satisfies LeavingSnapshot
    }
  })
  const { leaving, finishLeaving } = useTabStripMotion<LeavingSnapshot>({
    listRef: tabListRef,
    context: `${sidebarTab}\n${currentProjectCwd ?? ''}`,
    entries,
    still: splitTabIdSet,
    onEntered: revealActiveTab
  })

  // Runs after the motion hook has started any entry: a tab still growing is revealed once it has its
  // width, by its transitionend or its entry's finish, instead of scrolling twice.
  useLayoutEffect(() => {
    if (tabListRef.current?.querySelector('[data-tab-active]')?.getAnimations().length) return
    revealActiveTab()
  }, [activeTabId, currentProjectCwd, sidebarTab, displayTabs.map((tab) => tab.id).join('\n'), revealActiveTab])

  const { sensors, activeTab, clickGuard, handleDragStart, handleDragEnd, handleDragCancel } =
    useTabStripDnd(displayTabs, Object.fromEntries([...merges].map(([id, merge]) => [id, merge.memberIds])))
  // The pointer released at the end of a drag belongs to whatever tab the strip moved under it, so that
  // one click is not a selection; a click that never moved the tab still is.
  const selectTab = (tabId: string) => {
    if (clickGuard.current) return
    setActive(tabId)
    const { groups, setActivePane } = useSplitLayoutStore.getState()
    const pane = paneOfTab(groups, tabId)
    if (pane) setActivePane(pane.id)
  }

  return (
    <div
      data-tab-strip="true"
      className={cn(
        'flex h-8 w-max max-w-full min-w-0 items-stretch',
        (displayTabs.length > 0 || reintegratingTab) && 'no-drag',
        reintegratingTab && 'rounded-full ring-1 ring-inset ring-primary/30'
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
          <div
            ref={tabListRef}
            data-session-tab-list
            onTransitionEnd={(event) => {
              if (event.propertyName === 'flex-basis' && (event.target as Element).hasAttribute('data-tab-active')) revealActiveTab()
            }}
            className={cn(
              'flex min-w-0 flex-1 items-stretch overflow-x-auto rounded-full p-0.5 transition-[background-color] duration-200 ease-in-out motion-reduce:transition-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
              (displayTabs.length > 0 || leaving.length > 0 || reintegratingTab) && 'bg-glass-tab-bar-background solid:bg-tab-bar-background'
            )}
          >
            {interleave(entries, (entry) => entry.key, leaving).map((slot) => {
              if ('leaving' in slot) {
                const ghost = slot.leaving
                return <LeavingTabFace key={`leaving:${ghost.key}`} ghost={ghost} onDone={() => finishLeaving(ghost.key)} />
              }
              const { tab, merge, snapshot } = slot.item
              return (
                <Tab
                  key={tab.id}
                  tabId={tab.id}
                  cwd={tab.cwd}
                  title={snapshot.label}
                  kind={tab.kind}
                  path={tab.path}
                  sessionPath={tab.meta?.path}
                  active={snapshot.active}
                  loading={
                    merge
                      ? merge.tabs.some((t) => t.loadState === 'opening')
                      : tab.loadState === 'opening'
                  }
                  error={
                    merge
                      ? merge.tabs.find((t) => t.loadState === 'error')?.loadError
                      : (tab.loadState === 'error' ? tab.loadError : undefined)
                  }
                  split={snapshot.split}
                  splitTabIds={merge?.paneTabIds}
                  onSelect={() => selectTab(tab.id)}
                  onClose={() => {
                    // The same released pointer can land on the neighbour's close slot, which the drag it
                    // just ended has revealed by hovering it: that click closes nothing.
                    if (clickGuard.current) return
                    if (merge) {
                      for (const splitTab of merge.tabs) closeTab(splitTab.id)
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
              label={merges.get(activeTab.id)?.title ?? activeTab.title}
              kind={activeTab.kind}
              path={activeTab.path}
              split={Boolean(merges.get(activeTab.id)?.merged)}
              dragging
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

/** A session of whatever the strip is listing: the projects half needs a worktree for it to belong to. */
export async function newStripSession(sidebarTab: SidebarTab): Promise<void> {
  const { currentProjectCwd, newChat, newSession } = useSessionsStore.getState()
  if (stripShowsChats(sidebarTab, currentProjectCwd)) await newChat()
  else if (currentProjectCwd) await newSession(currentProjectCwd)
}

export function NewTabButton({ sidebarTab }: { sidebarTab: SidebarTab }) {
  const t = useT()
  const currentProjectCwd = useSessionsStore((state) => state.currentProjectCwd)
  const workspaceError = useSessionsStore((state) => state.workspaceError)
  const openBrowserTab = useSessionsStore((state) => state.openBrowserTab)
  const openTerminalTab = useSessionsStore((state) => state.openTerminalTab)
  const newTabShortcut = useShortcut('tab.new')
  const creatingRef = useRef(false)
  // A picked item hands focus to the new tab; only a dismissed menu returns it to the trigger.
  const pickedRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const createTab = async (kind: 'session' | 'browser' | 'terminal') => {
    pickedRef.current = true
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      // The button makes whatever the strip is listing, so the projects half only creates a session
      // once there is a worktree for it to belong to.
      if (kind === 'browser') await openBrowserTab(stripShowsChats(sidebarTab, currentProjectCwd) ? null : currentProjectCwd)
      else if (kind === 'terminal') openTerminalTab(stripShowsChats(sidebarTab, currentProjectCwd) ? null : currentProjectCwd)
      else await newStripSession(sidebarTab)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  return (
    <div className="no-drag flex shrink-0 items-center gap-0.5">
      {workspaceError ? (
        <span title={workspaceError} role="alert" className="text-destructive">
          <CircleAlert />
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            data-new-tab
            type="button"
            variant="ghost"
            size="icon-sm"
            className="translate-y-px rounded-full text-glass-prompt-foreground hover:bg-glass-prompt-foreground/8! hover:text-inherit solid:text-foreground solid:hover:bg-tab-hover-background!"
            aria-label={t('tabBar.new')}
            aria-busy={creating}
            title={createError ?? t('tabBar.new')}
            disabled={creating}
          >
            {creating ? (
              <LoaderCircle className="animate-spin" />
            ) : createError ? (
              <CircleAlert className="text-destructive" />
            ) : (
              <Plus />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (pickedRef.current) event.preventDefault()
            pickedRef.current = false
          }}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={creating} onSelect={() => void createTab('session')}>
              <SquareDashedText />{t('tabBar.newSession')}
              {newTabShortcut ? <DropdownMenuShortcut>{shortcutText(newTabShortcut)}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={creating} onSelect={() => void createTab('browser')}>
              <Globe />{t('tabBar.newBrowser')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={creating} onSelect={() => void createTab('terminal')}>
              <SquareTerminal />{t('tabBar.newTerminal')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
  /** A closed tab's inert copy collapsing out of the strip. */
  leaving?: boolean
  error?: string
  split?: boolean
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
  leaving = false,
  error,
  split,
  className,
  onSelect,
  onClose,
  onRenameCommit,
  onRenameCancel,
  ref,
  ...rest
}: TabFaceProps) {
  const t = useT()
  const listed = !dragging && !leaving
  return (
    <div
      ref={ref}
      data-session-tab={listed ? true : undefined}
      data-tab-active={active && listed ? true : undefined}
      aria-current={active && listed ? true : undefined}
      aria-hidden={leaving || undefined}
      className={cn(
        'close-reveal group/tab no-drag relative flex h-7 touch-none select-none items-center gap-1 rounded-full px-1.5 text-xs whitespace-nowrap session-tab-motion motion-reduce:transition-none after:pointer-events-none after:absolute after:inset-y-2 after:right-0 after:w-px after:bg-glass-prompt-foreground/16 after:transition-opacity last:after:opacity-0 has-[+[data-tab-active]]:after:opacity-0 has-[+:hover]:after:opacity-0 hover:after:opacity-0 focus-within:after:opacity-0 solid:after:bg-foreground/16',
        // A floating copy stays opaque and name-sized; only tabs in the strip share the available width.
        dragging
          ? 'pointer-events-none w-max bg-card text-foreground shadow-md after:opacity-0'
          : [
            leaving && 'pointer-events-none overflow-hidden',
            '@container/session-tab w-56 min-w-7 max-w-56 shrink-0 cursor-pointer text-glass-prompt-foreground solid:text-foreground',
            active ? 'basis-56 grow-0' : 'basis-7 grow',
            // The frost behind the rail is the window's native material; the selected face only paints the glass optics.
            active
              ? 'bg-glass-tab-active-background bg-(image:--glass-tab-active-sheen) shadow-glass-tab-active inset-ring-1 inset-ring-glass-tab-active-border after:opacity-0 solid:bg-tab-active-background solid:bg-none solid:shadow-xs solid:inset-ring-border'
              : 'hover:bg-glass-prompt-foreground/8 focus-within:bg-glass-prompt-foreground/8 solid:hover:bg-tab-hover-background solid:focus-within:bg-tab-hover-background'
          ],
        className
      )}
      onClick={onSelect}
      {...rest}
    >
      {!dragging ? (
        <span data-tab-close-slot className="group/close-slot invisible absolute top-0.5 left-1.5 flex size-6 items-center justify-center @min-[7rem]/session-tab:visible">
          {onClose ? (
            <CloseButton
              streaming={streaming}
              ariaLabel={t('sessions.close', { title: label })}
              className="no-drag rounded-full text-inherit transition-[background-color,opacity] group-hover/tab:opacity-100 group-focus-within/close-slot:opacity-100 hover:bg-glass-prompt-foreground/8! hover:text-inherit solid:hover:bg-tab-hover-background!"
              onClose={onClose}
            />
          ) : null}
        </span>
      ) : null}
      <span className={cn('flex min-w-0 items-center justify-center overflow-hidden', dragging ? 'gap-1.5' : 'w-full gap-0 transition-[padding,gap] duration-75 motion-reduce:transition-none @min-[7rem]/session-tab:gap-1.5 @min-[7rem]/session-tab:px-8')}>
        {split ? (
          <LayoutPanelLeft className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <TabKindIcon kind={kind} path={path} />
        )}
        <span data-tab-label className={cn('min-w-0 truncate', dragging ? 'max-w-60' : ['max-w-0 opacity-0 transition-[max-width,opacity] duration-150 motion-reduce:transition-none @min-[7rem]/session-tab:max-w-full @min-[7rem]/session-tab:opacity-100', editing && 'max-w-full flex-1'])}>
          {editing && onRenameCommit && onRenameCancel ? (
            <SessionRenameField
              // Renaming keeps text selectable without lifting the sortable tab.
              className="h-5 w-full select-text"
              value={label}
              onCommit={onRenameCommit}
              onCancel={onRenameCancel}
            />
          ) : label}
        </span>
      </span>
      {!dragging || dirty || loading || error ? (
        <span className={cn('flex shrink-0 items-center justify-end gap-1', !dragging && 'absolute inset-y-0 right-1.5 hidden min-w-6 items-center @min-[7rem]/session-tab:flex')}>
          {dirty ? <span role="img" aria-label={t('tabBar.unsaved')} className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
          {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-label={t('tabBar.loading')} /> : null}
          {error ? <CircleAlert role="img" aria-label={error} className="size-3.5 shrink-0 text-destructive" /> : null}
        </span>
      ) : null}
      {!dragging && (error || loading || dirty) ? (
        <span className="absolute top-0.5 right-0.5 @min-[7rem]/session-tab:hidden">
          {error ? <CircleAlert role="img" aria-label={error} className="size-2 text-destructive" />
            : loading ? <LoaderCircle aria-label={t('tabBar.loading')} className="size-2 animate-spin" />
              : <span role="img" aria-label={t('tabBar.unsaved')} className="block size-1.5 rounded-full bg-primary" />}
        </span>
      ) : null}
    </div>
  )
}

/** A split group's slot in the strip. */
interface MergedTab {
  /** Every pane's tab, in layout order. */
  paneTabIds: string[]
  /** The members this strip half lists, which move together when the merged tab is dragged. */
  memberIds: string[]
  tabs: OpenTab[]
  title: string
  merged: boolean
}

interface LeavingSnapshot {
  label: string
  kind: OpenTab['kind']
  path?: string
  active: boolean
  split: boolean
}

function LeavingTabFace({ ghost, onDone }: { ghost: LeavingTab<LeavingSnapshot>; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    collapseLeavingTab(ref.current!, ghost.width, onDone)
    // The collapse is started once for this copy; later renders only reposition it.
  }, [])
  const { label, kind, path, active, split } = ghost.snapshot
  return (
    <TabFace
      ref={ref}
      leaving
      label={label}
      kind={kind}
      path={path}
      active={active}
      split={split}
      style={{ flexBasis: ghost.width, flexGrow: 0, minWidth: 0 }}
    />
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
  split,
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
  split?: boolean
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
  const dirty = useFilesStore((state) => {
    const document = path ? state.documents[fileKey(cwd, path)] : undefined
    return document ? isDirty(document) : false
  })
  const rename = useSessionRename(tabId, sessionPath)
  const action = useProjectAction()
  const failure = error ?? action.error ?? rename.error ?? undefined
  // Only the pointer listeners are handed to the face, not dnd-kit's `attributes`: those make a tab
  // focusable and role="button", and a drag that answers to no key would then be reachable by keyboard
  // and dead. The 6px activation distance is what keeps a click selecting and a right click opening its
  // menu; a tab being renamed cannot be dragged at all, since selecting its text is itself a pointer move.
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tabId, disabled: rename.editing })
  const body = (
    <TabFace
      ref={setNodeRef}
      data-tab-key={tabId}
      {...(listeners as unknown as HTMLAttributes<HTMLDivElement>)}
      className={cn(isDragging && 'opacity-40')}
      style={{ transform: CSS.Transform.toString(transform), '--tab-drag-transition': transition } as CSSProperties}
      label={title}
      kind={kind}
      path={path}
      active={active}
      loading={loading}
      dirty={dirty}
      streaming={streaming}
      split={split}
      editing={rename.editing}
      error={failure}
      title={failure ?? title}
      onSelect={onSelect}
      onClose={onClose}
      onRenameCommit={rename.commit}
      onRenameCancel={rename.cancel}
    />
  )

  // A merged split tab stands for several panes; each pane header carries its own menu.
  if (splitTabIds?.length) return body
  return (
    <TabContextMenu
      tabId={tabId}
      kind={kind}
      action={action}
      editing={rename.editing}
      onRename={() => { onSelect(); rename.start() }}
    >
      {body}
    </TabContextMenu>
  )
}

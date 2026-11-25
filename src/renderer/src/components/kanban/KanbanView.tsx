/**
 * Main Kanban surface inside `[data-content-surface]`:
 * - Multi-column drag-and-drop Board view (`@dnd-kit/core` + `@dnd-kit/sortable`) with Linear-style
 *   collapsible right-hand "Hidden columns" rail (`Canceled`, droppable even while collapsed)
 * - Compact status-grouped List view with inline status switching and collapsible Canceled section
 */
import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  FolderKanban,
  Link2,
  ListTodo,
  MessageSquarePlus,
  Plus,
  RotateCw
} from 'lucide-react'
import { toast } from 'sonner'
import {
  KANBAN_STATUSES,
  type KanbanIssue,
  type KanbanStatus
} from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { cn, hideScroll } from '../../lib/utils'
import { useKanbanStore } from '../../stores/kanban'
import { useSessionsStore } from '../../stores/sessions'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty'
import { ScrollArea } from '../ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { KanbanCardView, SortableKanbanCard, type KanbanCardCallbacks } from './KanbanCard'
import { computeDropSortOrder, kanbanCollisionDetection } from './kanban-dnd'
import { KanbanLabelDot, KanbanPriorityIcon, KanbanStatusIcon } from './kanban-icons'
import { KanbanIssueContextMenu } from './KanbanIssueContextMenu'

const PRIORITY_WEIGHT = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 } as const

function sortColumnIssues(list: KanbanIssue[]): KanbanIssue[] {
  return [...list].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    const prio = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
    if (prio !== 0) return prio
    return b.number - a.number
  })
}

function KanbanColumn({
  status,
  issues,
  projectNames,
  showProjectBadge,
  callbacks,
  onQuickCreate,
  onHideColumn
}: {
  status: KanbanStatus
  issues: KanbanIssue[]
  projectNames: ReadonlyMap<string, string>
  showProjectBadge: boolean
  callbacks: KanbanCardCallbacks
  onQuickCreate: (status: KanbanStatus) => void
  onHideColumn?: () => void
}) {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${status}`,
    data: { type: 'column', status }
  })

  return (
    <div
      ref={setNodeRef}
      data-kanban-column={status}
      className={cn(
        'group/kanban-col flex h-full w-72 min-w-68 shrink-0 flex-col rounded-xl border border-transparent bg-glass-prompt-foreground/4 transition-colors solid:bg-muted/35',
        isOver && 'border-primary/35 bg-primary/6 solid:bg-accent/50'
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <KanbanStatusIcon status={status} className="size-3.5" />
        <span className="text-xs font-medium text-foreground">{t(`kanban.status.${status}`)}</span>
        <span className="rounded-full bg-glass-prompt-foreground/8 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground solid:bg-muted">
          {issues.length}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {onHideColumn ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('kanban.hideColumn')}
                  onClick={onHideColumn}
                  className="size-6 text-muted-foreground opacity-0 transition-opacity group-hover/kanban-col:opacity-100 focus-visible:opacity-100 hover:text-foreground motion-reduce:transition-none"
                >
                  <EyeOff className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('kanban.hideColumn')}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`${t('kanban.newIssue')} (${t(`kanban.status.${status}`)})`}
                onClick={() => onQuickCreate(status)}
                className="size-6 text-muted-foreground hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('kanban.newIssue')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pb-2 [&>[data-slot=scroll-area-scrollbar]]:hidden">
        <SortableContext
          items={issues.map((item) => `issue:${item.number}`)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex min-h-16 flex-col gap-2">
            {issues.length > 0 ? (
              issues.map((issue) => (
                <SortableKanbanCard
                  key={issue.id}
                  issue={issue}
                  projectName={issue.projectCwd ? (projectNames.get(issue.projectCwd) ?? null) : null}
                  showProjectBadge={showProjectBadge}
                  callbacks={callbacks}
                />
              ))
            ) : (
              <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-glass-border/60 text-[11px] text-muted-foreground/70 solid:border-border/60">
                {t('kanban.columnEmpty')}
              </div>
            )}
          </div>
        </SortableContext>
      </ScrollArea>
    </div>
  )
}

/** Single collapsed column pill inside Linear-style right-side "Hidden columns" rail — clickable to expand AND droppable! */
function HiddenColumnPill({
  status,
  count,
  onExpand
}: {
  status: KanbanStatus
  count: number
  onExpand: () => void
}) {
  const t = useT()
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${status}`,
    data: { type: 'column', status }
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-kanban-hidden-column={status}
      onClick={onExpand}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-lg border border-transparent bg-glass-prompt-foreground/4 px-3 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-glass-prompt-foreground/8 hover:text-foreground focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring solid:bg-muted/35 solid:hover:bg-accent/60',
        isOver && 'border-primary/40 bg-primary/10 text-foreground solid:bg-accent'
      )}
    >
      <KanbanStatusIcon status={status} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate font-medium">{t(`kanban.status.${status}`)}</span>
      <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{count}</span>
    </button>
  )
}

function HiddenColumnsRail({
  statuses,
  groupedByStatus,
  onExpand
}: {
  statuses: readonly KanbanStatus[]
  groupedByStatus: ReadonlyMap<KanbanStatus, KanbanIssue[]>
  onExpand: (status: KanbanStatus) => void
}) {
  const t = useT()
  return (
    <div className="flex w-52 shrink-0 flex-col gap-1.5 pt-1 pr-1">
      <div className="px-2 pb-0.5 text-xs font-medium text-muted-foreground">
        {t('kanban.hiddenColumns')}
      </div>
      {statuses.map((status) => (
        <HiddenColumnPill
          key={status}
          status={status}
          count={groupedByStatus.get(status)?.length ?? 0}
          onExpand={() => onExpand(status)}
        />
      ))}
    </div>
  )
}

export function KanbanView({ callbacks }: { callbacks: KanbanCardCallbacks }) {
  const t = useT()
  const loaded = useKanbanStore((s) => s.loaded)
  const loading = useKanbanStore((s) => s.loading)
  const error = useKanbanStore((s) => s.error)
  const items = useKanbanStore((s) => s.items)
  const viewMode = useKanbanStore((s) => s.viewMode)
  const projectScope = useKanbanStore((s) => s.projectScope)
  const searchQuery = useKanbanStore((s) => s.searchQuery)
  const hiddenStatuses = useKanbanStore((s) => s.hiddenStatuses)
  const setColumnHidden = useKanbanStore((s) => s.setColumnHidden)
  const openCreateDialog = useKanbanStore((s) => s.openCreateDialog)
  const openIssueDialog = useKanbanStore((s) => s.openIssueDialog)
  const updateIssue = useKanbanStore((s) => s.updateIssue)

  const projects = useSessionsStore((s) => s.projects)
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.cwd, p.name])), [projects])

  const [activeDragNumber, setActiveDragNumber] = useState<number | null>(null)
  const [listPeekStatuses, setListPeekStatuses] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!loaded && !loading) {
      void useKanbanStore.getState().init()
    }
  }, [loaded, loading])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const scopedFilteredAllStatuses = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const numNeedle = q.startsWith('#') ? Number(q.slice(1)) : Number(q)

    return items.filter((item) => {
      if (projectScope === 'unassigned' && item.projectCwd !== null) return false
      if (projectScope !== 'all' && projectScope !== 'unassigned' && item.projectCwd !== projectScope) {
        return false
      }
      if (q) {
        if (Number.isSafeInteger(numNeedle) && item.number === numNeedle) return true
        const projName = item.projectCwd ? (projectNames.get(item.projectCwd) ?? baseName(item.projectCwd)) : ''
        const matched = [
          `#${item.number}`,
          item.title,
          item.description,
          projName,
          ...item.labels
        ].some((field) => field.toLowerCase().includes(q))
        if (!matched) return false
      }
      return true
    })
  }, [items, projectScope, searchQuery, projectNames])

  const groupedByStatus = useMemo(() => {
    const map = new Map<KanbanStatus, KanbanIssue[]>()
    for (const status of KANBAN_STATUSES) map.set(status, [])
    for (const issue of scopedFilteredAllStatuses) {
      map.get(issue.status)?.push(issue)
    }
    for (const [status, list] of map) {
      map.set(status, sortColumnIssues(list))
    }
    return map
  }, [scopedFilteredAllStatuses])

  const hiddenSet = useMemo(() => new Set(hiddenStatuses), [hiddenStatuses])
  const visibleStatuses = useMemo(
    () => KANBAN_STATUSES.filter((s) => !hiddenSet.has(s)),
    [hiddenSet]
  )
  const orderedHiddenStatuses = useMemo(
    () => KANBAN_STATUSES.filter((s) => hiddenSet.has(s)),
    [hiddenSet]
  )

  const activeDragIssue = useMemo(
    () => (activeDragNumber != null ? items.find((i) => i.number === activeDragNumber) ?? null : null),
    [activeDragNumber, items]
  )

  const handleDragStart = (event: DragStartEvent) => {
    const raw = String(event.active.id)
    if (raw.startsWith('issue:')) {
      setActiveDragNumber(Number(raw.slice(6)))
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragNumber(null)
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    if (!activeId.startsWith('issue:')) return
    const draggedNumber = Number(activeId.slice(6))
    const dragged = items.find((i) => i.number === draggedNumber)
    if (!dragged) return

    const overId = String(over.id)
    let targetStatus: KanbanStatus | null = null
    let overIssueNumber: number | null = null

    if (overId.startsWith('column:')) {
      targetStatus = overId.slice(7) as KanbanStatus
    } else if (overId.startsWith('issue:')) {
      overIssueNumber = Number(overId.slice(6))
      const overIssue = items.find((i) => i.number === overIssueNumber)
      if (overIssue) targetStatus = overIssue.status
    }
    if (!targetStatus) return
    if (overIssueNumber === draggedNumber && targetStatus === dragged.status) return

    const nextSortOrder = computeDropSortOrder(
      groupedByStatus.get(targetStatus) ?? [],
      dragged,
      targetStatus,
      overIssueNumber
    )

    void updateIssue({
      number: draggedNumber,
      status: targetStatus,
      sortOrder: nextSortOrder
    }).catch((err) => toast.error(failureMessage(err)))
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyDescription role="alert">
            {t('kanban.loadFailed', { error })}
          </EmptyDescription>
          <Button variant="outline" size="xs" onClick={() => void useKanbanStore.getState().init()}>
            <RotateCw data-icon="inline-start" />
            {t('common.retry')}
          </Button>
        </Empty>
      </div>
    )
  }

  const scopeHasZeroItems =
    loaded &&
    !searchQuery.trim() &&
    scopedFilteredAllStatuses.length === 0 &&
    !items.some((item) => {
      if (projectScope === 'unassigned') return item.projectCwd === null
      if (projectScope !== 'all') return item.projectCwd === projectScope
      return true
    })

  if (scopeHasZeroItems) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListTodo />
            </EmptyMedia>
            <EmptyTitle>{t('kanban.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('kanban.emptyDescription')}</EmptyDescription>
          </EmptyHeader>
          <Button size="sm" onClick={() => openCreateDialog()}>
            <Plus data-icon="inline-start" />
            {t('kanban.newIssue')}
          </Button>
        </Empty>
      </div>
    )
  }

  const showProjectBadge = projectScope === 'all'

  if (viewMode === 'list') {
    if (scopedFilteredAllStatuses.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
          {t('kanban.noMatches')}
        </div>
      )
    }

    const renderListRows = (list: KanbanIssue[]) => (
      <div className="overflow-hidden rounded-xl border border-glass-card-border bg-glass-pane-background/60 divide-y divide-glass-border/50 solid:border-border solid:bg-card solid:divide-border">
        {list.map((issue) => {
          const linkCount = issue.linkedSessions.length + issue.linkedBotTaskIds.length
          const projLabel = issue.projectCwd
            ? (projectNames.get(issue.projectCwd) ?? baseName(issue.projectCwd))
            : t('kanban.unassigned')
          return (
            <KanbanIssueContextMenu key={issue.id} issue={issue}>
              <div
                data-kanban-list-row={issue.number}
                onClick={() => openIssueDialog(issue.number)}
                className="group/kanban-row flex h-9 cursor-pointer items-center gap-2.5 px-3 text-xs transition-colors hover:bg-glass-prompt-foreground/6 data-[state=open]:bg-glass-prompt-foreground/6 solid:hover:bg-accent/50 solid:data-[state=open]:bg-accent/50"
              >
                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('kanban.fields.status')}
                        className="flex size-5 items-center justify-center rounded hover:bg-glass-prompt-foreground/10 solid:hover:bg-accent"
                      >
                        <KanbanStatusIcon status={issue.status} className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      className={cn('max-h-52 min-w-40 overflow-y-auto overscroll-contain', hideScroll)}
                    >
                      <DropdownMenuRadioGroup
                        value={issue.status}
                        onValueChange={(next) => {
                          void updateIssue({ number: issue.number, status: next as KanbanStatus })
                            .catch((err) => toast.error(failureMessage(err)))
                        }}
                      >
                        {KANBAN_STATUSES.map((s) => (
                          <DropdownMenuRadioItem key={s} value={s}>
                            <KanbanStatusIcon status={s} className="size-3.5" />
                            <span>{t(`kanban.status.${s}`)}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <KanbanPriorityIcon priority={issue.priority} className="size-3.5" />
                <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  #{issue.number}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-medium text-foreground',
                    issue.status === 'canceled' && 'text-muted-foreground line-through'
                  )}
                >
                  {issue.title}
                </span>

                {issue.labels.slice(0, 3).map((label) => (
                  <span
                    key={label}
                    className="hidden max-w-28 shrink-0 items-center gap-1 truncate rounded-full border border-glass-border bg-glass-prompt-foreground/4 px-2 py-0.5 text-[10px] text-foreground/85 sm:inline-flex solid:border-border/80 solid:bg-muted/40"
                  >
                    <KanbanLabelDot label={label} />
                    <span className="truncate">{label}</span>
                  </span>
                ))}

                {showProjectBadge ? (
                  <span className="inline-flex max-w-32 shrink-0 items-center gap-1 truncate text-[11px] text-muted-foreground">
                    {issue.projectCwd ? <FolderKanban className="size-3 shrink-0" /> : null}
                    <span className="truncate">{projLabel}</span>
                  </span>
                ) : null}

                {linkCount > 0 ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
                    <Link2 className="size-3" />
                    {linkCount}
                  </span>
                ) : null}

                <div
                  className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/kanban-row:opacity-100 focus-within:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('kanban.copyIssue')}
                        onClick={() => {
                          void useKanbanStore
                            .getState()
                            .copyIssue(issue.number)
                            .then(
                              () => toast.success(t('kanban.copiedIssue')),
                              (err) => toast.error(failureMessage(err))
                            )
                        }}
                        className="size-6 text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('kanban.copyIssue')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('kanban.startInSession')}
                        onClick={() => callbacks.onStartInSession(issue)}
                        className="size-6 text-muted-foreground hover:text-foreground"
                      >
                        <MessageSquarePlus className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('kanban.startInSession')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('kanban.sendToBot')}
                        onClick={() => callbacks.onSendToBot(issue)}
                        className="size-6 text-muted-foreground hover:text-foreground"
                      >
                        <Bot className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('kanban.sendToBot')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </KanbanIssueContextMenu>
          )
        })}
      </div>
    )

    return (
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-scrollbar]]:hidden">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
          {visibleStatuses.map((status) => {
            const list = groupedByStatus.get(status) ?? []
            if (list.length === 0) return null
            return (
              <section key={status} className="group/kanban-list-sec flex flex-col gap-1">
                <header className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground">
                  <KanbanStatusIcon status={status} className="size-3.5" />
                  <span className="text-foreground">{t(`kanban.status.${status}`)}</span>
                  <span className="tabular-nums text-[11px]">{list.length}</span>
                  <div className="ml-auto flex items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('kanban.hideColumn')}
                          onClick={() => setColumnHidden(status, true)}
                          className="size-6 text-muted-foreground opacity-0 transition-opacity group-hover/kanban-list-sec:opacity-100 focus-visible:opacity-100 hover:text-foreground motion-reduce:transition-none"
                        >
                          <EyeOff className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t('kanban.hideColumn')}</TooltipContent>
                    </Tooltip>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('kanban.newIssue')}
                      onClick={() => openCreateDialog({ status })}
                      className="size-6 text-muted-foreground hover:text-foreground"
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                </header>
                {renderListRows(list)}
              </section>
            )
          })}

          {orderedHiddenStatuses.map((status) => {
            const list = groupedByStatus.get(status) ?? []
            if (list.length === 0) return null
            const peeked = Boolean(listPeekStatuses[status])
            return (
              <section key={status} className="flex flex-col gap-1 pt-1">
                <button
                  type="button"
                  onClick={() =>
                    setListPeekStatuses((prev) => ({ ...prev, [status]: !prev[status] }))
                  }
                  className="flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {peeked ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  <KanbanStatusIcon status={status} className="size-3.5" />
                  <span>{t(`kanban.status.${status}`)}</span>
                  <span className="tabular-nums text-[11px]">{list.length}</span>
                </button>
                {peeked ? renderListRows(list) : null}
              </section>
            )
          })}
        </div>
      </ScrollArea>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={kanbanCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDragNumber(null)}
    >
      <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-3 [scrollbar-width:thin]">
        {visibleStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={groupedByStatus.get(status) ?? []}
            projectNames={projectNames}
            showProjectBadge={showProjectBadge}
            callbacks={callbacks}
            onQuickCreate={(colStatus) => openCreateDialog({ status: colStatus })}
            onHideColumn={() => setColumnHidden(status, true)}
          />
        ))}

        {orderedHiddenStatuses.length > 0 ? (
          <HiddenColumnsRail
            statuses={orderedHiddenStatuses}
            groupedByStatus={groupedByStatus}
            onExpand={(status) => setColumnHidden(status, false)}
          />
        ) : null}
      </div>

      <DragOverlay dropAnimation={null} className="pointer-events-none">
        {activeDragIssue ? (
          <div className="w-68">
            <KanbanCardView
              issue={activeDragIssue}
              projectName={
                activeDragIssue.projectCwd
                  ? (projectNames.get(activeDragIssue.projectCwd) ?? null)
                  : null
              }
              showProjectBadge={showProjectBadge}
              overlay
              callbacks={callbacks}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

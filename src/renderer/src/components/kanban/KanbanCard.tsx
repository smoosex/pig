/**
 * Linear-inspired Kanban issue card:
 * - Subtle top identifier + hover quick actions ("Work in session" / "Send to Bot")
 * - Inline status icon paired with crisp 2-line title
 * - Optional pasted-screenshot thumbnail strip
 * - Pill metadata row (`[---]` priority box, `[📦 Project]`, `[● Label]` colored-dot pills) + creation date
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type Ref } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Bot, Box, Check, Copy, Link2, LoaderCircle, MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import { isBotTaskActive } from '../../../../shared/bot'
import { kanbanImageUrl, type KanbanIssue } from '../../../../shared/kanban'
import { baseName } from '../../../../shared/paths'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { useKanbanStore } from '../../stores/kanban'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { KanbanLabelDot, KanbanPriorityIcon, KanbanStatusIcon } from './kanban-icons'
import { KanbanIssueContextMenu } from './KanbanIssueContextMenu'

export interface KanbanCardCallbacks {
  onStartInSession: (issue: KanbanIssue) => void
  onSendToBot: (issue: KanbanIssue) => void
}

const cardPillClass =
  'inline-flex h-5 items-center gap-1 rounded-full border border-glass-border bg-glass-prompt-foreground/4 px-2 text-[11px] text-muted-foreground solid:border-border/80 solid:bg-muted/40'

export function KanbanCardView({
  issue,
  projectName,
  showProjectBadge,
  overlay = false,
  dragging = false,
  callbacks,
  style,
  className,
  onClick,
  ref,
  ...rest
}: {
  issue: KanbanIssue
  projectName: string | null
  showProjectBadge: boolean
  overlay?: boolean
  dragging?: boolean
  callbacks: KanbanCardCallbacks
  style?: CSSProperties
  ref?: Ref<HTMLDivElement>
} & Omit<HTMLAttributes<HTMLDivElement>, 'style'>) {
  const t = useT()
  const locale = useSettingsStore((s) => s.locale)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  const handleCopy = () => {
    void useKanbanStore
      .getState()
      .copyIssue(issue.number)
      .then(
        () => {
          setCopied(true)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
          toast.success(t('kanban.copiedIssue'))
        },
        (err) => toast.error(failureMessage(err))
      )
  }
  const botTasks = useBotStore((s) => s.tasks)
  const linkedBotTasks = issue.linkedBotTaskIds
    .map((id) => botTasks.find((task) => task.taskId === id))
    .filter((task): task is NonNullable<typeof task> => Boolean(task))
  const hasRunningBotTask = linkedBotTasks.some((task) => isBotTaskActive(task.status))
  const linkCount = issue.linkedSessions.length + linkedBotTasks.length

  const shortDate = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric'
      }).format(issue.createdAt),
    [locale, issue.createdAt]
  )

  return (
    <div
      ref={ref}
      style={style}
      {...rest}
      data-kanban-card={issue.number}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) {
          useKanbanStore.getState().openIssueDialog(issue.number)
        }
      }}
      className={cn(
        'group/kanban-card relative flex cursor-pointer flex-col gap-2 rounded-lg border border-glass-card-border bg-glass-button-background/65 p-3 text-left shadow-2xs transition-[background-color,border-color,opacity,box-shadow] duration-150 select-none hover:bg-glass-button-background/90 data-[state=open]:bg-glass-button-background/90 solid:border-border/80 solid:bg-card solid:shadow-none solid:hover:border-border solid:hover:bg-accent/25 solid:data-[state=open]:border-border solid:data-[state=open]:bg-accent/25',
        dragging && 'opacity-35',
        overlay && 'cursor-grabbing shadow-lg ring-1 ring-primary/30',
        className
      )}
    >
      {/* Top identifier + hover quick actions */}
      <div className="flex h-4 items-center justify-between gap-1.5">
        <span className="font-mono text-[11px] font-medium tabular-nums text-muted-foreground">
          #{issue.number}
        </span>

        <div className="flex items-center gap-1">
          {hasRunningBotTask ? (
            <LoaderCircle className="size-3 animate-spin text-primary" aria-hidden="true" />
          ) : null}
          <div
            className="flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover/kanban-card:opacity-100 group-focus-within/kanban-card:opacity-100 motion-reduce:transition-none"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('kanban.copyIssue')}
                  onClick={handleCopy}
                  className="size-5 rounded text-muted-foreground hover:text-foreground"
                >
                  {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
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
                  className="size-5 rounded text-muted-foreground hover:text-foreground"
                >
                  <MessageSquarePlus className="size-3" />
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
                  className="size-5 rounded text-muted-foreground hover:text-foreground"
                >
                  <Bot className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('kanban.sendToBot')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Inline status icon + crisp title */}
      <div className="flex items-start gap-1.5">
        <KanbanStatusIcon status={issue.status} className="mt-0.5 size-3.5" />
        <span
          className={cn(
            'line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-medium text-foreground break-words',
            issue.status === 'canceled' && 'text-muted-foreground line-through'
          )}
        >
          {issue.title}
        </span>
      </div>

      {/* Pasted screenshot thumbnails */}
      {issue.images.length > 0 ? (
        <div className="flex items-center gap-1.5 pt-0.5">
          {issue.images.slice(0, 2).map((img) => (
            <img
              key={img.id}
              src={kanbanImageUrl(img.id)}
              alt={img.name ?? ''}
              loading="lazy"
              decoding="async"
              className="h-12 w-20 rounded-md border border-glass-border object-cover solid:border-border"
            />
          ))}
          {issue.images.length > 2 ? (
            <span className="rounded-md border border-glass-border bg-glass-prompt-foreground/5 px-1.5 py-1 text-[10px] font-medium text-muted-foreground solid:border-border solid:bg-muted">
              +{issue.images.length - 2}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Linear-style metadata pills row */}
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <span
          className="inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-md border border-glass-border bg-glass-prompt-foreground/4 solid:border-border/80 solid:bg-muted/40"
          title={t(`kanban.priority.${issue.priority}`)}
        >
          <KanbanPriorityIcon priority={issue.priority} className="size-3" />
        </span>

        {showProjectBadge && issue.projectCwd ? (
          <span className={cn(cardPillClass, 'max-w-32')}>
            <Box className="size-2.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{projectName ?? baseName(issue.projectCwd)}</span>
          </span>
        ) : null}

        {issue.labels.slice(0, 3).map((label) => (
          <span key={label} className={cn(cardPillClass, 'max-w-32 text-foreground/85')}>
            <KanbanLabelDot label={label} />
            <span className="truncate">{label}</span>
          </span>
        ))}
      </div>

      {/* Subtle footer date + backlink count */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground/75">
        <span>{t('kanban.createdOn', { date: shortDate })}</span>
        {linkCount > 0 ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <Link2 className="size-2.5" aria-hidden="true" />
            {linkCount}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function SortableKanbanCard({
  issue,
  projectName,
  showProjectBadge,
  callbacks
}: {
  issue: KanbanIssue
  projectName: string | null
  showProjectBadge: boolean
  callbacks: KanbanCardCallbacks
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `issue:${issue.number}`,
    data: { type: 'issue', issue }
  })

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition
  }

  return (
    <KanbanIssueContextMenu issue={issue} disabled={isDragging}>
      <KanbanCardView
        ref={setNodeRef}
        issue={issue}
        projectName={projectName}
        showProjectBadge={showProjectBadge}
        dragging={isDragging}
        callbacks={callbacks}
        style={style}
        {...attributes}
        {...(listeners as unknown as HTMLAttributes<HTMLDivElement>)}
      />
    </KanbanIssueContextMenu>
  )
}

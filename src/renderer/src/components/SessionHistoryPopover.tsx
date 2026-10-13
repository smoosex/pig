import { useMemo, useState, type ComponentProps } from 'react'
import { History } from 'lucide-react'
import { useT } from '../hooks/useT'
import { relativeTime } from '../lib/relative-time'
import { cn } from '../lib/utils'
import { withSessionForks, type SessionFork } from '../../../shared/session-lineage'
import { useSessionsStore, selectActiveSessionId, type SessionMeta } from '../stores/sessions'
import { sessionTitle } from '../stores/sessions/session-title'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { SmoothHoverHighlight } from './ui/smooth-hover-highlight'
import { SquaresSpinner } from './RunningSpinners'
import { SessionSizeDots } from './SessionSizeDots'
import { SessionDeleteButton } from './sidebar/SessionDeleteButton'
import { SessionForkIcon } from './SessionForkIcon'

const emptySessions: SessionMeta[] = []

export function SessionHistoryPopover({
  cwd,
  size = 'icon-sm',
  triggerClassName
}: {
  cwd: string
  size?: ComponentProps<typeof Button>['size']
  triggerClassName?: string
}) {
  const sessions = useSessionsStore((state) => {
    for (const project of state.projects) {
      const worktree = project.worktrees?.find((item) => item.cwd === cwd)
      if (worktree) return worktree.sessions
      if (!project.worktrees && project.cwd === cwd) return project.sessions
    }
    return emptySessions
  })
  const openExisting = useSessionsStore((state) => state.openExisting)
  const deleteSession = useSessionsStore((state) => state.deleteSession)
  const activeId = useSessionsStore((state) => selectActiveSessionId(state))
  const t = useT()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The listing arrives newest-first, so a fork's parent row is the one above it.
  const rows = useMemo(() => withSessionForks(sessions), [sessions])
  const run = async (session: SessionMeta, action: 'open' | 'delete') => {
    if (pending) return
    setPending(session.id)
    setError(null)
    try {
      if (action === 'open') {
        await openExisting(session, 'project')
        setOpen(false)
      } else {
        await deleteSession(session)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={size}
          className={cn('shrink-0 text-muted-foreground', triggerClassName)}
          aria-label={t('sessions.history')}
        >
          <History />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="max-h-[min(28rem,var(--radix-popover-content-available-height,28rem))] w-96 overflow-hidden p-1.5"
      >
        <div className="min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SmoothHoverHighlight activeKey={activeId} className="flex flex-col gap-0.5">
            {rows.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('sessions.historyEmpty')}</p>
            ) : rows.map((row) => (
              <HistoryRow
                key={row.id}
                row={row}
                active={row.id === activeId}
                pending={pending}
                onOpen={() => void run(row, 'open')}
                onDelete={() => void run(row, 'delete')}
              />
            ))}
          </SmoothHoverHighlight>
        </div>
        {error ? <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p> : null}
      </PopoverContent>
    </Popover>
  )
}

function HistoryRow({
  row,
  active,
  pending,
  onOpen,
  onDelete
}: {
  row: SessionMeta & SessionFork
  active: boolean
  pending: string | null
  onOpen: () => void
  onDelete: () => void
}) {
  const streaming = useSessionsStore((state) => state.runtime[row.id]?.isStreaming ?? false)
  const t = useT()
  const title = sessionTitle(row)
  return (
    <div
      data-hover-highlight-row
      data-hover-highlight-active={active ? '' : undefined}
      className="group/session relative flex min-w-0 items-center rounded-md px-1"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 min-w-0 flex-1 justify-start !bg-transparent"
        disabled={pending !== null}
        onClick={onOpen}
      >
        {row.forkedFrom ? <SessionForkIcon /> : null}
        <span className="min-w-0 flex-1 truncate text-left font-normal">{title}</span>
        <span className="ml-4 flex shrink-0 items-center gap-2">
          <span
            className="w-14 shrink-0 text-right text-[0.7rem] text-muted-foreground tabular-nums"
            title={new Date(row.modified).toLocaleString()}
          >
            {relativeTime(row.modified, t)}
          </span>
          <SessionSizeDots
            size={row.size}
            className={
              streaming || pending === row.id
                ? 'opacity-0 transition-opacity'
                : 'transition-opacity group-hover/session:opacity-0'
            }
          />
        </span>
      </Button>
      <div className="pointer-events-none absolute right-1 z-10 flex w-12 items-center justify-end">
        {streaming || pending === row.id ? (
          <SquaresSpinner />
        ) : (
          <SessionDeleteButton
            ariaLabel={t('sessions.deleteSession', { title })}
            disabled={pending !== null}
            onConfirm={onDelete}
          />
        )}
      </div>
    </div>
  )
}

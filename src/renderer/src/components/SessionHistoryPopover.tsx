import { useState } from 'react'
import { History } from 'lucide-react'
import { relativeTime } from '../lib/relative-time'
import { useSessionsStore, type SessionMeta } from '../stores/sessions'
import { sessionTitle } from '../stores/sessions/session-title'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { SquaresSpinner } from './RunningSpinners'
import { SessionSizeDots } from './SessionSizeDots'
import { SessionDeleteButton } from './sidebar/SessionDeleteButton'

const emptySessions: SessionMeta[] = []

export function SessionHistoryPopover({ cwd }: { cwd: string }) {
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
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
          size="icon-sm"
          className="no-drag shrink-0 text-muted-foreground"
          aria-label="对话历史"
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
          <div className="flex flex-col gap-0.5">
            {sessions.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">暂无历史会话</p>
            ) : sessions.map((session) => (
              <HistoryRow
                key={session.id}
                session={session}
                pending={pending}
                onOpen={() => void run(session, 'open')}
                onDelete={() => void run(session, 'delete')}
              />
            ))}
          </div>
        </div>
        {error ? <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p> : null}
      </PopoverContent>
    </Popover>
  )
}

function HistoryRow({
  session,
  pending,
  onOpen,
  onDelete
}: {
  session: SessionMeta
  pending: string | null
  onOpen: () => void
  onDelete: () => void
}) {
  const streaming = useSessionsStore((state) => state.runtime[session.id]?.isStreaming ?? false)
  const title = sessionTitle(session)
  return (
    <div className="group/session relative flex min-w-0 items-center rounded-md px-1 transition-colors hover:bg-accent">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 min-w-0 flex-1 justify-start !bg-transparent"
        disabled={pending !== null}
        onClick={onOpen}
      >
        <span className="min-w-0 flex-1 truncate text-left font-normal">{title}</span>
        <span className="ml-4 flex shrink-0 items-center gap-2">
          <span
            className="w-14 shrink-0 text-right text-[0.7rem] text-muted-foreground tabular-nums"
            title={new Date(session.modified).toLocaleString()}
          >
            {relativeTime(session.modified)}
          </span>
          <SessionSizeDots
            size={session.size}
            className={
              streaming || pending === session.id
                ? 'opacity-0 transition-opacity'
                : 'transition-opacity group-hover/session:opacity-0'
            }
          />
        </span>
      </Button>
      <div className="pointer-events-none absolute right-1 z-10 flex w-12 items-center justify-end group-hover/session:bg-accent has-[:focus-visible]:bg-accent">
        {streaming || pending === session.id ? (
          <SquaresSpinner />
        ) : (
          <SessionDeleteButton
            ariaLabel={`删除会话 ${title}`}
            disabled={pending !== null}
            onConfirm={onDelete}
          />
        )}
      </div>
    </div>
  )
}

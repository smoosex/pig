import { useSessionsStore, type SessionMeta } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { HookSidebar } from '../ui/hook-sidebar'
import { SquaresSpinner } from '../RunningSpinners'
import { SessionDeleteButton } from './SessionDeleteButton'

export function SessionList({
  sessions,
  pending,
  onOpen,
  onDelete
}: {
  sessions: SessionMeta[]
  pending: boolean
  onOpen: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => void
}) {
  const activeIndex = useSessionsStore((s) =>
    sessions.findIndex((session) => session.id === s.activeSessionId)
  )

  return (
    <HookSidebar
      items={sessions.map((session) => session.name || session.firstMessage || '空会话')}
      value={activeIndex}
      color="var(--primary)"
      railLeft="1.5rem"
      className="pt-0.5 pb-1"
      renderItem={(_, index) => {
        const session = sessions[index]
        if (!session) return null
        return (
          <SessionRow
            session={session}
            pending={pending}
            onOpen={() => onOpen(session)}
            onDelete={() => onDelete(session)}
          />
        )
      }}
    />
  )
}

function SessionRow({
  session,
  pending,
  onOpen,
  onDelete
}: {
  session: SessionMeta
  pending: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const active = useSessionsStore((s) => s.activeSessionId === session.id)
  const streaming = useSessionsStore((s) => s.runtime[session.id]?.isStreaming ?? false)
  const label = session.name || session.firstMessage || '空会话'
  return (
    <div className="pl-9 pr-1">
      <div
        className={cn(
          'group/session flex min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors hover:bg-sidebar-accent',
          active && 'bg-sidebar-accent'
        )}
      >
        <Button
          variant="ghost"
          size="xs"
          className="h-7 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal !bg-transparent"
          title={session.firstMessage}
          disabled={pending}
          onClick={onOpen}
        >
          <span className="min-w-0 truncate">
            {session.name || session.firstMessage || '(空会话)'}
          </span>
        </Button>
        {streaming ? (
          <SquaresSpinner />
        ) : (
          <SessionDeleteButton
            ariaLabel={`删除会话 ${label}`}
            disabled={pending}
            onConfirm={onDelete}
          />
        )}
      </div>
    </div>
  )
}

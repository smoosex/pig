import { useSessionsStore, type ProjectGroup, type SessionMeta } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { SquaresSpinner } from '../RunningSpinners'
import { SessionDeleteButton } from './SessionDeleteButton'
import { useProjectAction } from './project-action'

function chatTitle(group: ProjectGroup): string {
  const session = group.sessions[0]
  return session?.name || session?.firstMessage || '新对话'
}

export function ChatList() {
  const chats = useSessionsStore((s) => s.chats)

  if (chats.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">点击 + 开始对话</p>
  }

  return (
    <div className="flex flex-col gap-0.5 py-1">
      {chats.map((chat) => {
        const session = chat.sessions[0]
        if (!session) return null
        return <ChatRow key={chat.cwd} session={session} title={chatTitle(chat)} cwd={chat.cwd} />
      })}
    </div>
  )
}

function ChatRow({ session, title, cwd }: { session: SessionMeta; title: string; cwd: string }) {
  const openExisting = useSessionsStore((s) => s.openExisting)
  const deleteChat = useSessionsStore((s) => s.deleteChat)
  const active = useSessionsStore((s) => s.activeSessionId === session.id)
  const streaming = useSessionsStore((s) => s.runtime[session.id]?.isStreaming ?? false)
  const { pending, error, runAction } = useProjectAction()
  return (
    <div className="px-1">
      <div
        className={cn(
          'group/chat flex min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors hover:bg-sidebar-accent',
          active && 'bg-sidebar-accent'
        )}
      >
        <Button
          variant="ghost"
          size="xs"
          className="h-7 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal !bg-transparent"
          title={title}
          disabled={pending !== null}
          onClick={() => void runAction('open', () => openExisting(session, 'chat'))}
        >
          <span className="min-w-0 truncate">{title}</span>
        </Button>
        {streaming ? (
          <SquaresSpinner />
        ) : (
          <SessionDeleteButton
            ariaLabel={`删除对话 ${title}`}
            disabled={pending !== null}
            onConfirm={() => void runAction('delete', () => deleteChat(cwd))}
          />
        )}
      </div>
      {error ? (
        <p role="alert" className="px-1 py-1 text-xs break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

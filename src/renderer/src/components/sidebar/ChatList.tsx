import { useSessionsStore, selectActiveSessionId, type ProjectGroup, type SessionMeta } from '../../stores/sessions'
import { Button } from '../ui/button'
import { TreeNav } from '../spectrumui/tree-nav'
import { SquaresSpinner } from '../RunningSpinners'
import { SessionDeleteButton } from './SessionDeleteButton'
import { useProjectAction } from './project-action'

function chatTitle(group: ProjectGroup): string {
  const session = group.sessions[0]
  return session?.name || session?.firstMessage || '新对话'
}

export function ChatList() {
  const chats = useSessionsStore((state) => state.chats)
  const activeSessionId = useSessionsStore(selectActiveSessionId)
  const rows = chats.flatMap((chat) => {
    const session = chat.sessions[0]
    return session ? [{ session, title: chatTitle(chat), cwd: chat.cwd }] : []
  })

  if (rows.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">点击 + 开始对话</p>
  }

  return (
    <TreeNav
      items={rows.map(({ session, title }) => ({ label: title, href: session.id }))}
      activeHref={activeSessionId ?? undefined}
      showHighlight={false}
      className="py-1 pr-1"
      renderItem={(_, index, active) => {
        const row = rows[index]
        return row ? <ChatRow {...row} active={active} /> : null
      }}
    />
  )
}

function ChatRow({
  session,
  title,
  cwd,
  active
}: {
  session: SessionMeta
  title: string
  cwd: string
  active: boolean
}) {
  const openExisting = useSessionsStore((state) => state.openExisting)
  const deleteChat = useSessionsStore((state) => state.deleteChat)
  const streaming = useSessionsStore((state) => state.runtime[session.id]?.isStreaming ?? false)
  const { pending, error, runAction } = useProjectAction()

  return (
    <div>
      <div
        data-sidebar-hover-row
        className="group/chat relative flex h-8 min-w-0 items-center gap-0.5 rounded-md px-2"
      >
        <Button
          variant="ghost"
          size="xs"
          className="h-8 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal !bg-transparent"
          title={title}
          aria-current={active ? 'page' : undefined}
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
        <p role="alert" className="px-2 py-1 text-xs break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

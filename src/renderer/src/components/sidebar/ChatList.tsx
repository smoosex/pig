import { useSessionsStore, selectActiveSessionId, type SessionMeta } from '../../stores/sessions'
import { sessionTitle } from '../../stores/sessions/session-title'
import { Button } from '../ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Download, PenLine } from 'lucide-react'
import { api } from '../../ipc/api'
import { SessionRenameField, useSessionRename } from '../SessionRenameField'
import { useT } from '../../hooks/useT'
import { TreeNav } from '../spectrumui/tree-nav'
import { SquaresSpinner } from '../RunningSpinners'
import { SessionDeleteButton } from './SessionDeleteButton'
import { useProjectAction } from './project-action'

export function ChatList() {
  const t = useT()
  const chats = useSessionsStore((state) => state.chats)
  const activeSessionId = useSessionsStore(selectActiveSessionId)
  const rows = chats.flatMap((chat) => {
    const session = chat.sessions[0]
    return session ? [{ session, title: sessionTitle(session), cwd: chat.cwd }] : []
  })

  if (rows.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{t('sidebar.chatsEmpty')}</p>
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
  const t = useT()
  const streaming = useSessionsStore((state) => state.runtime[session.id]?.isStreaming ?? false)
  const { pending, error, runAction } = useProjectAction()
  const rename = useSessionRename(session.id, session.path)

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={rename.editing}>
          <div
            data-sidebar-hover-row
            className="group/chat relative flex h-8 min-w-0 items-center gap-0.5 rounded-md px-2"
          >
            {rename.editing ? (
              <SessionRenameField
                className="h-7 flex-1"
                value={title}
                onCommit={rename.commit}
                onCancel={rename.cancel}
              />
            ) : (
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
            )}
            {streaming ? (
              <SquaresSpinner />
            ) : (
              <SessionDeleteButton
                ariaLabel={t('sessions.deleteChat', { title })}
                disabled={pending !== null}
                onConfirm={() => void runAction('delete', () => deleteChat(cwd))}
              />
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={rename.start}>
            <PenLine data-icon="inline-start" />
            {t('common.rename')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={pending !== null}
            onSelect={() => void runAction('export', () => api.exportSession(session.id))}
          >
            <Download data-icon="inline-start" />
            {t('sessions.export')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {error || rename.error ? (
        <p role="alert" className="px-2 py-1 text-xs break-words text-destructive">
          {error || rename.error}
        </p>
      ) : null}
    </div>
  )
}

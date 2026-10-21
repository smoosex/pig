import { useMemo } from 'react'
import { useSessionsStore, selectActiveSessionId, type SessionMeta } from '../../stores/sessions'
import { withSessionForks, type SessionFork } from '../../../../shared/session-lineage'
import { sessionTitle } from '../../stores/sessions/session-title'
import { Button } from '../ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Copy, Download, PenLine } from 'lucide-react'
import { api } from '../../ipc/api'
import { cn } from '../../lib/utils'
import { SessionRenameField, useSessionRename } from '../SessionRenameField'
import { useT } from '../../hooks/useT'
import { TreeNav } from '../spectrumui/tree-nav'
import { SessionCloseButton, SessionUnreadDot } from './SessionCloseButton'
import { SessionDeleteButton } from './SessionDeleteButton'
import { useProjectAction } from './project-action'
import { SessionForkIcon } from '../SessionForkIcon'
import { sidebarButtonSurface, sidebarRowSurface } from './sidebar-surface'

export function ChatList() {
  const t = useT()
  const chats = useSessionsStore((state) => state.chats)
  const activeSessionId = useSessionsStore(selectActiveSessionId)
  // One row per chat, headed by its newest session. A chat forked from another chat keeps its own
  // directory, so the fork it came from is the other chat's row.
  const rows = useMemo(
    () =>
      withSessionForks(
        chats.flatMap((chat) => {
          const session = chat.sessions[0]
          return session
            ? [{ ...session, cwd: chat.cwd }]
            : []
        })
      ),
    [chats]
  )

  if (rows.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">{t('sidebar.chatsEmpty')}</p>
  }

  return (
    <TreeNav
      items={rows.map((row) => ({ label: sessionTitle(row), href: row.id }))}
      activeHref={activeSessionId ?? undefined}
      showHighlight={false}
      className="py-1 pr-1"
      renderItem={(_, index, active) => {
        const row = rows[index]
        return row ? <ChatRow row={row} active={active} /> : null
      }}
    />
  )
}

function ChatRow({ row, active }: { row: SessionMeta & SessionFork; active: boolean }) {
  const session = row
  const title = sessionTitle(row)
  const cwd = row.cwd
  const openExisting = useSessionsStore((state) => state.openExisting)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const deleteChat = useSessionsStore((state) => state.deleteChat)
  const t = useT()
  const streaming = useSessionsStore((state) => state.runtime[session.id]?.isStreaming ?? false)
  const unread = useSessionsStore((state) => state.runtime[session.id]?.unread ?? false)
  const { pending, error, runAction } = useProjectAction()
  const rename = useSessionRename(session.id, session.path)
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={rename.editing}>
          <div
            data-sidebar-hover-row
            data-sidebar-selected={active || undefined}
            className={cn(
              'close-reveal group/session relative flex h-8 min-w-0 items-center gap-0.5 rounded-md px-2',
              sidebarRowSurface(active)
            )}
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
                className={cn('h-8 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal', sidebarButtonSurface)}
                title={title}
                aria-current={active ? 'page' : undefined}
                disabled={pending !== null}
                onClick={() => void runAction('open', () => openExisting(session, 'chat'))}
              >
                {row.forkedFrom ? <SessionForkIcon /> : null}
                <span className="min-w-0 truncate">{title}</span>
              </Button>
            )}
            {streaming ? (
              <SessionCloseButton
                streaming
                ariaLabel={t('sessions.close', { title })}
                disabled={pending !== null}
                onClose={() => closeTab(session.id)}
              />
            ) : (
              <span className="group/close-slot relative flex size-6 shrink-0 items-center justify-center">
                {unread ? <SessionUnreadDot /> : null}
                <SessionDeleteButton
                  ariaLabel={t('sessions.deleteChat', { title })}
                  disabled={pending !== null}
                  onConfirm={() => void runAction('delete', () => deleteChat(cwd))}
                />
              </span>
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
            onSelect={() => void runAction('copy-id', () => navigator.clipboard.writeText(session.id))}
          >
            <Copy data-icon="inline-start" />
            {t('sessions.copyId')}
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

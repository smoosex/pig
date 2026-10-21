import { useMemo } from 'react'
import { CircleAlert, Copy, Download, LoaderCircle, PenLine } from 'lucide-react'
import { useSessionsStore, selectActiveSessionId, type OpenTab } from '../../stores/sessions'
import { withSessionForks, type SessionFork } from '../../../../shared/session-lineage'
import { api } from '../../ipc/api'
import { useProjectAction } from './project-action'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'
import { SessionRenameField, useSessionRename } from '../SessionRenameField'
import { HookSidebar } from '../ui/hook-sidebar'
import { SessionCloseButton } from './SessionCloseButton'
import { SessionForkIcon } from '../SessionForkIcon'
import { useT } from '../../hooks/useT'
import { sidebarButtonSurface, sidebarRowSurface } from './sidebar-surface'

export function SessionList({ sessions }: { sessions: OpenTab[] }) {
  // The tab list keeps the order the strip was left in; the fork rows it holds just hang under the
  // session they were forked from. A tab the listing has not reached yet carries no file, so it can
  // neither be nor name a parent.
  const rows = useMemo(
    () =>
      withSessionForks(
        sessions.map((tab) => ({
          tab,
          path: tab.meta?.path ?? `tab:${tab.id}`,
          modified: tab.meta?.modified ?? '',
          parentSession: tab.meta?.parentSession
        })),
        { order: 'input' }
      ),
    [sessions]
  )
  const activeIndex = useSessionsStore((state) =>
    rows.findIndex((row) => row.tab.id === selectActiveSessionId(state))
  )

  return (
    <HookSidebar
      items={rows.map((row) => ({ label: row.tab.title, href: row.tab.id }))}
      value={activeIndex}
      color="var(--primary)"
      railLeft="1.5rem"
      className="pt-0.5 pb-1"
      renderItem={(_, index) => {
        const row = rows[index]
        return row ? <SessionRow key={row.tab.id} tab={row.tab} fork={row} /> : null
      }}
    />
  )
}

type SessionTabRow = { tab: OpenTab; path: string; modified: string; parentSession?: string } & SessionFork

function SessionRow({ tab, fork }: { tab: OpenTab; fork: SessionTabRow }) {
  const session = tab
  const t = useT()
  const active = useSessionsStore((state) => selectActiveSessionId(state) === session.id)
  const streaming = useSessionsStore((state) => state.runtime[session.id]?.isStreaming ?? false)
  const unread = useSessionsStore((state) => state.runtime[session.id]?.unread ?? false)
  const activateTab = useSessionsStore((state) => state.activateTab)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const rename = useSessionRename(session.id, session.meta?.path)
  const { pending, error, runAction } = useProjectAction()
  return (
    <div className="pr-1 pl-9">
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={rename.editing}>
          <div
            data-sidebar-hover-row
            data-sidebar-selected={active || undefined}
            className={cn(
              'close-reveal group/session relative flex min-w-0 items-center gap-0.5 rounded-sm px-1',
              sidebarRowSurface(active)
            )}
          >
            {rename.editing ? (
              <SessionRenameField
                className="h-7 flex-1"
                value={session.title}
                onCommit={rename.commit}
                onCancel={rename.cancel}
              />
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className={cn('h-7 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal', sidebarButtonSurface)}
                title={session.loadError || session.title}
                onClick={() => void activateTab(session.id)}
              >
                {fork.forkedFrom ? <SessionForkIcon /> : null}
                <span className="min-w-0 truncate">{session.title}</span>
              </Button>
            )}
            {session.loadState === 'opening' ? <LoaderCircle className="animate-spin" /> : null}
            {session.loadState === 'error' ? <CircleAlert className="text-destructive" /> : null}
            <SessionCloseButton
              streaming={streaming}
              unread={unread}
              ariaLabel={t('sessions.close', { title: session.title })}
              onClose={() => closeTab(session.id)}
            />
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
        <p role="alert" className="px-1 py-1 text-xs break-words text-destructive">
          {error || rename.error}
        </p>
      ) : null}
    </div>
  )
}

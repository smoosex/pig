import { CircleAlert, LoaderCircle, PenLine, X } from 'lucide-react'
import { useSessionsStore, selectActiveSessionId, type OpenTab } from '../../stores/sessions'
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
import { SquaresSpinner } from '../RunningSpinners'

export function SessionList({ sessions }: { sessions: OpenTab[] }) {
  const activeIndex = useSessionsStore((state) =>
    sessions.findIndex((session) => session.id === selectActiveSessionId(state))
  )

  return (
    <HookSidebar
      items={sessions.map((session) => session.title)}
      value={activeIndex}
      color="var(--primary)"
      railLeft="1.5rem"
      className="pt-0.5 pb-1"
      renderItem={(_, index) => {
        const session = sessions[index]
        return session ? <SessionRow session={session} /> : null
      }}
    />
  )
}

function SessionRow({ session }: { session: OpenTab }) {
  const active = useSessionsStore((state) => selectActiveSessionId(state) === session.id)
  const streaming = useSessionsStore((state) => state.runtime[session.id]?.isStreaming ?? false)
  const activateTab = useSessionsStore((state) => state.activateTab)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const rename = useSessionRename(session.id, session.meta?.path)
  return (
    <div className="pr-1 pl-9">
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={rename.editing}>
          <div
            data-sidebar-hover-row
            className={cn(
              'group/session relative flex min-w-0 items-center gap-0.5 rounded-sm px-1 transition-colors',
              active && 'bg-sidebar-accent'
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
                className="h-7 min-w-0 flex-1 justify-start rounded-md px-0 text-left text-xs font-normal !bg-transparent"
                title={session.loadError || session.title}
                onClick={() => void activateTab(session.id)}
              >
                <span className="min-w-0 truncate">{session.title}</span>
              </Button>
            )}
            {streaming ? <SquaresSpinner /> : null}
            {session.loadState === 'opening' ? <LoaderCircle className="animate-spin" /> : null}
            {session.loadState === 'error' ? <CircleAlert className="text-destructive" /> : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
              aria-label={`关闭 ${session.title}`}
              onClick={() => closeTab(session.id)}
            >
              <X />
            </Button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={rename.start}>
            <PenLine data-icon="inline-start" />
            重命名
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {rename.error ? (
        <p role="alert" className="px-1 py-1 text-xs break-words text-destructive">
          {rename.error}
        </p>
      ) : null}
    </div>
  )
}

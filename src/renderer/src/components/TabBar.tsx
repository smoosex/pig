import { useState } from 'react'
import { CircleAlert, LoaderCircle, Plus, X } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { CloseSpin } from './RunningSpinners'
import { SessionHistoryPopover } from './SessionHistoryPopover'

export function TabBar() {
  const openTabs = useSessionsStore((state) => state.openTabs)
  const activeSessionId = useSessionsStore((state) => state.activeSessionId)
  const currentProjectCwd = useSessionsStore((state) => state.currentProjectCwd)
  const workspaceError = useSessionsStore((state) => state.workspaceError)
  const setActive = useSessionsStore((state) => state.setActive)
  const closeTab = useSessionsStore((state) => state.closeTab)
  const newSession = useSessionsStore((state) => state.newSession)
  const newChat = useSessionsStore((state) => state.newChat)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const visibleTabs = openTabs.filter((tab) => currentProjectCwd
    ? tab.kind === 'project' && tab.cwd === currentProjectCwd
    : tab.kind === 'chat')

  const createTab = async () => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    try {
      if (currentProjectCwd) await newSession(currentProjectCwd)
      else await newChat()
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 items-stretch">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleTabs.map((tab) => (
          <Tab
            key={tab.sessionId}
            sessionId={tab.sessionId}
            title={tab.title}
            active={tab.sessionId === activeSessionId}
            loading={tab.loadState === 'opening'}
            error={tab.loadState === 'error' ? tab.loadError : undefined}
            onSelect={() => setActive(tab.sessionId)}
            onClose={() => closeTab(tab.sessionId)}
          />
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="no-drag mx-1 self-center"
          aria-label="新建标签页"
          aria-busy={creating}
          title={createError ?? '新建标签页'}
          disabled={creating}
          onClick={() => void createTab()}
        >
          {creating ? (
            <LoaderCircle className="animate-spin" />
          ) : createError ? (
            <CircleAlert className="text-destructive" />
          ) : (
            <Plus />
          )}
        </Button>
      </div>
      {currentProjectCwd ? (
        <div className="no-drag relative flex shrink-0 items-center gap-0.5 px-1.5 before:absolute before:top-2 before:bottom-2 before:left-0 before:w-px before:bg-border">
          {workspaceError ? (
            <span title={workspaceError} role="alert" className="text-destructive">
              <CircleAlert />
            </span>
          ) : null}
          <SessionHistoryPopover cwd={currentProjectCwd} />
        </div>
      ) : null}
    </div>
  )
}

function Tab({
  sessionId,
  title,
  active,
  loading,
  error,
  onSelect,
  onClose
}: {
  sessionId: string
  title: string
  active: boolean
  loading: boolean
  error?: string
  onSelect: () => void
  onClose: () => void
}) {
  const streaming = useSessionsStore((state) => state.runtime[sessionId]?.isStreaming ?? false)
  return (
    <div
      className={cn(
        'no-drag relative flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs whitespace-nowrap after:absolute after:top-2 after:right-0 after:bottom-2 after:w-px after:bg-border last:after:hidden',
        active
          ? 'bg-card text-foreground before:absolute before:right-2 before:bottom-0 before:left-2 before:h-0.5 before:bg-primary'
          : 'text-muted-foreground'
      )}
      title={error}
      onClick={onSelect}
    >
      <span className="max-w-35 truncate">{title}</span>
      {loading ? <LoaderCircle className="animate-spin" aria-label="正在加载" /> : null}
      {error ? <CircleAlert className="text-destructive" aria-label={error} /> : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="no-drag text-muted-foreground hover:text-foreground"
        aria-label={`关闭 ${title}`}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <span className="relative inline-flex size-3.5 items-center justify-center">
          {streaming ? <CloseSpin /> : null}
          <X className="size-2.5" />
        </span>
      </Button>
    </div>
  )
}

import { X } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { CloseSpin } from './RunningSpinners'

export function TabBar() {
  const openTabs = useSessionsStore((s) => s.openTabs)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const setActive = useSessionsStore((s) => s.setActive)
  const closeTab = useSessionsStore((s) => s.closeTab)

  return (
    <div className="flex h-full min-h-0 flex-1 items-stretch overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {openTabs.map((t) => (
        <Tab
          key={t.sessionId}
          sessionId={t.sessionId}
          title={t.title}
          active={t.sessionId === activeSessionId}
          onSelect={() => setActive(t.sessionId)}
          onClose={() => closeTab(t.sessionId)}
        />
      ))}
    </div>
  )
}

function Tab({
  sessionId,
  title,
  active,
  onSelect,
  onClose
}: {
  sessionId: string
  title: string
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const streaming = useSessionsStore((s) => s.runtime[sessionId]?.isStreaming ?? false)
  return (
    <div
      className={cn(
        'no-drag relative flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs whitespace-nowrap after:absolute after:top-2 after:right-0 after:bottom-2 after:w-px after:bg-border last:after:hidden',
        active ? 'bg-card text-foreground' : 'text-muted-foreground'
      )}
      onClick={onSelect}
    >
      <span className="max-w-35 truncate">{title}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="no-drag text-muted-foreground hover:text-foreground"
        aria-label={`关闭 ${title}`}
        onClick={(e) => {
          e.stopPropagation()
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

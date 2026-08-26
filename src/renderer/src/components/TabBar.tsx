import { X } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

export function TabBar() {
  const openTabs = useSessionsStore((s) => s.openTabs)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const setActive = useSessionsStore((s) => s.setActive)
  const closeTab = useSessionsStore((s) => s.closeTab)

  return (
    <div className="flex h-full min-h-0 flex-1 items-stretch overflow-x-auto px-1.5">
      {openTabs.map((t) => (
        <div
          key={t.sessionId}
          className={cn(
            'no-drag relative flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-xs whitespace-nowrap after:absolute after:top-2 after:right-0 after:bottom-2 after:w-px after:bg-border last:after:hidden',
            t.sessionId === activeSessionId ? 'bg-background text-foreground' : 'text-muted-foreground'
          )}
          onClick={() => setActive(t.sessionId)}
        >
          <span className="max-w-35 truncate">{t.title}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="no-drag text-muted-foreground hover:text-foreground"
            aria-label={`关闭 ${t.title}`}
            onClick={(e) => {
              e.stopPropagation()
              closeTab(t.sessionId)
            }}
          >
            <X />
          </Button>
        </div>
      ))}
    </div>
  )
}

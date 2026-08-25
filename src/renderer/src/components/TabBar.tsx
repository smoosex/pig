import { X } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'

export function TabBar() {
  const openTabs = useSessionsStore((s) => s.openTabs)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const setActive = useSessionsStore((s) => s.setActive)
  const closeTab = useSessionsStore((s) => s.closeTab)

  return (
    <div className="flex h-full min-h-0 flex-1 items-stretch overflow-x-auto">
      {openTabs.map((t) => (
        <div
          key={t.sessionId}
          className={`no-drag flex cursor-pointer items-center gap-1.5 border-r border-line px-2.5 py-1.5 text-xs whitespace-nowrap ${
            t.sessionId === activeSessionId ? 'bg-canvas text-fg' : 'text-muted'
          }`}
          onClick={() => setActive(t.sessionId)}
        >
          <span className="max-w-35 truncate">{t.title}</span>
          <button
            className="cursor-pointer rounded border-none bg-transparent px-0.5 text-sm leading-none text-muted hover:bg-elev-2 hover:text-fg"
            onClick={(e) => {
              e.stopPropagation()
              closeTab(t.sessionId)
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
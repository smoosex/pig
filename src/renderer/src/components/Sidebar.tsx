import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useSessionsStore } from '../stores/sessions'

export function Sidebar() {
  const projects = useSessionsStore((s) => s.projects)
  const openExisting = useSessionsStore((s) => s.openExisting)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <aside className="flex w-60 shrink-0 flex-col">
      <div className="flex-1 overflow-y-auto py-1.5">
        {projects.length === 0 && <div className="px-3 py-4 text-[13px] text-muted">暂无历史会话</div>}
        {projects.map((p) => {
          const isCollapsed = collapsed[p.cwd] ?? true
          return (
            <div key={p.cwd} className="mb-0.5">
              <div
                className="flex cursor-pointer items-center gap-1 px-3 py-1 text-[13px] select-none hover:bg-elev-2"
                onClick={() => setCollapsed((c) => ({ ...c, [p.cwd]: !(c[p.cwd] ?? true) }))}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3 shrink-0 text-muted" />
                ) : (
                  <ChevronDown className="size-3 shrink-0 text-muted" />
                )}
                <span className="min-w-0 flex-1 truncate" title={p.cwd}>
                  {p.name}
                </span>
                <span className="text-[11px] text-muted">{p.sessions.length}</span>
              </div>
              {!isCollapsed &&
                p.sessions.map((s) => (
                  <div
                    key={s.id}
                    className="cursor-pointer truncate py-1 pr-3 pl-6.5 text-xs text-muted hover:bg-elev-2 hover:text-fg"
                    title={s.firstMessage}
                    onClick={() => void openExisting(s)}
                  >
                    {s.name || s.firstMessage || '(空会话)'}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
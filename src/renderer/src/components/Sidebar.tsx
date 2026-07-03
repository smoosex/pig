import { useState } from 'react'
import { api } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'

export function Sidebar() {
  const projects = useSessionsStore((s) => s.projects)
  const openExisting = useSessionsStore((s) => s.openExisting)
  const newSession = useSessionsStore((s) => s.newSession)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const handleNew = async (): Promise<void> => {
    const cwd = await api.pickDirectory()
    if (cwd) await newSession(cwd)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>会话</span>
        <button className="new-btn" onClick={() => void handleNew()}>
          + 新建
        </button>
      </div>
      <div className="sidebar-body">
        {projects.length === 0 && <div className="sidebar-empty">暂无历史会话</div>}
        {projects.map((p) => {
          const isCollapsed = collapsed[p.cwd]
          return (
            <div key={p.cwd} className="project-group">
              <div
                className="project-title"
                onClick={() => setCollapsed((c) => ({ ...c, [p.cwd]: !c[p.cwd] }))}
              >
                <span className="caret">{isCollapsed ? '▶' : '▼'}</span>
                <span className="project-name" title={p.cwd}>
                  {p.name}
                </span>
                <span className="project-count">{p.sessions.length}</span>
              </div>
              {!isCollapsed && (
                <div className="session-list">
                  {p.sessions.map((s) => (
                    <div
                      key={s.id}
                      className="session-item"
                      title={s.firstMessage}
                      onClick={() => void openExisting(s)}
                    >
                      {s.name || s.firstMessage || '(空会话)'}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
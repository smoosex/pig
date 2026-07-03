import { useSessionsStore } from '../stores/sessions'

export function TabBar() {
  const openTabs = useSessionsStore((s) => s.openTabs)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const setActive = useSessionsStore((s) => s.setActive)
  const closeTab = useSessionsStore((s) => s.closeTab)

  return (
    <div className="tabbar">
      {openTabs.map((t) => (
        <div
          key={t.sessionId}
          className={`tab ${t.sessionId === activeSessionId ? 'active' : ''}`}
          onClick={() => setActive(t.sessionId)}
        >
          <span className="tab-title">{t.title}</span>
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              closeTab(t.sessionId)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
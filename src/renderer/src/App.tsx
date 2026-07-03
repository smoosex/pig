import { useEffect } from 'react'
import { useSessionsStore } from './stores/sessions'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { useEventBridge } from './hooks/useEventBridge'

export default function App() {
  const loadProjects = useSessionsStore((s) => s.loadProjects)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  useEventBridge()

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {activeSessionId ? (
          <>
            <TabBar />
            <ChatView />
            <Composer />
          </>
        ) : (
          <div className="empty">从左侧选择或新建一个会话</div>
        )}
      </div>
    </div>
  )
}
import { useEffect, useState } from 'react'
import { useSessionsStore } from './stores/sessions'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { useEventBridge } from './hooks/useEventBridge'
import { api } from './ipc/api'
import { PanelLeft } from 'lucide-react'

function SidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="no-drag flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-muted hover:bg-elev-2 hover:text-fg"
      onClick={onClick}
      title="侧边栏"
    >
      <PanelLeft className="size-4" />
    </button>
  )
}

export default function App() {
  const loadProjects = useSessionsStore((s) => s.loadProjects)
  const newSession = useSessionsStore((s) => s.newSession)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  useEventBridge()

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const handleNew = async (): Promise<void> => {
    const cwd = await api.pickDirectory()
    if (cwd) await newSession(cwd)
  }

  return (
    <div className="flex h-full flex-col bg-elev">
      <div className="drag flex h-11 shrink-0 items-center">
        <div className={`flex h-full shrink-0 items-center pr-3 pl-19.5 ${sidebarOpen ? 'w-60' : ''}`}>
          <SidebarToggle onClick={() => setSidebarOpen((v) => !v)} />
          {sidebarOpen ? (
            <button
              type="button"
              className="no-drag ml-auto cursor-pointer rounded-md border-none bg-accent px-2 py-0.5 text-xs leading-none text-black"
              onClick={() => void handleNew()}
            >
              + 新建
            </button>
          ) : null}
        </div>
        {activeSessionId ? <TabBar /> : <div className="flex-1" />}
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? <Sidebar /> : null}
        <div className="m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-canvas">
          {activeSessionId ? (
            <>
              <ChatView />
              <Composer />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              从左侧选择或新建一个会话
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
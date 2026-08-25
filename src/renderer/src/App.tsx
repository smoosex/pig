import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { useSessionsStore } from './stores/sessions'
import { useEventBridge } from './hooks/useEventBridge'
import { Button } from './components/ui/button'
import { Empty, EmptyDescription } from './components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { cn } from './lib/utils'

function SidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="no-drag"
          onClick={onClick}
          aria-label="侧边栏"
        >
          <PanelLeft />
        </Button>
      </TooltipTrigger>
      <TooltipContent>侧边栏</TooltipContent>
    </Tooltip>
  )
}

export default function App() {
  const loadProjects = useSessionsStore((s) => s.loadProjects)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  useEventBridge()

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-card">
        <div className="drag flex h-11 shrink-0 items-center">
          <div className={cn('flex h-full shrink-0 items-center pr-3 pl-19.5', sidebarOpen && 'w-60')}>
            <SidebarToggle onClick={() => setSidebarOpen((v) => !v)} />
          </div>
          {activeSessionId ? <TabBar /> : <div className="flex-1" />}
        </div>
        <div className="flex min-h-0 flex-1">
          {sidebarOpen ? <Sidebar /> : null}
          <div className="m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-background">
            {activeSessionId ? (
              <>
                <ChatView />
                <Composer />
              </>
            ) : (
              <Empty>
                <EmptyDescription>从左侧选择或新建一个会话</EmptyDescription>
              </Empty>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

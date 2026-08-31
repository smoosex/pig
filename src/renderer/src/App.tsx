import { useEffect, useState } from 'react'
import { FolderPlus, PanelLeft } from 'lucide-react'
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
          className="no-drag translate-y-px"
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
  const openProject = useSessionsStore((s) => s.openProject)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  useEventBridge()

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-card">
        <div className="drag flex h-10 shrink-0 items-center">
          <div className={cn('flex h-full shrink-0 items-center pr-3 pl-20', sidebarOpen && 'w-62')}>
            <SidebarToggle onClick={() => setSidebarOpen((v) => !v)} />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          {sidebarOpen ? <Sidebar /> : null}
          <div className="m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-background">
            <div className="flex h-9 shrink-0 items-center overflow-hidden">
              {activeSessionId ? <TabBar /> : <div className="flex-1" />}
            </div>
            {activeSessionId ? (
              <>
                <ChatView />
                <Composer />
              </>
            ) : (
              <Empty className="gap-4">
                <EmptyDescription>从左侧选择会话，或打开一个项目</EmptyDescription>
                <Button variant="outline" size="sm" onClick={() => void openProject()}>
                  <FolderPlus />
                  打开项目
                </Button>
              </Empty>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

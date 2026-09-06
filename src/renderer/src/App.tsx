import { useEffect, useState } from 'react'
import { FolderPlus, MessageSquarePlus, PanelLeft } from 'lucide-react'
import { useSessionsStore } from './stores/sessions'
import { useEventBridge } from './hooks/useEventBridge'
import { Button } from './components/ui/button'
import { Empty, EmptyDescription } from './components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { SettingsPage } from './components/settings/SettingsPage'
import { useSettingsStore } from './stores/settings'
import { applyDocumentTheme } from './lib/theme'
import { cn } from './lib/utils'

function ThemeSync() {
  const appearance = useSettingsStore((s) => s.appearance)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)

  useEffect(() => {
    applyDocumentTheme({ appearance, lightTheme, darkTheme })
    if (appearance !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyDocumentTheme({ appearance, lightTheme, darkTheme })
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [appearance, lightTheme, darkTheme])

  return null
}

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
  const loadChats = useSessionsStore((s) => s.loadChats)
  const openProject = useSessionsStore((s) => s.openProject)
  const newChat = useSessionsStore((s) => s.newChat)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const loadSettings = useSettingsStore((s) => s.load)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEventBridge()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key !== ',' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      setSettingsOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    void loadProjects()
    void loadChats()
    void loadSettings()
  }, [loadProjects, loadChats, loadSettings])

  return (
    <TooltipProvider>
      <ThemeSync />
      <div className="flex h-full flex-col bg-background">
        <div className="drag flex h-10 shrink-0 items-center">
          <div className={cn('flex h-full shrink-0 items-center pr-3 pl-20', (sidebarOpen || settingsOpen) && 'w-62')}>
            {settingsOpen ? null : <SidebarToggle onClick={() => setSidebarOpen((v) => !v)} />}
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          {settingsOpen ? (
            <SettingsPage onClose={() => setSettingsOpen(false)} />
          ) : (
            <>
              {sidebarOpen ? <Sidebar onOpenSettings={() => setSettingsOpen(true)} /> : null}
              <div className="m-2 flex min-w-0 flex-1 flex-col rounded-xl bg-card shadow-md">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
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
                    <EmptyDescription>从左侧选择，或打开项目、开始对话</EmptyDescription>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => void openProject()}>
                        <FolderPlus />
                        打开项目
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void newChat()}>
                        <MessageSquarePlus />
                        新对话
                      </Button>
                    </div>
                  </Empty>
                )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}

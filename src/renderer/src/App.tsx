import { lazy, Suspense, useEffect, useState } from 'react'
import { FolderPlus, MessageSquarePlus, PanelLeft, PanelRight, RefreshCw } from 'lucide-react'
import { useSessionsStore, selectActiveSessionId } from './stores/sessions'
import { useDiffStore } from './stores/diff'
import { useT } from './hooks/useT'
import { useEventBridge } from './hooks/useEventBridge'
import { useSessionNames } from './hooks/useSessionNames'
import { useSessionWindows } from './hooks/useSessionWindows'
import { Button } from './components/ui/button'
import { Kbd } from './components/ui/kbd'
import { Empty, EmptyDescription } from './components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ChatView } from './components/ChatView'
import { ChangesView } from './components/diff/ChangesView'
import { WorkspacePanel } from './components/panel/WorkspacePanel'
import { Composer } from './components/Composer'
import { SettingsPage } from './components/settings/SettingsPage'
import { ProjectSessionHome } from './components/ProjectSessionHome'
import { SessionGreeting } from './components/SessionGreeting'
import { useSettingsStore } from './stores/settings'
import { applyDocumentTheme } from './lib/theme'
import { prewarmHighlighter } from './lib/highlight'
import { cn } from './lib/utils'

// The editor is the heaviest thing a tab can pull in, so it arrives with the first file that is opened.
const FileView = lazy(() => import('./components/files/FileView'))

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

function HighlighterWarmup() {
  useEffect(() => {
    const idle = requestIdleCallback(() => prewarmHighlighter(), { timeout: 3000 })
    return () => cancelIdleCallback(idle)
  }, [])

  return null
}

function SidebarToggle({ onClick }: { onClick: () => void }) {
  const t = useT()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="no-drag translate-y-px hover:bg-sidebar-accent dark:hover:bg-sidebar-accent"
          onClick={onClick}
          aria-label={t('app.sidebarLeft')}
        >
          <PanelLeft />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {t('app.sidebarLeft')} <Kbd className="bg-transparent!">⌘ E</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

export default function App() {
  const t = useT()
  const initializeProjectWorkspaces = useSessionsStore((s) => s.initializeProjectWorkspaces)
  const acquireProjectDraft = useSessionsStore((s) => s.acquireProjectDraft)
  const releaseProjectDraft = useSessionsStore((s) => s.releaseProjectDraft)
  const loadChats = useSessionsStore((s) => s.loadChats)
  const openProject = useSessionsStore((s) => s.openProject)
  const newChat = useSessionsStore((s) => s.newChat)
  const closeTab = useSessionsStore((s) => s.closeTab)
  const activeSessionId = useSessionsStore((s) => selectActiveSessionId(s))
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const projects = useSessionsStore((s) => s.projects)
  const currentProjectCwd = useSessionsStore((s) => s.currentProjectCwd)
  const workspaceRestoreError = useSessionsStore((s) => s.workspaceRestoreError)
  const draftSessionId = useSessionsStore((s) =>
    currentProjectCwd ? (s.draftSessionByCwd[currentProjectCwd] ?? null) : null
  )
  const activeTab = useSessionsStore((s) =>
    s.openTabs.find((tab) => tab.id === s.activeTabId)
  )
  const loadSettings = useSettingsStore((s) => s.load)
  const loadReviewPrefs = useDiffStore((s) => s.loadReviewPrefs)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEventBridge()
  useSessionWindows()
  useSessionNames()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return
      if (event.isComposing || event.keyCode === 229) return
      if (event.shiftKey) {
        if (event.key.toLowerCase() === 'a') {
          event.preventDefault()
          if (!event.repeat) void openProject()
        } else if (event.key.toLowerCase() === 'e') {
          event.preventDefault()
          // The right column only exists inside a project, so outside one the key does nothing.
          if (!event.repeat && currentProjectCwd) {
            const diff = useDiffStore.getState()
            diff.setReviewOpen(!diff.reviewOpen)
          }
        }
        return
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault()
        setSidebarOpen((open) => !open)
      } else if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (!event.repeat && activeTabId) closeTab(activeTabId)
      } else if (event.key === ',') {
        event.preventDefault()
        if (!event.repeat) setSettingsOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [activeTabId, closeTab, currentProjectCwd, openProject])

  useEffect(() => {
    void initializeProjectWorkspaces()
    void loadChats()
    void loadSettings()
    void loadReviewPrefs()
  }, [initializeProjectWorkspaces, loadChats, loadSettings, loadReviewPrefs])

  const diffTab = activeTab?.kind === 'diff' ? activeTab : null
  const fileTab = activeTab?.kind === 'file' ? activeTab : null
  const reviewOpen = useDiffStore((s) => s.reviewOpen)
  const setReviewOpen = useDiffStore((s) => s.setReviewOpen)
  const sessionReady = Boolean(activeSessionId && activeTab?.loadState === 'ready')
  const projectHome = Boolean(currentProjectCwd && !activeTabId)
  const restoreError = !currentProjectCwd && !activeTab ? workspaceRestoreError : null
  const currentProject = currentProjectCwd
    ? projects.find((project) =>
        project.cwd === currentProjectCwd ||
        project.worktrees?.some((worktree) => worktree.cwd === currentProjectCwd)
      )
    : undefined
  const currentWorktree = currentProject?.worktrees?.find(
    (worktree) => worktree.cwd === currentProjectCwd
  )
  const composerWorkspace = currentProject
    ? {
        project: currentProject.name,
        branch: currentWorktree?.branch ?? currentProject.name
      }
    : null

  useEffect(() => {
    if (!projectHome || !currentProjectCwd) return
    const cwd = currentProjectCwd
    acquireProjectDraft(cwd)
    return () => releaseProjectDraft(cwd)
  }, [acquireProjectDraft, currentProjectCwd, projectHome, releaseProjectDraft])

  return (
    <TooltipProvider>
      <ThemeSync />
      <HighlighterWarmup />
      <div className="flex h-full flex-col bg-background">
        <div className="drag flex h-10 shrink-0 items-center">
          <div className={cn('flex h-full shrink-0 items-center pr-3 pl-20', (sidebarOpen || settingsOpen) && 'w-62')}>
            {settingsOpen ? null : <SidebarToggle onClick={() => setSidebarOpen((v) => !v)} />}
          </div>
          <div className="flex-1" />
          {currentProjectCwd && !settingsOpen ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="no-drag mr-3 translate-y-px hover:bg-sidebar-accent dark:hover:bg-sidebar-accent"
                  aria-label={t('app.sidebarRight')}
                  aria-pressed={reviewOpen}
                  onClick={() => setReviewOpen(!reviewOpen)}
                >
                  <PanelRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t('app.sidebarRight')} <Kbd className="bg-transparent!">⌘ ⇧ E</Kbd>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1">
          <Sidebar hidden={!sidebarOpen || settingsOpen} onOpenSettings={() => setSettingsOpen(true)} />
          {settingsOpen ? (
            <SettingsPage onClose={() => setSettingsOpen(false)} />
          ) : (
            <>
              <div className="m-2 flex min-w-0 flex-1 flex-col rounded-xl bg-chat-background shadow-md">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
                <div className="flex h-9 shrink-0 items-center overflow-hidden">
                  {currentProjectCwd || activeTabId ? <TabBar /> : <div className="flex-1" />}
                </div>
                {diffTab ? (
                  <ChangesView cwd={diffTab.cwd} />
                ) : fileTab?.path ? (
                  <Suspense
                    fallback={<p className="px-3 py-2 text-xs text-muted-foreground">{t('app.openingFile')}</p>}
                  >
                    <FileView cwd={fileTab.cwd} path={fileTab.path} />
                  </Suspense>
                ) : sessionReady || projectHome ? (
                  <>
                    {sessionReady ? <ChatView /> : <SessionGreeting />}
                    <Composer
                      draftCwd={projectHome ? currentProjectCwd! : undefined}
                      draftSessionId={projectHome ? draftSessionId : null}
                      workspace={composerWorkspace}
                    />
                    {projectHome ? <ProjectSessionHome cwd={currentProjectCwd!} /> : null}
                  </>
                ) : (
                  <Empty className="gap-4">
                    <EmptyDescription>
                      {restoreError
                        ? t('app.restoreFailed', { error: restoreError })
                        : activeTab?.loadState === 'opening'
                        ? t('app.loadingSession')
                        : activeTab?.loadState === 'error'
                          ? activeTab.loadError || t('app.loadFailed')
                          : currentProjectCwd
                            ? t('app.emptyInProject')
                            : t('app.emptyNoProject')}
                    </EmptyDescription>
                    {!currentProjectCwd && !activeTab ? (
                      <div className="flex items-center gap-2">
                        {restoreError ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void initializeProjectWorkspaces()}
                          >
                            <RefreshCw />
                            {t('app.retryRestore')}
                          </Button>
                        ) : null}
                        <Button variant="outline" size="sm" onClick={() => void openProject()}>
                          <FolderPlus />
                          {t('app.openProject')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => void newChat()}>
                          <MessageSquarePlus />
                          {t('app.newChat')}
                        </Button>
                      </div>
                    ) : null}
                  </Empty>
                )}
              </div>
            </div>
            {currentProjectCwd ? <WorkspacePanel cwd={currentProjectCwd} hidden={!reviewOpen} /> : null}
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}

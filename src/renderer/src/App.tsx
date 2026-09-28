import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { PanelLeft, PanelRight, RefreshCw } from 'lucide-react'
import { useSessionsStore, selectActiveSessionId } from './stores/sessions'
import { useDiffStore } from './stores/diff'
import { useT } from './hooks/useT'
import { useEventBridge } from './hooks/useEventBridge'
import { useSessionNames } from './hooks/useSessionNames'
import { api } from './ipc/api'
import { openNotifiedSession } from './chat/notification-navigation'
import { useSessionWindows } from './hooks/useSessionWindows'
import { Button } from './components/ui/button'
import { Kbd } from './components/ui/kbd'
import { Empty, EmptyDescription } from './components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import { Sidebar } from './components/Sidebar'
import { GooglyEyesButton } from './components/ui/googly-eyes-button'
import { useSidebarPreferences } from './components/sidebar/use-sidebar-preferences'
import type { SidebarTab } from '../../shared/api'
import { TabBar } from './components/TabBar'
import { halfSwitch } from './components/tab-strip'
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
  const setWorkspaceRestoreMode = useSessionsStore((s) => s.setWorkspaceRestoreMode)
  const acquireProjectDraft = useSessionsStore((s) => s.acquireProjectDraft)
  const releaseProjectDraft = useSessionsStore((s) => s.releaseProjectDraft)
  const acquireChatDraft = useSessionsStore((s) => s.acquireChatDraft)
  const releaseChatDraft = useSessionsStore((s) => s.releaseChatDraft)
  const focusChatHome = useSessionsStore((s) => s.focusChatHome)
  const retryChatDraft = useSessionsStore((s) => s.retryChatDraft)
  const chatDraft = useSessionsStore((s) => s.chatDraft)
  const chatDraftError = useSessionsStore((s) => s.chatDraftError)
  const workspaceError = useSessionsStore((s) => s.workspaceError)
  const loadChats = useSessionsStore((s) => s.loadChats)
  const openProject = useSessionsStore((s) => s.openProject)
  const closeTab = useSessionsStore((s) => s.closeTab)
  const activeSessionId = useSessionsStore((s) => selectActiveSessionId(s))
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const openTabs = useSessionsStore((s) => s.openTabs)
  const setActiveTab = useSessionsStore((s) => s.setActive)
  const selectProjectCwd = useSessionsStore((s) => s.selectProjectCwd)
  const projects = useSessionsStore((s) => s.projects)
  const currentProjectCwd = useSessionsStore((s) => s.currentProjectCwd)
  const restoredProjectCwd = useSessionsStore((s) => s.restoredProjectCwd)
  const workspaceRestoreError = useSessionsStore((s) => s.workspaceRestoreError)
  const draftSessionId = useSessionsStore((s) =>
    currentProjectCwd ? (s.draftSessionByCwd[currentProjectCwd] ?? null) : null
  )
  const workspaceRestoreReady = useSessionsStore((s) => s.workspaceRestoreReady)
  const activeTab = useSessionsStore((s) =>
    s.openTabs.find((tab) => tab.id === s.activeTabId)
  )
  const loadSettings = useSettingsStore((s) => s.load)
  const loadReviewPrefs = useDiffStore((s) => s.loadReviewPrefs)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const { tab: sidebarTab, setTab: setSidebarTab, ready: sidebarReady, error: sidebarPrefsError } = useSidebarPreferences()
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * What each half of the switcher was left on. A chat clears `currentProjectCwd`, so the worktree
   * the projects half sat in has to be remembered here; the chat half remembers its tab because the
   * strip's own memory is per worktree and chats have none.
   */
  const projectFocusCwd = useRef<string | null>(null)
  const chatFocusTabId = useRef<string | null>(null)
  const requestedWorkspaceRestore = useRef(false)
  useEventBridge()
  useSessionWindows()
  useSessionNames()

  useEffect(() => api.onNotificationClick((sessionId) => {
    openNotifiedSession(sessionId, sidebarTab, setSidebarTab, setWorkspaceRestoreMode, () => setSettingsOpen(false))
  }), [sidebarTab, setSidebarTab, setWorkspaceRestoreMode])

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
    if (!sidebarReady || requestedWorkspaceRestore.current) return
    requestedWorkspaceRestore.current = true
    void initializeProjectWorkspaces(sidebarTab === 'chats')
  }, [initializeProjectWorkspaces, sidebarReady, sidebarTab])

  useEffect(() => {
    void loadChats()
    void loadSettings()
    void loadReviewPrefs()
  }, [loadChats, loadSettings, loadReviewPrefs])

  const diffTab = activeTab?.kind === 'diff' ? activeTab : null
  const fileTab = activeTab?.kind === 'file' ? activeTab : null
  const reviewOpen = useDiffStore((s) => s.reviewOpen)
  const setReviewOpen = useDiffStore((s) => s.setReviewOpen)
  const sessionReady = Boolean(activeSessionId && activeTab?.loadState === 'ready')
  const projectHome = Boolean(currentProjectCwd && !activeTabId)
  /**
   * Nothing open at all: the chats half's own home, a chat the first message turns into a tab. It
   * waits for the restore, which is what decides whether a worktree was open to show instead.
   */
  const chatHome = Boolean(workspaceRestoreReady && !activeTab && !currentProjectCwd && !workspaceRestoreError)
  const restoreError = !currentProjectCwd && !activeTab ? workspaceRestoreError : null
  const currentProject = currentProjectCwd
    ? projects.find((project) =>
        project.cwd === currentProjectCwd ||
        project.worktrees?.some((worktree) => worktree.cwd === currentProjectCwd)
      )
    : undefined
  /** What the projects half may still return to: a worktree nobody lists is not one of them. */
  const knownProjectCwds = new Set(
    projects.flatMap((project) => [
      project.cwd,
      ...(project.worktrees ?? []).map((worktree) => worktree.cwd)
    ])
  )
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

  useEffect(() => {
    if (!chatHome) return
    acquireChatDraft()
    return () => releaseChatDraft()
  }, [acquireChatDraft, chatHome, releaseChatDraft])

  useEffect(() => {
    if (!activeTab) {
      if (currentProjectCwd) projectFocusCwd.current = currentProjectCwd
      return
    }
    if (activeTab.kind === 'chat') chatFocusTabId.current = activeTab.id
    else projectFocusCwd.current = activeTab.cwd
  }, [activeTab, currentProjectCwd])

  /**
   * The switcher moves the content pane with it: the half being entered shows the session it was
   * left on, or its newest tab when that one is gone. The chats half with nothing open shows its
   * own home, so the pane never keeps the half that was just left.
   */
  const switchSidebarTab = (next: SidebarTab) => {
    if (next === sidebarTab) return
    setSidebarTab(next)
    // Keep the restore mode in sync now: the scan may finish before a sidebarTab effect runs.
    setWorkspaceRestoreMode(next === 'chats')
    const action = halfSwitch(
      openTabs,
      next,
      activeTabId,
      currentProjectCwd,
      chatFocusTabId.current,
      projectFocusCwd.current ?? restoredProjectCwd,
      knownProjectCwds
    )
    if (action.kind === 'chat') setActiveTab(action.tabId)
    else if (action.kind === 'project') void selectProjectCwd(action.cwd)
    else if (action.kind === 'chatHome') focusChatHome()
  }

  return (
    <TooltipProvider disableHoverableContent>
      <ThemeSync />
      <HighlighterWarmup />
      <div className="flex h-full flex-col bg-background">
        <div className="drag flex h-10 shrink-0 items-center">
          <div className={cn('flex h-full shrink-0 items-center gap-1 pr-3 pl-20', (sidebarOpen || settingsOpen) && 'w-62')}>
            {settingsOpen ? null : (
              <>
                <SidebarToggle onClick={() => setSidebarOpen((v) => !v)} />
                <GooglyEyesButton
                  label={t(sidebarTab === 'projects' ? 'sidebar.projects' : 'sidebar.chats')}
                  alternateLabel={t(sidebarTab === 'projects' ? 'sidebar.chats' : 'sidebar.projects')}
                  pressed={sidebarTab === 'chats'}
                  ariaLabel={t('sidebar.tabsAria')}
                  // The toolbar's icon buttons are h-7; match the button, not its icon.
                  height={28}
                  onClick={() => switchSidebarTab(sidebarTab === 'projects' ? 'chats' : 'projects')}
                />
              </>
            )}
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
          <Sidebar
            hidden={!sidebarOpen || settingsOpen}
            onOpenSettings={() => setSettingsOpen(true)}
            tab={sidebarTab}
            preferencesError={sidebarPrefsError}
          />
          {settingsOpen ? (
            <SettingsPage onClose={() => setSettingsOpen(false)} />
          ) : (
            <>
              <div className="m-2 flex min-w-0 flex-1 flex-col rounded-xl bg-chat-background shadow-md">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
                <div className="flex h-9 shrink-0 items-center overflow-hidden">
                  {currentProjectCwd || activeTabId ? <TabBar sidebarTab={sidebarTab} /> : <div className="flex-1" />}
                </div>
                {diffTab ? (
                  <ChangesView cwd={diffTab.cwd} />
                ) : fileTab?.path ? (
                  <Suspense
                    fallback={<p className="px-3 py-2 text-xs text-muted-foreground">{t('app.openingFile')}</p>}
                  >
                    <FileView cwd={fileTab.cwd} path={fileTab.path} />
                  </Suspense>
                ) : sessionReady || projectHome || chatHome ? (
                  <>
                    {sessionReady ? <ChatView /> : <SessionGreeting />}
                    {chatHome && (chatDraftError || workspaceError) ? (
                      <div
                        role="alert"
                        className="flex flex-col items-center gap-1 px-3.5 pb-2 text-xs text-destructive"
                      >
                        {chatDraftError ? (
                          <span className="flex items-center gap-2">
                            {chatDraftError}
                            <Button variant="outline" size="xs" onClick={retryChatDraft}>
                              <RefreshCw />
                              {t('common.retry')}
                            </Button>
                          </span>
                        ) : null}
                        {/* A chat or draft that could not be taken back leaves no tab to report it in. */}
                        {workspaceError ? <span>{workspaceError}</span> : null}
                      </div>
                    ) : null}
                    <Composer
                      draftCwd={projectHome ? currentProjectCwd! : chatHome ? chatDraft?.cwd : undefined}
                      draftSessionId={
                        projectHome ? draftSessionId : chatHome ? (chatDraft?.sessionId ?? null) : null
                      }
                      workspace={composerWorkspace}
                    />
                    {projectHome ? <ProjectSessionHome cwd={currentProjectCwd!} /> : null}
                  </>
                ) : (
                  <Empty className="gap-4">
                    <EmptyDescription>
                      {restoreError
                        ? t('app.restoreFailed', { error: restoreError })
                        : activeTab?.loadState === 'error'
                          ? activeTab.loadError || t('app.loadFailed')
                          : t('app.loadingSession')}
                    </EmptyDescription>
                    {restoreError ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void initializeProjectWorkspaces(sidebarTab === 'chats')}
                      >
                        <RefreshCw />
                        {t('app.retryRestore')}
                      </Button>
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

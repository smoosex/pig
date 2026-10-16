import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { PanelLeft, PanelRight, RefreshCw } from 'lucide-react'
import { useSessionsStore, selectActiveSessionId } from './stores/sessions'
import { useDiffStore } from './stores/diff'
import { useT } from './hooks/useT'
import { useEventBridge } from './hooks/useEventBridge'
import { useSessionNames } from './hooks/useSessionNames'
import { useWorktreeDeletions } from './hooks/useWorktreeDeletions'
import { api } from './ipc/api'
import { openNotifiedSession } from './chat/notification-navigation'
import { SystemPluginUI } from './components/SystemPluginUI'
import { SubagentTranscriptDialog } from './components/subagents/SubagentTranscriptDialog'
import { SubagentCloseConfirm } from './components/subagents/SubagentCloseConfirm'
import { ExtensionUI } from './components/ExtensionUI'
import { useToolSettingsStore } from './stores/tool-settings'
import { useSessionWindows } from './hooks/useSessionWindows'
import { useModelCatalog } from './hooks/useModelCatalog'
import { useModelCatalogStore } from './stores/model-catalog'
import { Alert, AlertAction, AlertDescription, AlertTitle } from './components/ui/alert'
import { Button } from './components/ui/button'
import { Kbd } from './components/ui/kbd'
import { Empty, EmptyDescription } from './components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import { Sidebar } from './components/Sidebar'
import { GooglyEyesButton } from './components/ui/googly-eyes-button'
import { useSidebarPreferences } from './components/sidebar/use-sidebar-preferences'
import { sidebarSurfaceHover, sidebarSurfaceToggle } from './components/sidebar/sidebar-surface'
import type { SidebarTab } from '../../shared/api'
import { NewTabButton, TabBar } from './components/TabBar'
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

import { useSplitLayoutStore, collectPaneNodes, type PaneNode } from './stores/split-layout'
import { SplitPaneContainer } from './components/chat/SplitPaneContainer'
import { SplitPaneOverlay } from './components/chat/SplitPaneOverlay'

// The editor is the heaviest thing a tab can pull in, so it arrives with the first file that is opened.
const FileView = lazy(() => import('./components/files/FileView'))

function ThemeSync() {
  const appearance = useSettingsStore((s) => s.appearance)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)
  const surfaceStyle = useSettingsStore((s) => s.surfaceStyle)

  useEffect(() => {
    applyDocumentTheme({ appearance, lightTheme, darkTheme, surfaceStyle })
    if (appearance !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyDocumentTheme({ appearance, lightTheme, darkTheme, surfaceStyle })
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [appearance, lightTheme, darkTheme, surfaceStyle])

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
          className={cn('no-drag translate-y-px', sidebarSurfaceHover)}
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

export function PaneViewContent({
  node,
  isActive,
  composerWorkspace
}: {
  node: PaneNode
  isActive: boolean
  composerWorkspace: { project: string; branch: string } | null
}) {
  const t = useT()
  const paneTab = useSessionsStore((s) => s.openTabs.find((item) => item.id === node.tabId))
  const runtime = useSessionsStore((s) => s.runtime[node.tabId])
  const isDiff = paneTab?.kind === 'diff'
  const isFile = paneTab?.kind === 'file'

  useEffect(() => {
    if (
      paneTab &&
      !isDiff &&
      !isFile &&
      paneTab.loadState === 'cold'
    ) {
      void useSessionsStore.getState().activateTab(node.tabId)
    }
  }, [paneTab, isDiff, isFile, node.tabId])

  if (paneTab?.loadState === 'error') {
    return (
      <Empty>
        <EmptyDescription role="alert">{paneTab.loadError || t('app.loadFailed')}</EmptyDescription>
        <Button variant="outline" size="xs" onClick={() => void useSessionsStore.getState().activateTab(node.tabId)}>
          <RefreshCw data-icon="inline-start" />
          {t('common.retry')}
        </Button>
      </Empty>
    )
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col">
      {isDiff ? (
        <ChangesView cwd={paneTab.cwd} />
      ) : isFile && paneTab.path ? (
        <Suspense
          fallback={<p className="px-3 py-2 text-xs text-muted-foreground">{t('app.openingFile')}</p>}
        >
          <FileView cwd={paneTab.cwd} path={paneTab.path} />
        </Suspense>
      ) : (
        <>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {paneTab?.loadState === 'opening' || (paneTab?.loadState === 'cold' && !runtime) ? (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                {t('app.loadingSession')}
              </div>
            ) : (
              <ChatView explicitSessionId={node.tabId} />
            )}
          </div>
          <Composer explicitSessionId={node.tabId} isActive={isActive} workspace={composerWorkspace} />
        </>
      )}
    </div>
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
  const splitRoot = useSplitLayoutStore((s) => s.root)
  const splitDragOver = useSplitLayoutStore((s) => s.dragOver)
  const splitPaneNodes = splitRoot ? collectPaneNodes(splitRoot) : []
  const splitTabIdSet = new Set(splitPaneNodes.map((p) => p.tabId))
  const isMultiPane = splitPaneNodes.length > 1 && Boolean(activeTabId && splitTabIdSet.has(activeTabId))

  useEffect(() => {
    const openTabIds = new Set(openTabs.map((t) => t.id))
    for (const pane of splitPaneNodes) {
      if (!openTabIds.has(pane.tabId)) {
        useSplitLayoutStore.getState().closePane(pane.id)
      }
    }
  }, [openTabs, splitRoot])
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
  useWorktreeDeletions()
  useModelCatalog()
  const modelCatalogError = useModelCatalogStore((s) => s.error)
  const modelCatalogLoading = useModelCatalogStore((s) => s.loading)

  useEffect(() => api.onMcpChanged(() => {
    const store = useToolSettingsStore.getState()
    if (store.loaded) void store.load()
  }), [])

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
      <SystemPluginUI activeSessionId={activeSessionId} />
      <SubagentTranscriptDialog />
      <SubagentCloseConfirm />
      <ExtensionUI />
      <div data-app-surface className="flex h-full flex-col transition-[background-color] duration-200 ease-in-out motion-reduce:transition-none solid:bg-background">
        <header data-app-header className="drag relative flex h-10 min-w-0 shrink-0 items-center justify-between">
          <div data-header-leading className={cn('flex h-full shrink-0 items-center gap-1 pr-3 pl-20', (sidebarOpen || settingsOpen) && 'w-62')}>
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
          {/* Keep both 248px rails and the card's 8px gutters reserved when either sidebar is hidden. */}
          <div data-header-tabs className="absolute inset-x-64 inset-y-1 flex min-w-0 items-center justify-center">
            {!settingsOpen && (currentProjectCwd || activeTabId) ? <TabBar sidebarTab={sidebarTab} /> : null}
          </div>
          {!settingsOpen && (currentProjectCwd || activeTabId) ? (
            <div data-header-trailing className="flex h-full shrink-0 items-center gap-1 pl-2 pr-3">
              <NewTabButton sidebarTab={sidebarTab} />
              {currentProjectCwd ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn('no-drag translate-y-px', sidebarSurfaceToggle)}
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
          ) : null}
        </header>
        {modelCatalogError ? (
          <Alert variant="destructive">
            <AlertTitle>{t('model.loadFailed')}</AlertTitle>
            <AlertDescription>{modelCatalogError}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="xs"
                disabled={modelCatalogLoading}
                onClick={() => void useModelCatalogStore.getState().load()}
              >
                {t('common.retry')}
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
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
              <div
                data-content-surface
                className={cn(
                  'm-2 flex min-w-96 flex-1 flex-col rounded-xl transition-[background-color,box-shadow,backdrop-filter] duration-200 ease-in-out motion-reduce:transition-none',
                  // One material backplate per container; reading tabs and panes keep their opaque surfaces.
                  !isMultiPane && (diffTab || fileTab)
                    ? 'bg-chat-background shadow-md'
                    : 'bg-glass-background backdrop-blur-xl shadow-glass-panel ring-1 ring-glass-border solid:bg-chat-background solid:backdrop-blur-none solid:shadow-md solid:ring-0'
                )}
              >
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
                  <div
                    className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                    data-pane-id={isMultiPane ? undefined : activeTabId ?? 'single'}
                  >
                    {isMultiPane ? (
                      <SplitPaneContainer
                        className="flex-1 min-h-0 min-w-0"
                        renderPane={(node: PaneNode, isActive) => (
                          <PaneViewContent node={node} isActive={isActive} composerWorkspace={composerWorkspace} />
                        )}
                      />
                    ) : diffTab ? (
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
                    {!isMultiPane && (
                      <SplitPaneOverlay
                        position={splitDragOver?.paneId === (activeTabId ?? 'single') ? splitDragOver.position : null}
                      />
                    )}
                  </div>
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

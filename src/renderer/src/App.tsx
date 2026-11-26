import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, FolderPlus, PanelLeft, PanelRight, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { useIsPresent } from 'motion/react'
import { useSessionsStore, selectActiveSessionId } from './stores/sessions'
import { isSessionEmpty } from './chat/session-empty'
import { useDiffStore } from './stores/diff'
import { useT } from './hooks/useT'
import { useFloatingSidebar } from './hooks/useFloatingSidebar'
import { useEventBridge } from './hooks/useEventBridge'
import { useSessionNames } from './hooks/useSessionNames'
import { useWorktreeDeletions } from './hooks/useWorktreeDeletions'
import { useBrowserAgentRequests } from './hooks/useBrowserAgentRequests'
import { useTerminalAgentRequests } from './hooks/useTerminalAgentRequests'
import { useSessionAgentRequests } from './hooks/useSessionAgentRequests'
import { api } from './ipc/api'
import { openNotifiedSession } from './chat/notification-navigation'
import { visibleNotificationSessions } from './chat/notification-visibility'
import { SystemPluginUI } from './components/SystemPluginUI'
import { SubagentTranscriptDialog } from './components/subagents/SubagentTranscriptDialog'
import { SubagentCloseConfirm } from './components/subagents/SubagentCloseConfirm'
import { QuitConfirm } from './components/QuitConfirm'
import { ExtensionUI } from './components/ExtensionUI'
import { useToolSettingsStore } from './stores/tool-settings'
import { useSessionWindows } from './hooks/useSessionWindows'
import { useModelCatalog } from './hooks/useModelCatalog'
import { useModelCatalogStore } from './stores/model-catalog'
import { Alert, AlertAction, AlertDescription, AlertTitle } from './components/ui/alert'
import { Button } from './components/ui/button'
import { ShortcutKbd } from './components/ShortcutKbd'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip'
import { Sidebar } from './components/Sidebar'
import { DreamDialogHost } from './components/settings/DreamSettings'
import { useBotStore } from './stores/bot'
import { useComposerDraftsStore } from './stores/composer-drafts'
import { useKanbanStore } from './stores/kanban'
import { BotOrbButton } from './components/bot/BotOrbButton'
import { BotPeekBubble } from './components/bot/BotPeekBubble'
import { BotPage } from './components/bot/BotPage'
import { KanbanHeader } from './components/kanban/KanbanHeader'
import { KanbanIssueDialog } from './components/kanban/KanbanIssueDialog'
import { KanbanToggleButton } from './components/kanban/KanbanToggleButton'
import { KanbanView } from './components/kanban/KanbanView'
import { useSidebarPreferences } from './components/sidebar/use-sidebar-preferences'
import { sidebarSurfaceHover, sidebarSurfaceToggle } from './components/sidebar/sidebar-surface'
import type { KanbanIssue, SidebarTab } from '../../shared/api'
import { NewTabButton, TabBar, newStripSession } from './components/TabBar'
import { halfSwitch, stripSlots, visibleTabsFor } from './components/tab-strip'
import { isChatScope } from './stores/sessions/tab-order'
import type { OpenTab } from './stores/sessions'
import { BrowserPanel } from './components/browser/BrowserPanel'
import { ChatView } from './components/ChatView'
import { ReplyBookmarks } from './components/ReplyBookmarks'
import { ChangesView } from './components/diff/ChangesView'
import { TurnDiffPanel } from './components/diff/TurnDiffPanel'
import { WorkspacePanel } from './components/panel/WorkspacePanel'
import { WorkspaceLayout } from './components/WorkspaceLayout'
import { Composer } from './components/Composer'
import { SettingsPage } from './components/settings/SettingsPage'
import { ProjectSessionHome } from './components/ProjectSessionHome'
import { ProjectPickerDialog } from './components/projects/ProjectPickerDialog'
import { MoveProjectDialog } from './components/projects/MoveProjectDialog'
import { SessionGreeting } from './components/SessionGreeting'
import { subscribeSettingsChanges, useSettingsStore } from './stores/settings'
import { applyDocumentTheme } from './lib/theme'
import { prewarmHighlighter } from './lib/highlight'
import { captureStartupBlueprint } from './lib/startup-blueprint'
import { cn } from './lib/utils'
import { eventAccelerator, isComposingKey, isShortcutRecording, isTerminalShellChord, shortcutBindings } from './lib/shortcuts'
import { findShortcut, HOST_SHORTCUT_ACTIONS, TAB_SELECT_ACTIONS, type HostShortcutAction } from '../../shared/shortcuts'
import { failureMessage } from './lib/ipc-error'

import { useSplitLayoutStore, allPanes, collectPaneNodes, groupOfTab, paneOfTab, type PaneNode } from './stores/split-layout'
import { SplitPaneContainer } from './components/chat/SplitPaneContainer'

// The editor is the heaviest thing a tab can pull in, so it arrives with the first file that is opened.
const FileView = lazy(() => import('./components/files/FileView'))
const TerminalPanel = lazy(() => import('./components/terminal/TerminalPanel'))

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
        {t('app.sidebarLeft')} <ShortcutKbd action="sidebar.toggleLeft" />
      </TooltipContent>
    </Tooltip>
  )
}

function BrowserTabContent({ tab, active, surfaceVisible }: { tab: OpenTab; active: boolean; surfaceVisible: boolean }) {
  const present = useIsPresent()
  const targetSessionId = useSessionsStore((state) => {
    const realTarget = (id: string | null | undefined) => state.openTabs.find((item) =>
      item.id === id && (item.kind === 'project' || item.kind === 'chat') &&
      (!tab.cwd || item.cwd === tab.cwd)
    )?.id
    // No guessing: the session the browser was opened from, or one the user picked; otherwise none.
    return realTarget(tab.browserTargetSessionId) ?? null
  })
  // A mounted pane is visible even when another split pane owns keyboard focus.
  return (
    <BrowserPanel
      browserId={tab.id}
      targetSessionId={targetSessionId}
      active={present && surfaceVisible}
      focused={active && present && surfaceVisible}
      onFocus={() => {
        const layout = useSplitLayoutStore.getState()
        const pane = paneOfTab(layout.groups, tab.id)
        if (pane) layout.setActivePane(pane.id)
        useSessionsStore.getState().setActive(tab.id)
      }}
    />
  )
}

function TerminalTabContent({ tab, active }: { tab: OpenTab; active: boolean }) {
  const present = useIsPresent()
  return (
    <Suspense fallback={null}>
      <TerminalPanel terminalId={tab.id} cwd={tab.cwd || null} active={active && present} onFocus={() => {
        const layout = useSplitLayoutStore.getState()
        const pane = paneOfTab(layout.groups, tab.id)
        if (pane) layout.setActivePane(pane.id)
        if (useSessionsStore.getState().activeTabId !== tab.id) useSessionsStore.getState().setActive(tab.id)
      }} />
    </Suspense>
  )
}

export const PaneViewContent = memo(function PaneViewContent({
  node,
  isActive,
  surfaceVisible = true,
  composerWorkspace
}: {
  node: PaneNode
  isActive: boolean
  surfaceVisible?: boolean
  composerWorkspace: { project: string; branch: string } | null
}) {
  const t = useT()
  const present = useIsPresent()
  const paneTab = useSessionsStore((s) => s.openTabs.find((item) => item.id === node.tabId))
  const runtime = useSessionsStore((s) => s.runtime[node.tabId])
  const empty = useSessionsStore((s) => paneTab?.loadState === 'ready' && isSessionEmpty(s.runtime[node.tabId]))
  const isDiff = paneTab?.kind === 'diff'
  const isFile = paneTab?.kind === 'file'
  const isTurnDiff = paneTab?.kind === 'turn-diff'

  useEffect(() => {
    if (
      paneTab &&
      !isDiff &&
      !isFile &&
      !isTurnDiff &&
      paneTab.kind !== 'browser' &&
      paneTab.kind !== 'terminal' &&
      paneTab.loadState === 'cold'
    ) {
      void useSessionsStore.getState().activateTab(node.tabId)
    }
  }, [paneTab, isDiff, isFile, isTurnDiff, node.tabId])

  if (!paneTab) return null
  if (paneTab.loadState === 'error') {
    return (
      <Empty>
        <EmptyDescription role="alert">{paneTab.loadError || t('app.loadFailed')}</EmptyDescription>
        <Button variant="outline" size="xs" onClick={() => void useSessionsStore.getState().activateTab(node.tabId)}>
          <RotateCw data-icon="inline-start" />
          {t('common.retry')}
        </Button>
      </Empty>
    )
  }

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col">
      {paneTab?.kind === 'browser' ? (
        <BrowserTabContent tab={paneTab} active={isActive} surfaceVisible={surfaceVisible} />
      ) : paneTab?.kind === 'terminal' ? (
        <TerminalTabContent tab={paneTab} active={isActive && surfaceVisible} />
      ) : isDiff ? (
        <ChangesView cwd={paneTab.cwd} />
      ) : isTurnDiff && paneTab.turnDiff ? (
        <TurnDiffPanel tab={paneTab} />
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
          <Composer explicitSessionId={node.tabId} isActive={isActive && present} centered={empty} workspace={composerWorkspace} />
          {empty ? <div className="min-h-0 flex-1" /> : null}
        </>
      )}
    </div>
  )
})

export default function App() {
  const t = useT()
  const initializeProjectWorkspaces = useSessionsStore((s) => s.initializeProjectWorkspaces)
  const setWorkspaceRestoreMode = useSessionsStore((s) => s.setWorkspaceRestoreMode)
  const acquireProjectDraft = useSessionsStore((s) => s.acquireProjectDraft)
  const releaseProjectDraft = useSessionsStore((s) => s.releaseProjectDraft)
  const openProject = useSessionsStore((s) => s.openProject)
  const closeTab = useSessionsStore((s) => s.closeTab)
  const activeSessionId = useSessionsStore((s) => selectActiveSessionId(s))
  const activeTabId = useSessionsStore((s) => s.activeTabId)
  const openTabs = useSessionsStore((s) => s.openTabs)
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
  const settingsSettled = useSettingsStore((s) => s.loaded || s.error !== null)
  const loadReviewPrefs = useDiffStore((s) => s.loadReviewPrefs)
  const reviewSettled = useDiffStore((s) => s.reviewReady || s.prefsError !== null)
  const splitGroups = useSplitLayoutStore((s) => s.groups)
  // Only the group holding the active tab is on screen; the others wait behind their merged tabs.
  const activeSplit = groupOfTab(splitGroups, activeTabId)
  const splitPaneNodes = activeSplit ? collectPaneNodes(activeSplit.root) : []

  useEffect(() => {
    const openTabIds = new Set(openTabs.map((t) => t.id))
    for (const pane of allPanes(splitGroups)) {
      if (!openTabIds.has(pane.tabId)) {
        useSplitLayoutStore.getState().closePane(pane.id)
      }
    }
  }, [openTabs, splitGroups])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const [autoCollapsed, setAutoCollapsed] = useState({ left: false, right: false })
  const floatingSidebar = useFloatingSidebar()
  const hoverSidebar = floatingSidebar.side
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const { tab: sidebarTab, setTab: setSidebarTab, ready: sidebarReady, error: sidebarPrefsError } = useSidebarPreferences()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const botOpen = useBotStore((s) => s.open)
  const initBot = useBotStore((s) => s.init)
  const projectHome = Boolean(currentProjectCwd && !activeTabId)
  /** What the projects half may still return to: a worktree nobody lists is not one of them. */
  const knownProjectCwds = new Set(
    projects.flatMap((project) => [
      project.cwd,
      ...(project.worktrees ?? []).map((worktree) => worktree.cwd)
    ])
  )
  const missingProjectCwds = new Set(
    projects.flatMap((project) => [
      ...(project.missing ? [project.cwd] : []),
      ...(project.worktrees ?? []).filter((worktree) => worktree.missing).map((worktree) => worktree.cwd)
    ])
  )
  const activeProjectWorkspaceCwd =
    currentProjectCwd && !missingProjectCwds.has(currentProjectCwd) ? currentProjectCwd : null
  const activeWorkspaceCwd =
    sidebarTab === 'kanban' ? null : activeProjectWorkspaceCwd

  const toggleLeftSidebar = () => {
    if (autoCollapsed.left) {
      floatingSidebar.toggle('left')
      setSidebarOpen(true)
    } else setSidebarOpen((open) => !open)
  }
  const toggleRightSidebar = () => {
    if (!activeWorkspaceCwd) return
    const diff = useDiffStore.getState()
    if (autoCollapsed.right) {
      floatingSidebar.toggle('right')
      diff.setReviewOpen(true)
    } else diff.setReviewOpen(!diff.reviewOpen)
  }
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
  useBrowserAgentRequests()
  useTerminalAgentRequests()
  useSessionAgentRequests()
  useModelCatalog()
  const modelCatalogError = useModelCatalogStore((s) => s.error)
  const modelCatalogLoading = useModelCatalogStore((s) => s.loading)

  useEffect(subscribeSettingsChanges, [])

  useEffect(() => api.onMcpChanged(() => {
    const store = useToolSettingsStore.getState()
    if (store.loaded) void store.load()
  }), [])

  const botSessionId = useBotStore((s) => s.state?.sessionId ?? null)
  const notificationVisibilityKey = JSON.stringify(visibleNotificationSessions(
    openTabs, activeTabId, splitPaneNodes.map((pane) => pane.tabId), settingsOpen, { open: botOpen, sessionId: botSessionId }
  ))
  useEffect(() => {
    void api.setVisibleNotificationSessions(JSON.parse(notificationVisibilityKey) as string[]).catch((error: unknown) => {
      console.error('Could not report visible notification sessions:', error)
    })
  }, [notificationVisibilityKey])

  useEffect(() => api.onNotificationClick((sessionId) => {
    const bot = useBotStore.getState()
    openNotifiedSession(
      sessionId,
      sidebarTab,
      setSidebarTab,
      setWorkspaceRestoreMode,
      () => setSettingsOpen(false),
      {
        sessionId: bot.state?.sessionId ?? null,
        openBot: () => bot.openBot(),
        closeBot: () => bot.closeBot()
      }
    )
  }), [sidebarTab, setSidebarTab, setWorkspaceRestoreMode])

  useEffect(() => {
    const selectStripTab = (action: (typeof TAB_SELECT_ACTIONS)[number]) => {
      const { openTabs, currentProjectCwd } = useSessionsStore.getState()
      const layout = useSplitLayoutStore.getState()
      const slots = stripSlots(visibleTabsFor(openTabs, sidebarTab, currentProjectCwd), layout.groups)
      const slot = action === 'tab.selectLast' ? slots.at(-1) : slots[TAB_SELECT_ACTIONS.indexOf(action)]
      if (!slot) return
      setSettingsOpen(false)
      useSessionsStore.getState().setActive(slot.tabId)
      const pane = paneOfTab(layout.groups, slot.tabId)
      if (pane) layout.setActivePane(pane.id)
    }
    const runShortcut = (action: HostShortcutAction) => {
      // The picker handles close requests itself, including its in-flight save lock.
      const sessState = useSessionsStore.getState()
      if (sessState.projectPickerOpen || sessState.relocateProjectTarget || sessState.moveProjectTarget) return
      switch (action) {
        case 'tab.close': {
          if (settingsOpen) setSettingsOpen(false)
          else if (useBotStore.getState().open) useBotStore.getState().closeBot()
          else if (activeTabId) closeTab(activeTabId)
          break
        }
        case 'tab.new':
          setSettingsOpen(false)
          if (sidebarTab === 'kanban') {
            useKanbanStore.getState().openCreateDialog()
            break
          }
          newStripSession(sidebarTab).catch((error: unknown) => {
            useSessionsStore.setState({ workspaceError: failureMessage(error) })
          })
          break
        case 'project.add': void openProject(); break
        case 'bot.toggle':
          setSettingsOpen(false)
          useBotStore.getState().toggleBot()
          break
        case 'bot.toggleTasks':
          if (useBotStore.getState().open) useBotStore.getState().toggleDrawer()
          break
        case 'kanban.toggle':
          setSettingsOpen(false)
          if (useBotStore.getState().open) {
            useBotStore.getState().closeBot()
            switchSidebarTab('kanban')
          } else if (sidebarTab === 'kanban') {
            switchSidebarTab('projects')
          } else {
            switchSidebarTab('kanban')
          }
          break
        case 'sidebar.toggleLeft': toggleLeftSidebar(); break
        case 'settings.toggle': setSettingsOpen((open) => !open); break
        case 'sidebar.toggleRight': {
          if (!activeWorkspaceCwd) break
          toggleRightSidebar()
          break
        }
        default: selectStripTab(action)
      }
    }
    const offBrowserShortcut = api.browser.onShortcutRequested(runShortcut)
    const onKeyDown = (event: KeyboardEvent) => {
      if (isShortcutRecording() || isComposingKey(event) || isTerminalShellChord(event)) return
      // The directory dialog owns its shortcuts, including Cmd+W; never close a background tab.
      const sessState = useSessionsStore.getState()
      if (sessState.projectPickerOpen || sessState.relocateProjectTarget || sessState.moveProjectTarget) return
      const action = findShortcut(shortcutBindings(), eventAccelerator(event), HOST_SHORTCUT_ACTIONS)
      if (!action) return
      event.preventDefault()
      if (!event.repeat) runShortcut(action)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      offBrowserShortcut()
    }
  }, [activeTabId, activeWorkspaceCwd, closeTab, currentProjectCwd, openProject, settingsOpen, sidebarTab, autoCollapsed.left, autoCollapsed.right])

  useEffect(() => {
    if (!sidebarReady || requestedWorkspaceRestore.current) return
    requestedWorkspaceRestore.current = true
    void initializeProjectWorkspaces(false)
  }, [initializeProjectWorkspaces, sidebarReady])

  useEffect(() => {
    if (!workspaceRestoreReady || workspaceRestoreError || currentProjectCwd || activeTab || projects.length === 0) return
    void selectProjectCwd(projects[0]!.cwd)
  }, [activeTab, currentProjectCwd, projects, selectProjectCwd, workspaceRestoreError, workspaceRestoreReady])

  useEffect(() => {
    void loadSettings()
    void loadReviewPrefs()
    void initBot()
    void useKanbanStore.getState().init()
  }, [loadSettings, loadReviewPrefs, initBot])

  const reviewOpen = useDiffStore((s) => s.reviewOpen)
  useEffect(() => {
    setAutoCollapsed((previous) => {
      const left = windowWidth < 648 + (previous.left ? 24 : 0)
      const rightLimit = sidebarOpen && !left ? 896 : 648
      const right = windowWidth < rightLimit + (previous.right ? 24 : 0)
      return left === previous.left && right === previous.right ? previous : { left, right }
    })
  }, [windowWidth, sidebarOpen])
  const leftCollapsed = !sidebarOpen || autoCollapsed.left
  const rightCollapsed = !reviewOpen || autoCollapsed.right
  useEffect(() => {
    if (settingsOpen || (hoverSidebar === 'left' && !leftCollapsed) ||
        (hoverSidebar === 'right' && (!rightCollapsed || !activeWorkspaceCwd))) {
      floatingSidebar.close()
    }
  }, [settingsOpen, hoverSidebar, leftCollapsed, rightCollapsed, activeWorkspaceCwd, floatingSidebar.close])
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
  // Keep the last active workspace's right sidebar mounted across brief switches so FileTree / ChangesPanel
  // do not tear down unnecessarily; drop it once that project or chat directory is removed.
  const [retainedRightCwd, setRetainedRightCwd] = useState<string | null>(null)
  if (activeWorkspaceCwd && retainedRightCwd !== activeWorkspaceCwd) {
    setRetainedRightCwd(activeWorkspaceCwd)
  } else if (
    retainedRightCwd &&
    (missingProjectCwds.has(retainedRightCwd) || (!activeWorkspaceCwd && !knownProjectCwds.has(retainedRightCwd)))
  ) {
    setRetainedRightCwd(null)
  }
  const rightPanelCwd = activeWorkspaceCwd ?? retainedRightCwd
  const hasRetainableChatTabs = openTabs.some((tab) => tab.kind === 'project' || tab.kind === 'chat')

  useEffect(() => {
    if (!projectHome || !currentProjectCwd || missingProjectCwds.has(currentProjectCwd)) return
    const cwd = currentProjectCwd
    acquireProjectDraft(cwd)
    return () => releaseProjectDraft(cwd)
  }, [acquireProjectDraft, currentProjectCwd, projectHome, releaseProjectDraft])

  const kanbanLoaded = useKanbanStore((s) => s.loaded)
  const kanbanError = useKanbanStore((s) => s.error)
  const kanbanItems = useKanbanStore((s) => s.items)
  const kanbanViewMode = useKanbanStore((s) => s.viewMode)
  const kanbanProjectScope = useKanbanStore((s) => s.projectScope)
  const kanbanHiddenStatuses = useKanbanStore((s) => s.hiddenStatuses)
  const activeTabSettled = !activeTab || (activeTab.loadState !== 'cold' && activeTab.loadState !== 'opening')
  const kanbanSettled = sidebarTab !== 'kanban' || kanbanLoaded || Boolean(kanbanError)
  const startupSettled = Boolean(
    (workspaceRestoreReady || workspaceRestoreError) &&
      sidebarReady &&
      reviewSettled &&
      settingsSettled &&
      activeTabSettled &&
      kanbanSettled
  )
  const notifiedStartupReady = useRef(false)
  // A failed restore is shown by the app itself, so it lifts the startup screen too.
  useEffect(() => {
    if (!startupSettled || notifiedStartupReady.current) return
    notifiedStartupReady.current = true
    const root = document.documentElement
    root.dataset.startupFocus = '1'
    void root.offsetHeight
    api.notifyStartupReady()
    const timer = window.setTimeout(() => {
      delete root.dataset.startupFocus
    }, 920)
    return () => {
      window.clearTimeout(timer)
      delete root.dataset.startupFocus
    }
  }, [startupSettled])

  const activeMessageCount = useSessionsStore((s) => {
    if (!activeSessionId) return 0
    const rt = s.runtime[activeSessionId]
    return (rt?.turns.length ?? 0) + (rt?.liveMessages.length ?? 0)
  })
  const lastBlueprintJson = useRef('')
  const rightSurfaceOpen = Boolean(activeWorkspaceCwd) && !rightCollapsed
  useEffect(() => {
    if (!startupSettled || !activeTabSettled || settingsOpen || botOpen) return
    const flushBlueprint = () => {
      const bp = captureStartupBlueprint(document, {
        leftOpen: !leftCollapsed,
        rightOpen: rightSurfaceOpen
      })
      if (!bp) return
      const json = JSON.stringify(bp)
      if (json === lastBlueprintJson.current) return
      lastBlueprintJson.current = json
      void api.saveStartupBlueprint?.(bp)?.catch(() => {})
    }
    // Wait past the 500ms centered-to-bottom composer glide when the first message is sent.
    const timer = window.setTimeout(flushBlueprint, 600)
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushBlueprint()
    }
    window.addEventListener('pagehide', flushBlueprint)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pagehide', flushBlueprint)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [
    startupSettled,
    activeTabSettled,
    activeTabId,
    sidebarTab,
    leftCollapsed,
    rightSurfaceOpen,
    settingsOpen,
    botOpen,
    projects.length,
    openTabs.length,
    splitGroups,
    windowWidth,
    activeMessageCount,
    kanbanLoaded,
    kanbanItems,
    kanbanViewMode,
    kanbanProjectScope,
    kanbanHiddenStatuses
  ])

  useEffect(() => {
    if (!activeTab) {
      if (currentProjectCwd) projectFocusCwd.current = currentProjectCwd
      return
    }
    if (isChatScope(activeTab)) chatFocusTabId.current = activeTab.id
    else projectFocusCwd.current = activeTab.cwd
  }, [activeTab, currentProjectCwd])

  const switchSidebarTab = (next: SidebarTab) => {
    if (next === sidebarTab) return
    setSidebarTab(next)
    if (next === 'kanban') return
    setWorkspaceRestoreMode(false)
    const action = halfSwitch(
      openTabs,
      next,
      activeTabId,
      currentProjectCwd,
      chatFocusTabId.current,
      projectFocusCwd.current ?? restoredProjectCwd,
      knownProjectCwds
    )
    if (action.kind === 'project') void selectProjectCwd(action.cwd)
  }

  const toggleKanban = () => {
    setSettingsOpen(false)
    switchSidebarTab(sidebarTab === 'kanban' ? 'projects' : 'kanban')
  }

  const openExistingWorkspaceSession = useCallback(async (sessionId: string, cwd: string) => {
    setSettingsOpen(false)
    if (useBotStore.getState().open) useBotStore.getState().closeBot()
    const store = useSessionsStore.getState()
    const isOpenedProject = store.projects.some(
      (p) => p.cwd === cwd || p.worktrees?.some((wt) => wt.cwd === cwd)
    )
    if (sidebarTab !== 'projects') {
      setSidebarTab('projects')
      setWorkspaceRestoreMode(false)
    }
    if (isOpenedProject) {
      await selectProjectCwd(cwd)
    }
    if (useSessionsStore.getState().openTabs.some((tab) => tab.id === sessionId)) {
      await useSessionsStore.getState().activateTab(sessionId)
      return
    }
    const findMeta = () => {
      for (const proj of useSessionsStore.getState().projects) {
        const found = proj.sessions.find((item) => item.id === sessionId)
        if (found) return found
      }
      return undefined
    }
    let meta = findMeta()
    if (!meta && isOpenedProject) {
      await useSessionsStore.getState().refreshCwd(cwd).catch(() => {})
      meta = findMeta()
    }
    if (meta && isOpenedProject) {
      await useSessionsStore.getState().openExisting(meta, 'project')
    }
  }, [selectProjectCwd, setSidebarTab, setWorkspaceRestoreMode, sidebarTab])

  const kanbanCallbacks = useMemo(() => ({
    onStartInSession: (issue: KanbanIssue) => {
      void (async () => {
        try {
          setSettingsOpen(false)
          const store = useSessionsStore.getState()
          const openedProject = issue.projectCwd
            ? store.projects.find((p) => p.cwd === issue.projectCwd)
            : undefined
          if (!openedProject) {
            useBotStore.getState().addDraftIssueMention(issue.number)
            useBotStore.getState().openBot()
            return
          }
          if (useBotStore.getState().open) useBotStore.getState().closeBot()
          setSidebarTab('projects')
          setWorkspaceRestoreMode(false)
          await selectProjectCwd(openedProject.cwd)
          const targetSessionId = await useSessionsStore.getState().newSession(openedProject.cwd)
          if (targetSessionId) {
            useComposerDraftsStore.getState().restoreDraft(targetSessionId, {
              content: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      {
                        type: 'issueMention',
                        attrs: {
                          number: issue.number,
                          title: issue.title,
                          status: issue.status,
                          detail: ''
                        }
                      },
                      { type: 'text', text: ' ' }
                    ]
                  }
                ]
              },
              images: []
            })
          }
        } catch (error) {
          toast.error(failureMessage(error))
        }
      })()
    },
    onSendToBot: (issue: KanbanIssue) => {
      setSettingsOpen(false)
      useBotStore.getState().addDraftIssueMention(issue.number)
      useBotStore.getState().openBot()
    }
  }), [selectProjectCwd, setSidebarTab, setWorkspaceRestoreMode])

  return (
    <TooltipProvider disableHoverableContent>
      <ThemeSync />
      <HighlighterWarmup />
      <SystemPluginUI activeSessionId={activeSessionId} />
      <SubagentTranscriptDialog />
      <SubagentCloseConfirm />
      <QuitConfirm />
      <ExtensionUI />
      <ProjectPickerDialog />
      <MoveProjectDialog />
      <KanbanIssueDialog
        callbacks={kanbanCallbacks}
        isBoardVisible={sidebarTab === 'kanban' && !botOpen && !settingsOpen}
        onLocateInBoard={(issue) => {
          setSettingsOpen(false)
          if (useBotStore.getState().open) useBotStore.getState().closeBot()
          useKanbanStore.getState().setProjectScope(issue.projectCwd ?? 'unassigned')
          setSidebarTab('kanban')
        }}
        onOpenLinkedSession={(sessionId, cwd) => {
          void openExistingWorkspaceSession(sessionId, cwd)
        }}
      />
      <BotPeekBubble hidden={settingsOpen} />
      <div data-app-surface data-modal-blur-root className="flex h-full flex-col transition-[background-color,filter] duration-200 ease-in-out motion-reduce:transition-none solid:bg-background">
        {botOpen && !settingsOpen ? (
          <BotPage
            onOpenKanban={() => {
              useBotStore.getState().closeBot()
              setSidebarTab('kanban')
            }}
            onJumpToWorkspace={({ cwd, projectCwd, sessionId, openChanges, openFilePath }) => {
              setSettingsOpen(false)
              if (sidebarTab !== 'projects') switchSidebarTab('projects')
              void (async () => {
                const rootCwd = projectCwd ?? cwd
                const initialProject = useSessionsStore.getState().projects.find(
                  (proj) => proj.cwd === rootCwd || proj.worktrees?.some((wt) => wt.cwd === cwd)
                )
                if (
                  initialProject &&
                  initialProject.cwd !== cwd &&
                  !initialProject.worktrees?.some((wt) => wt.cwd === cwd)
                ) {
                  await useSessionsStore.getState().refreshProject(initialProject.cwd).catch(() => {})
                }
                await selectProjectCwd(cwd)
                const store = useSessionsStore.getState()
                if (openFilePath) {
                  await store.openFileTab(cwd, openFilePath)
                  return
                }
                if (openChanges) {
                  await store.openChangesTab(cwd)
                  useDiffStore.getState().setReviewOpen(true)
                  return
                }
                if (sessionId) {
                  if (store.openTabs.some((tab) => tab.id === sessionId)) {
                    await store.activateTab(sessionId)
                    return
                  }
                  const findMeta = () => {
                    for (const proj of useSessionsStore.getState().projects) {
                      const direct = proj.sessions.find((item) => item.id === sessionId)
                      if (direct) return direct
                      for (const wt of proj.worktrees ?? []) {
                        const inWt = wt.sessions.find((item) => item.id === sessionId)
                        if (inWt) return inWt
                      }
                    }
                    return undefined
                  }
                  let meta = findMeta()
                  if (!meta) {
                    const targetRoot =
                      useSessionsStore.getState().projects.find(
                        (proj) => proj.cwd === rootCwd || proj.worktrees?.some((wt) => wt.cwd === cwd)
                      )?.cwd ?? rootCwd
                    await useSessionsStore.getState().refreshProject(targetRoot).catch(() => {})
                    await useSessionsStore.getState().loadWorktreeSessions(cwd).catch(() => {})
                    meta = findMeta()
                  }
                  if (meta) {
                    await useSessionsStore.getState().openExisting(meta, 'project')
                  }
                }
              })()
            }}
          />
        ) : null}
        <div
          data-workspace-shell
          inert={botOpen && !settingsOpen}
          aria-hidden={botOpen && !settingsOpen}
          className={cn('min-h-0 flex-1 flex-col', botOpen && !settingsOpen ? 'hidden' : 'flex')}
        >
        <header data-app-header className="drag relative flex h-10 min-w-0 shrink-0 items-center justify-between">
          <div data-header-leading className={cn('flex h-full shrink-0 items-center gap-1 pr-3 pl-20 transition-[width] duration-200 ease-in-out motion-reduce:transition-none', !leftCollapsed || settingsOpen ? 'w-62' : 'w-46')}>
            {settingsOpen ? null : (
              <>
                <SidebarToggle onClick={toggleLeftSidebar} />
                <BotOrbButton registerAnchor={!botOpen} />
                <KanbanToggleButton active={sidebarTab === 'kanban'} onClick={toggleKanban} />
              </>
            )}
          </div>
          {/* Keep both 248px rails and the card's 8px gutters reserved when either sidebar is hidden. */}
          <div data-header-tabs className="absolute inset-x-64 inset-y-1 flex min-w-0 items-center justify-center">
            {!settingsOpen && sidebarTab !== 'kanban' && (currentProjectCwd || activeTabId) ? (
              <TabBar sidebarTab={sidebarTab} />
            ) : null}
          </div>
          {!settingsOpen ? (
            <div data-header-trailing className="flex h-full shrink-0 items-center gap-1 pl-2 pr-3">
              {sidebarTab === 'kanban' ? (
                <KanbanHeader />
              ) : (
                <>
                  <NewTabButton sidebarTab={sidebarTab} sidebarLayout={`${leftCollapsed}:${rightCollapsed}:${hoverSidebar}:${settingsOpen}`} />
                  <ReplyBookmarks onNavigate={() => {
                    setWorkspaceRestoreMode(false)
                    setSidebarTab('projects')
                  }} />
                  {activeWorkspaceCwd ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className={cn('no-drag translate-y-px', sidebarSurfaceToggle)}
                          aria-label={t('app.sidebarRight')}
                          aria-pressed={reviewOpen}
                          onClick={toggleRightSidebar}
                        >
                          <PanelRight />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t('app.sidebarRight')} <ShortcutKbd action="sidebar.toggleRight" />
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </>
              )}
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
        <div className="relative flex min-h-0 flex-1">
          {!settingsOpen && leftCollapsed && hoverSidebar !== 'left' ? (
            <div className="absolute inset-y-0 left-0 z-20 w-2" onMouseEnter={() => floatingSidebar.hover('left')} />
          ) : null}
          {!settingsOpen && activeWorkspaceCwd && rightCollapsed && hoverSidebar !== 'right' ? (
            <div className="absolute inset-y-0 right-0 z-20 w-2" onMouseEnter={() => floatingSidebar.hover('right')} />
          ) : null}
          <WorkspaceLayout
            settingsOpen={settingsOpen}
            leftCollapsed={leftCollapsed}
            rightCollapsed={!activeWorkspaceCwd || rightCollapsed}
            leftFloating={leftCollapsed && hoverSidebar === 'left'}
            rightFloating={Boolean(activeWorkspaceCwd) && rightCollapsed && hoverSidebar === 'right'}
            left={
              <>
                <div
                  className={cn('flex shrink-0', leftCollapsed && 'absolute inset-y-0 left-0 z-30',
                    leftCollapsed && hoverSidebar === 'left' && !settingsOpen && 'p-2',
                    leftCollapsed && hoverSidebar !== 'left' && 'pointer-events-none')}
                  onMouseMoveCapture={(event) => floatingSidebar.trackPointer('left', event)}
                >
                  <div
                    data-sidebar-overlay={leftCollapsed && hoverSidebar === 'left' && !settingsOpen ? '' : undefined}
                    className={cn('flex', leftCollapsed && hoverSidebar === 'left' && !settingsOpen &&
                      'overflow-hidden rounded-xl bg-glass-popover-background bg-(image:--glass-popover-sheen) shadow-glass-popover ring-1 ring-glass-content-border solid:bg-sidebar solid:bg-none solid:shadow-md solid:ring-0')}
                  >
                    <Sidebar
                      floating={leftCollapsed}
                      hidden={leftCollapsed && hoverSidebar !== 'left'}
                      onOpenSettings={() => setSettingsOpen(true)}
                      tab={sidebarTab}
                      onSwitchTab={switchSidebarTab}
                      preferencesError={sidebarPrefsError}
                    />
                  </div>
                </div>
              </>
            }
            right={rightPanelCwd ? (
              <>
                <div
                  className={cn('flex shrink-0', rightCollapsed && 'absolute inset-y-0 right-0 z-30',
                    activeWorkspaceCwd && rightCollapsed && hoverSidebar === 'right' && 'p-2',
                    (!activeWorkspaceCwd || (rightCollapsed && hoverSidebar !== 'right')) && 'pointer-events-none')}
                  onMouseMoveCapture={(event) => floatingSidebar.trackPointer('right', event)}
                >
                  <div
                    data-sidebar-overlay={!settingsOpen && activeWorkspaceCwd && rightCollapsed && hoverSidebar === 'right' ? '' : undefined}
                    className={cn('flex', !settingsOpen && activeWorkspaceCwd && rightCollapsed && hoverSidebar === 'right' &&
                      'overflow-hidden rounded-xl bg-glass-popover-background bg-(image:--glass-popover-sheen) shadow-glass-popover ring-1 ring-glass-content-border solid:bg-sidebar solid:bg-none solid:shadow-md solid:ring-0')}
                  >
                    <WorkspacePanel
                      cwd={rightPanelCwd}
                      defaultTab={knownProjectCwds.has(rightPanelCwd) ? 'changes' : 'files'}
                      floating={rightCollapsed}
                      hidden={settingsOpen || !activeWorkspaceCwd || (rightCollapsed && hoverSidebar !== 'right')}
                    />
                  </div>
                </div>
              </>
            ) : null}
            renderSettings={(navigationTarget, active) => (
              <SettingsPage navigationTarget={navigationTarget} active={active} onClose={() => setSettingsOpen(false)} />
            )}
          >
            <div
              data-content-surface
              // One material backplate for every tab kind; panes and reading views paint nothing over it in glass.
              className="m-2 flex min-w-96 flex-1 flex-col rounded-xl bg-glass-content-background bg-(image:--glass-content-sheen) shadow-glass-content ring-1 ring-glass-content-border transition-[background-color,box-shadow] duration-200 ease-in-out motion-reduce:transition-none solid:bg-chat-background solid:bg-none solid:shadow-md solid:ring-0"
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
                <div
                  data-content-inner
                  className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                >
                  {sidebarTab === 'kanban' ? (
                    <KanbanView callbacks={kanbanCallbacks} />
                  ) : null}
                  {activeTab || hasRetainableChatTabs ? (
                    <SplitPaneContainer
                      tabId={activeTab ? activeTabId! : null}
                      visible={Boolean(activeTab) && sidebarTab !== 'kanban'}
                      className={cn('min-h-0 min-w-0 flex-1', (!activeTab || sidebarTab === 'kanban') && 'hidden')}
                      renderPane={(node: PaneNode, isActive) => (
                        <PaneViewContent
                          node={node}
                          isActive={isActive}
                          surfaceVisible={!botOpen && sidebarTab !== 'kanban'}
                          composerWorkspace={composerWorkspace}
                        />
                      )}
                    />
                  ) : null}
                  {sidebarTab === 'kanban' || activeTab ? null : projectHome ? (
                    <>
                      <SessionGreeting />
                      <Composer
                        draftCwd={currentProjectCwd!}
                        draftSessionId={draftSessionId}
                        centered
                        workspace={composerWorkspace}
                      />
                      <ProjectSessionHome cwd={currentProjectCwd!} />
                    </>
                  ) : workspaceRestoreReady && !restoreError ? (
                    <Empty className="gap-4">
                      <EmptyHeader>
                        <EmptyTitle>{t('app.emptyProjectsTitle')}</EmptyTitle>
                        <EmptyDescription>{t('app.emptyProjectsDescription')}</EmptyDescription>
                      </EmptyHeader>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <Button size="sm" onClick={() => void openProject()}>
                          <FolderPlus data-icon="inline-start" />
                          {t('sidebar.addProject')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => useBotStore.getState().openBot()}>
                          <Bot data-icon="inline-start" />
                          {t('app.openBot')}
                        </Button>
                      </div>
                    </Empty>
                  ) : (
                    <Empty className="gap-4">
                      <EmptyDescription>
                        {restoreError
                          ? t('app.restoreFailed', { error: restoreError })
                          : t('app.loadingSession')}
                      </EmptyDescription>
                      {restoreError ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void initializeProjectWorkspaces(false)}
                        >
                          <RotateCw />
                          {t('app.retryRestore')}
                        </Button>
                      ) : null}
                    </Empty>
                  )}
                </div>
              </div>
            </div>
          </WorkspaceLayout>
        </div>
        </div>
      </div>
      <DreamDialogHost />
    </TooltipProvider>
  )
}

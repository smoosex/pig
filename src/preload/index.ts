import { contextBridge, ipcRenderer } from 'electron'
import { GLASS_SURFACE_ARGUMENT } from '../shared/surface-style'
import type { DiffScope, DiffWatchError, FileStamp, ModelCatalog, SessionApi, WorktreeDeletionJob, SessionNameUpdate, SessionTreeView, SessionWindowMessage, SettingsAuthEvent, SystemUIEvent, MemoryPluginSettingsPatch, PluginScope, WebSearchSettingsPatch, ExtensionUIEvent, SubagentListUpdate, SubagentSettingsPatch } from '../shared/api'

/** Keep the IPC channel allowlist here; the renderer never receives ipcRenderer itself. */
const api: SessionApi = {
  browser: {
    create: (browserId) => ipcRenderer.invoke('browser:create', browserId),
    getState: (browserId) => ipcRenderer.invoke('browser:get-state', browserId),
    navigate: (browserId, url) => ipcRenderer.invoke('browser:navigate', browserId, url),
    back: (browserId) => ipcRenderer.invoke('browser:back', browserId),
    forward: (browserId) => ipcRenderer.invoke('browser:forward', browserId),
    reload: (browserId) => ipcRenderer.invoke('browser:reload', browserId),
    setBounds: (browserId, bounds) => ipcRenderer.invoke('browser:set-bounds', browserId, bounds),
    setSelecting: (browserId, selecting, options) => ipcRenderer.invoke('browser:set-selecting', browserId, selecting, options),
    removeAnnotations: (browserId, ids) => ipcRenderer.invoke('browser:remove-annotations', browserId, ids),
    capture: (browserId) => ipcRenderer.invoke('browser:capture', browserId),
    snapshot: (browserId) => ipcRenderer.invoke('browser:snapshot', browserId),
    copyUrl: (browserId) => ipcRenderer.invoke('browser:copy-url', browserId),
    openExternal: (browserId) => ipcRenderer.invoke('browser:open-external', browserId),
    inspect: (browserId) => ipcRenderer.invoke('browser:inspect', browserId),
    close: (browserId) => ipcRenderer.invoke('browser:close', browserId),
    listCookieSources: (browserId) => ipcRenderer.invoke('browser:list-cookie-sources', browserId),
    previewCookies: (browserId, sourceId, scope) => ipcRenderer.invoke('browser:preview-cookies', browserId, sourceId, scope),
    importCookies: (browserId, sourceId, scope, expectedSite) => ipcRenderer.invoke('browser:import-cookies', browserId, sourceId, scope, expectedSite),
    clearSiteCookies: (browserId, expectedSite) => ipcRenderer.invoke('browser:clear-site-cookies', browserId, expectedSite),
    onCloseRequested: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, browserId: string) => listener(browserId)
      ipcRenderer.on('browser:close-tab-requested', handler)
      return () => ipcRenderer.off('browser:close-tab-requested', handler)
    },
    releaseAgent: (browserId) => ipcRenderer.invoke('browser:release-agent', browserId),
    onAgentOpenRequest: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, request: import('../shared/browser').BrowserAgentOpenRequest) => listener(request)
      ipcRenderer.on('browser:agent-open-request', handler)
      return () => ipcRenderer.off('browser:agent-open-request', handler)
    },
    answerAgentOpen: (requestId, result) => ipcRenderer.invoke('browser:agent-open-answer', requestId, result),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: import('../shared/browser').BrowserState) => listener(state)
      ipcRenderer.on('browser:state', handler)
      return () => ipcRenderer.off('browser:state', handler)
    },
    onSelection: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, selection: import('../shared/browser').BrowserSelection) => listener(selection)
      ipcRenderer.on('browser:selection', handler)
      return () => ipcRenderer.off('browser:selection', handler)
    }
  },
  listProjects: () => ipcRenderer.invoke('session:list-projects'),
  discoverOpenedWorktrees: () => ipcRenderer.invoke('project:discover-opened-worktrees'),
  listWorktreeSessions: (projectCwd: string, cwd: string) =>
    ipcRenderer.invoke('project:list-worktree-sessions', projectCwd, cwd),
  listProject: (cwd: string) => ipcRenderer.invoke('session:list-project', cwd),
  listChats: () => ipcRenderer.invoke('session:list-chats'),
  isChatCwd: (cwd: string) => ipcRenderer.invoke('session:is-chat-cwd', cwd),
  browseProjectDirectories: (path, showHidden) => ipcRenderer.invoke('project:browse-directories', path, showHidden),
  searchProjectDirectories: (path, query, showHidden) => ipcRenderer.invoke('project:search-directories', path, query, showHidden),
  cancelProjectDirectorySearch: () => ipcRenderer.invoke('project:cancel-directory-search'),
  openProject: (path) => ipcRenderer.invoke('session:open-project', path),
  unpinProject: (cwd: string) => ipcRenderer.invoke('session:unpin-project', cwd),
  reorderProjects: (cwds: string[]) =>
    ipcRenderer.invoke('session:reorder-projects', cwds),
  createChat: () => ipcRenderer.invoke('session:create-chat'),
  deleteChat: (cwd: string) => ipcRenderer.invoke('session:delete-chat', cwd),
  createSession: (cwd: string, sessionId?: string) =>
    ipcRenderer.invoke('session:create', cwd, sessionId),
  promoteSession: (sessionId: string) => ipcRenderer.invoke('session:promote', sessionId),
  discardDraftSession: (sessionId: string) => ipcRenderer.invoke('session:discard-draft', sessionId),
  openSession: (path: string) =>
    ipcRenderer.invoke('session:open', path),
  prepareSession: (sessionId: string) =>
    ipcRenderer.invoke('session:prepare', sessionId),
  closeSession: (sessionId: string) => ipcRenderer.invoke('session:close', sessionId),
  deleteProject: (cwd: string) => ipcRenderer.invoke('session:delete-project', cwd),
  worktreeCreateInfo: (projectCwd: string) => ipcRenderer.invoke('project:worktree-create-info', projectCwd),
  createWorktree: (projectCwd: string, options?: { initGit?: boolean }) =>
    ipcRenderer.invoke('project:create-worktree', projectCwd, options),
  worktreeDeletionInfo: (projectCwd: string, cwd: string) =>
    ipcRenderer.invoke('project:worktree-deletion-info', projectCwd, cwd),
  deleteWorktree: (projectCwd: string, cwd: string) =>
    ipcRenderer.invoke('project:delete-worktree', projectCwd, cwd),
  listWorktreeDeletions: () => ipcRenderer.invoke('project:list-worktree-deletions'),
  retryWorktreeDeletion: (cwd: string) => ipcRenderer.invoke('project:retry-worktree-deletion', cwd),
  onWorktreeDeletionsChanged: (listener: (jobs: WorktreeDeletionJob[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, jobs: WorktreeDeletionJob[]) => listener(jobs)
    ipcRenderer.on('worktrees:deletions-changed', handler)
    return () => ipcRenderer.off('worktrees:deletions-changed', handler)
  },
  retryWorktreeNaming: (projectCwd: string, cwd: string) =>
    ipcRenderer.invoke('project:retry-worktree-naming', projectCwd, cwd),
  onProjectsChanged: (listener: (projectCwd: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, cwd: string) => listener(cwd)
    ipcRenderer.on('projects:changed', handler)
    return () => ipcRenderer.off('projects:changed', handler)
  },
  onSessionNames: (listener: (updates: SessionNameUpdate[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, updates: SessionNameUpdate[]) => listener(updates)
    ipcRenderer.on('session:names', handler)
    return () => ipcRenderer.off('session:names', handler)
  },
  onDiffChanged: (listener: (cwd: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, cwd: string) => listener(cwd)
    ipcRenderer.on('diff:changed', handler)
    return () => ipcRenderer.off('diff:changed', handler)
  },
  onDiffWatchError: (listener: (error: DiffWatchError) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: DiffWatchError) => listener(error)
    ipcRenderer.on('diff:watch-error', handler)
    return () => ipcRenderer.off('diff:watch-error', handler)
  },
  deleteSession: (sessionId: string, path: string, cwd: string) =>
    ipcRenderer.invoke('session:delete', sessionId, path, cwd),
  renameSession: (sessionId: string, name: string, path?: string) =>
    ipcRenderer.invoke('session:rename', sessionId, name, path),
  prompt: (
    sessionId: string,
    text: string,
    images?: Parameters<SessionApi['prompt']>[2],
    textAttachments?: Parameters<SessionApi['prompt']>[3],
    streamingBehavior?: Parameters<SessionApi['prompt']>[4]
  ) => ipcRenderer.invoke('session:prompt', sessionId, text, images, textAttachments, streamingBehavior),
  abort: (sessionId: string) => ipcRenderer.invoke('session:abort', sessionId),
  executeBash: (sessionId: string, command: string, id: string) =>
    ipcRenderer.invoke('session:execute-bash', sessionId, command, id),
  abortBash: (sessionId: string) => ipcRenderer.invoke('session:abort-bash', sessionId),
  abortCompaction: (sessionId: string) => ipcRenderer.invoke('session:abort-compaction', sessionId),
  abortBranchSummary: (sessionId: string) => ipcRenderer.invoke('session:abort-branch-summary', sessionId),
  compactSession: (sessionId: string, instructions?: string) =>
    ipcRenderer.invoke('session:compact', sessionId, instructions),
  getDisplayTurns: (sessionId: string) =>
    ipcRenderer.invoke('session:get-display-turns', sessionId),
  getTurnWindow: (sessionId: string, start: number, count: number) =>
    ipcRenderer.invoke('session:get-turn-window', sessionId, start, count),
  getTurnMessages: (sessionId: string, turnId: string) =>
    ipcRenderer.invoke('session:get-turn-messages', sessionId, turnId),
  getSessionTrees: (sessionId: string, views?: SessionTreeView[]) =>
    ipcRenderer.invoke('session:get-trees', sessionId, views),
  setSessionLabel: (sessionId: string, targetId: string, label: string, path?: string) =>
    ipcRenderer.invoke('session:set-label', sessionId, targetId, label, path),
  viewBranch: (sessionId: string, tipId: string, options?: Parameters<SessionApi['viewBranch']>[2]) =>
    ipcRenderer.invoke('session:view-branch', sessionId, tipId, options),
  forkSession: (sessionId: string, userEntryId: string) =>
    ipcRenderer.invoke('session:fork', sessionId, userEntryId),
  getSessionCapabilities: (sessionId) => ipcRenderer.invoke('session:capabilities', sessionId),
  setSessionCapability: (sessionId, group, id, enabled) => ipcRenderer.invoke('session:set-capability', sessionId, group, id, enabled),
  getControls: (sessionId: string) =>
    ipcRenderer.invoke('session:get-controls', sessionId),
  getScopedModels: () => ipcRenderer.invoke('models:get-scoped'),
  setScopedModels: (patterns: string[]) => ipcRenderer.invoke('models:set-scoped', patterns),
  onScopedModelsChanged: (listener: () => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('models:scope-changed', handler)
    return () => { ipcRenderer.off('models:scope-changed', handler) }
  },
  getModelCatalog: () => ipcRenderer.invoke('models:get-catalog'),
  refreshModelCatalog: () => ipcRenderer.invoke('models:refresh-catalog'),
  getTokenStats: (sessionId: string) =>
    ipcRenderer.invoke('session:get-token-stats', sessionId),
  getCommands: (sessionId: string) =>
    ipcRenderer.invoke('session:get-commands', sessionId),
  exportSession: (sessionId: string) =>
    ipcRenderer.invoke('session:export', sessionId),
  setModel: (sessionId: string, provider: string, id: string) =>
    ipcRenderer.invoke('session:set-model', sessionId, provider, id),
  setThinking: (sessionId: string, level: string) =>
    ipcRenderer.invoke('session:set-thinking', sessionId, level),
  setModelThinkingPreference: (sessionId, remember) =>
    ipcRenderer.invoke('session:set-model-thinking-preference', sessionId, remember),
  followUpAction: (sessionId, index, action, mode) =>
    ipcRenderer.invoke('session:follow-up-action', sessionId, index, action, mode),
  pickDirectory: () => ipcRenderer.invoke('system:pick-directory'),
  getSidebarPrefs: () => ipcRenderer.invoke('system:get-sidebar-prefs'),
  readDirectory: (cwd: string, path: string) => ipcRenderer.invoke('files:read-directory', cwd, path),
  suggestFiles: (cwd: string, query: string) => ipcRenderer.invoke('files:suggest', cwd, query),
  readFile: (cwd: string, path: string) => ipcRenderer.invoke('files:read', cwd, path),
  writeFile: (
    cwd: string,
    path: string,
    contents: string,
    options: { expected?: FileStamp; overwrite?: boolean }
  ) => ipcRenderer.invoke('files:write', cwd, path, contents, options),
  openFileExternally: (cwd: string, path: string) =>
    ipcRenderer.invoke('files:open-externally', cwd, path),
  revealFileExternally: (cwd: string, path: string) =>
    ipcRenderer.invoke('files:reveal-externally', cwd, path),
  createFile: (cwd: string, path: string) => ipcRenderer.invoke('files:create-file', cwd, path),
  createDirectory: (cwd: string, path: string) =>
    ipcRenderer.invoke('files:create-directory', cwd, path),
  renameEntry: (cwd: string, path: string, name: string) =>
    ipcRenderer.invoke('files:rename', cwd, path, name),
  trashEntry: (cwd: string, path: string) => ipcRenderer.invoke('files:trash', cwd, path),
  copyPath: (cwd: string, path: string) => ipcRenderer.invoke('files:copy-path', cwd, path),
  readWorktreeDiff: (cwd: string) => ipcRenderer.invoke('diff:read-worktree', cwd),
  readWorktreePatch: (cwd: string, scope: DiffScope) =>
    ipcRenderer.invoke('diff:read-patch', cwd, scope),
  readUntrackedFile: (cwd: string, path: string) =>
    ipcRenderer.invoke('diff:read-untracked', cwd, path),
  watchWorktreeDiff: (cwd: string) => ipcRenderer.invoke('diff:watch', cwd),
  unwatchWorktreeDiff: (cwd: string, leaseId: string) => ipcRenderer.invoke('diff:unwatch', cwd, leaseId),
  setSidebarPrefs: (patch: unknown) =>
    ipcRenderer.invoke('system:set-sidebar-prefs', patch),
  getOpenProjectSessions: () => ipcRenderer.invoke('system:get-open-project-sessions'),
  saveOpenProjectChangesTab: (cwd: string, open: boolean, activeTabId: string | null) =>
    ipcRenderer.invoke('system:save-open-project-changes-tab', cwd, open, activeTabId),
  selectOpenProjectWorkspace: (cwd: string, sessionId: string | null, activeTabId: string | null) =>
    ipcRenderer.invoke('system:select-open-project-workspace', cwd, sessionId, activeTabId),
  saveOpenProjectTabOrder: (cwd: string, tabIds: string[]) =>
    ipcRenderer.invoke('system:save-open-project-tab-order', cwd, tabIds),
  saveOpenChatTabs: (tabIds: string[], activeTabId: string | null) =>
    ipcRenderer.invoke('system:save-open-chat-tabs', tabIds, activeTabId),
  getMcpSettings: () => ipcRenderer.invoke('mcp:get'),
  saveMcpServer: (name, config, replace, icon) => ipcRenderer.invoke('mcp:save', name, config, replace, icon),
  removeMcpServer: (name) => ipcRenderer.invoke('mcp:remove', name),
  setMcpEnabled: (name, enabled) => ipcRenderer.invoke('mcp:enable', name, enabled),
  previewMcpImport: (json, name) => ipcRenderer.invoke('mcp:preview', json, name),
  importMcpServers: (json, replaceNames, name, icon) => ipcRenderer.invoke('mcp:import', json, replaceNames, name, icon),
  searchMcpMarket: (query) => ipcRenderer.invoke('mcp:search', query),
  testMcpServer: (name) => ipcRenderer.invoke('mcp:test', name),
  loginMcpServer: (name) => ipcRenderer.invoke('mcp:login', name),
  logoutMcpServer: (name) => ipcRenderer.invoke('mcp:logout', name),
  cancelMcpLogin: () => ipcRenderer.invoke('mcp:cancel-login'),
  replyExtensionUI: (id, value) => ipcRenderer.invoke('extensions:reply', id, value),
  onExtensionUI: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: ExtensionUIEvent) => listener(value)
    ipcRenderer.on('extensions:ui', handler)
    return () => ipcRenderer.off('extensions:ui', handler)
  },
  onMcpChanged: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('mcp:changed', handler)
    return () => ipcRenderer.off('mcp:changed', handler)
  },
  supportsGlass: process.argv.includes(GLASS_SURFACE_ARGUMENT),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  setSkillEnabled: (id, enabled) => ipcRenderer.invoke('skills:enable', id, enabled),
  removeSkill: (id) => ipcRenderer.invoke('skills:remove', id),
  readSkill: (id) => ipcRenderer.invoke('skills:read', id),
  openSkillDirectory: (id) => ipcRenderer.invoke('skills:open-directory', id),
  probeSkills: (source) => ipcRenderer.invoke('skills:probe', source),
  discardSkillProbe: (token) => ipcRenderer.invoke('skills:discard-probe', token),
  installSkills: (token, paths) => ipcRenderer.invoke('skills:install', token, paths),
  searchSkillMarket: (query) => ipcRenderer.invoke('skills:search', query),
  onSkillsChanged: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('skills:changed', handler)
    return () => ipcRenderer.off('skills:changed', handler)
  },
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  installPlugin: (source: string) => ipcRenderer.invoke('plugins:install', source),
  pickPluginPath: () => ipcRenderer.invoke('plugins:pick-path'),
  setPluginScopes: (id: string, scopes: PluginScope[]) => ipcRenderer.invoke('plugins:scopes', id, scopes),
  updatePlugin: (id: string) => ipcRenderer.invoke('plugins:update', id),
  removePlugin: (id: string) => ipcRenderer.invoke('plugins:remove', id),
  isMemoryPluginEnabled: (sessionId: string) => ipcRenderer.invoke('plugins:memory-enabled', sessionId),
  getMemoryPluginDefaults: () => ipcRenderer.invoke('plugins:memory-defaults'),
  getMemoryPluginSettings: () => ipcRenderer.invoke('plugins:memory-get'),
  setMemoryPluginSettings: (patch: MemoryPluginSettingsPatch) => ipcRenderer.invoke('plugins:memory-set', patch),
  getMemoryDetail: (sessionId: string, kind: 'status' | 'view', full?: boolean) => ipcRenderer.invoke('plugins:memory-detail', sessionId, kind, full),
  getPluginSettings: (id: string) => ipcRenderer.invoke('plugins:config-get', id),
  setPluginSettings: (id: string, patch: Record<string, string | number | boolean | null>) => ipcRenderer.invoke('plugins:config-set', id, patch),
  getWebSearchSettings: () => ipcRenderer.invoke('plugins:web-search-get'),
  setWebSearchSettings: (patch: WebSearchSettingsPatch) => ipcRenderer.invoke('plugins:web-search-set', patch),
  testWebSearch: (provider: string | null) => ipcRenderer.invoke('plugins:web-search-test', provider),
  replyReviewUI: (id: string, value: string | null) => ipcRenderer.invoke('system-plugins:review-reply', id, value),
  onSystemUI: (listener: (event: SystemUIEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: SystemUIEvent) => listener(value)
    ipcRenderer.on('system-plugins:ui', handler)
    return () => ipcRenderer.off('system-plugins:ui', handler)
  },
  onPluginsChanged: (listener: () => void): (() => void) => {
    const handler = () => listener()
    ipcRenderer.on('plugins:changed', handler)
    return () => ipcRenderer.off('plugins:changed', handler)
  },
  listSubagents: (parentSessionId: string) => ipcRenderer.invoke('subagents:list', parentSessionId),
  abortSubagent: (parentSessionId: string, id: string) => ipcRenderer.invoke('subagents:abort', parentSessionId, id),
  abortAllSubagents: (parentSessionId: string) => ipcRenderer.invoke('subagents:abort-all', parentSessionId),
  clearFinishedSubagents: (parentSessionId: string) => ipcRenderer.invoke('subagents:clear-finished', parentSessionId),
  getSubagentTranscript: (parentSessionId: string, id: string) => ipcRenderer.invoke('subagents:transcript', parentSessionId, id),
  getSubagentSettings: () => ipcRenderer.invoke('subagents:settings-get'),
  setSubagentSettings: (patch: SubagentSettingsPatch) => ipcRenderer.invoke('subagents:settings-set', patch),
  onSubagentsChanged: (listener: (update: SubagentListUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: SubagentListUpdate) => listener(value)
    ipcRenderer.on('subagents:changed', handler)
    return () => ipcRenderer.off('subagents:changed', handler)
  },
  setSendShortcut: (shortcut: string) =>
    ipcRenderer.invoke('settings:set-send-shortcut', shortcut),
  setCompletionNotifications: (enabled: boolean) =>
    ipcRenderer.invoke('settings:set-completion-notifications', enabled),
  setBeamBorderEnabled: (enabled: boolean) => ipcRenderer.invoke('settings:set-beam-border', enabled),
  setLocaleSetting: (locale: string) => ipcRenderer.invoke('settings:set-locale', locale),
  setTheme: (patch: unknown) => ipcRenderer.invoke('settings:set-theme', patch),
  setDefaultModelSetting: (provider: string, id: string) =>
    ipcRenderer.invoke('settings:set-default-model', provider, id),
  setDefaultThinkingSetting: (level: string) =>
    ipcRenderer.invoke('settings:set-default-thinking', level),
  listProviders: () => ipcRenderer.invoke('settings:list-providers'),
  loginProvider: (providerId: string, authType: string) =>
    ipcRenderer.invoke('settings:login', providerId, authType),
  logoutProvider: (providerId: string) =>
    ipcRenderer.invoke('settings:logout', providerId),
  replyAuthPrompt: (id: string, value: string | null) =>
    ipcRenderer.invoke('settings:auth-reply', id, value),
  cancelLogin: () => ipcRenderer.invoke('settings:cancel-login'),
  onEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: unknown): void => listener(event)
    ipcRenderer.on('pi:event', handler)
    return () => {
      ipcRenderer.off('pi:event', handler)
    }
  },
  onNotificationClick: (listener: (sessionId: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, sessionId: string): void => listener(sessionId)
    ipcRenderer.on('notification:click', handler)
    return () => ipcRenderer.off('notification:click', handler)
  },
  onSessionWindow: (listener: (update: SessionWindowMessage) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: SessionWindowMessage): void => listener(update)
    ipcRenderer.on('session:window', handler)
    return () => {
      ipcRenderer.off('session:window', handler)
    }
  },
  onSessionBranchChanged: (listener: (sessionId: string, leafId: string | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, leafId: string | null): void => listener(sessionId, leafId)
    ipcRenderer.on('session:branch-changed', handler)
    return () => {
      ipcRenderer.off('session:branch-changed', handler)
    }
  },
  onAuthEvent: (listener: (event: SettingsAuthEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: SettingsAuthEvent): void => listener(event)
    ipcRenderer.on('settings:auth-event', handler)
    return () => {
      ipcRenderer.off('settings:auth-event', handler)
    }
  },
  onModelCatalog: (listener: (catalog: ModelCatalog) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, catalog: ModelCatalog): void => listener(catalog)
    ipcRenderer.on('models:changed', handler)
    return () => {
      ipcRenderer.off('models:changed', handler)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  Object.assign(window, { api })
}

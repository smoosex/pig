import { contextBridge, ipcRenderer } from 'electron'
import type { SessionApi, SessionWindowMessage, SettingsAuthEvent } from '../shared/api'

/** Keep the IPC channel allowlist here; the renderer never receives ipcRenderer itself. */
const api: SessionApi = {
  listProjects: () => ipcRenderer.invoke('session:list-projects'),
  listProject: (cwd: string) => ipcRenderer.invoke('session:list-project', cwd),
  listChats: () => ipcRenderer.invoke('session:list-chats'),
  isChatCwd: (cwd: string) => ipcRenderer.invoke('session:is-chat-cwd', cwd),
  openProject: () => ipcRenderer.invoke('session:open-project'),
  unpinProject: (cwd: string) => ipcRenderer.invoke('session:unpin-project', cwd),
  reorderProjects: (cwds: string[]) =>
    ipcRenderer.invoke('session:reorder-projects', cwds),
  createChat: () => ipcRenderer.invoke('session:create-chat'),
  deleteChat: (cwd: string) => ipcRenderer.invoke('session:delete-chat', cwd),
  createSession: (cwd: string) =>
    ipcRenderer.invoke('session:create', cwd),
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
  deleteWorktree: (projectCwd: string, cwd: string, force?: boolean) =>
    ipcRenderer.invoke('project:delete-worktree', projectCwd, cwd, force),
  onProjectsChanged: (listener: (projectCwd: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, cwd: string) => listener(cwd)
    ipcRenderer.on('projects:changed', handler)
    return () => ipcRenderer.off('projects:changed', handler)
  },
  deleteSession: (sessionId: string, path: string, cwd: string) =>
    ipcRenderer.invoke('session:delete', sessionId, path, cwd),
  prompt: (
    sessionId: string,
    text: string,
    images?: Parameters<SessionApi['prompt']>[2],
    textAttachments?: Parameters<SessionApi['prompt']>[3],
    streamingBehavior?: Parameters<SessionApi['prompt']>[4]
  ) => ipcRenderer.invoke('session:prompt', sessionId, text, images, textAttachments, streamingBehavior),
  abort: (sessionId: string) => ipcRenderer.invoke('session:abort', sessionId),
  getDisplayTurns: (sessionId: string) =>
    ipcRenderer.invoke('session:get-display-turns', sessionId),
  getTurnWindow: (sessionId: string, start: number, count: number) =>
    ipcRenderer.invoke('session:get-turn-window', sessionId, start, count),
  getTurnMessages: (sessionId: string, turnId: string) =>
    ipcRenderer.invoke('session:get-turn-messages', sessionId, turnId),
  getSessionTree: (sessionId: string) =>
    ipcRenderer.invoke('session:get-tree', sessionId),
  viewBranch: (sessionId: string, tipId: string) =>
    ipcRenderer.invoke('session:view-branch', sessionId, tipId),
  getControls: (sessionId: string) =>
    ipcRenderer.invoke('session:get-controls', sessionId),
  getTokenStats: (sessionId: string) =>
    ipcRenderer.invoke('session:get-token-stats', sessionId),
  getCommands: (sessionId: string) =>
    ipcRenderer.invoke('session:get-commands', sessionId),
  exportSession: (sessionId: string, outputPath?: string) =>
    ipcRenderer.invoke('session:export', sessionId, outputPath),
  setModel: (sessionId: string, provider: string, id: string) =>
    ipcRenderer.invoke('session:set-model', sessionId, provider, id),
  setThinking: (sessionId: string, level: string) =>
    ipcRenderer.invoke('session:set-thinking', sessionId, level),
  refreshModels: (sessionId: string) =>
    ipcRenderer.invoke('session:refresh-models', sessionId),
  followUpAction: (sessionId: string, index: number, action: string) =>
    ipcRenderer.invoke('session:follow-up-action', sessionId, index, action),
  pickDirectory: () => ipcRenderer.invoke('system:pick-directory'),
  getSidebarPrefs: () => ipcRenderer.invoke('system:get-sidebar-prefs'),
  setSidebarPrefs: (patch: unknown) =>
    ipcRenderer.invoke('system:set-sidebar-prefs', patch),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSendShortcut: (shortcut: string) =>
    ipcRenderer.invoke('settings:set-send-shortcut', shortcut),
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
  onSessionWindow: (listener: (update: SessionWindowMessage) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: SessionWindowMessage): void => listener(update)
    ipcRenderer.on('session:window', handler)
    return () => {
      ipcRenderer.off('session:window', handler)
    }
  },
  onAuthEvent: (listener: (event: SettingsAuthEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: SettingsAuthEvent): void => listener(event)
    ipcRenderer.on('settings:auth-event', handler)
    return () => {
      ipcRenderer.off('settings:auth-event', handler)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  Object.assign(window, { api })
}

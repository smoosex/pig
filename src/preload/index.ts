import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listProjects: (): Promise<unknown> => ipcRenderer.invoke('session:list-projects'),
  listProject: (cwd: string): Promise<unknown> => ipcRenderer.invoke('session:list-project', cwd),
  listChats: (): Promise<unknown> => ipcRenderer.invoke('session:list-chats'),
  isChatCwd: (cwd: string): Promise<boolean> => ipcRenderer.invoke('session:is-chat-cwd', cwd),
  openProject: (): Promise<unknown> => ipcRenderer.invoke('session:open-project'),
  unpinProject: (cwd: string): Promise<void> => ipcRenderer.invoke('session:unpin-project', cwd),
  createChat: (): Promise<{ sessionId: string; cwd: string }> => ipcRenderer.invoke('session:create-chat'),
  deleteChat: (cwd: string): Promise<void> => ipcRenderer.invoke('session:delete-chat', cwd),
  createSession: (cwd: string): Promise<{ sessionId: string; cwd: string }> =>
    ipcRenderer.invoke('session:create', cwd),
  openSession: (path: string): Promise<{ sessionId: string; cwd: string }> =>
    ipcRenderer.invoke('session:open', path),
  prepareSession: (sessionId: string): Promise<{ sessionId: string; cwd: string; created: boolean }> =>
    ipcRenderer.invoke('session:prepare', sessionId),
  closeSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:close', sessionId),
  deleteProject: (cwd: string): Promise<void> => ipcRenderer.invoke('session:delete-project', cwd),
  deleteSession: (sessionId: string, path: string, cwd: string): Promise<void> =>
    ipcRenderer.invoke('session:delete', sessionId, path, cwd),
  prompt: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('session:prompt', sessionId, text),
  abort: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:abort', sessionId),
  getMessages: (sessionId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('session:get-messages', sessionId),
  getDisplayTurns: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('session:get-display-turns', sessionId),
  getTurnMessages: (sessionId: string, turnId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('session:get-turn-messages', sessionId, turnId),
  getSessionTree: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('session:get-tree', sessionId),
  viewBranch: (sessionId: string, tipId: string): Promise<void> =>
    ipcRenderer.invoke('session:view-branch', sessionId, tipId),
  getControls: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('session:get-controls', sessionId),
  setModel: (sessionId: string, provider: string, id: string): Promise<unknown> =>
    ipcRenderer.invoke('session:set-model', sessionId, provider, id),
  setThinking: (sessionId: string, level: string): Promise<unknown> =>
    ipcRenderer.invoke('session:set-thinking', sessionId, level),
  refreshModels: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('session:refresh-models', sessionId),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('system:pick-directory'),
  getSidebarPrefs: (): Promise<unknown> => ipcRenderer.invoke('system:get-sidebar-prefs'),
  setSidebarPrefs: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('system:set-sidebar-prefs', patch),
  onEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: unknown): void => listener(event)
    ipcRenderer.on('pi:event', handler)
    return () => {
      ipcRenderer.off('pi:event', handler)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore
  window.api = api
}
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listProjects: (): Promise<unknown> => ipcRenderer.invoke('session:list-projects'),
  listProject: (cwd: string): Promise<unknown> => ipcRenderer.invoke('session:list-project', cwd),
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
  getControls: (sessionId: string): Promise<unknown> =>
    ipcRenderer.invoke('session:get-controls', sessionId),
  setModel: (sessionId: string, provider: string, id: string): Promise<unknown> =>
    ipcRenderer.invoke('session:set-model', sessionId, provider, id),
  setThinking: (sessionId: string, level: string): Promise<unknown> =>
    ipcRenderer.invoke('session:set-thinking', sessionId, level),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('system:pick-directory'),
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
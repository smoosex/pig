import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listProjects: (): Promise<unknown> => ipcRenderer.invoke('session:list-projects'),
  createSession: (cwd: string): Promise<{ sessionId: string; cwd: string }> =>
    ipcRenderer.invoke('session:create', cwd),
  openSession: (path: string): Promise<{ sessionId: string; cwd: string }> =>
    ipcRenderer.invoke('session:open', path),
  closeSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:close', sessionId),
  prompt: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('session:prompt', sessionId, text),
  abort: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:abort', sessionId),
  getMessages: (sessionId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('session:get-messages', sessionId),
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
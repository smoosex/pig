/** Native material changes wait for every loaded UI to paint solid; closed or reloading UIs never hold the barrier. */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { SurfaceStyle } from '../../shared/api'
import type { SettingsSurfaceRequest } from '../../shared/settings'
import type { SurfaceHandoff } from './service'

interface PendingSurface {
  windows: Map<BrowserWindow, (error?: Error) => void>
}

export class SettingsSurfaceCoordinator {
  private ready = new Set<BrowserWindow>()
  private watched = new WeakSet<BrowserWindow>()
  private pending = new Map<string, PendingSurface>()

  watch(win: BrowserWindow): void {
    this.ready.add(win)
    if (this.watched.has(win)) return
    this.watched.add(win)
    const invalidate = () => {
      this.ready.delete(win)
      // A window that is gone or reloading cannot show the old material any more.
      for (const pending of this.pending.values()) pending.windows.get(win)?.()
    }
    win.once('closed', invalidate)
    win.webContents.on('render-process-gone', invalidate)
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) invalidate()
    })
  }

  private send(win: BrowserWindow, request: SettingsSurfaceRequest): void {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('settings:surface', request)
  }

  reply(win: BrowserWindow, requestId: string, error?: string): void {
    this.pending.get(requestId)?.windows.get(win)?.(error ? new Error(error) : undefined)
  }

  async prepare(signal?: AbortSignal): Promise<SurfaceHandoff> {
    signal?.throwIfAborted()
    const requestId = randomUUID()
    const waiting: PendingSurface = { windows: new Map() }
    const windows = [...this.ready].filter((win) => !win.isDestroyed() && !win.webContents.isDestroyed())
    this.pending.set(requestId, waiting)
    const finish = (surfaceStyle: SurfaceStyle) => {
      for (const win of windows) this.send(win, { type: 'finish', requestId, surfaceStyle })
    }
    const abort = () => {
      for (const settle of [...waiting.windows.values()]) settle(signal!.reason instanceof Error ? signal!.reason : new Error('Settings change cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await Promise.all(windows.map((win) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => settle(new Error('Settings UI did not prepare its solid surface in time')), 5_000)
        const settle = (error?: Error) => {
          if (!waiting.windows.delete(win)) return
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        waiting.windows.set(win, settle)
        try {
          this.send(win, { type: 'prepare-solid', requestId })
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)))
        }
      })))
      return { finish }
    } catch (error) {
      for (const settle of [...waiting.windows.values()]) settle(new Error('Settings surface handoff cancelled'))
      // No material or file changed yet. Undo any staged opaque backgrounds.
      finish('glass')
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.pending.delete(requestId)
    }
  }
}

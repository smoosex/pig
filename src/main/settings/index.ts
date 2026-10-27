/** Electron integration for the shared configuration service and the session-bound Agent bridge. */
import { BrowserWindow, nativeTheme, type BrowserWindow as Window } from 'electron'
import { registerSettingsAgentHost } from '../plugins/pig-settings-host'
import { applyLocaleSetting } from '../i18n'
import { applyShortcutOverrides } from '../shortcuts'
import { applyWindowSurfaceStyle } from '../window-surface'
import { SettingsService } from './service'
import { SettingsSurfaceCoordinator } from './surface'

export interface SettingsSessions {
  sessionWindow(sessionId: string): Window | undefined
  isSessionLive(sessionId: string): boolean
}

export function createSettingsRuntime(sessions?: SettingsSessions) {
  const surface = new SettingsSurfaceCoordinator()
  const service = new SettingsService({
    prepareSolid: (signal) => surface.prepare(signal),
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme.appearance
      applyWindowSurfaceStyle(theme.surfaceStyle)
    },
    applyLocale: applyLocaleSetting,
    applyShortcuts: applyShortcutOverrides,
    isDark: () => nativeTheme.shouldUseDarkColors,
    publish: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents?.isDestroyed()) win.webContents?.send('settings:changed', event)
      }
    }
  })
  if (sessions) {
    const authorize = (sessionId: string) => {
      const win = sessions.sessionWindow(sessionId)
      if (!sessions.isSessionLive(sessionId) || !win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('The requesting session is no longer open in a Pig window')
    }
    registerSettingsAgentHost({
      async list(sessionId, options) {
        authorize(sessionId)
        const result = await service.list(options)
        authorize(sessionId)
        return result
      },
      async get(sessionId, group) {
        authorize(sessionId)
        const result = await service.get(group)
        authorize(sessionId)
        return result
      },
      update: (sessionId, request, signal) => service.update(request, signal, () => authorize(sessionId))
    })
  }
  return { service, surface }
}

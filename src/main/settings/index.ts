/** Electron integration for the shared configuration service and the session-bound Agent bridge. */
import { BrowserWindow, nativeTheme, type BrowserWindow as Window } from 'electron'
import { registerSettingsAgentHost } from '../plugins/pig-settings-host'
import { applyLocaleSetting } from '../i18n'
import { applyShortcutOverrides } from '../shortcuts'
import { applyWindowSurfaceStyle } from '../window-surface'
import { refreshPluginSessions, refreshToolSessions } from '../pi/session-registry'
import { emitToolSettingsChanged } from '../mcp/events'
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
    // Same notifications and reloads as the plugin and MCP settings IPC.
    pluginsChanged: async () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('plugins:changed')
      }
      await refreshPluginSessions()
    },
    mcpChanged: async () => {
      await refreshToolSessions()
      emitToolSettingsChanged()
    },
    publish: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents?.isDestroyed()) win.webContents?.send('settings:changed', event)
      }
    }
  })
  if (sessions) {
    const authorize = async (sessionId: string, instance?: object) => {
      const ordinary = sessions.isSessionLive(sessionId)
      const liveBotSettingsWindow = !ordinary && instance ? (await import('../bot/service')).liveBotSettingsWindow : undefined
      const getWindow = ordinary
        ? () => sessions.isSessionLive(sessionId) ? sessions.sessionWindow(sessionId) : undefined
        : () => liveBotSettingsWindow?.(sessionId, instance)
      const win = getWindow()
      const check = () => {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed() || getWindow() !== win) {
          throw new Error('The requesting session is no longer open in a Pig window')
        }
      }
      check()
      return check
    }
    registerSettingsAgentHost({
      async list(sessionId, options, instance) {
        const check = await authorize(sessionId, instance)
        const result = await service.list(options)
        check()
        return result
      },
      async get(sessionId, group, instance) {
        const check = await authorize(sessionId, instance)
        const result = await service.get(group)
        check()
        return result
      },
      async update(sessionId, request, signal, instance) {
        return service.update(request, signal, await authorize(sessionId, instance))
      }
    })
  }
  return { service, surface }
}

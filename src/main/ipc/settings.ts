import { ipcMain, nativeTheme } from 'electron'
import { windowForEvent } from './window'
import {
  loadPigSettings,
  savePigSettings,
  type SendShortcut
} from '../pig-settings'
import { applyLocaleSetting, systemLocale } from '../i18n'
import type { LocaleSetting, ThemePrefs } from '../../shared/api'
import { applyWindowSurfaceStyle } from '../window-surface'
import {
  cancelProviderLogin,
  listProviders,
  loginProvider,
  logoutProvider,
  resolveAuthPrompt,
  type ProviderAuthType
} from '../pi/providers'
import {
  getDefaultSessionSettings,
  setDefaultModel,
  setDefaultThinking,
  type SessionThinkingLevel
} from '../pi/model-settings'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async () => {
    const pig = await loadPigSettings()
    const [defaults, providers] = await Promise.all([
      getDefaultSessionSettings(),
      listProviders()
    ])
    return {
      sendShortcut: pig.sendShortcut,
      completionNotifications: pig.completionNotifications,
      beamBorderEnabled: pig.beamBorderEnabled,
      localeSetting: pig.locale,
      systemLocale: systemLocale(),
      appearance: pig.appearance,
      surfaceStyle: pig.surfaceStyle,
      lightTheme: pig.lightTheme,
      darkTheme: pig.darkTheme,
      defaultModel: defaults.model,
      defaultThinkingLevel: defaults.thinkingLevel,
      thinkingLevels: defaults.thinkingLevels,
      providers
    }
  })

  ipcMain.handle('settings:set-send-shortcut', async (_event, shortcut: SendShortcut) => {
    return savePigSettings({ sendShortcut: shortcut })
  })

  ipcMain.handle('settings:set-completion-notifications', async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean notification setting')
    return savePigSettings({ completionNotifications: enabled })
  })

  ipcMain.handle('settings:set-beam-border', async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean beam border setting')
    return savePigSettings({ beamBorderEnabled: enabled })
  })

  ipcMain.handle('settings:set-locale', async (_event, locale: LocaleSetting) => {
    const next = await savePigSettings({ locale })
    applyLocaleSetting(next.locale)
    return { localeSetting: next.locale, systemLocale: systemLocale() }
  })

  ipcMain.handle(
    'settings:set-theme',
    async (
      _event,
      patch: Partial<ThemePrefs>
    ) => {
      const next = await savePigSettings(patch ?? {})
      nativeTheme.themeSource = next.appearance
      applyWindowSurfaceStyle(next.surfaceStyle)
      return next
    }
  )

  ipcMain.handle('settings:set-default-model', async (_event, provider: string, id: string) => {
    if (!provider || !id) throw new Error('Provider and model id are required')
    return setDefaultModel(provider, id)
  })

  ipcMain.handle('settings:set-default-thinking', async (_event, level: SessionThinkingLevel) => {
    if (!level) throw new Error('Thinking level is required')
    return setDefaultThinking(level)
  })

  ipcMain.handle('settings:list-providers', async () => listProviders())

  ipcMain.handle(
    'settings:login',
    async (event, providerId: string, authType: ProviderAuthType) => {
      if (!providerId) throw new Error('Provider id is required')
      const win = windowForEvent(event)
      await loginProvider(win, providerId, authType)
      return listProviders()
    }
  )

  ipcMain.handle('settings:logout', async (_event, providerId: string) => {
    if (!providerId) throw new Error('Provider id is required')
    await logoutProvider(providerId)
    return listProviders()
  })

  ipcMain.handle('settings:auth-reply', async (_event, id: string, value: string | null) => {
    if (!id) throw new Error('Prompt id is required')
    resolveAuthPrompt(id, value)
  })

  ipcMain.handle('settings:cancel-login', async () => {
    cancelProviderLogin()
  })
}

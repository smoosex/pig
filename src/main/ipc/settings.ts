import { ipcMain } from 'electron'
import { windowForEvent } from './window'
import {
  loadPigSettings,
  savePigSettings,
  type Appearance,
  type PaletteId,
  type SendShortcut
} from '../pig-settings'
import { applyLocaleSetting, systemLocale } from '../i18n'
import type { LocaleSetting } from '../../shared/api'
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
  listAvailableModels,
  setDefaultModel,
  setDefaultThinking,
  type SessionThinkingLevel
} from '../pi/model-settings'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', async () => {
    const pig = await loadPigSettings()
    const [defaults, models, providers] = await Promise.all([
      getDefaultSessionSettings(),
      listAvailableModels(),
      listProviders()
    ])
    return {
      sendShortcut: pig.sendShortcut,
      localeSetting: pig.locale,
      systemLocale: systemLocale(),
      appearance: pig.appearance,
      lightTheme: pig.lightTheme,
      darkTheme: pig.darkTheme,
      defaultModel: defaults.model,
      defaultThinkingLevel: defaults.thinkingLevel,
      thinkingLevels: defaults.thinkingLevels,
      models,
      providers
    }
  })

  ipcMain.handle('settings:set-send-shortcut', async (_event, shortcut: SendShortcut) => {
    return savePigSettings({ sendShortcut: shortcut })
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
      patch: { appearance?: Appearance; lightTheme?: PaletteId; darkTheme?: PaletteId }
    ) => {
      return savePigSettings(patch ?? {})
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

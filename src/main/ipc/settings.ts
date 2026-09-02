import { BrowserWindow, ipcMain } from 'electron'
import { loadPigSettings, savePigSettings, type SendShortcut } from '../pig-settings'
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
} from '../pi/session-registry'

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
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window attached to sender')
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

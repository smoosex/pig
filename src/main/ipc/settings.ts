import { ipcMain } from 'electron'
import { windowForEvent } from './window'
import { assertBrowserSender } from '../browser/validation'
import { createSettingsRuntime, type SettingsSessions } from '../settings'
import type { LocaleSetting, SendShortcut, ThemePrefs } from '../../shared/api'
import {
  cancelProviderLogin,
  listProviders,
  loginProvider,
  logoutProvider,
  resolveAuthPrompt,
  type ProviderAuthType
} from '../pi/providers'
import type { SessionThinkingLevel } from '../pi/model-settings'

export function registerSettingsIpc(sessions?: SettingsSessions): void {
  const { service, surface } = createSettingsRuntime(sessions)
  ipcMain.handle('settings:get', async (event) => {
    if (event.sender) {
      const win = windowForEvent(event)
      assertBrowserSender(event, win)
      surface.watch(win)
    }
    const [settings, providers] = await Promise.all([service.getUi(), listProviders()])
    return { ...settings, providers }
  })

  ipcMain.handle('settings:surface-reply', (event, requestId: string, error?: string) => {
    const win = windowForEvent(event)
    assertBrowserSender(event, win)
    if (typeof requestId !== 'string' || (error !== undefined && typeof error !== 'string')) throw new Error('Invalid settings surface reply')
    surface.reply(win, requestId, error?.slice(0, 500))
  })

  ipcMain.handle('settings:set-send-shortcut', (_event, shortcut: SendShortcut) =>
    service.updateUi('shortcuts', { sendShortcut: shortcut }))
  ipcMain.handle('settings:set-shortcuts', (_event, patch: unknown) =>
    service.updateUi('shortcuts', { bindings: patch }))
  ipcMain.handle('settings:set-completion-notifications', (_event, enabled: boolean) =>
    service.updateUi('notifications', { completionNotifications: enabled }))
  ipcMain.handle('settings:set-beam-border', (_event, enabled: boolean) => service.setBeamBorder(enabled))
  ipcMain.handle('settings:set-locale', (_event, locale: LocaleSetting) => service.updateUi('general', { locale }))
  ipcMain.handle('settings:set-theme', (_event, patch: Partial<ThemePrefs>) => service.updateUi('theme', patch))

  const defaultsReply = async (patch: { model?: { provider: string; id: string }; thinkingLevel?: SessionThinkingLevel }) => {
    const next = await service.updateUi('defaults', patch)
    return { model: next.defaultModel, thinkingLevel: next.defaultThinkingLevel, thinkingLevels: next.thinkingLevels, settingsRevision: next.settingsRevision }
  }
  ipcMain.handle('settings:set-default-model', (_event, provider: string, id: string) => defaultsReply({ model: { provider, id } }))
  ipcMain.handle('settings:set-default-thinking', (_event, level: SessionThinkingLevel) => defaultsReply({ thinkingLevel: level }))

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

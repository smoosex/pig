import { BrowserWindow, ipcMain } from 'electron'
import type { CustomModelInput, CustomProviderInput, DiscoverModelsInput } from '../../shared/api'
import { assertBrowserSender } from '../browser/validation'
import {
  discoverCustomModels,
  getCustomModels,
  removeCustomModel,
  removeCustomProvider,
  saveCustomModel,
  saveCustomProvider
} from '../pi/custom-models'
import { getScopedModels, setScopedModels } from '../pi/scoped-models'
import { currentModelCatalog, refreshModelCatalog } from '../pi/model-catalog'
import { windowForEvent } from './window'

/**
 * The model catalog is app-wide state, not a session's: these handlers are the only way a picker
 * learns about a new provider, and `refreshModelCatalog()` pushes the result to every window
 * including the caller's, so a reply and a push never disagree about which revision is current.
 */
export function registerModelIpc(): void {
  ipcMain.handle('models:get-scoped', () => getScopedModels())
  ipcMain.handle('models:set-scoped', async (_event, patterns: string[]) => {
    await setScopedModels(patterns)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('models:scope-changed')
      }
    }
  })
  ipcMain.handle('models:get-catalog', () => currentModelCatalog())
  ipcMain.handle('models:refresh-catalog', () => refreshModelCatalog())
  ipcMain.handle('models:custom-get', (event) => {
    if (event.sender) assertBrowserSender(event, windowForEvent(event))
    return getCustomModels()
  })
  ipcMain.handle('models:custom-save-provider', (event, input: CustomProviderInput) => {
    assertBrowserSender(event, windowForEvent(event))
    return saveCustomProvider(input)
  })
  ipcMain.handle('models:custom-remove-provider', (event, providerId: string) => {
    assertBrowserSender(event, windowForEvent(event))
    return removeCustomProvider(providerId)
  })
  ipcMain.handle('models:custom-save-model', (event, providerId: string, model: CustomModelInput | CustomModelInput[]) => {
    assertBrowserSender(event, windowForEvent(event))
    return saveCustomModel(providerId, model)
  })
  ipcMain.handle('models:custom-remove-model', (event, providerId: string, modelId: string) => {
    assertBrowserSender(event, windowForEvent(event))
    return removeCustomModel(providerId, modelId)
  })
  ipcMain.handle('models:custom-discover', (event, input: DiscoverModelsInput) => {
    assertBrowserSender(event, windowForEvent(event))
    return discoverCustomModels(input)
  })
}

export { startModelCatalog } from '../pi/model-catalog'

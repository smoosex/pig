/* Persona configuration is owned by Pig; only a window's UI main frame can edit its files. */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { refreshConversationFeatures } from '../pi/session-registry'
import {
  getPersona, savePersonaFile, setPersonaAutomatic, setPersonaMood, setPersonaObserver
} from '../features/persona/service'
import { onPersonaControlsChanged } from '../features/persona/controls'
import { clearObserverUsage, summarizeObserverUsage } from '../features/persona/usage'
import type { PersonaDocument, PersonaMoodValues, PersonaObserverSettings, PersonaObserverUsageRange } from '../../shared/persona'

function assertUi(event: IpcMainInvokeEvent): void {
  assertBrowserSender(event, windowForEvent(event))
}

export function registerPersonaIpc(): void {
  // Conversations change mood through the settings tools too; open settings pages must re-read.
  onPersonaControlsChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('persona:changed')
    }
  })
  ipcMain.handle('persona:get', (event) => {
    assertUi(event)
    return getPersona()
  })
  ipcMain.handle('persona:save-file', async (event, document: PersonaDocument) => {
    assertUi(event)
    const result = await savePersonaFile(document)
    await refreshConversationFeatures()
    return result
  })
  ipcMain.handle('persona:set-mood', (event, values: PersonaMoodValues) => {
    assertUi(event)
    return setPersonaMood(values)
  })
  ipcMain.handle('persona:set-observer', (event, settings: PersonaObserverSettings) => {
    assertUi(event)
    return setPersonaObserver(settings)
  })
  ipcMain.handle('persona:set-automatic', (event, enabled: boolean) => {
    assertUi(event)
    return setPersonaAutomatic(enabled)
  })
  ipcMain.handle('persona:observer-usage', (event, range: PersonaObserverUsageRange) => {
    assertUi(event)
    return summarizeObserverUsage(range)
  })
  ipcMain.handle('persona:clear-observer-usage', (event) => {
    assertUi(event)
    return clearObserverUsage()
  })
}

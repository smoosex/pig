/* Persona configuration is owned by Pig; only a window's UI main frame can edit its files. */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { refreshPluginSessions } from '../pi/session-registry'
import {
  getPersona, savePersonaFile, setPersonaAutomatic, setPersonaMood, setPersonaObserver
} from '../plugins/pi-persona/service'
import type { PersonaDocument, PersonaMoodValues, PersonaObserverSettings } from '../../shared/persona'

function assertUi(event: IpcMainInvokeEvent): void {
  assertBrowserSender(event, windowForEvent(event))
}

export function registerPersonaIpc(): void {
  ipcMain.handle('persona:get', (event) => {
    assertUi(event)
    return getPersona()
  })
  ipcMain.handle('persona:save-file', async (event, document: PersonaDocument) => {
    assertUi(event)
    const result = await savePersonaFile(document)
    await refreshPluginSessions(true)
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
}

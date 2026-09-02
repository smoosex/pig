import { registerSessionIpc } from './session'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'

export function registerIpc(): void {
  registerSessionIpc()
  registerSettingsIpc()
  registerSystemIpc()
}

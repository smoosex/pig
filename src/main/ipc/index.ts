import { registerSessionIpc } from './session'
import { registerProjectIpc } from './projects'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'

export function registerIpc(): void {
  registerProjectIpc()
  registerSessionIpc()
  registerSettingsIpc()
  registerSystemIpc()
}

import { registerSessionIpc } from './session'
import { registerSystemIpc } from './system'

export function registerIpc(): void {
  registerSessionIpc()
  registerSystemIpc()
}

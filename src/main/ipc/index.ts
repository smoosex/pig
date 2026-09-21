import { registerSessionIpc } from './session'
import { registerProjectIpc } from './projects'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'
import { registerDiffIpc } from './diff'
import { registerFilesIpc } from './files'

export function registerIpc(): void {
  registerProjectIpc()
  registerSessionIpc()
  registerSettingsIpc()
  registerSystemIpc()
  registerDiffIpc()
  registerFilesIpc()
}

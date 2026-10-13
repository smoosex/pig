import { registerSessionIpc } from './session'
import { registerProjectIpc } from './projects'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'
import { registerDiffIpc } from './diff'
import { registerFilesIpc } from './files'
import { registerPluginIpc } from './plugins'
import { registerMcpIpc } from './mcp'
import { registerModelIpc } from './models'

export function registerIpc(): void {
  registerProjectIpc()
  registerSessionIpc()
  registerSettingsIpc()
  registerSystemIpc()
  registerDiffIpc()
  registerFilesIpc()
  registerPluginIpc()
  registerMcpIpc()
  registerModelIpc()
}

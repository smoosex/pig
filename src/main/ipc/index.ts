import { registerSessionIpc } from './session'
import { registerProjectIpc } from './projects'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'
import { registerDiffIpc } from './diff'
import { registerFilesIpc } from './files'
import { registerPluginIpc } from './plugins'
import { registerMcpIpc } from './mcp'
import { registerModelIpc } from './models'
import { registerSkillsIpc } from './skills'
import { registerSubagentIpc } from './subagents'
import { registerBrowserIpc } from './browser'
import { registerTerminalIpc } from './terminal'
import { getLive } from '../pi/session-registry'
import { registerProcessIpc } from './processes'
import { registerPermissionsIpc } from './permissions'
import { registerSessionReader } from '../pi/session-read'

export function registerIpc(): void {
  registerProjectIpc()
  registerSessionIpc()
  registerSessionReader()
  registerSystemIpc()
  registerDiffIpc()
  registerFilesIpc()
  registerPluginIpc()
  registerMcpIpc()
  registerModelIpc()
  registerSkillsIpc()
  const sessions = { sessionWindow: (id: string) => getLive(id)?.win, isSessionLive: (id: string) => getLive(id) !== undefined }
  registerSubagentIpc(getLive)
  registerSettingsIpc(sessions)
  registerTerminalIpc(sessions)
  registerBrowserIpc(sessions)
  registerProcessIpc()
  registerPermissionsIpc()
}

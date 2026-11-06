import { registerSessionIpc } from './session'
import { registerProjectIpc } from './projects'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'
import { registerDiffIpc } from './diff'
import { registerFilesIpc } from './files'
import { registerPluginIpc } from './plugins'
import { registerPersonaIpc } from './persona'
import { registerConversationFeaturesIpc } from './conversation-features'
import { registerMcpIpc } from './mcp'
import { registerModelIpc } from './models'
import { registerSkillsIpc } from './skills'
import { registerSubagentIpc } from './subagents'
import { registerBrowserIpc } from './browser'
import { registerTerminalIpc } from './terminal'
import { getLive } from '../pi/session-registry'
import { isChatCwd } from '../chats'
import { registerProcessIpc } from './processes'
import { registerPermissionsIpc } from './permissions'
import { registerSessionReader } from '../pi/session-read'
import { registerSessionAgentIpc } from './session-agent'

export function registerIpc(): void {
  registerProjectIpc()
  registerSessionIpc()
  registerSessionReader()
  registerSessionAgentIpc()
  registerSystemIpc()
  registerDiffIpc()
  registerFilesIpc()
  registerPluginIpc()
  registerPersonaIpc()
  registerConversationFeaturesIpc()
  registerMcpIpc()
  registerModelIpc()
  registerSkillsIpc()
  const sessions = { sessionWindow: (id: string) => getLive(id)?.win, isSessionLive: (id: string) => getLive(id) !== undefined }
  registerSubagentIpc(getLive)
  registerSettingsIpc(sessions)
  registerTerminalIpc(sessions)
  registerBrowserIpc({
    ...sessions,
    sessionScope: (id) => {
      const live = getLive(id)
      return live ? (isChatCwd(live.cwd) ? '' : live.cwd) : undefined
    }
  })
  registerProcessIpc()
  registerPermissionsIpc()
}

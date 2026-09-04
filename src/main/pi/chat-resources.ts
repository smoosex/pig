import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type ResourceLoader
} from '@earendil-works/pi-coding-agent'

const CHAT_APPEND_PROMPT = `This session is a conversation, not a software project.
The current working directory is an empty scratch folder for this chat. It is not the user's project.
Do not list, read, search, or otherwise inspect the working directory or parent directories unless the user explicitly asks you to use files or commands.
Answer from the conversation. Only use tools when the user asks for file, command, or workspace work.`

function isInside(file: string, root: string): boolean {
  const base = resolve(root)
  const target = resolve(file)
  return target === base || target.startsWith(base + sep)
}

export async function createChatResourceLoader(cwd: string): Promise<ResourceLoader> {
  const agentDir = getAgentDir()
  const userAgents = resolve(homedir(), '.agents')
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter((file) => isInside(file.path, agentDir))
    }),
    skillsOverride: (base) => ({
      skills: base.skills.filter(
        (skill) => isInside(skill.filePath, agentDir) || isInside(skill.filePath, userAgents)
      ),
      diagnostics: base.diagnostics
    }),
    appendSystemPrompt: [CHAT_APPEND_PROMPT]
  })
  await loader.reload()
  return loader
}

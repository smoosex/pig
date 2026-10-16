/** Load only Pig-approved extensions, preserving Chat's restricted instructions and skills. */
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { applySkillPreferences } from '../skills/manager'
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type ResourceLoader,
  type ExtensionFactory
} from '@earendil-works/pi-coding-agent'

const CHAT_APPEND_PROMPT = `This session is a conversation, not a software project.
The current working directory is an empty scratch folder for this chat. It is not the user's project.
Do not list, read, search, or otherwise inspect the working directory or parent directories unless the user explicitly asks you to use files or commands.
Answer from the conversation. Enabled external services and Codemode may help with the user's request, but they do not authorize inspecting this scratch folder or parent directories.`

function isInside(file: string, root: string): boolean {
  const base = resolve(root)
  const target = resolve(file)
  return target === base || target.startsWith(base + sep)
}

export function sessionResourceSettings(cwd: string, agentDir: string): SettingsManager {
  // ResourceLoader resolves packages even with noExtensions=true, potentially running install scripts.
  // Only Pig's explicitly approved package paths may participate in extension loading.
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      const path = scope === 'global' ? join(agentDir, 'settings.json') : join(cwd, '.pi', 'settings.json')
      let text: string | undefined
      try {
        const settings: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Invalid Pi settings: ${path}`)
        text = JSON.stringify({ ...settings, packages: [] })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // Read-only by design: Pig owns plugin allowlisting and its own settings files, and the
      // Pi extension API exposes no settings writer, so any write here indicates misuse.
      const next = fn(text)
      if (next !== undefined) throw new Error('Pi settings are read-only in Pig sessions')
    }
  })
}

interface SessionResourceOptions {
  settingsManager?: SettingsManager
  extensionFactories?: ExtensionFactory[]
  appendSystemPrompt?: string[]
}

export async function createNoExtensionsResourceLoader(cwd: string, pluginPaths: string[] = [], options: SessionResourceOptions = {}): Promise<ResourceLoader> {
  const agentDir = getAgentDir()
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: options.settingsManager ?? sessionResourceSettings(cwd, agentDir),
    extensionFactories: options.extensionFactories,
    noExtensions: true,
    additionalExtensionPaths: pluginPaths,
    skillsOverride: (base) => applySkillPreferences(base),
    ...(options.appendSystemPrompt?.length ? { appendSystemPrompt: options.appendSystemPrompt } : {})
  })
  await loader.reload()
  return loader
}

export async function createChatResourceLoader(cwd: string, pluginPaths: string[] = [], options: SessionResourceOptions = {}): Promise<ResourceLoader> {
  const agentDir = getAgentDir()
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: options.settingsManager ?? sessionResourceSettings(cwd, agentDir),
    extensionFactories: options.extensionFactories,
    noExtensions: true,
    additionalExtensionPaths: pluginPaths,
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter((file) => isInside(file.path, agentDir))
    }),
    skillsOverride: (base) => applySkillPreferences(base, true),
    appendSystemPrompt: [CHAT_APPEND_PROMPT, ...(options.appendSystemPrompt ?? [])]
  })
  await loader.reload()
  return loader
}

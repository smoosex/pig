/** Load only Pig-approved extensions, preserving Chat's restricted instructions and skills. */
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { applySkillPreferences, listSkillChoices } from '../skills/manager'
import { capability, readSessionCapabilities } from './session-capabilities'
import type { SessionCapability } from '../../shared/session-capabilities'
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
  sessionId?: string
  /** Receives the SDK's skills before Pig's preferences, so the full list can be built on demand. */
  onSkillBase?: (base: SkillBase) => void
}
type SkillBase = Parameters<typeof applySkillPreferences>[0]

function sessionSkills(base: SkillBase, chat: boolean, options: SessionResourceOptions) {
  options.onSkillBase?.(base)
  const overrides = options.sessionId ? readSessionCapabilities(options.sessionId).skills : {}
  return applySkillPreferences(base, chat, overrides)
}

export function sessionSkillChoices(base: SkillBase, chat: boolean, overrides: Record<string, boolean>): SessionCapability[] {
  const unique = new Map(listSkillChoices(base, chat).map(({ skill, defaultEnabled, source }) => [skill.filePath,
    { ...capability(skill.filePath, skill.name, defaultEnabled, overrides, skill.description), source }]))
  return [...unique.values()]
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
    skillsOverride: (base) => sessionSkills(base, false, options)
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
    skillsOverride: (base) => sessionSkills(base, true, options),
    appendSystemPrompt: [CHAT_APPEND_PROMPT]
  })
  await loader.reload()
  return loader
}

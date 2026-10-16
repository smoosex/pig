/** Builds the SDK runtime of a Pig session: approved plugins, Pig tools, and Chat's restricted resources. */
import { createAgentSession, getAgentDir, type AgentSession, type ResourceLoader, type SessionManager } from '@earendil-works/pi-coding-agent'
import { isChatCwd } from '../chats'
import { createChatResourceLoader, createNoExtensionsResourceLoader, sessionResourceSettings } from './chat-resources'
import { startModelRuntime } from './model-settings'
import { sessionToolFactory } from './tool-resources'

export class SessionResourceError extends Error { readonly code = 'ERR_SESSION_RESOURCES_UNAVAILABLE' }

export function assertExtensionResources(loader: ResourceLoader): void {
  const errors = loader.getExtensions().errors
  if (errors.length) throw new SessionResourceError(errors.map((item) => `${item.path}: ${item.error}`).join('\n'))
}

export async function createSessionRuntime(
  cwd: string,
  sessionManager: SessionManager,
  pluginPaths: string[],
  appendSystemPrompt?: string[],
  options: Pick<NonNullable<Parameters<typeof createChatResourceLoader>[2]>, 'onSkillBase'> & {
    toolPreferences?: Parameters<typeof sessionToolFactory>[2]
  } = {}
): Promise<AgentSession> {
  const settingsManager = sessionResourceSettings(cwd, getAgentDir())
  const sessionId = sessionManager.getSessionId()
  const resources = { onSkillBase: options.onSkillBase, settingsManager, sessionId,
    extensionFactories: [sessionToolFactory(cwd, sessionId, options.toolPreferences)], appendSystemPrompt }
  const resourceLoader = isChatCwd(cwd)
    ? await createChatResourceLoader(cwd, pluginPaths, resources)
    : await createNoExtensionsResourceLoader(cwd, pluginPaths, resources)
  assertExtensionResources(resourceLoader)
  const result = await createAgentSession({
    cwd,
    sessionManager,
    modelRuntime: await startModelRuntime(),
    settingsManager,
    resourceLoader
  })
  return result.session
}

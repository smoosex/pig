/** Builds the SDK runtime of a Pig session: approved plugins, Pig tools, and Chat's restricted resources. */
import { createAgentSession, getAgentDir, type AgentSession, type ExtensionUIContext, type ResourceLoader, type SessionManager } from '@earendil-works/pi-coding-agent'
import { isChatCwd } from '../chats'
import { createChatResourceLoader, createNoExtensionsResourceLoader, sessionResourceSettings } from './chat-resources'
import { startModelRuntime } from './model-settings'
import { pigDocsExtension } from './pig-docs'
import { pigIdentityExtension } from './pig-identity'
import { permissionsExtension, type PermissionOptions } from '../permissions/extension'
import { sessionPermission } from '../permissions/store'
import { restrictPermissionMode } from '../permissions/mode'
import type { PermissionMode } from '../../shared/permissions'
import { sessionToolFactory } from './tool-resources'
import { SESSION_TOOLS_EXTENSION } from '../permissions/mcp'

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
    /** Subagents keep Pi's plain identity, like they skip the persona plugin. */
    identity?: boolean
    /** Subagents share the parent's grants, but may never exceed their launch mode. */
    permissions?: { sessionId: string; mode: PermissionMode; approvalUI?: Pick<ExtensionUIContext, 'select'>; signal?: AbortSignal }
  } = {}
): Promise<AgentSession> {
  const settingsManager = sessionResourceSettings(cwd, getAgentDir())
  const sessionId = sessionManager.getSessionId()
  const inherited = options.permissions
  const permissionOptions: PermissionOptions = {
    cwd, settingsManager,
    sessionId: inherited?.sessionId ?? sessionId,
    approvalUI: inherited?.approvalUI,
    signal: inherited?.signal,
    mcpAtExecution: true,
    // A child retains its launch-time ceiling and also follows later parent restrictions.
    mode: inherited
      ? () => restrictPermissionMode(inherited.mode, sessionPermission(inherited.sessionId).mode)
      : () => sessionPermission(sessionId).mode
  }
  const permissions = permissionsExtension(permissionOptions)
  const resources = { onSkillBase: options.onSkillBase, settingsManager, sessionId,
    extensionFactories: [
      pigDocsExtension,
      permissions,
      ...(options.identity === false ? [] : [pigIdentityExtension]),
      { name: SESSION_TOOLS_EXTENSION, factory: sessionToolFactory(cwd, sessionId, options.toolPreferences, permissionOptions) }
    ], appendSystemPrompt }
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

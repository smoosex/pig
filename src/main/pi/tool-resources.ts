/** Only user-facing sessions opt into Pig's tool factories; auxiliary resource loaders stay unchanged. */
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type ExtensionContext,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { pigPath } from '../pig-dir'
import { sessionMcpConfig } from '../mcp/settings'
import { readSessionCapabilities } from './session-capabilities'
import type { SessionCapabilityOverrides } from '../../shared/session-capabilities'
import { mcpCredentials, mcpSdk } from '../mcp/sdk'
import { createMcpConnections } from '../mcp/connections'
import { t } from '../i18n'
import { openMcpUrl } from '../extension-ui'
import { loadAllowedRanges } from '../network-address'
import { webSearchConfigPath } from './web-search-settings'
import { authorizeMcpCall, type PermissionOptions } from '../permissions/extension'

export function sessionToolFactory(
  cwd: string,
  sessionId: string,
  inherited?: Pick<SessionCapabilityOverrides, 'tools' | 'mcp'>,
  permissions?: PermissionOptions
): ExtensionFactory {
  return async (pi) => {
    const preferences = inherited ?? readSessionCapabilities(sessionId)
    const snapshot = await sessionMcpConfig(cwd, preferences.mcp)
    const codemode = preferences.tools.codemode !== false
    let context: ExtensionContext | undefined
    // Overrides change only through a resource reload, which runs this factory again.
    pi.on('tool_call', (event) => {
      if (preferences.tools[event.toolName] === false)
        return { block: true, reason: 'Tool disabled for this session' }
      return undefined
    })
    pi.on('session_start', (_event, ctx) => {
      context = ctx
    })
    const { runtime } = await mcpSdk()
    const connections = createMcpConnections(
      runtime,
      async (origin, addresses, signal) => {
        if (!context?.hasUI) return false
        return context.ui.confirm(
          t('mcp.localAccessTitle'),
          t('mcp.localAccessDescription', { origin, addresses: addresses.join(', ') }),
          { signal }
        )
      },
      // A user-declared proxy fake-IP range is proxy-owned space, not an internal service.
      () => loadAllowedRanges(webSearchConfigPath())
    )
    await createCodemodeExtension({ mode: 'on' })(pi)
    await createToolSearchExtension()(pi)
    // Pi preflights a whole parallel batch before executing it. Wrap only SDK MCP tools so the
    // permission decision happens at execution and remains cancellable while a client reconnects.
    const mcpPi = permissions ? new Proxy(pi, {
      get(target, key, receiver) {
        if (key !== 'registerTool') return Reflect.get(target, key, receiver)
        return (tool: ToolDefinition) => {
          if (!tool.namespace?.name.startsWith('mcp__')) return pi.registerTool(tool)
          return pi.registerTool({
            ...tool,
            async execute(id, input, signal, update, ctx) {
              const guard = await authorizeMcpCall(permissions, tool, input, ctx, signal)
              try {
                guard.check()
                return await tool.execute(id, input, guard.signal, update, ctx)
              } finally { guard.dispose() }
            }
          })
        }
      }
    }) : pi
    await createMcpExtension({
      loadConfig: () => snapshot,
      createTransport: connections.createTransport,
      fetch: connections.fetch,
      credentials: await mcpCredentials(),
      logPath: pigPath('mcp.log'),
      openUrl: openMcpUrl,
      updateConfig: () => {
        throw new Error('Manage MCP configuration in Pig settings')
      }
    })(mcpPi)
    pi.on('session_shutdown', async () => {
      context = undefined
      await connections.close()
    })
    pi.on('session_start', () => {
      const tools = pi
        .getActiveTools()
        .filter((name) => name !== 'codemode' && name !== 'tool_search')
      // Pi registers codemode inactive; Pig activates it like any other extension tool.
      if (codemode) tools.push('codemode')
      if (
        codemode ||
        pi
          .getAllTools()
          .some((tool) => tool.exposure === 'deferred' || tool.exposure === 'codemode') ||
        snapshot.servers.some(
          (entry) =>
            entry.config.enabled &&
            (entry.config.exposure === 'deferred' ||
              Object.values(entry.config.toolExposure ?? {}).includes('deferred'))
        )
      )
        tools.push('tool_search')
      pi.setActiveTools([...new Set(tools)])
    })
  }
}

/** Only user-facing sessions opt into Pig's tool factories; auxiliary resource loaders stay unchanged. */
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type ExtensionContext
} from '@earendil-works/pi-coding-agent'
import { pigPath } from '../pig-dir'
import { sessionMcpConfig } from '../mcp/settings'
import { mcpCredentials, mcpSdk } from '../mcp/sdk'
import { createMcpConnections } from '../mcp/connections'
import { t } from '../i18n'
import { openMcpUrl } from '../extension-ui'
import { loadAllowedRanges } from '../network-address'
import { webSearchConfigPath } from './web-search-settings'

export function sessionToolFactory(cwd: string): ExtensionFactory {
  return async (pi) => {
    const snapshot = await sessionMcpConfig(cwd)
    let context: ExtensionContext | undefined
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
    if (snapshot.codemode) await createCodemodeExtension({ mode: 'on' })(pi)
    await createToolSearchExtension()(pi)
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
    })(pi)
    pi.on('session_shutdown', async () => {
      context = undefined
      await connections.close()
    })
    pi.on('session_start', () => {
      const tools = pi
        .getActiveTools()
        .filter((name) => name !== 'codemode' && name !== 'tool_search')
      if (snapshot.codemode) tools.push('codemode')
      if (
        snapshot.codemode ||
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

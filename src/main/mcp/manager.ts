/** Management connections use Pi's transport/OAuth implementation without a model or session transcript. */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { ModelRegistry } from '@earendil-works/pi-coding-agent'
import type { McpProbeResult } from '../../shared/api'
import { createExtensionUI, cancelExtensionUI, openMcpUrl } from '../extension-ui'
import { startModelRuntime } from '../pi/model-settings'
import { t } from '../i18n'
import { configuredServers, deleteMcpCredentials, flushToolMutations } from './settings'
import { assertMcpAuthCurrent, createMcpConnections, onMcpAuthRetire } from './connections'
import { mcpCredentials, mcpSdk, type McpConnection } from './sdk'

interface Operation {
  name: string
  owner: string
  authenticating: boolean
  controller: AbortController
  done: Promise<void>
  connections?: ReturnType<typeof createMcpConnections>
}
const operations = new Set<Operation>()
export function cancelMcpLogin(): void {
  for (const operation of operations) if (operation.authenticating) operation.controller.abort()
}
export async function cancelMcpOperations(name?: string): Promise<void> {
  const selected = [...operations].filter((operation) => !name || operation.name === name)
  for (const operation of selected) operation.controller.abort()
  await Promise.all(selected.map((operation) => operation.done))
}
onMcpAuthRetire(async (names) => {
  await Promise.all([...names].map((name) => cancelMcpOperations(name)))
})
async function connection(
  name: string,
  operation: Operation,
  win?: BrowserWindow
): Promise<McpConnection> {
  await flushToolMutations(operation.controller.signal)
  operation.controller.signal.throwIfAborted()
  const entry = (await configuredServers()).find((server) => server.name === name)
  if (!entry) throw new Error(`MCP server not found: ${name}`)
  const { runtime } = await mcpSdk()
  const credentials = await mcpCredentials()
  operation.controller.signal.throwIfAborted()
  assertMcpAuthCurrent(name)
  const connections = createMcpConnections(runtime, async (origin, addresses, signal) => {
    if (!win) return false
    const ui = await createExtensionUI(win, operation.owner)
    return ui.confirm(
      t('mcp.localAccessTitle'),
      t('mcp.localAccessDescription', { origin, addresses: addresses.join(', ') }),
      { signal: AbortSignal.any([signal, operation.controller.signal]) }
    )
  })
  operation.connections = connections
  return new runtime.McpServerConnection({
    entry,
    cwd: process.cwd(),
    createTransport: connections.createTransport,
    fetch: connections.fetch,
    credentials,
    onTools: () => {},
    providerToken: async (provider) =>
      new ModelRegistry(await startModelRuntime()).getApiKeyForProvider(provider)
  })
}
async function withConnection<T>(
  name: string,
  win: BrowserWindow | undefined,
  authenticating: boolean,
  action: (server: McpConnection, operation: Operation) => Promise<T>
): Promise<T> {
  assertMcpAuthCurrent(name)
  if (authenticating && [...operations].some((operation) => operation.authenticating))
    throw new Error('An MCP login is already in progress')
  let finish!: () => void
  const operation: Operation = {
    name,
    owner: `mcp:${name}:${randomUUID()}`,
    authenticating,
    controller: new AbortController(),
    done: new Promise<void>((resolve) => {
      finish = resolve
    })
  }
  operations.add(operation)
  let server: McpConnection | undefined
  let closing: Promise<void> | undefined
  const close = () =>
    server || operation.connections
      ? (closing ??= (async () => {
          try {
            await server?.close()
          } finally {
            await operation.connections?.close()
          }
        })())
      : Promise.resolve()
  const abort = () => {
    cancelExtensionUI(operation.owner)
    // An abort listener cannot await teardown; the finalizer awaits this same promise and propagates errors.
    void close().catch(() => {})
  }
  const destroyed = () => operation.controller.abort()
  win?.webContents.once('destroyed', destroyed)
  operation.controller.signal.addEventListener('abort', abort, { once: true })
  try {
    if (win?.isDestroyed() || win?.webContents.isDestroyed()) operation.controller.abort()
    server = await connection(name, operation, win)
    operation.controller.signal.throwIfAborted()
    return await action(server, operation)
  } finally {
    cancelExtensionUI(operation.owner)
    operation.controller.signal.removeEventListener('abort', abort)
    win?.webContents.removeListener('destroyed', destroyed)
    try {
      await close()
    } finally {
      operations.delete(operation)
      finish()
    }
  }
}
function result(server: McpConnection): McpProbeResult {
  return {
    state:
      server.state === 'connected'
        ? 'ready'
        : server.state === 'needs-auth'
          ? 'needs-auth'
          : 'failed',
    ...(server.error ? { message: server.error } : {}),
    tools: server.tools.map(({ name, description }) => ({ name, description }))
  }
}
export function testMcpServer(name: string, win?: BrowserWindow): Promise<McpProbeResult> {
  return withConnection(name, win, false, async (server, operation) => {
    try {
      await server.getClient()
    } catch (error) {
      // The probe boundary returns SDK connection/auth failures as a typed status for the settings page.
      if (server.state !== 'failed' && server.state !== 'needs-auth') throw error
    }
    operation.controller.signal.throwIfAborted()
    return result(server)
  })
}
export function loginMcpServer(win: BrowserWindow, name: string): Promise<McpProbeResult> {
  if ([...operations].some((operation) => operation.authenticating))
    throw new Error('An MCP login is already in progress')
  return withConnection(name, win, true, async (server, operation) => {
    try {
      await server.getClient()
    } catch (error) {
      // A 401 requiring interactive OAuth is expected here; network/protocol/IO failures are not.
      if (server.state !== 'needs-auth') throw error
    }
    operation.controller.signal.throwIfAborted()
    if (!server.oauthUrl)
      throw new Error('This server uses API key/provider authentication, not OAuth')
    const ui = await createExtensionUI(win, operation.owner)
    const { runtime } = await mcpSdk()
    await runtime.signInMcpServer({
      serverUrl: server.oauthUrl,
      fetch: operation.connections!.fetch,
      store: (await mcpCredentials()).forServer(name, server.oauthUrl),
      settings: server.oauthSettings(),
      challenge: server.challenge,
      signal: operation.controller.signal,
      prompt: {
        showAuthorizationUrl: (url) => {
          ui.notify(url.href)
          return openMcpUrl(url.href)
        },
        promptForRedirectUrl: (signal) =>
          ui.input(t('mcp.oauth'), t('mcp.oauthRedirect'), { signal })
      }
    })
    await server.reconnect()
    operation.controller.signal.throwIfAborted()
    return result(server)
  })
}
export async function logoutMcpServer(name: string): Promise<void> {
  await deleteMcpCredentials(name)
}

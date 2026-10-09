/** Revoke MCP capabilities before deleting credentials; retired runtimes can never refresh or reconnect. */
import type { mcpSdk } from './sdk'
import { createMcpNetwork, type AuthorizeLocal } from './network.ts'

type Runtime = Awaited<ReturnType<typeof mcpSdk>>['runtime']
type Factory = Runtime['createDefaultTransport']
type Provider = NonNullable<Parameters<Factory>[2]> & { settled?(): Promise<void> }
const generations = new Map<string, number>()
const blocked = new Map<string, number>()
const scopes = new Set<{ retire(names: Set<string>): Promise<void> }>()
const cancellations = new Set<(names: Set<string>) => Promise<void>>()
export class McpAuthRevokedError extends Error {
  readonly code = 'ERR_MCP_AUTH_REVOKED'
}
export function mcpAuthGeneration(name: string): number {
  return generations.get(name) ?? 0
}
export function assertMcpAuthCurrent(name: string, generation = mcpAuthGeneration(name)): void {
  if (blocked.has(name) || generation !== mcpAuthGeneration(name))
    throw new McpAuthRevokedError(`MCP authentication revoked: ${name}`)
}
export function onMcpAuthRetire(cancel: (names: Set<string>) => Promise<void>): void {
  cancellations.add(cancel)
}
export async function withMcpAuthMutation<T>(
  names: string[],
  change: () => Promise<T> | T
): Promise<T> {
  const affected = new Set(names)
  for (const name of affected) {
    blocked.set(name, (blocked.get(name) ?? 0) + 1)
    generations.set(name, mcpAuthGeneration(name) + 1)
  }
  try {
    // close() also awaits SDK auth.settled(), so already-running refreshes finish before removal.
    await Promise.all(
      [...cancellations]
        .map((cancel) => cancel(affected))
        .concat([...scopes].map((scope) => scope.retire(affected)))
    )
    return await change()
  } finally {
    for (const name of affected) {
      const count = blocked.get(name)! - 1
      if (count) blocked.set(name, count)
      else blocked.delete(name)
    }
  }
}
export function createMcpConnections(runtime: Runtime, authorize?: AuthorizeLocal) {
  const versions = new Map(generations)
  const network = createMcpNetwork(authorize)
  const handles = new Set<{ name: string; close(): Promise<void> }>()
  const scope = {
    async retire(names: Set<string>) {
      await Promise.all(
        [...handles].filter((handle) => names.has(handle.name)).map((handle) => handle.close())
      )
    }
  }
  scopes.add(scope)
  let closed = false
  const createTransport: Factory = (entry, cwd, auth) => {
    if (closed) throw new McpAuthRevokedError('MCP runtime is closed')
    const check = () => assertMcpAuthCurrent(entry.name, versions.get(entry.name) ?? 0)
    check()
    let retired = false
    const checkProvider = () => {
      check()
      if (retired) throw new McpAuthRevokedError(`MCP connection is closed: ${entry.name}`)
    }
    const guarded = auth
      ? {
          async token() {
            checkProvider()
            return auth.token()
          },
          async onUnauthorized(context: Parameters<NonNullable<Provider['onUnauthorized']>>[0]) {
            checkProvider()
            await auth.onUnauthorized?.(context)
          }
        }
      : undefined
    const transport = runtime.createDefaultTransport(entry, cwd, guarded, network.fetch)
    const originalClose = transport.close.bind(transport)
    let closing: Promise<void> | undefined
    const handle = {
      name: entry.name,
      close() {
        retired = true
        return (closing ??= (async () => {
          try {
            await originalClose()
          } finally {
            await (auth as Provider | undefined)?.settled?.()
            handles.delete(handle)
          }
        })())
      }
    }
    transport.close = handle.close
    handles.add(handle)
    return transport
  }
  return {
    fetch: network.fetch,
    createTransport,
    async close() {
      closed = true
      try {
        await Promise.all([...handles].map((handle) => handle.close()))
      } finally {
        scopes.delete(scope)
        await network.close()
      }
    }
  }
}

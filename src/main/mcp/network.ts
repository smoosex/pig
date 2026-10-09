/** MCP HTTP and OAuth share a fail-closed connector: DNS answers are validated where sockets open. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Agent } from 'undici'
import { isBlockedAddress } from '../network-address.ts'

export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>
export type McpLookup = (hostname: string) => Promise<{ address: string; family: number }[]>
export type AuthorizeLocal = (
  origin: string,
  addresses: string[],
  signal: AbortSignal
) => Promise<boolean>
export class McpNetworkError extends Error {
  readonly code = 'ERR_MCP_NETWORK_DENIED'
}
interface RequestContext {
  url: URL
  signal: AbortSignal
}
const redirects = new Set([301, 302, 303, 307, 308])

export function createMcpNetwork(
  authorize?: AuthorizeLocal,
  resolve: McpLookup = (host) => lookup(host, { all: true, verbatim: true })
) {
  const context = new AsyncLocalStorage<RequestContext>()
  const shutdown = new AbortController()
  const grants = new Set<string>()
  const approvals = new Map<string, Promise<boolean>>()
  let agent: Agent | undefined
  let transport: Promise<typeof import('undici')> | undefined
  const validate = async ({ url, signal }: RequestContext, addresses: string[]) => {
    signal.throwIfAborted()
    const denied = addresses.filter(
      (address) => isBlockedAddress(address) && !grants.has(`${url.origin}|${address}`)
    )
    if (!denied.length) return
    if (denied.some((address) => !isIP(address)))
      throw new McpNetworkError(`Invalid DNS address for ${url.origin}`)
    const key = `${url.origin}|${[...denied].sort().join(',')}`
    let approval = approvals.get(key)
    if (!approval) {
      approval = authorize ? authorize(url.origin, denied, signal) : Promise.resolve(false)
      approvals.set(key, approval)
    }
    const allowed = await approval
    signal.throwIfAborted()
    if (!allowed)
      throw new McpNetworkError(
        `MCP local-network access denied: ${url.origin} (${denied.join(', ')})`
      )
    for (const address of denied) grants.add(`${url.origin}|${address}`)
  }
  const load = () =>
    (transport ??= import('undici').then((module) => {
      if (typeof module.Agent.prototype.destroy !== 'function')
        throw new McpNetworkError('MCP requires a Node-compatible DNS-enforcing HTTP transport')
      agent = new module.Agent({
        connect: {
          lookup(hostname, options, callback) {
            const request = context.getStore()
            if (!request) {
              callback(new McpNetworkError('Missing MCP connection policy'), '')
              return
            }
            // This is the actual connector lookup, not a preflight followed by a second DNS resolution.
            void resolve(hostname)
              .then(async (addresses) => {
                if (!addresses.length) throw new McpNetworkError(`No DNS addresses for ${hostname}`)
                await validate(
                  request,
                  addresses.map(({ address }) => address)
                )
                const selected = options.family
                  ? addresses.filter(({ family }) => family === options.family)
                  : addresses
                if (!selected.length)
                  throw new McpNetworkError(`No matching DNS family for ${hostname}`)
                if (options.all) callback(null, selected)
                else callback(null, selected[0].address, selected[0].family)
              })
              .catch((error: NodeJS.ErrnoException) => {
                // DNS/authorization failure is translated to the connector's error callback, never bypassed.
                callback(error, '')
              })
          }
        }
      })
      return module
    }))
  const checkedFetch: McpFetch = async (input, init = {}) => {
    let url = new URL(input)
    const signal = AbortSignal.any([shutdown.signal, ...(init.signal ? [init.signal] : [])])
    let request = { ...init, signal }
    const module = await load()
    for (let hop = 0; hop <= 5; hop++) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new McpNetworkError('Only HTTP(S) MCP requests are allowed')
      if (url.username || url.password)
        throw new McpNetworkError('MCP URLs must not contain credentials')
      const current = { url, signal }
      const host = url.hostname.replace(/^\[|\]$/g, '')
      // Literal IPs bypass Node's DNS lookup, so check them explicitly before dispatch.
      if (isIP(host)) await validate(current, [host])
      let response: Response
      try {
        response = (await context.run(current, () =>
          module.fetch(url, {
            ...request,
            redirect: 'manual',
            dispatcher: agent
          } as unknown as import('undici').RequestInit)
        )) as unknown as Response
      } catch (error) {
        // Undici wraps connector errors in TypeError; preserve our stable policy error for the UI.
        if ((error as Error).cause instanceof McpNetworkError) throw (error as Error).cause
        throw error
      }
      const location = response.headers.get('location')
      if (!redirects.has(response.status) || !location || init.redirect === 'manual')
        return response
      await response.body?.cancel()
      if (init.redirect === 'error' || hop === 5)
        throw new McpNetworkError('MCP redirect refused or limit exceeded')
      const next = new URL(location, url)
      const headers = new Headers(request.headers)
      if (next.origin !== url.origin) {
        headers.delete('authorization')
        headers.delete('cookie')
        headers.delete('proxy-authorization')
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          request.method?.toUpperCase() === 'POST')
      ) {
        request = { ...request, method: 'GET', body: undefined }
        headers.delete('content-length')
        headers.delete('content-type')
      } else if (request.body instanceof ReadableStream)
        throw new McpNetworkError('Cannot replay a streaming MCP request across redirects')
      request = { ...request, headers }
      url = next
    }
    throw new McpNetworkError('MCP redirect limit exceeded')
  }
  return {
    fetch: checkedFetch,
    async close() {
      shutdown.abort()
      await agent?.destroy()
    }
  }
}

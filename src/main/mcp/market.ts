/** Featured recipes work offline; explicit searches augment them with compatible official Registry entries. */
import type { McpConfig, McpMarketInput, McpMarketResult, McpMarketServer } from '../../shared/api'
import { literalMcpValue } from '../../shared/mcp-market'
import { featuredMcpServers } from './featured'

interface Variable {
  name?: string
  value?: string
  default?: string
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  variables?: Record<string, Variable>
}
interface Argument extends Variable {
  type?: string
  valueHint?: string
}
interface RegistryServer {
  name: string
  title?: string
  description?: string
  websiteUrl?: string
  repository?: { url?: string }
  remotes?: { type: string; url: string; headers?: Variable[] }[]
  packages?: {
    registryType: string
    identifier: string
    transport?: { type?: string }
    environmentVariables?: Variable[]
    packageArguments?: Argument[]
    runtimeArguments?: Argument[]
  }[]
}
const placeholder = /\{[^{}]+\}/g
const input = (value: Variable, where: McpMarketInput['where'], key: string): McpMarketInput => ({
  key,
  where,
  label: key,
  description: value.description,
  required: value.isRequired,
  secret: value.isSecret,
  ...(value.value?.includes('{') ? { format: value.value.replace(placeholder, '{}') } : {})
})
export function registryMcpServer(server: RegistryServer): McpMarketServer | null {
  if (typeof server.name !== 'string') return null
  const short = server.name
    .split('/')
    .pop()!
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+/, '')
  if (!short) return null
  const base = {
    id: server.name,
    name: short,
    title: server.title || short,
    description: server.description || '',
    publisher: server.name.split('/')[0],
    homepage: server.websiteUrl || server.repository?.url,
    featured: false
  }
  for (const remote of server.remotes ?? []) {
    if (
      remote.type !== 'streamable-http' ||
      !remote.url?.startsWith('https://') ||
      remote.url.includes('{')
    )
      continue
    const headers: Record<string, string> = {}
    const inputs: McpMarketInput[] = []
    for (const header of remote.headers ?? []) {
      if (!header.name) continue
      if (header.value && !header.value.includes('{'))
        headers[header.name] = literalMcpValue(header.value)
      else {
        const variables = Object.values(header.variables ?? {})
        if (variables.length > 1) return null
        const variable = variables[0]
        inputs.push(
          input(
            {
              ...header,
              isRequired: variable?.isRequired ?? header.isRequired,
              isSecret: variable?.isSecret ?? header.isSecret
            },
            'header',
            header.name
          )
        )
      }
    }
    return {
      ...base,
      config: {
        url: remote.url,
        headers,
        description: base.description,
        enabled: false,
        exposure: 'deferred'
      },
      inputs
    }
  }
  for (const kind of ['npm', 'pypi', 'oci']) {
    for (const pkg of server.packages ?? []) {
      if (
        pkg.registryType !== kind ||
        !pkg.identifier ||
        (pkg.transport?.type && pkg.transport.type !== 'stdio')
      )
        continue
      const command = kind === 'npm' ? 'npx' : kind === 'pypi' ? 'uvx' : 'docker'
      const args =
        kind === 'npm'
          ? ['-y', `${pkg.identifier.replace(/@[^/]+$/, '')}@latest`]
          : kind === 'pypi'
            ? [`${pkg.identifier.split('@')[0]}@latest`]
            : ['run', '-i', '--rm']
      const env: Record<string, string> = {}
      const inputs: McpMarketInput[] = []
      for (const variable of pkg.environmentVariables ?? []) {
        if (!variable.name) continue
        const value = variable.value || variable.default
        if (value && !value.includes('{')) env[variable.name] = literalMcpValue(value)
        else inputs.push(input(variable, 'env', variable.name))
        if (kind === 'oci') args.push('-e', variable.name)
      }
      if (kind === 'oci') args.push(pkg.identifier)
      for (const [i, argument] of (pkg.packageArguments ?? []).entries()) {
        const value = argument.value || argument.default
        if (!value && !argument.isRequired) continue
        if (argument.type === 'named' && argument.name) args.push(argument.name)
        if (value && !value.includes('{')) args.push(value)
        else if (argument.isRequired || value?.includes('{')) {
          const key = `arg${i}`
          args.push(`{${key}}`)
          inputs.push({
            ...input(argument, 'arg', key),
            label: argument.name || argument.valueHint || key,
            required: true
          })
        }
      }
      // Unknown runtime flags could change where/how the package executes; leave those to manual JSON.
      if (pkg.runtimeArguments?.length) continue
      return {
        ...base,
        config: {
          command,
          args,
          env,
          description: base.description,
          enabled: false,
          exposure: 'deferred'
        },
        inputs
      }
    }
  }
  return null
}
function identity(config: McpConfig): string {
  if ('url' in config) return config.url.replace(/\/$/, '')
  const pkg = config.args?.find((value) => !value.startsWith('-') && value !== 'run') || ''
  return `${config.command}:${pkg.replace(/@[^/@]+$/, '')}`
}
const cache = new Map<string, { expires: number; servers: McpMarketServer[] }>()
export async function searchMcpMarket(
  query: string,
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = fetch
): Promise<McpMarketResult> {
  const q = query.trim().toLowerCase()
  const featured = featuredMcpServers.filter(
    (server) => !q || JSON.stringify(server).toLowerCase().includes(q)
  )
  if (!q) return { servers: featured }
  try {
    let found = cache.get(q)
    if (!found || found.expires < Date.now()) {
      const url = new URL('https://registry.modelcontextprotocol.io/v0/servers')
      url.search = new URLSearchParams({ search: q, limit: '100', version: 'latest' }).toString()
      const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`MCP Registry: HTTP ${response.status}`)
      const body = (await response.json()) as {
        servers?: { server: RegistryServer; _meta?: Record<string, { status?: string }> }[]
      }
      const servers = (body.servers ?? [])
        .flatMap((entry) => {
          const status = entry._meta?.['io.modelcontextprotocol.registry/official']?.status
          if (status && status !== 'active') return []
          const converted = registryMcpServer(entry.server)
          return converted ? [converted] : []
        })
        .sort((a, b) => {
          const rank = (server: McpMarketServer) =>
            (server.name.toLowerCase() === q ? 100 : 0) +
            (server.title.toLowerCase().includes(q) ? 20 : 0) -
            (server.id.startsWith('ai.smithery/') ? 60 : 0)
          return rank(b) - rank(a)
        })
        .slice(0, 30)
      found = { expires: Date.now() + 300_000, servers }
      if (cache.size >= 64) cache.delete(cache.keys().next().value!)
      cache.set(q, found)
    }
    const seen = new Set(featured.map((server) => identity(server.config)))
    return {
      servers: [
        ...featured,
        ...found.servers.filter((server) => {
          const key = identity(server.config)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      ]
    }
  } catch (error) {
    return { servers: featured, error: error instanceof Error ? error.message : String(error) }
  }
}

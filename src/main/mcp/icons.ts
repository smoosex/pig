/**
 * MCP catalog icons, fetched once and cached on disk.
 *
 * Catalog listings name an HTTPS source; the renderer never contacts it. Main downloads the bytes
 * under the shared address policy, stores them in `PIG_DIR/mcp-icons/`, and serves them through the
 * `pig-mcp-icon` scheme. An address the policy blocks is refused even when the source is well-known,
 * so an icon can never become a way to reach an internal service.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  isAllowedAddress,
  isBlockedAddress,
  isProxyFakeAddress,
  loadAllowedRanges
} from '../network-address.ts'
import { webSearchConfigPath } from '../pi/web-search-settings'
import { pigPath } from '../pig-dir'
import { parseMcpIconUrl } from '../../shared/mcp-icons'

const MAX_ICON_BYTES = 1 << 20
const MAX_REDIRECTS = 3
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const ICON_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|avif|bmp)$/
export interface McpIcon {
  body: Buffer
  mimeType: string
}
export interface McpIconDeps {
  /** Directory the cache lives in; defaults to `PIG_DIR/mcp-icons`. */
  directory?: string
  /** DNS answers for a hostname; the connection itself is not pinned to this answer. */
  resolve?: (hostname: string) => Promise<string[]>
  request?: (input: URL, init: RequestInit) => Promise<Response>
  /** Proxy fake-IP ranges exempted from the blocked policy; read per miss so a change applies live. */
  allowedRanges?: () => string[]
  /** How long a failed lookup is remembered before the policy and DNS are consulted again. */
  negativeTtlMs?: number
}

/** The declared proxy fake-IP ranges, the same knob the bundled web-access plugin reads. */
function declaredRanges(): string[] {
  return loadAllowedRanges(webSearchConfigPath())
}

function blocked(addresses: string[], ranges: string[], resolved: boolean): boolean {
  return addresses.some(
    (address) =>
      isBlockedAddress(address) &&
      !(resolved && isProxyFakeAddress(address)) &&
      !isAllowedAddress(address, ranges)
  )
}

export function createMcpIconCache(deps: McpIconDeps = {}) {
  const resolve =
    deps.resolve ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address))
  const request = deps.request ?? ((input: URL, init: RequestInit) => fetch(input, init))
  const ranges = deps.allowedRanges ?? declaredRanges
  const directory = deps.directory ?? pigPath('mcp-icons')
  // A successful icon is stable; a failure may be a policy or DNS answer the user is about to change.
  const cached = new Map<string, { icon: McpIcon | null; expires?: number }>()
  const negativeTtl = deps.negativeTtlMs ?? 30_000
  const inFlight = new Map<string, Promise<McpIcon | null>>()

  const cachePath = (source: string): string => {
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 32)
    return join(directory, digest)
  }
  /**
   * Reject an icon source before connecting. The connection is not pinned to this answer, because
   * the bytes are inert images and the renderer never receives a response body to inspect.
   */
  const allowedUrl = async (source: string): Promise<URL | null> => {
    let url: URL
    try {
      url = new URL(source)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const exempt = ranges()
    if (isIP(host)) return blocked([host], exempt, false) ? null : url
    let addresses: string[]
    try {
      addresses = await resolve(host)
    } catch {
      return null
    }
    return !addresses.length || blocked(addresses, exempt, true) ? null : url
  }
  const download = async (source: string): Promise<McpIcon | null> => {
    // Every hop is resolved and checked, so a redirect cannot smuggle in a blocked address.
    let url = await allowedUrl(source)
    if (!url) return null
    for (let hop = 0; ; hop++) {
      let response: Response
      try {
        response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      } catch {
        // An icon that cannot be fetched is a listing without an icon, not a broken settings page.
        return null
      }
      const location = response.headers.get('location')
      if (REDIRECTS.has(response.status) && location) {
        await response.body?.cancel()
        if (hop >= MAX_REDIRECTS) return null
        url = await allowedUrl(new URL(location, url).href)
        if (!url) return null
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        return null
      }
      const mimeType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (!ICON_TYPES.test(mimeType) || declared > MAX_ICON_BYTES) {
        await response.body?.cancel()
        return null
      }
      const body = Buffer.from(await response.arrayBuffer())
      if (!body.length || body.length > MAX_ICON_BYTES) return null
      return { body, mimeType }
    }
  }
  const store = async (source: string, icon: McpIcon): Promise<void> => {
    const file = cachePath(source)
    await mkdir(directory, { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, icon.body)
    await rename(temporary, file)
    await writeFile(`${file}.type`, icon.mimeType, 'utf8')
  }
  const loadFromDisk = async (source: string): Promise<McpIcon | null> => {
    const file = cachePath(source)
    try {
      const [body, mimeType] = await Promise.all([readFile(file), readFile(`${file}.type`, 'utf8')])
      if (!body.length || body.length > MAX_ICON_BYTES || !ICON_TYPES.test(mimeType.trim()))
        return null
      return { body, mimeType: mimeType.trim() }
    } catch (error) {
      // An absent or half-written entry is a miss; any other IO fault is a real failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  /** Bytes for one catalog source, or null when it is not a fetchable, public, image-typed URL. */
  const icon = (source: string): Promise<McpIcon | null> => {
    const hit = cached.get(source)
    if (hit && (!hit.expires || hit.expires > Date.now())) return Promise.resolve(hit.icon)
    let pending = inFlight.get(source)
    if (!pending) {
      pending = (async () => {
        const stored = await loadFromDisk(source)
        if (stored) return stored
        const fetched = await download(source)
        if (fetched) await store(source, fetched)
        return fetched
      })().finally(() => inFlight.delete(source))
      inFlight.set(source, pending)
    }
    return pending.then((result) => {
      cached.set(
        source,
        result ? { icon: result } : { icon: null, expires: Date.now() + negativeTtl }
      )
      return result
    })
  }
  return { icon }
}

const defaultCache = createMcpIconCache()

export function mcpIcon(source: string): Promise<McpIcon | null> {
  return defaultCache.icon(source)
}

export async function mcpIconResponse(requestUrl: string): Promise<Response> {
  const source = parseMcpIconUrl(requestUrl)
  if (!source) return new Response(null, { status: 404 })
  const icon = await mcpIcon(source)
  if (!icon) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(icon.body), {
    headers: { 'content-type': icon.mimeType, 'cache-control': 'private, max-age=86400' }
  })
}

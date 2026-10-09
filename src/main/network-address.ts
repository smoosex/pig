/** Shared connection-address policy for MCP and web access, including IPv4-mapped IPv6. */
import { readFileSync } from 'node:fs'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3]
] as const)
  blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
] as const)
  blocked.addSubnet(address, prefix, 'ipv6')

/**
 * The RFC 2544 benchmarking range, which Clash/Surge/Mihomo-style TUN proxies hand out as a fake IP
 * for every resolved hostname. A resolved answer in this range is proxy-owned space: the proxy maps
 * the connection back to the name it resolved. A literal address is never exempt, so naming the range
 * outright stays blocked instead of reaching whatever the user runs there.
 */
const proxyFakeIp = new BlockList()
proxyFakeIp.addSubnet('198.18.0.0', 15, 'ipv4')

export function isProxyFakeAddress(address: string): boolean {
  return isIP(address) === 4 && proxyFakeIp.check(address, 'ipv4')
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  return family === 0 || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function familyOf(address: string): 'ipv4' | 'ipv6' {
  const family = isIP(address)
  if (!family) throw new Error(`Not an IP address: ${address}`)
  return family === 4 ? 'ipv4' : 'ipv6'
}

/** Validate and normalize `ssrf.allowRanges` entries; a malformed range must not fail silently. */
export function parseAllowedRanges(values: unknown, source: string): string[] {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values))
    throw new Error(`ssrf.allowRanges in ${source} must be an array of CIDR strings`)
  return values.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim())
      throw new Error(`ssrf.allowRanges in ${source} entry ${index + 1} must be a CIDR string`)
    const range = entry.trim()
    const [address, prefix] = range.split('/')
    const family = familyOf(address)
    const bits = family === 'ipv4' ? 32 : 128
    if (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > bits))
      throw new Error(`ssrf.allowRanges in ${source} has an invalid range: ${range}`)
    const list = new BlockList()
    if (prefix === undefined) list.addAddress(address, family)
    else list.addSubnet(address, Number(prefix), family)
    return range
  })
}

/** Ranges the user declared as proxy fake-IP space; the same knob the bundled web-access plugin reads. */
export function loadAllowedRanges(path: string): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // A missing file simply means no exemption; unreadable or malformed JSON is the user's problem.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const ssrf = (raw as { ssrf?: unknown } | null)?.ssrf
  if (!ssrf || typeof ssrf !== 'object' || Array.isArray(ssrf)) return []
  return parseAllowedRanges((ssrf as { allowRanges?: unknown }).allowRanges, path)
}

const allowedLists = new Map<string, BlockList>()

/** True when the address falls inside a declared allow range, exempting it from the blocked policy. */
export function isAllowedAddress(address: string, ranges: string[]): boolean {
  if (!ranges.length || !isIP(address)) return false
  const key = ranges.join(',')
  let list = allowedLists.get(key)
  if (!list) {
    list = new BlockList()
    for (const range of ranges) {
      const [address, prefix] = range.split('/')
      const family = familyOf(address)
      if (prefix === undefined) list.addAddress(address, family)
      else list.addSubnet(address, Number(prefix), family)
    }
    allowedLists.set(key, list)
  }
  return list.check(address, familyOf(address))
}

/** Public-network-only favicon transport. DNS validation is the socket lookup, never a preflight. */
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { isBlockedAddress } from '../network-address'

const MAX_BYTES = 256 * 1024
const REDIRECTS = new Set([301, 302, 303, 307, 308])
type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>

function blocked(): Error {
  return Object.assign(new Error('Favicon destination is not a public address'), { code: 'ERR_FAVICON_ADDRESS' })
}

export function faviconLookup(resolve: Resolve = (host) => lookup(host, { all: true })): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
        callback(blocked(), '', 0)
        return
      }
      if (options.all) callback(null, addresses)
      else callback(null, addresses[0]!.address, addresses[0]!.family)
    }, (error: Error) => callback(error, '', 0))
  }
}

function validate(url: URL): void {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw blocked()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // IP literals bypass Node's lookup callback, so they must be checked here.
  if (isIP(host) && isBlockedAddress(host)) throw blocked()
}

interface IconResponse { body: Buffer | null; redirect?: string }
function requestIcon(url: URL, signal: AbortSignal, socketLookup: LookupFunction): Promise<IconResponse> {
  validate(url)
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: false, lookup: socketLookup, signal,
      headers: { Accept: 'image/png,image/jpeg,image/x-icon', 'Accept-Encoding': 'identity' }
    }, (response) => {
      const status = response.statusCode ?? 0
      if (REDIRECTS.has(status) && response.headers.location) {
        resolve({ body: null, redirect: response.headers.location })
        response.destroy()
        return
      }
      if (status < 200 || status >= 300 || Number(response.headers['content-length']) > MAX_BYTES) {
        resolve({ body: null })
        response.destroy()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES) {
          resolve({ body: null })
          response.destroy()
        } else chunks.push(chunk)
      })
      response.on('end', () => resolve({ body: Buffer.concat(chunks) }))
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('Favicon response aborted')))
    })
    request.on('error', reject)
    request.end()
  })
}

/** No cookies, ambient proxy, shared connection pool or certificate exceptions from browser pages. */
export async function fetchFaviconBytes(input: string, socketLookup = faviconLookup()): Promise<Buffer | null> {
  const signal = AbortSignal.timeout(10_000)
  let url = new URL(input)
  for (let redirects = 0; redirects <= 5; redirects++) {
    const result = await requestIcon(url, signal, socketLookup)
    if (!result.redirect) return result.body
    if (redirects === 5) throw new Error('Too many favicon redirects')
    url = new URL(result.redirect, url)
  }
  return null
}

/** Favicon transport validates the actual socket lookup and redirects; decoding rejects pixel bombs. */
import { expect, mock, test } from 'bun:test'
import { createServer } from 'node:http'
import type { LookupFunction } from 'node:net'
import { deflateSync } from 'node:zlib'
import { faviconLookup, fetchFaviconBytes } from '../src/main/browser/favicon-network'
import { isBoundedFavicon } from '../src/main/browser/favicon-image'

let decoded = 0
mock.module('electron', () => ({ nativeImage: {
  createFromBuffer: () => { decoded++; throw new Error('Unexpected native decode') },
  createFromBitmap: () => { decoded++; throw new Error('Unexpected native decode') }
} }))
const { decodeFavicon } = await import('../src/main/browser/favicon')

function resolveUsing(lookup: LookupFunction): Promise<unknown> {
  return new Promise((resolve, reject) => lookup('public.test', { all: true }, (error, address) => error ? reject(error) : resolve(address)))
}

test('IP literals and actual DNS answers reject local, private and mapped addresses', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
    await expect(resolveUsing(faviconLookup(async () => [{ address, family: address.includes(':') ? 6 : 4 }]))).rejects.toMatchObject({ code: 'ERR_FAVICON_ADDRESS' })
  }
  await expect(fetchFaviconBytes('http://127.0.0.1/favicon.ico')).rejects.toMatchObject({ code: 'ERR_FAVICON_ADDRESS' })
  await expect(fetchFaviconBytes('http://[::1]/favicon.ico')).rejects.toMatchObject({ code: 'ERR_FAVICON_ADDRESS' })
  await expect(fetchFaviconBytes('file:///tmp/icon')).rejects.toMatchObject({ code: 'ERR_FAVICON_ADDRESS' })
})

test('connection lookup rechecks DNS on every call instead of trusting a prior public result', async () => {
  let calls = 0
  const lookup = faviconLookup(async () => [{ address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }])
  expect(await resolveUsing(lookup)).toEqual([{ address: '93.184.216.34', family: 4 }])
  await expect(resolveUsing(lookup)).rejects.toMatchObject({ code: 'ERR_FAVICON_ADDRESS' })
})

test('redirects cannot target loopback or a hostname newly resolving to private space', async () => {
  const server = createServer((request, response) => {
    response.writeHead(302, { Location: request.url === '/literal' ? 'http://127.0.0.1/private' : 'http://rebound.test/private' })
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  // Only the test server is routed to loopback; the redirect uses the real validating lookup.
  const checked = faviconLookup(async () => [{ address: '127.0.0.1', family: 4 }])
  const lookup: LookupFunction = (host, options, callback) => {
    if (host !== 'initial.test') return checked(host, options, callback)
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
    else callback(null, '127.0.0.1', 4)
  }
  try {
    for (const path of ['literal', 'rebound']) {
      await expect(fetchFaviconBytes(`http://initial.test:${address.port}/${path}`, lookup)).rejects.toMatchObject({ code: 'ERR_FAVICON_ADDRESS' })
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

function png(width: number, height: number): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(kind, 4)
    data.copy(result, 8)
    return result // CRC isn't inspected by the size gate; nativeImage still validates the image.
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(100_000))), chunk('IEND', Buffer.alloc(0))])
}

test('oversized compressed PNG and an ICO with a lying 32px directory never reach nativeImage', () => {
  const bomb = png(16384, 16384)
  expect(bomb.length).toBeLessThan(256 * 1024)
  expect(isBoundedFavicon(bomb)).toBe(false)
  expect(decodeFavicon(bomb)).toBeNull()
  const ico = Buffer.alloc(22)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(1, 4)
  ico[6] = ico[7] = 32
  ico.writeUInt32LE(bomb.length, 14)
  ico.writeUInt32LE(22, 18)
  expect(decodeFavicon(Buffer.concat([ico, bomb]))).toBeNull()
  expect(decoded).toBe(0)
  expect(isBoundedFavicon(png(32, 32))).toBe(true)
  expect(isBoundedFavicon(Buffer.from('not an image'))).toBe(false)
})

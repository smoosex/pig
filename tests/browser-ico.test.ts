import { expect, test } from 'bun:test'
import { decodeIco } from '../src/main/browser/ico'

function icon(bits: 24 | 32, alpha: number) {
  const stride = 4
  const dib = Buffer.alloc(40 + stride + 4)
  dib.writeUInt32LE(40, 0)
  dib.writeInt32LE(1, 4)
  dib.writeInt32LE(2, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(bits, 14)
  dib.set([10, 20, 30, alpha], 40)
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = 1
  header[7] = 1
  header.writeUInt32LE(dib.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, dib])
}

test('ICO DIB converts to a native BGRA bitmap and preserves alpha', () => {
  expect(decodeIco(icon(32, 128))).toEqual({ rgba: Buffer.from([10, 20, 30, 128]), width: 1, height: 1 })
  const masked = icon(32, 0)
  masked[66] = 128
  expect(decodeIco(masked)).toEqual({ rgba: Buffer.from([10, 20, 30, 0]), width: 1, height: 1 })
  expect(decodeIco(icon(24, 0))).toEqual({ rgba: Buffer.from([10, 20, 30, 255]), width: 1, height: 1 })
})

test('malformed or unsupported frames cannot escape their bounds', () => {
  expect(decodeIco(Buffer.alloc(0))).toBeNull()
  const truncated = icon(32, 255).subarray(0, 30)
  expect(decodeIco(truncated)).toBeNull()
  const compressed = icon(32, 255)
  compressed.writeUInt32LE(3, 38)
  expect(decodeIco(compressed)).toBeNull()
  const wrongSize = icon(32, 255)
  wrongSize.writeInt32LE(256, 26)
  expect(decodeIco(wrongSize)).toBeNull()
})

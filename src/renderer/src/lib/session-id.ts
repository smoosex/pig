const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Time-ordered UUIDv7, minted before main answers. A project home needs a session identity on its
 * first keystroke, so the id cannot wait for the create round trip.
 */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const timestamp = Date.now()
  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(timestamp / 2 ** (8 * (5 - index))) & 0xff
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f)
  bytes[8] = 0x80 | (bytes[8] & 0x3f)
  const value = hex(bytes)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

/** Inspect raster dimensions before nativeImage allocates pixels. Only bounded PNG/JPEG are accepted. */
const MAX_SIDE = 512
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function bounded(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE
}

export function isBoundedFavicon(body: Buffer): boolean {
  if (body.subarray(0, 8).equals(PNG)) {
    if (body.length < 33 || body.readUInt32BE(8) !== 13 || body.toString('ascii', 12, 16) !== 'IHDR' ||
      !bounded(body.readUInt32BE(16), body.readUInt32BE(20))) return false
    // Do not hand animated PNGs or extra image headers to the native decoder.
    let at = 8
    while (at + 12 <= body.length) {
      const size = body.readUInt32BE(at)
      if (size > body.length - at - 12) return false
      const type = body.toString('ascii', at + 4, at + 8)
      if (type === 'acTL' || (type === 'IHDR' && at !== 8)) return false
      at += size + 12
      if (type === 'IEND') return at === body.length
    }
    return false
  }
  if (body.length < 4 || body.readUInt16BE(0) !== 0xffd8) return false
  let at = 2
  let sawDimensions = false
  while (at + 4 <= body.length) {
    if (body[at++] !== 0xff) return false
    while (body[at] === 0xff) at++
    const marker = body[at++]
    if (marker === 0xda) return sawDimensions // Pixel data follows the start-of-scan header.
    if (at + 2 > body.length) return false
    const size = body.readUInt16BE(at)
    if (size < 2 || size > body.length - at) return false
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (size < 8 || !bounded(body.readUInt16BE(at + 5), body.readUInt16BE(at + 3))) return false
      sawDimensions = true
    } else if (marker !== undefined && marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return false
    }
    at += size
  }
  return false
}

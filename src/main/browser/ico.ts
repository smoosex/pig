/** Bounded ICO frame extraction. PNG frames pass to Chromium; uncompressed 24/32-bit DIBs become nativeImage's BGRA bitmap. */
export type IconFrame = { png: Buffer } | { rgba: Buffer; width: number; height: number }
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function decodeIco(body: Buffer): IconFrame | null {
  if (body.length < 6 || body.readUInt16LE(0) !== 0 || body.readUInt16LE(2) !== 1) return null
  const count = body.readUInt16LE(4)
  if (!count || count > 256 || body.length < 6 + count * 16) return null
  const frames: { offset: number; size: number; width: number; height: number }[] = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const size = body.readUInt32LE(at + 8)
    const offset = body.readUInt32LE(at + 12)
    if (offset < 6 + count * 16 || size > body.length - offset) continue
    frames.push({ offset, size, width: body[at]! || 256, height: body[at + 1]! || 256 })
  }
  // Prefer a 32px or larger frame, keeping decode bounded by ICO's 256px dimensions.
  frames.sort((a, b) => (a.width < 32 ? 1000 - a.width : a.width) - (b.width < 32 ? 1000 - b.width : b.width))
  for (const frame of frames) {
    const data = body.subarray(frame.offset, frame.offset + frame.size)
    if (data.subarray(0, 8).equals(PNG)) return { png: data }
    if (data.length < 40 || data.readUInt32LE(0) !== 40 || data.readUInt32LE(16) !== 0 || data.readUInt16LE(12) !== 1) continue
    const { width, height } = frame
    const bits = data.readUInt16LE(14)
    if ((bits !== 24 && bits !== 32) || data.readInt32LE(4) !== width || data.readInt32LE(8) !== height * 2) continue
    const stride = Math.ceil(width * bits / 32) * 4
    const maskStride = Math.ceil(width / 32) * 4
    const maskAt = 40 + stride * height
    if (data.length < maskAt) continue
    const hasMask = data.length >= maskAt + maskStride * height
    const rgba = Buffer.alloc(width * height * 4)
    let hasAlpha = false
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const src = 40 + (height - 1 - y) * stride + x * (bits / 8)
        const dst = (y * width + x) * 4
        rgba[dst] = data[src]!
        rgba[dst + 1] = data[src + 1]!
        rgba[dst + 2] = data[src + 2]!
        const alpha = bits === 32 ? data[src + 3]! : 255
        rgba[dst + 3] = alpha
        if (bits === 32 && alpha !== 0) hasAlpha = true
      }
    }
    // Older 32-bit icons leave all alpha bytes zero and use the one-bit AND mask instead.
    if (bits === 24 || !hasAlpha) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const transparent = hasMask && (data[maskAt + (height - 1 - y) * maskStride + (x >> 3)]! & (128 >> (x & 7))) !== 0
          rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255
        }
      }
    }
    return { rgba, width, height }
  }
  return null
}

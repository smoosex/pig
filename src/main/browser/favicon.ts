/** Public-only downloads and dimension checks precede every native bitmap decode on the main process. */
import { nativeImage } from 'electron'
import { decodeIco } from './ico'
import { fetchFaviconBytes } from './favicon-network'
import { isBoundedFavicon } from './favicon-image'

const SIZE = 32

export function decodeFavicon(body: Buffer): string | null {
  // Never ask nativeImage to parse the ICO container: its PNG frames can claim dimensions unrelated
  // to the ICO directory. DIB extraction is independently bounded to ICO's 256px dimensions.
  const frame = body.length >= 4 && body.readUInt32LE(0) === 0x00010000 ? decodeIco(body) : null
  const raster = frame && 'png' in frame ? frame.png : body
  let image: Electron.NativeImage
  if (frame && 'rgba' in frame) {
    image = nativeImage.createFromBitmap(frame.rgba, { width: frame.width, height: frame.height, scaleFactor: 1 })
  } else {
    if (!isBoundedFavicon(raster)) return null
    image = nativeImage.createFromBuffer(raster)
  }
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  return (width > SIZE || height > SIZE ? image.resize({ width: SIZE, height: SIZE, quality: 'best' }) : image).toDataURL()
}

export async function fetchFavicon(url: string): Promise<string | null> {
  const body = await fetchFaviconBytes(url)
  return body ? decodeFavicon(body) : null
}

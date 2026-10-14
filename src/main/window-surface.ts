/** The last applied surface also seeds reopened windows; changing material never replaces a window. */
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { SurfaceStyle } from '../shared/api'
import { parseSurfaceStyle } from '../shared/surface-style'
import { supportsGlass } from './surface-support'

let surfaceStyle = parseSurfaceStyle(undefined, supportsGlass)

export function windowSurfaceOptions(): Pick<BrowserWindowConstructorOptions, 'backgroundColor' | 'vibrancy' | 'backgroundMaterial'> {
  const glass = supportsGlass && surfaceStyle === 'glass'
  return {
    // Solid is painted by the document; changing this native backing can expose a black frame.
    backgroundColor: supportsGlass ? '#00000000' : '#1a1a1a',
    vibrancy: glass && process.platform === 'darwin' ? 'under-window' : undefined,
    backgroundMaterial: supportsGlass && process.platform === 'win32' ? glass ? 'acrylic' : 'none' : undefined
  }
}

export function applyWindowSurfaceStyle(next: SurfaceStyle): void {
  next = parseSurfaceStyle(next, supportsGlass)
  if (surfaceStyle === next) return
  surfaceStyle = next
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    // Native fade-out removes its view asynchronously and can race a rapid re-enable; CSS owns the fade.
    if (process.platform === 'darwin') window.setVibrancy(next === 'glass' ? 'under-window' : null)
    else if (process.platform === 'win32') window.setBackgroundMaterial(next === 'glass' ? 'acrylic' : 'none')
  }
}

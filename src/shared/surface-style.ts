/** Unsupported platforms stay opaque, including when preferences were copied from another platform. */
import type { SurfaceStyle } from './api'

export const GLASS_SURFACE_ARGUMENT = '--pig-glass-surface'

export function parseSurfaceStyle(value: unknown, supportsGlass: boolean): SurfaceStyle {
  return supportsGlass && value !== 'solid' ? 'glass' : 'solid'
}

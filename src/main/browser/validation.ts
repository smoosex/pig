/** Validate untrusted renderer/guest inputs before touching native views. */
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { BrowserBounds, BrowserElement, BrowserPickerOptions } from '../../shared/browser'

export function assertBrowserSender(event: IpcMainInvokeEvent, win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error('Browser controls require the owning UI main frame')
  }
}

export function normalizeBrowserUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Browser URL is required')
  let value = input.trim()
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)
  if (local) value = `http://${value}`
  else if (!/^[a-z][a-z\d+.-]*:/i.test(value) || /^[^/?#:@]+:\d+(?:[/?#]|$)/.test(value)) value = `https://${value}`
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without credentials are allowed')
  }
  return url.href
}

export function isBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

export function validateBounds(value: unknown): asserts value is BrowserBounds {
  if (!value || typeof value !== 'object') throw new Error('Invalid browser bounds')
  const b = value as BrowserBounds
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 0 || b.height < 0) {
    throw new Error('Invalid browser bounds')
  }
  for (const radius of [b.bottomLeftRadius, b.bottomRightRadius]) {
    if (radius !== undefined && (!Number.isFinite(radius) || radius < 0)) throw new Error('Invalid browser corner radius')
  }
  if (b.devtools !== undefined) {
    const height = b.devtools?.height
    if (height === undefined || !Number.isFinite(height) || height < 0 || height > b.height + 1) {
      throw new Error('Invalid browser DevTools bounds')
    }
  }
}

export function browserDipBounds(bounds: BrowserBounds, zoom: number, width: number, height: number): BrowserBounds {
  validateBounds(bounds)
  const x = Math.min(width, Math.max(0, Math.round(bounds.x * zoom)))
  const y = Math.min(height, Math.max(0, Math.round(bounds.y * zoom)))
  const right = Math.min(width, Math.max(x, Math.round((bounds.x + bounds.width) * zoom)))
  const bottom = Math.min(height, Math.max(y, Math.round((bounds.y + bounds.height) * zoom)))
  return { x, y, width: right - x, height: bottom - y }
}

export function validatePickerOptions(value: unknown): asserts value is BrowserPickerOptions {
  if (!value || typeof value !== 'object') throw new Error('Invalid picker options')
  const options = value as BrowserPickerOptions
  if (!options.labels || !options.theme) throw new Error('Invalid picker options')
  for (const key of ['comment', 'add', 'cancel', 'remove', 'update'] as const) {
    if (typeof options.labels[key] !== 'string' || options.labels[key].length > 256) throw new Error('Invalid picker label')
  }
  for (const key of ['background', 'foreground', 'border', 'muted', 'primary', 'primaryForeground', 'input', 'ring', 'shadow', 'destructive'] as const) {
    if (typeof options.theme[key] !== 'string' || options.theme[key].length > 2048) throw new Error('Invalid picker theme')
  }
}

export function isBrowserElement(value: unknown): value is BrowserElement {
  if (!value || typeof value !== 'object') return false
  const e = value as BrowserElement
  if (![e.selector, e.tagName, e.role, e.name, e.text].every(v => typeof v === 'string' && v.length <= 100_000)) return false
  try { validateBounds(e.bounds) } catch { return false }
  return !!e.styles && typeof e.styles === 'object' && !Array.isArray(e.styles) &&
    Object.entries(e.styles).length <= 200 && Object.entries(e.styles).every(([key, v]) => key.length <= 200 && typeof v === 'string' && v.length <= 10_000)
}

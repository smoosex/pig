/**
 * Main's copy of the shortcut bindings, for browser guests: their key events never reach the
 * renderer. Startup and every save replace it; until startup has read settings it holds the defaults.
 */
import { resolveShortcuts, type ShortcutBindings, type ShortcutOverrides } from '../shared/shortcuts'

const mac = process.platform === 'darwin'
let bindings = resolveShortcuts({}, mac)

export function hostShortcutBindings(): ShortcutBindings {
  return bindings
}

export function applyShortcutOverrides(overrides: ShortcutOverrides): void {
  bindings = resolveShortcuts(overrides, mac)
}

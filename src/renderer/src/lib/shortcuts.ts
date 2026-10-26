/** Renderer side of the shortcut table: the resolved bindings, event matching and display. */
import { useMemo } from 'react'
import {
  formatAccelerator,
  resolveShortcuts,
  strokeToAccelerator,
  type ShortcutActionId,
  type ShortcutBindings,
  type ShortcutOverrides
} from '../../../shared/shortcuts'
import { useSettingsStore } from '../stores/settings'
import { IS_MAC } from './platform'

export { IS_MAC }

let cached: { overrides: ShortcutOverrides; bindings: ShortcutBindings } | null = null

function resolved(overrides: ShortcutOverrides): ShortcutBindings {
  if (cached?.overrides !== overrides) cached = { overrides, bindings: resolveShortcuts(overrides, IS_MAC) }
  return cached.bindings
}

/** For listeners that live outside React and must see the latest bindings. */
export function shortcutBindings(): ShortcutBindings {
  return resolved(useSettingsStore.getState().shortcuts)
}

export function useShortcutBindings(): ShortcutBindings {
  const overrides = useSettingsStore((s) => s.shortcuts)
  return useMemo(() => resolved(overrides), [overrides])
}

export function useShortcut(id: ShortcutActionId): string | null {
  return useShortcutBindings()[id]
}

export function eventAccelerator(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  return strokeToAccelerator({ code: event.code, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }, IS_MAC)
}

/**
 * Control alone (no Command, Shift or Alt) is shell input in a terminal on every platform: Control+W,
 * Control+E and friends are readline commands, so window shortcuts never take them from the shell.
 */
export function isShellChord(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}

export function isTerminalShellChord(event: KeyboardEvent): boolean {
  return isShellChord(event) && event.target instanceof Element && event.target.closest('.xterm') !== null
}

/** IME composition reports keys that are not the user's shortcut. */
export function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

export function matchesShortcut(event: KeyboardEvent, id: ShortcutActionId): boolean {
  const accelerator = eventAccelerator(event)
  return accelerator !== null && shortcutBindings()[id] === accelerator
}

export function shortcutLabel(accelerator: string): string[] {
  return formatAccelerator(accelerator, IS_MAC)
}

/** Text form for placeholders and hints: `⌘L` on macOS, `Ctrl+L` elsewhere. */
export function shortcutText(accelerator: string): string {
  return shortcutLabel(accelerator).join(IS_MAC ? '' : '+')
}

/**
 * While the settings page records a key, every other listener stands down, including the ones that
 * run before it in the capture phase.
 */
let recording = false

export function setShortcutRecording(value: boolean): void {
  recording = value
}

export function isShortcutRecording(): boolean {
  return recording
}

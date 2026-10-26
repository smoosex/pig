/**
 * The single table of Pig's configurable shortcuts, shared by main (browser guests, which never reach
 * the renderer's listeners) and the renderer.
 *
 * An accelerator is a canonical string such as `Mod+Shift+KeyE`: modifiers in a fixed order, then a
 * `KeyboardEvent.code`. Matching uses the physical key, not `key`: Shift turns `,` into `<`, and
 * non-Latin layouts and IME composition change `key` while `code` stays put. `Mod` is Command on
 * macOS and Control elsewhere; `Ctrl` (macOS) and `Meta` (elsewhere) name the other key.
 *
 * settings.json stores only overrides; a missing entry follows the default, `null` disables it.
 */

export type ShortcutGroup = 'global' | 'tabs' | 'composer' | 'file' | 'terminal' | 'projectPicker'

export const TAB_SELECT_ACTIONS = [
  'tab.select1', 'tab.select2', 'tab.select3', 'tab.select4',
  'tab.select5', 'tab.select6', 'tab.select7', 'tab.select8', 'tab.selectLast'
] as const

export const SHORTCUT_ACTIONS = [
  'sidebar.toggleLeft', 'sidebar.toggleRight', 'settings.toggle', 'project.add',
  'tab.new', 'tab.close', ...TAB_SELECT_ACTIONS,
  'composer.focus',
  'file.save',
  'terminal.clear', 'terminal.selectAll',
  'projectPicker.addCurrent'
] as const

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]
export type ShortcutOverrides = Partial<Record<ShortcutActionId, string | null>>
export type ShortcutBindings = Record<ShortcutActionId, string | null>

interface ShortcutDefinition {
  group: ShortcutGroup
  /** Platform-specific when the macOS default would take a key the shell needs elsewhere. */
  default: string | null | { mac: string | null; other: string | null }
}

export const SHORTCUT_DEFINITIONS: Record<ShortcutActionId, ShortcutDefinition> = {
  'sidebar.toggleLeft': { group: 'global', default: 'Mod+KeyE' },
  'sidebar.toggleRight': { group: 'global', default: 'Mod+Shift+KeyE' },
  'settings.toggle': { group: 'global', default: 'Mod+Comma' },
  'project.add': { group: 'global', default: 'Mod+Shift+KeyA' },
  'tab.new': { group: 'tabs', default: 'Mod+KeyT' },
  'tab.close': { group: 'tabs', default: 'Mod+KeyW' },
  'tab.select1': { group: 'tabs', default: 'Mod+Digit1' },
  'tab.select2': { group: 'tabs', default: 'Mod+Digit2' },
  'tab.select3': { group: 'tabs', default: 'Mod+Digit3' },
  'tab.select4': { group: 'tabs', default: 'Mod+Digit4' },
  'tab.select5': { group: 'tabs', default: 'Mod+Digit5' },
  'tab.select6': { group: 'tabs', default: 'Mod+Digit6' },
  'tab.select7': { group: 'tabs', default: 'Mod+Digit7' },
  'tab.select8': { group: 'tabs', default: 'Mod+Digit8' },
  'tab.selectLast': { group: 'tabs', default: 'Mod+Digit9' },
  'composer.focus': { group: 'composer', default: 'Mod+KeyL' },
  'file.save': { group: 'file', default: 'Mod+KeyS' },
  // Control+K and Control+A are readline commands outside macOS.
  'terminal.clear': { group: 'terminal', default: { mac: 'Mod+KeyK', other: 'Mod+Shift+KeyK' } },
  'terminal.selectAll': { group: 'terminal', default: { mac: 'Mod+KeyA', other: null } },
  'projectPicker.addCurrent': { group: 'projectPicker', default: 'Mod+Enter' }
}

/**
 * Handled by the window wherever focus is, including browser guests (forwarded by main) and terminals.
 * `composer.focus` is window-wide too, but stays with the renderer: it was never taken from pages.
 */
export const HOST_SHORTCUT_ACTIONS = SHORTCUT_ACTIONS.filter((id) => {
  const group = SHORTCUT_DEFINITIONS[id].group
  return group === 'global' || group === 'tabs'
}) as HostShortcutAction[]
export type HostShortcutAction = Exclude<ShortcutActionId,
  'composer.focus' | 'file.save' | 'terminal.clear' | 'terminal.selectAll' | 'projectPicker.addCurrent'>

/** Window-wide actions: they take their key from every other context, so they conflict with all of them. */
export function isWindowShortcut(id: ShortcutActionId): boolean {
  return id === 'composer.focus' || (HOST_SHORTCUT_ACTIONS as readonly string[]).includes(id)
}

export const WINDOW_SHORTCUT_ACTIONS = SHORTCUT_ACTIONS.filter(isWindowShortcut)

export interface KeyStroke {
  code: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

const KEY_CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Backquote|Minus|Equal|Enter|Tab|Space|Backspace|Delete|Escape|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert)$/
const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

/** The canonical accelerator for a key press, or null for a bare modifier or an unsupported key. */
export function strokeToAccelerator(stroke: KeyStroke, mac: boolean): string | null {
  if (!KEY_CODE.test(stroke.code)) return null
  const modifiers: Modifier[] = []
  if (mac ? stroke.meta : stroke.ctrl) modifiers.push('Mod')
  if (mac && stroke.ctrl) modifiers.push('Ctrl')
  if (!mac && stroke.meta) modifiers.push('Meta')
  if (stroke.alt) modifiers.push('Alt')
  if (stroke.shift) modifiers.push('Shift')
  return [...modifiers, stroke.code].join('+')
}

interface ParsedAccelerator {
  modifiers: Set<Modifier>
  code: string
}

function parse(value: string): ParsedAccelerator | null {
  const parts = value.split('+')
  const code = parts.pop()!
  if (!KEY_CODE.test(code)) return null
  const modifiers = new Set<Modifier>()
  let last = -1
  for (const part of parts) {
    const index = MODIFIER_ORDER.indexOf(part as Modifier)
    // Canonical order only, so equal shortcuts are equal strings.
    if (index <= last) return null
    last = index
    modifiers.add(part as Modifier)
  }
  return { modifiers, code }
}

export function isAccelerator(value: unknown): value is string {
  return typeof value === 'string' && parse(value) !== null
}

/** Command is always `Mod` on macOS and Control is always `Mod` elsewhere, so the other spelling never fires. */
function isPlatformAccelerator(value: unknown, mac: boolean): value is string {
  const parsed = typeof value === 'string' ? parse(value) : null
  return parsed !== null && !parsed.modifiers.has(mac ? 'Meta' : 'Ctrl')
}

export function defaultShortcut(id: ShortcutActionId, mac: boolean): string | null {
  const value = SHORTCUT_DEFINITIONS[id].default
  return value === null || typeof value === 'string' ? value : mac ? value.mac : value.other
}

export function resolveShortcuts(overrides: ShortcutOverrides, mac: boolean): ShortcutBindings {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((id) => [
    id,
    overrides[id] === undefined ? defaultShortcut(id, mac) : overrides[id]
  ])) as ShortcutBindings
}

/** Drops unknown actions and malformed values; a hand-edited file degrades per entry, not as a whole. */
export function parseShortcutOverrides(value: unknown, mac: boolean): ShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: ShortcutOverrides = {}
  for (const [id, binding] of Object.entries(value)) {
    if (!(SHORTCUT_ACTIONS as readonly string[]).includes(id)) continue
    if (binding === null || isPlatformAccelerator(binding, mac)) result[id as ShortcutActionId] = binding
  }
  return result
}

/** The first action in `candidates` bound to `accelerator`; table order settles hand-edited conflicts. */
export function findShortcut<T extends ShortcutActionId>(
  bindings: ShortcutBindings,
  accelerator: string | null,
  candidates: readonly T[]
): T | null {
  if (!accelerator) return null
  return candidates.find((id) => bindings[id] === accelerator) ?? null
}

export type ShortcutProblem =
  | { kind: 'needsModifier' }
  | { kind: 'reserved' }
  | { kind: 'conflict'; with: ShortcutActionId }

// Editing, quitting, hiding and minimizing belong to the system and to every text field.
const RESERVED = new Set(['Mod+KeyC', 'Mod+KeyV', 'Mod+KeyX', 'Mod+KeyZ', 'Mod+Shift+KeyZ', 'Mod+KeyQ', 'Mod+KeyH', 'Mod+KeyM'])

/** Why `accelerator` cannot be given to `id`, checked against the other current bindings. */
export function shortcutProblem(
  id: ShortcutActionId,
  accelerator: string,
  bindings: ShortcutBindings
): ShortcutProblem | null {
  const parsed = parse(accelerator)
  if (!parsed) return { kind: 'needsModifier' }
  const { modifiers, code } = parsed
  const command = modifiers.has('Mod') || modifiers.has('Ctrl') || modifiers.has('Meta')
  // A window-wide key without Command/Control would be stolen from every text field and the shell.
  if (isWindowShortcut(id) && !command) return { kind: 'needsModifier' }
  // Without a command modifier only keys that type nothing are usable.
  if (!command && !modifiers.has('Alt') && !/^(Tab|F\d+)$/.test(code)) return { kind: 'needsModifier' }
  // Tab completes and Alt edits in the shell.
  if (!command && SHORTCUT_DEFINITIONS[id].group === 'terminal') return { kind: 'needsModifier' }
  if (RESERVED.has(accelerator)) return { kind: 'reserved' }
  if (accelerator === 'Mod+KeyA' && SHORTCUT_DEFINITIONS[id].group !== 'terminal') return { kind: 'reserved' }
  const group = SHORTCUT_DEFINITIONS[id].group
  for (const other of SHORTCUT_ACTIONS) {
    if (other === id || bindings[other] !== accelerator) continue
    if (isWindowShortcut(id) || isWindowShortcut(other) || SHORTCUT_DEFINITIONS[other].group === group) {
      return { kind: 'conflict', with: other }
    }
  }
  return null
}

/** `'default'` drops the override; it can never be an accelerator, which always ends in a key code. */
export type ShortcutPatch = { [K in ShortcutActionId]?: string | null | 'default' }

/**
 * Applies a patch, rejecting malformed input and any changed binding with a problem against the
 * result. Several entries change together, so taking over a key and unbinding its old owner is one save.
 */
export function applyShortcutPatch(overrides: ShortcutOverrides, patch: unknown, mac: boolean): ShortcutOverrides {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected a shortcut patch')
  const next: ShortcutOverrides = { ...overrides }
  const changed: [ShortcutActionId, string][] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!(SHORTCUT_ACTIONS as readonly string[]).includes(key)) throw new Error(`Unknown shortcut action: ${key}`)
    const id = key as ShortcutActionId
    if (value === 'default' || value === defaultShortcut(id, mac)) {
      delete next[id]
      // A restored default may have been handed to another action meanwhile.
      const restored = defaultShortcut(id, mac)
      if (restored !== null) changed.push([id, restored])
    } else if (value === null || isPlatformAccelerator(value, mac)) {
      next[id] = value
      if (value !== null) changed.push([id, value])
    } else {
      throw new Error(`Invalid shortcut for ${id}`)
    }
  }
  const bindings = resolveShortcuts(next, mac)
  for (const [id, accelerator] of changed) {
    const problem = shortcutProblem(id, accelerator, bindings)
    if (problem) throw new Error(`Shortcut ${accelerator} cannot be used for ${id}: ${problem.kind}`)
  }
  return next
}

const MAC_MODIFIER: Record<Modifier, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘', Meta: '⌘' }
const OTHER_MODIFIER: Record<Modifier, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Meta: 'Win', Alt: 'Alt', Shift: 'Shift' }
const KEY_LABEL: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Backquote: '`', Minus: '-', Equal: '=', Space: 'Space', Escape: 'Esc',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn'
}
const MAC_KEY_LABEL: Record<string, string> = { Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥' }

/** Display parts in the platform's order: ⌃⌥⇧⌘ on macOS, Ctrl+Alt+Shift elsewhere. */
export function formatAccelerator(accelerator: string, mac: boolean): string[] {
  const parsed = parse(accelerator)
  if (!parsed) return [accelerator]
  const order: Modifier[] = mac ? ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta'] : ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']
  const labels = mac ? MAC_MODIFIER : OTHER_MODIFIER
  const key = (mac ? MAC_KEY_LABEL[parsed.code] : undefined) ??
    KEY_LABEL[parsed.code] ?? parsed.code.replace(/^(Key|Digit)/, '')
  return [...order.filter((modifier) => parsed.modifiers.has(modifier)).map((modifier) => labels[modifier]), key]
}

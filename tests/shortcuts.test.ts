import { describe, expect, test } from 'bun:test'
import {
  applyShortcutPatch,
  formatAccelerator,
  parseShortcutOverrides,
  resolveShortcuts,
  shortcutProblem,
  strokeToAccelerator
} from '../src/shared/shortcuts'

const stroke = (code: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) =>
  ({ code, meta: false, ctrl: false, alt: false, shift: false, ...mods })

describe('accelerators', () => {
  test('Mod is Command on macOS and Control elsewhere; the other key keeps its own name', () => {
    expect(strokeToAccelerator(stroke('KeyE', { meta: true, shift: true }), true)).toBe('Mod+Shift+KeyE')
    expect(strokeToAccelerator(stroke('KeyE', { ctrl: true, shift: true }), false)).toBe('Mod+Shift+KeyE')
    expect(strokeToAccelerator(stroke('KeyE', { ctrl: true }), true)).toBe('Ctrl+KeyE')
    expect(strokeToAccelerator(stroke('KeyE', { meta: true }), false)).toBe('Meta+KeyE')
    expect(strokeToAccelerator(stroke('MetaLeft', { meta: true }), true)).toBeNull()
    expect(strokeToAccelerator(stroke('Numpad1', { meta: true }), true)).toBeNull()
  })

  test('stored overrides keep valid entries and drop the rest one by one', () => {
    expect(parseShortcutOverrides({
      'tab.new': 'Mod+KeyN', 'tab.close': null, 'nope': 'Mod+KeyX', 'file.save': 'Shift+Mod+KeyS', 'composer.focus': 3
    }, true)).toEqual({ 'tab.new': 'Mod+KeyN', 'tab.close': null })
    expect(parseShortcutOverrides(['Mod+KeyN'], true)).toEqual({})
  })

  test('the spelling a platform never produces is dropped or refused, since it could never fire', () => {
    expect(parseShortcutOverrides({ 'tab.new': 'Meta+KeyN', 'file.save': 'Ctrl+KeyS' }, true)).toEqual({ 'file.save': 'Ctrl+KeyS' })
    expect(parseShortcutOverrides({ 'tab.new': 'Meta+KeyN', 'file.save': 'Ctrl+KeyS' }, false)).toEqual({ 'tab.new': 'Meta+KeyN' })
    expect(() => applyShortcutPatch({}, { 'tab.new': 'Meta+KeyN' }, true)).toThrow('Invalid')
    expect(() => applyShortcutPatch({}, { 'tab.new': 'Ctrl+KeyN' }, false)).toThrow('Invalid')
  })

  test('defaults follow the platform where the shell needs the macOS key', () => {
    expect(resolveShortcuts({}, true)['terminal.clear']).toBe('Mod+KeyK')
    expect(resolveShortcuts({}, false)['terminal.clear']).toBe('Mod+Shift+KeyK')
    expect(resolveShortcuts({}, false)['terminal.selectAll']).toBeNull()
    expect(resolveShortcuts({ 'tab.close': null }, true)['tab.close']).toBeNull()
  })

  test('display follows platform conventions', () => {
    expect(formatAccelerator('Mod+Shift+KeyE', true)).toEqual(['⇧', '⌘', 'E'])
    expect(formatAccelerator('Mod+Shift+KeyE', false)).toEqual(['Ctrl', 'Shift', 'E'])
    expect(formatAccelerator('Mod+Comma', true)).toEqual(['⌘', ','])
  })
})

describe('binding rules', () => {
  const defaults = resolveShortcuts({}, true)

  test('window-wide actions need Command or Control; others may use keys that type nothing', () => {
    expect(shortcutProblem('tab.new', 'Alt+KeyN', defaults)).toEqual({ kind: 'needsModifier' })
    expect(shortcutProblem('file.save', 'KeyN', defaults)).toEqual({ kind: 'needsModifier' })
    expect(shortcutProblem('file.save', 'Shift+Tab', defaults)).toBeNull()
    expect(shortcutProblem('file.save', 'F5', defaults)).toBeNull()
    expect(shortcutProblem('terminal.clear', 'Tab', defaults)).toEqual({ kind: 'needsModifier' })
    expect(shortcutProblem('terminal.clear', 'Alt+KeyK', defaults)).toEqual({ kind: 'needsModifier' })
  })

  test('editing keys are reserved, select-all only outside the terminal', () => {
    expect(shortcutProblem('tab.new', 'Mod+KeyC', defaults)).toEqual({ kind: 'reserved' })
    expect(shortcutProblem('file.save', 'Mod+KeyA', defaults)).toEqual({ kind: 'reserved' })
    expect(shortcutProblem('terminal.clear', 'Mod+KeyA', defaults)).toEqual({ kind: 'conflict', with: 'terminal.selectAll' })
  })

  test('window-wide keys conflict everywhere; scoped keys only within their own context', () => {
    expect(shortcutProblem('file.save', 'Mod+KeyE', defaults)).toEqual({ kind: 'conflict', with: 'sidebar.toggleLeft' })
    expect(shortcutProblem('tab.new', 'Mod+KeyS', defaults)).toEqual({ kind: 'conflict', with: 'file.save' })
    expect(shortcutProblem('terminal.clear', 'Mod+KeyS', defaults)).toBeNull()
  })

  test('a patch is validated as a whole, so taking over a key and unbinding its owner is one save', () => {
    expect(() => applyShortcutPatch({}, { 'tab.new': 'Mod+KeyW' }, true)).toThrow('conflict')
    expect(applyShortcutPatch({}, { 'tab.new': 'Mod+KeyW', 'tab.close': null }, true))
      .toEqual({ 'tab.new': 'Mod+KeyW', 'tab.close': null })
    expect(applyShortcutPatch({ 'tab.new': 'Mod+KeyN' }, { 'tab.new': 'default' }, true)).toEqual({})
    expect(applyShortcutPatch({ 'tab.new': 'Mod+KeyN' }, { 'tab.new': 'Mod+KeyT' }, true)).toEqual({})
    expect(() => applyShortcutPatch({}, { 'tab.nope': null }, true)).toThrow('Unknown')
    // Restoring a default someone else took over is a conflict too, however the default is spelled.
    const taken = { 'tab.new': 'Mod+KeyW', 'tab.close': null }
    expect(() => applyShortcutPatch(taken, { 'tab.close': 'default' }, true)).toThrow('conflict')
    expect(() => applyShortcutPatch(taken, { 'tab.close': 'Mod+KeyW' }, true)).toThrow('conflict')
    expect(() => applyShortcutPatch({}, { 'tab.new': 'Shift+Mod+KeyN' }, true)).toThrow('Invalid')
  })
})

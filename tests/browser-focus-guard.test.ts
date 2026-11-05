import { test, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'
import { BrowserFocusGuard } from '../src/main/browser/focus-guard'

function fixture() {
  const all: Contents[] = []
  class Contents extends EventEmitter {
    dead = false
    focused = false
    calls = 0
    visible = true
    constructor() { super(); all.push(this) }
    isDestroyed() { return this.dead }
    isFocused() { return this.focused }
    focus() {
      this.calls++
      for (const contents of all) contents.focused = false
      this.focused = true
      this.emit('focus')
    }
    destroy() { this.dead = true; this.emit('destroyed') }
  }
  const host = new Contents()
  host.focused = true
  const win = Object.assign(new EventEmitter(), {
    focused: true, webContents: host, isDestroyed: () => false,
    isFocused() { return this.focused }
  })
  const published: Contents[] = []
  const guard = new BrowserFocusGuard(win as unknown as BrowserWindow)
  const add = (visible: boolean) => {
    const contents = new Contents()
    contents.visible = visible
    guard.register(contents as unknown as WebContents, () => contents.visible, () => published.push(contents))
    return contents
  }
  return { host, win, guard, add, published }
}

test('unseen pages cannot retain focus or publish activation, even before navigation starts', () => {
  const f = fixture()
  const page = f.add(false)
  page.focus()
  expect(f.host.focused).toBe(true)
  expect(f.host.calls).toBe(1)
  expect(f.published).toEqual([])
  page.focus()
  expect(f.host.calls).toBe(2)
  f.guard.dispose()
})

test('background navigation protects visible split panes beyond tool completion and follows new user ownership', () => {
  const f = fixture()
  const page = f.add(true)
  const other = f.add(true)
  const tools = f.add(true)
  f.guard.protect(page as unknown as WebContents)
  page.focus()
  expect(f.host.focused).toBe(true)
  expect(f.published).toEqual([])
  other.focus()
  page.focus()
  expect(other.focused).toBe(true)
  expect(f.host.calls).toBe(1)
  tools.focus()
  page.focus()
  expect(tools.focused).toBe(true)
  expect(f.published).toEqual([other, tools])
  f.guard.dispose()
})

test('clicking the target or explicitly activating it releases only its navigation guard', () => {
  const f = fixture()
  const page = f.add(true)
  const other = f.add(true)
  f.guard.protect(page as unknown as WebContents)
  f.guard.protect(other as unknown as WebContents)
  page.emit('before-mouse-event', {}, { type: 'mouseDown' })
  page.focus()
  expect(page.focused).toBe(true)
  other.focus()
  expect(page.focused).toBe(true)
  f.guard.userIntent(other as unknown as WebContents)
  other.focus()
  expect(other.focused).toBe(true)
  expect(f.published).toEqual([page, other])
  f.guard.dispose()
})

test('ordinary Tab in the host, another page or DevTools preserves every background navigation guard', async () => {
  for (const location of ['host', 'page', 'devtools']) {
    const f = fixture()
    const source = location === 'host' ? f.host : f.add(true)
    source.focus()
    f.published.length = 0
    const targets = [f.add(true), f.add(true)]
    for (const target of targets) f.guard.protect(target as unknown as WebContents)
    const calls = source.calls
    source.emit('before-input-event', {}, { type: 'keyDown', key: 'Tab', control: false, meta: false })
    await Promise.resolve()
    for (const target of targets) {
      target.focus()
      expect(source.focused).toBe(true)
      expect(target.focused).toBe(false)
    }
    expect(source.calls).toBe(calls + targets.length)
    expect(f.published).toEqual([])
    f.guard.dispose()
  }
})

test('window blur and source destruction prevent stale restoration; disposal removes all listeners', () => {
  const f = fixture()
  const page = f.add(false)
  f.guard.protect(page as unknown as WebContents)
  f.win.focused = false
  f.win.emit('blur')
  page.focus()
  expect(f.host.calls).toBe(0)
  f.win.focused = true
  page.focus()
  expect(f.host.calls).toBe(0)
  f.host.focus()
  f.guard.protect(page as unknown as WebContents)
  f.host.destroy()
  page.focus()
  expect(f.host.calls).toBe(1)
  f.guard.dispose()
  expect(page.listenerCount('focus')).toBe(0)
  expect(page.listenerCount('before-mouse-event')).toBe(0)
  expect(f.win.listenerCount('blur')).toBe(0)
  expect(f.published).toEqual([])
})

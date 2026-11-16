import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { registerBrowserDownloads } from '../src/main/browser/downloads'

class MockSession extends EventEmitter {
  start(contents?: MockContents, item = new MockDownload()) {
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    this.emit('will-download', event, item, contents, null)
    return { event, item }
  }
}
class MockContents extends EventEmitter {
  dead = false
  constructor(readonly session: MockSession) { super() }
  isDestroyed() { return this.dead }
  destroy() { this.dead = true; this.emit('destroyed') }
}
class MockDownload extends EventEmitter {
  options: object[] = []
  cancellations = 0
  setupError = false
  cancelError = false
  setSaveDialogOptions(options: object) {
    if (this.setupError) throw new Error('https://user:password@example.test/file?token=secret /private/file')
    this.options.push(options)
  }
  cancel() {
    this.cancellations++
    if (this.cancelError) throw new Error('/private/file token=secret')
    this.emit('done', {}, 'cancelled')
  }
  update(state: 'progressing' | 'interrupted') { this.emit('updated', {}, state) }
  done(state: 'completed' | 'cancelled' | 'interrupted') { this.emit('done', {}, state) }
}
function fixture(session = new MockSession()) {
  const contents = new MockContents(session)
  const errors: string[] = []
  let alive = true
  const register = (saveDialogTitle?: string) => registerBrowserDownloads(contents as unknown as WebContents, {
    isAlive: () => alive,
    report: error => errors.push(error),
    errorMessage: '下载失败或中断',
    saveDialogTitle
  })
  return { session, contents, errors, register, die: () => { alive = false } }
}
function detached(item: MockDownload) {
  expect(item.listenerCount('updated')).toBe(0)
  expect(item.listenerCount('done')).toBe(0)
}

describe('browser downloads', () => {
  test('one fail-closed gate per shared Session, exact WebContents registration and independent Sessions', () => {
    const a = fixture()
    const b = fixture(a.session)
    const c = fixture()
    const disposeA = a.register()
    const disposeB = b.register()
    c.register()
    expect(a.session.listenerCount('will-download')).toBe(1)
    expect(c.session.listenerCount('will-download')).toBe(1)
    const first = a.session.start(a.contents)
    const second = a.session.start(b.contents)
    expect(first.event.prevented).toBe(false)
    expect(second.event.prevented).toBe(false)
    for (const source of [undefined, new MockContents(a.session), c.contents]) {
      const blocked = a.session.start(source)
      expect(blocked.event.prevented).toBe(true)
      expect(blocked.item.options).toEqual([])
      detached(blocked.item)
    }
    disposeA()
    expect(first.item.cancellations).toBe(1)
    expect(second.item.cancellations).toBe(0)
    expect(a.session.start(a.contents).event.prevented).toBe(true)
    expect(a.session.start(b.contents).event.prevented).toBe(false)
    disposeB()
    expect(a.session.listenerCount('will-download')).toBe(1)
    expect(a.session.start(b.contents).event.prevented).toBe(true)
    a.register()
    expect(a.session.listenerCount('will-download')).toBe(1)
    expect(a.session.start(a.contents).event.prevented).toBe(false)
  })

  test('configures the automatic native save dialog without a silent path or runtime Electron dependency', () => {
    const f = fixture()
    f.register('保存下载文件')
    const { item } = f.session.start(f.contents)
    expect(item.options).toEqual([{ title: '保存下载文件' }])
    item.done('completed')
    f.register()
    expect(f.session.start(f.contents).item.options).toEqual([{}])
    // The mock intentionally has no setSavePath, URL, filename or destination accessors.
  })

  test('completed and user-cancelled items detach without errors or subsequent cleanup cancellation', () => {
    const f = fixture()
    const dispose = f.register()
    for (const state of ['completed', 'cancelled'] as const) {
      const { item } = f.session.start(f.contents)
      item.done(state)
      detached(item)
      item.done('interrupted')
      item.update('interrupted')
      expect(item.cancellations).toBe(0)
    }
    dispose()
    expect(f.errors).toEqual([])
  })

  test('terminal interruption reports only the injected generic message and detaches', () => {
    const f = fixture()
    const dispose = f.register()
    const { item } = f.session.start(f.contents)
    item.done('interrupted')
    detached(item)
    item.done('interrupted')
    dispose()
    expect(item.cancellations).toBe(0)
    expect(f.errors).toEqual(['下载失败或中断'])
  })

  test('resumable interruption stays owned, reports once and can finish or be cancelled on teardown', () => {
    const f = fixture()
    const dispose = f.register()
    const { item } = f.session.start(f.contents)
    item.update('interrupted')
    item.update('interrupted')
    expect(item.listenerCount('done')).toBe(1)
    item.update('progressing')
    item.done('completed')
    detached(item)
    const terminal = f.session.start(f.contents).item
    terminal.update('interrupted')
    terminal.done('interrupted')
    detached(terminal)
    const pending = f.session.start(f.contents).item
    pending.update('interrupted')
    pending.update('progressing')
    dispose()
    expect(item.cancellations).toBe(0)
    expect(pending.cancellations).toBe(1)
    detached(pending)
    expect(f.errors).toEqual(['下载失败或中断', '下载失败或中断', '下载失败或中断'])
  })

  test('source destruction and explicit host cleanup cancel every unfinished item, suppressing late callbacks', () => {
    for (const destroySource of [true, false]) {
      const f = fixture()
      const dispose = f.register()
      const first = f.session.start(f.contents).item
      const second = f.session.start(f.contents).item
      const lateDone = first.listeners('done')[0]!
      const lateUpdate = first.listeners('updated')[0]!
      first.cancelError = true
      if (destroySource) f.contents.destroy()
      else { f.die(); dispose() }
      dispose()
      expect(first.cancellations).toBe(1)
      expect(second.cancellations).toBe(1)
      detached(first)
      detached(second)
      expect(f.contents.listenerCount('destroyed')).toBe(0)
      lateDone({}, 'interrupted')
      lateUpdate({}, 'interrupted')
      expect(f.errors).toEqual([])
      expect(f.session.start(f.contents).event.prevented).toBe(true)
    }
  })

  test('isAlive guards new requests and late item events before host cleanup arrives', () => {
    for (const action of ['start', 'update', 'done'] as const) {
      const f = fixture()
      f.register()
      const { item } = f.session.start(f.contents)
      const other = f.session.start(f.contents).item
      f.die()
      if (action === 'start') expect(f.session.start(f.contents).event.prevented).toBe(true)
      if (action === 'update') item.update('interrupted')
      if (action === 'done') item.done('interrupted')
      expect(other.cancellations).toBe(1)
      expect(item.cancellations).toBe(action === 'done' ? 0 : 1)
      expect(f.errors).toEqual([])
      detached(item)
      detached(other)
    }
  })

  test('replacement cancels old ownership and stale cleanup cannot unregister the replacement', () => {
    const f = fixture()
    const oldDispose = f.register()
    const oldItem = f.session.start(f.contents).item
    const dispose = f.register()
    const newItem = f.session.start(f.contents).item
    oldDispose()
    expect(oldItem.cancellations).toBe(1)
    expect(newItem.cancellations).toBe(0)
    expect(f.contents.listenerCount('destroyed')).toBe(1)
    expect(f.session.listenerCount('will-download')).toBe(1)
    dispose()
    expect(newItem.cancellations).toBe(1)
  })

  test('native setup failure prevents download and reports no raw error or metadata', () => {
    const f = fixture()
    f.register()
    const item = new MockDownload()
    item.setupError = true
    expect(f.session.start(f.contents, item).event.prevented).toBe(true)
    detached(item)
    expect(item.cancellations).toBe(0)
    expect(f.errors).toEqual(['下载失败或中断'])
  })

  test('dead contents or host cannot register', () => {
    for (const destroySource of [true, false]) {
      const f = fixture()
      if (destroySource) f.contents.destroy()
      else f.die()
      f.register()()
      expect(f.contents.listenerCount('destroyed')).toBe(0)
      expect(f.session.listenerCount('will-download')).toBe(0)
    }
  })
})

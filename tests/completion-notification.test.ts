import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

async function runFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-completion-notification-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    class FakeNotification extends EventEmitter {
      static supported = true
      static instances: FakeNotification[] = []
      static isSupported() { return FakeNotification.supported }
      shown = false
      constructor(readonly options: { title: string; body: string }) {
        super()
        FakeNotification.instances.push(this)
      }
      show() { this.shown = true }
    }
    mock.module('electron', () => ({
      app: { isPackaged: false },
      Notification: FakeNotification
    }))
    const { sendCompletionNotification } = await import('../src/main/completion-notification')
    const { setVisibleNotificationSessions } = await import('../src/main/completion-visibility')
    const { savePigSettings } = await import('../src/main/pig-settings')
    const { t } = await import('../src/main/i18n')
    const events: Array<{ channel: string; sessionId: string }> = []
    const windowActions: string[] = []
    let focused = false
    let destroyed = false
    const win = {
      isFocused: () => focused,
      isDestroyed: () => destroyed,
      isMinimized: () => true,
      restore: () => windowActions.push('restore'),
      show: () => windowActions.push('show'),
      focus: () => windowActions.push('focus'),
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: () => destroyed,
        send: (channel: string, sessionId: string) => events.push({ channel, sessionId })
      })
    } as unknown as BrowserWindow

    await sendCompletionNotification('chat-1', win, new AbortController().signal, {
      title: '修复登录问题', reply: '\n第一行回复\r\n\n第二行回复\n第三行不显示'
    })
    assert.equal(FakeNotification.instances.length, 1)
    assert.equal(FakeNotification.instances[0].shown, true)
    assert.deepEqual(FakeNotification.instances[0].options, { title: '修复登录问题', body: '第一行回复\n第二行回复' })
    const errors: unknown[][] = []
    const originalError = console.error
    try {
      console.error = (...args: unknown[]) => { errors.push(args) }
      FakeNotification.instances[0].emit('failed', {}, 'Notifications are not allowed')
    } finally {
      console.error = originalError
    }
    assert.deepEqual(errors, [['Could not show completion notification:', 'Notifications are not allowed']])
    FakeNotification.instances[0].emit('click')
    assert.deepEqual(windowActions, ['restore', 'show', 'focus'])
    assert.deepEqual(events, [{ channel: 'notification:click', sessionId: 'chat-1' }])

    await sendCompletionNotification('empty-reply', win, new AbortController().signal, { title: '空回复', reply: ' \n' })
    assert.deepEqual(FakeNotification.instances[1].options, { title: '空回复', body: t('notification.replyReady') })

    focused = true
    setVisibleNotificationSessions(win, ['chat-2', 'chat-3'])
    for (const id of ['chat-2', 'chat-3']) {
      await sendCompletionNotification(id, win, new AbortController().signal, { title: '标题', reply: '回复' })
    }
    assert.equal(FakeNotification.instances.length, 2, 'all visible split sessions are suppressed')
    await sendCompletionNotification('project-1', win, new AbortController().signal, { title: '项目完成', reply: '回复' })
    assert.equal(FakeNotification.instances.length, 3, 'a hidden project notifies while viewing Chat')
    FakeNotification.instances[2].emit('click')
    assert.deepEqual(events.at(-1), { channel: 'notification:click', sessionId: 'project-1' })
    setVisibleNotificationSessions(win, ['project-1'])
    await sendCompletionNotification('chat-2', win, new AbortController().signal, { title: 'Chat 完成', reply: '回复' })
    assert.equal(FakeNotification.instances.length, 4, 'a hidden Chat notifies while viewing a project')
    FakeNotification.instances[3].emit('click')
    assert.deepEqual(events.at(-1), { channel: 'notification:click', sessionId: 'chat-2' })
    focused = false
    await sendCompletionNotification('project-1', win, new AbortController().signal, { title: '标题', reply: '回复' })
    assert.equal(FakeNotification.instances.length, 5, 'a visible session still notifies when the window is unfocused')
    await savePigSettings({ completionNotifications: false })
    await sendCompletionNotification('chat-2', win, new AbortController().signal, { title: '标题', reply: '回复' })
    await savePigSettings({ completionNotifications: true })
    const cancelled = new AbortController()
    cancelled.abort()
    await sendCompletionNotification('chat-2', win, cancelled.signal, { title: '标题', reply: '回复' })
    FakeNotification.supported = false
    await sendCompletionNotification('chat-2', win, new AbortController().signal, { title: '标题', reply: '回复' })
    assert.equal(FakeNotification.instances.length, 5)

    destroyed = true
    FakeNotification.instances[0].emit('click')
    assert.equal(events.length, 3)
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--completion-notification-fixture') {
  await runFixture()
} else {
  test('completion notifications respect focus, settings, cancellation and route clicks', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--completion-notification-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
    }
  })
}

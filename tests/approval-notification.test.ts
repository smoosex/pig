import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow } from 'electron'
import { runSelf } from './helpers/subprocess.ts'

async function runFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-approval-notification-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    class FakeNotification extends EventEmitter {
      static instances: FakeNotification[] = []
      static isSupported() { return true }
      shown = false
      closed = false
      constructor(readonly options: { title: string; body: string; actions: Array<{ type: string; text: string }> }) {
        super()
        FakeNotification.instances.push(this)
      }
      show() { this.shown = true }
      close() { this.closed = true }
    }
    const dock: string[] = []
    mock.module('electron', () => ({
      app: { isPackaged: false, dock: { bounce: () => { dock.push('bounce'); return 7 }, cancelBounce: (id: number) => dock.push(`cancel:${id}`) } },
      Notification: FakeNotification
    }))
    mock.module(fileURLToPath(new URL('../src/main/pi/session-registry.ts', import.meta.url)), () => ({
      getLive: (id: string) => id === 'chat-1'
        ? { agentSession: { sessionName: '修复登录', sessionManager: { getEntries: () => [] } } }
        : undefined
    }))
    const { trackApproval, retireApproval } = await import('../src/main/approval-notification')
    const { setVisibleNotificationSessions } = await import('../src/main/completion-visibility')
    const { updatePigSettings } = await import('../src/main/pig-settings')
    const poll = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    const waitForNotifications = async (count: number): Promise<void> => {
      const deadline = performance.now() + 2_000
      while (FakeNotification.instances.length < count && performance.now() < deadline) await poll()
      assert.equal(FakeNotification.instances.length, count, `waiting for ${count} notifications`)
    }
    const expectNoNewNotifications = async (count: number, message: string): Promise<void> => {
      // A negative condition is initially true even while refresh is still pending; observe the
      // entire window instead of returning at the first matching count.
      const deadline = performance.now() + 250
      do {
        assert.equal(FakeNotification.instances.length, count, message)
        await poll()
      } while (performance.now() < deadline)
      assert.equal(FakeNotification.instances.length, count, message)
    }
    const sent: unknown[][] = []
    let focused = false
    const win = Object.assign(new EventEmitter(), {
      isFocused: () => focused,
      isDestroyed: () => false,
      isMinimized: () => false,
      show: () => {},
      focus: () => {},
      flashFrame: () => {},
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        send: (...args: unknown[]) => sent.push(args)
      })
    }) as unknown as BrowserWindow
    const replies: string[] = []
    const notice = (id: string, title = `Allow ${id}?`, sourceTitle?: string) => ({
      id, title, options: ['Allow once', 'Allow for session', 'Deny'], sourceTitle,
      reply: (option: string) => { replies.push(`${id}:${option}`); retireApproval('chat-1', id) }
    })

    trackApproval('chat-1', win, notice('a'))
    trackApproval('chat-1', win, notice('b', 'Write file?', 'Inspect code'))
    await waitForNotifications(1)
    await expectNoNewNotifications(1, 'one notification per session, for the oldest request')
    const first = FakeNotification.instances[0]
    assert.equal(first.shown, true)
    assert.equal(first.options.title, '修复登录')
    assert.match(first.options.body, /Allow a\?/)
    assert.match(first.options.body, /\n./, 'more requests are mentioned without a stale count')
    assert.deepEqual(first.options.actions.map((action) => action.text), ['Deny'], 'nothing can be allowed without the full request')
    assert.deepEqual(dock, ['bounce'])

    first.emit('action', { actionIndex: 0 }, 0)
    assert.deepEqual(replies, ['a:Deny'])
    assert.equal(first.closed, true)
    await waitForNotifications(2)
    assert.equal(FakeNotification.instances.length, 2, 'the next pending request follows')
    assert.match(FakeNotification.instances[1].options.body, /Inspect code · Write file\?/)

    FakeNotification.instances[1].emit('click')
    assert.deepEqual(sent.at(-1), ['notification:click', 'chat-1'])
    retireApproval('chat-1', 'b')
    assert.equal(FakeNotification.instances[1].closed, true, 'answering in the app retires the notification')
    assert.deepEqual(dock, ['bounce', 'cancel:7'], 'the dock keeps bouncing until no approval waits')

    focused = true
    setVisibleNotificationSessions(win, ['chat-1'])
    trackApproval('chat-1', win, notice('c'))
    await expectNoNewNotifications(2, 'a visible session answers in its composer')
    focused = false
    ;(win as unknown as EventEmitter).emit('blur')
    await waitForNotifications(3)
    assert.equal(FakeNotification.instances.length, 3, 'looking away from a waiting approval notifies')
    retireApproval('chat-1', 'c')
    focused = true
    trackApproval('chat-1', win, notice('c2'))
    await expectNoNewNotifications(3, 'a focused visible session does not notify before switching tabs')
    setVisibleNotificationSessions(win, ['chat-2'])
    await waitForNotifications(4)
    assert.equal(FakeNotification.instances.length, 4, 'switching tabs away from a waiting approval notifies')
    retireApproval('chat-1', 'c2')
    setVisibleNotificationSessions(win, ['chat-1'])

    focused = false
    await updatePigSettings(() => ({ approvalNotifications: false }))
    trackApproval('chat-1', win, notice('d'))
    await expectNoNewNotifications(4, 'the setting turns them off')
    retireApproval('chat-1', 'd')
    await updatePigSettings(() => ({ approvalNotifications: true }))

    trackApproval('chat-1', win, notice('e'))
    retireApproval('chat-1', 'e')
    await expectNoNewNotifications(4, 'a request finished before the check never shows')
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--approval-notification-fixture') {
  await runFixture()
} else {
  test('approval notifications follow pending requests, answer through actions and respect visibility', async () => {
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--approval-notification-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      timeoutMs: 12_000
    })
    assert.equal(code, 0, stderr || stdout)
  })
}

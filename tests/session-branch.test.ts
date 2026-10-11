import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { switchSessionBranch } from '../src/main/pi/session-branch'

function fixture() {
  const sessionManager = SessionManager.inMemory('/project')
  const events: unknown[] = []
  let refreshes = 0
  const session = {
    sessionManager,
    isStreaming: false,
    isBashRunning: false,
    refreshContext: () => { refreshes++ },
    extensionRunner: { emit: async (event: unknown) => { events.push(event) } }
  } as unknown as Parameters<typeof switchSessionBranch>[0]
  return { session, sessionManager, events, refreshes: () => refreshes }
}

const user = (text: string) => ({ role: 'user' as const, content: text, timestamp: 1 })

test('tree restores a user prompt before its sent message without modifying the old branch', async () => {
  const { session, sessionManager: sm, events, refreshes } = fixture()
  const first = sm.appendMessage(user('第一轮'))
  const parent = sm.appendCustomEntry('checkpoint', {})
  const target = sm.appendMessage(user('第二轮\n继续'))
  const oldLeaf = sm.appendCustomEntry('checkpoint', {})
  const entries = sm.getEntries()
  const result = await switchSessionBranch(session, target, { restoreUserInput: true })
  assert.deepEqual(result, { leafId: parent, restoredPrompt: { text: '第二轮\n继续', images: [] } })
  assert.deepEqual(sm.getBranch().map((entry) => entry.id), [first, parent])
  assert.deepEqual(sm.getEntries(), entries)
  assert.equal(refreshes(), 1)
  assert.deepEqual(events, [{ type: 'session_tree', newLeafId: parent, oldLeafId: oldLeaf }])
  const resent = sm.appendMessage(user('修改后的第二轮'))
  assert.equal(sm.getEntry(resent)?.parentId, parent)
  assert.ok(sm.getEntry(target), 'the original sent prompt remains available in the tree')
})

test('restoring the first user node resets to an empty branch, even when it is the current leaf', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage(user('首轮问题'))
  const result = await switchSessionBranch(session, target, { restoreUserInput: true })
  assert.deepEqual(result, { leafId: null, restoredPrompt: { text: '首轮问题', images: [] } })
  assert.deepEqual(sm.getBranch(), [])
})

test('tree restoration retains all text blocks and image payloads', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage({
    role: 'user', timestamp: 1,
    content: [
      { type: 'text', text: '图片说明\n' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      { type: 'text', text: '粘贴的完整内容' }
    ]
  })
  const { restoredPrompt } = await switchSessionBranch(session, target, { restoreUserInput: true })
  assert.deepEqual(restoredPrompt, {
    text: '图片说明\n粘贴的完整内容',
    images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }]
  })
})

test('branch synchronization keeps a user node sent, and non-user restoration does not replace the draft', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage(user('已发送'))
  const other = sm.appendCustomEntry('checkpoint', {})
  assert.deepEqual(await switchSessionBranch(session, target), { leafId: target })
  assert.equal(sm.getBranch().at(-1)?.id, target)
  assert.deepEqual(await switchSessionBranch(session, other, { restoreUserInput: true }), { leafId: other })
})

test('busy sessions reject restoration without moving the leaf', async () => {
  const { session, sessionManager: sm } = fixture()
  const target = sm.appendMessage(user('问题'))
  for (const state of [{ isStreaming: true, isBashRunning: false }, { isStreaming: false, isBashRunning: true }]) {
    await assert.rejects(switchSessionBranch({ ...session, ...state }, target, { restoreUserInput: true }), /Session is busy/)
    assert.equal(sm.getLeafId(), target)
  }
})

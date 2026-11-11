import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { displayTurnsFromEntries } from '../src/main/pi/session-display-model'
import type { SessionSource } from '../src/main/pi/session-source'
import { runSelf } from './helpers/subprocess'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-bookmark-ipc-'))
  const file = join(root, 'session.jsonl')
  await writeFile(file, 'persisted')
  const handlers = new Map<string, (...args: any[]) => any>()
  const messages: string[] = []
  const win = { isDestroyed: () => false, webContents: { send: (channel: string) => messages.push(channel) } }
  let guest = false
  let owner = { win, cwd: '/project', kind: 'file', path: file }
  let onBranch = true
  let present = true
  let gate: Promise<void> | undefined
  const entries = [
    { type: 'message', id: 'user', parentId: null, timestamp: new Date(1).toISOString(),
      message: { role: 'user', content: 'Question', timestamp: 1 } },
    { type: 'message', id: 'reply', parentId: 'user', timestamp: new Date(2).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Verified reply' }], stopReason: 'stop', timestamp: 2 } }
  ] as unknown as SessionEntry[]
  let turn = displayTurnsFromEntries('session', entries)[0]
  const source = {
    turnSummaries: () => [{ id: 'user', bytes: 1, hasImages: false }],
    turnWindow: () => [turn], branchIds: () => onBranch ? entries.map(entry => entry.id) : ['other'],
    entryById: (id: string) => present ? entries.find(entry => entry.id === id) : undefined
  } as unknown as SessionSource
  mock.module('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }, BrowserWindow: { getAllWindows: () => [win] } }))
  mock.module('../src/main/pig-dir', () => ({ pigPath: () => join(root, 'bookmarks.json') }))
  mock.module('../src/main/browser/validation', () => ({ assertBrowserSender: () => { if (guest) throw new Error('UI main frame required') } }))
  mock.module('../src/main/ipc/window', () => ({ windowForEvent: () => win }))
  mock.module('../src/main/chats', () => ({ isChatCwd: () => false }))
  mock.module('../src/main/pi/session-registry', () => ({ sessionState: () => owner, withSource: async (_id: string, read: (source: SessionSource) => unknown) => { await gate; return read(source) } }))
  const { registerBookmarksIpc } = await import('../src/main/ipc/bookmarks')
  registerBookmarksIpc()
  const event = {} as IpcMainInvokeEvent
  const call = async (name: string, ...args: unknown[]) => handlers.get(`bookmarks:${name}`)!(event, ...args)
  try {
    const saved = await call('add', 'session', 'user', 'reply', 'Example')
    assert.equal(saved.items[0].preview, 'Verified reply')
    assert.equal(saved.items[0].session.path, file)
    assert.ok(messages.includes('bookmarks:changed'))
    assert.equal((await call('add', 'session', 'user', 'reply', 'Example')).items.length, 1)
    assert.deepEqual(await call('locate', 'session/reply'), { turnIndex: 0 })
    entries.push({
      type: 'compaction', id: 'compaction', parentId: 'reply', timestamp: new Date(3).toISOString(),
      summary: 'Compacted context', firstKeptEntryId: 'user', tokensBefore: 100
    })
    turn = displayTurnsFromEntries('session', entries)[0]
    assert.equal(turn.lastEntryId, 'compaction')
    assert.equal(turn.replyEntryId, 'reply')
    assert.deepEqual(await call('locate', 'session/reply'), { turnIndex: 0 }, 'manual compaction does not invalidate navigation')
    const afterCompaction = await call('add', 'session', 'user', 'reply', 'Example')
    assert.equal(afterCompaction.items.length, 1, 'the same reply cannot be duplicated after compaction')
    assert.equal(afterCompaction.revision, saved.revision)
    await assert.rejects(call('add', 'session', 'user', 'compaction', 'Example'), /not found/, 'the mutable turn tail is not a reply identifier')
    entries.push({
      type: 'message', id: 'replacement', parentId: 'compaction', timestamp: new Date(4).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Another reply' }], stopReason: 'stop', timestamp: 4 }
    } as SessionEntry)
    turn = displayTurnsFromEntries('session', entries)[0]
    assert.deepEqual(await call('locate', 'session/reply'), { turnIndex: null }, 'an ancestor reply no longer displayed must be reached through its original branch')
    entries.pop()
    turn = displayTurnsFromEntries('session', entries)[0]
    onBranch = false
    assert.deepEqual(await call('locate', 'session/reply'), { turnIndex: null }, 'another branch is not silently mistaken for the current reply')
    present = false
    await assert.rejects(call('locate', 'session/reply'), /no longer exists/)
    present = true; onBranch = true
    await assert.rejects(call('add', 'session', 'user', 'fake', 'Example'), /not found/)
    guest = true
    for (const method of ['list', 'remove', 'locate']) await assert.rejects(call(method, 'session/reply'), /main frame/)
    guest = false
    const old = owner
    owner = { ...owner, win: {} as typeof win }
    await assert.rejects(call('add', 'session', 'user', 'reply', 'Example'), /another window/)
    owner = old
    const pending = Promise.withResolvers<void>(); gate = pending.promise
    const adding = call('add', 'session', 'user', 'reply', 'Example')
    owner = { ...owner }
    pending.resolve()
    await assert.rejects(adding, /replaced/)
    gate = undefined
    assert.equal((await call('remove', 'session/reply')).items.length, 0)
    turn.answer = []
    await assert.rejects(call('add', 'session', 'user', 'reply', 'Example'), /not found/)
    turn.answer = [{ type: 'image', mimeType: 'image/png', url: 'pig-image:test' }]
    assert.equal((await call('add', 'session', 'user', 'reply', 'Example')).items[0].preview, '', 'image-only replies can be bookmarked without copying image bytes')
  } finally { await rm(root, { recursive: true, force: true }) }
}

if (process.argv.includes('--fixture')) await fixture()
else test('bookmark IPC validates persisted replies and UI ownership and locates historical branches', async () => {
  const result = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 15_000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})

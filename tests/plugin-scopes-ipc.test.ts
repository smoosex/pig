import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-plugin-scopes-ipc-')))
  const previousPig = process.env.PIG_DIR
  process.env.PIG_DIR = join(root, 'pig')
  const handlers = new Map<string, (...args: any[]) => unknown>()
  let refreshes = 0
  const webContents = { mainFrame: {}, isDestroyed: () => false }
  const win = { webContents, isDestroyed: () => false }
  mock.module('electron', () => ({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: (sender: unknown) => sender === webContents ? win : undefined },
    dialog: {},
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) }
  }))
  mock.module(fileURLToPath(new URL('../src/main/pi/session-registry.ts', import.meta.url)), () => ({
    getLive: () => undefined,
    hasBusyPluginSessions: () => false,
    refreshConversationFeatures: async () => { refreshes++ },
    sessionCwd: (sessionId: string) => {
      if (sessionId === 'project') return join(root, 'project')
      if (sessionId === 'chat') return join(process.env.PIG_DIR!, 'chats', 'chat')
      throw new Error('Unknown session')
    },
    sessionSourceFor: async () => ({ branch: () => [] })
  }))
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents, senderFrame: webContents.mainFrame }, ...args)
  try {
    const { registerConversationFeaturesIpc } = await import('../src/main/ipc/conversation-features')
    registerConversationFeaturesIpc()
    assert.equal(handlers.has('conversation-features:get'), false)
    assert.equal(handlers.has('conversation-features:set-scopes'), false)
    assert.equal(handlers.has('plugins:memory-enabled'), false)
    for (const channel of handlers.keys()) {
      await assert.rejects(Promise.resolve().then(() => handlers.get(channel)!({ sender: webContents, senderFrame: {} })), /owning UI main frame/)
    }
    for (const sessionId of ['project', 'chat']) {
      assert.equal(await invoke('memory:enabled', sessionId), true)
      assert.match(await invoke('memory:detail', sessionId, 'view') as string, /No visible observations/)
    }
    await invoke('memory:set', { observeAfterTokens: 900 })
    assert.equal(refreshes, 1, 'memory settings still reload idle sessions')
    await invoke('memory:set', { fileMemory: { enabled: true } })
    assert.equal(refreshes, 2)
    assert.deepEqual((await invoke('memory:get') as { fileMemory: unknown }).fileMemory, { enabled: true })
    await assert.rejects(invoke('memory:set', { longTerm: { enabled: true } }), /Unknown memory setting/)
    await assert.rejects(invoke('memory:set', { fileMemory: { enabled: true, model: {} } }), /Invalid/)
    assert.deepEqual(await invoke('memory:files:list'), [])
    const { MemoryFiles, memoryRoot } = await import('../src/main/features/memory/long-term/files')
    const files = new MemoryFiles(join(memoryRoot(), 'global'))
    const first = files.save('MEMORY.md', 'Entry', null)
    assert.equal((await invoke('memory:files:read', 'global/MEMORY.md') as { content: string }).content, 'Entry')
    await invoke('memory:files:save', 'global/MEMORY.md', 'Updated', first.revision)
    await assert.rejects(invoke('memory:files:save', 'global/MEMORY.md', 'Lost', first.revision), /conflict/)
    await assert.rejects(invoke('memory:files:read', '../secret.md'), /scope/)
    await assert.rejects(invoke('memory:files:read', 'global/../../secret.md'), /relative/)
    assert.equal(handlers.has('memory:long-term:list'), false)
    const current = files.read('MEMORY.md')
    await invoke('memory:files:delete', 'global/MEMORY.md', current.revision)
    assert.deepEqual(await invoke('memory:files:list'), [])
    await assert.rejects(invoke('memory:enabled'), /Session id is required/)
    await assert.rejects(invoke('memory:enabled', 'unknown'), /Unknown session/)
  } finally {
    if (previousPig === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previousPig
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('built-in memory IPC is enabled in project and chat sessions and only accepts the owning UI', async () => {
  const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  assert.equal(code, 0, stderr || stdout)
}, 12_000)

import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
    for (const removed of ['memory:enabled', 'memory:detail', 'memory:defaults']) assert.equal(handlers.has(removed), false)
    await assert.rejects(invoke('memory:set', { observeAfterTokens: 900 }), /Unknown memory setting/)
    assert.equal(refreshes, 0)
    await invoke('memory:set', { fileMemory: { enabled: true } })
    assert.equal(refreshes, 1, 'file-memory settings still reload idle sessions')
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
    const { addOpenedProject } = await import('../src/main/opened-projects')
    const { projectMemoryKey } = await import('../src/main/features/memory/long-term/files')
    const gitProject = join(root, 'project-pig')
    const plainProject = join(root, 'plain-project')
    await mkdir(join(gitProject, '.git', 'objects'), { recursive: true })
    await mkdir(join(gitProject, '.git', 'refs'))
    await writeFile(join(gitProject, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await mkdir(plainProject)
    const missingProject = join(root, 'missing-project')
    for (const cwd of [gitProject, plainProject, missingProject]) await addOpenedProject(cwd)
    const { sessionWorkspace } = await import('../src/main/sandbox/workspace')
    assert.equal((await sessionWorkspace(gitProject)).gitCommonDir, join(gitProject, '.git'))
    const { listOpenedCwds } = await import('../src/main/opened-projects')
    assert.ok((await listOpenedCwds()).includes(gitProject))
    const identities = [join(gitProject, '.git'), plainProject, missingProject, gitProject]
    for (const identity of identities) {
      new MemoryFiles(join(memoryRoot(), 'projects', projectMemoryKey(identity)), memoryRoot()).save('MEMORY.md', 'Entry', null)
    }
    const listing = await invoke('memory:files:list') as { path: string; projectName?: string }[]
    const named = (identity: string) => listing.find(item => item.path === `projects/${projectMemoryKey(identity)}/MEMORY.md`)!
    assert.equal(named(join(gitProject, '.git')).projectName, 'project-pig', 'Git memory uses the common directory identity')
    assert.equal(named(plainProject).projectName, 'plain-project', 'non-Git memory uses its real cwd')
    assert.equal(named(gitProject).projectName, undefined, 'a matching name cannot override a different project identity')
    assert.equal(named(missingProject).projectName, undefined, 'missing projects retain their ID without a guessed name')
  } finally {
    if (previousPig === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previousPig
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('file-memory IPC retains scoped editing and accepts only the owning UI', async () => {
  const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  assert.equal(code, 0, stderr || stdout)
}, 12_000)

import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginInfo } from '../src/shared/api'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-plugin-scopes-ipc-'))
  const previousPig = process.env.PIG_DIR
  process.env.PIG_DIR = join(root, 'pig')
  const handlers = new Map<string, (...args: any[]) => unknown>()
  let refreshes = 0
  mock.module('electron', () => ({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: {},
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) }
  }))
  mock.module(fileURLToPath(new URL('../src/main/pi/session-registry.ts', import.meta.url)), () => ({
    getLive: () => undefined,
    hasBusyPluginSessions: () => false,
    refreshPluginSessions: async () => { refreshes++ },
    sessionCwd: (sessionId: string) => {
      if (sessionId === 'project') return join(root, 'project')
      if (sessionId === 'chat') return join(process.env.PIG_DIR!, 'chats', 'chat')
      throw new Error('Unknown session')
    },
    sessionSourceFor: async () => ({ branch: () => [] })
  }))
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  try {
    const { registerPluginIpc } = await import('../src/main/ipc/plugins')
    registerPluginIpc()
    assert.equal(await invoke('plugins:memory-enabled', 'project'), false)
    assert.equal(await invoke('plugins:memory-enabled', 'chat'), false)
    await assert.rejects(invoke('plugins:memory-detail', 'project', 'view'), /not enabled/)
    await assert.rejects(invoke('plugins:memory-detail', 'chat', 'view'), /not enabled/)

    const plugins = await invoke('plugins:scopes', 'observational-memory', ['chat']) as PluginInfo[]
    assert.deepEqual(plugins.find((plugin) => plugin.id === 'observational-memory')?.scopes, ['chat'])
    assert.equal(refreshes, 1)
    assert.equal(await invoke('plugins:memory-enabled', 'project'), false)
    assert.equal(await invoke('plugins:memory-enabled', 'chat'), true)
    await assert.rejects(invoke('plugins:memory-detail', 'project', 'view'), /not enabled/)
    assert.match(await invoke('plugins:memory-detail', 'chat', 'view') as string, /No visible observations/)

    await invoke('plugins:scopes', 'observational-memory', ['project', 'chat'])
    assert.equal(await invoke('plugins:memory-enabled', 'project'), true)
    assert.equal(await invoke('plugins:memory-enabled', 'chat'), true)
    await invoke('plugins:scopes', 'observational-memory', [])
    assert.equal(await invoke('plugins:memory-enabled', 'project'), false)
    assert.equal(await invoke('plugins:memory-enabled', 'chat'), false)
    await assert.rejects(invoke('plugins:scopes', 'observational-memory', ['unknown']), /Invalid plugin scopes/)
    await assert.rejects(invoke('plugins:scopes', 'observational-memory', true), /Invalid plugin scopes/)
    assert.equal(refreshes, 3, 'invalid scope payloads do not trigger a reload')
    await assert.rejects(invoke('plugins:memory-enabled'), /Session id is required/)
    await assert.rejects(invoke('plugins:memory-enabled', 'unknown'), /Unknown session/)
  } finally {
    if (previousPig === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previousPig
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('plugin IPC scopes memory availability and details to the requested session', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stderr || stdout)
  } finally { clearTimeout(timer); child.kill() }
}, 12_000)

import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow } from 'electron'

async function fixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-mcp-manager-'))
  process.env.PIG_DIR = root
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'mcp.json'),
    JSON.stringify({
      mcpServers: { fixture: { url: 'https://example.invalid/mcp', enabled: false } }
    })
  )
  const adapterPath = fileURLToPath(new URL('../src/main/mcp/sdk.ts', import.meta.url))
  const adapter = await import(adapterPath)
  const sdk = await adapter.mcpSdk()
  const instances: FakeConnection[] = []
  let signInStarted!: () => void
  const signingIn = new Promise<void>((resolve) => {
    signInStarted = resolve
  })
  class FakeConnection {
    state = 'connected'
    tools = [{ name: 'fixture', description: 'Fixture' }]
    error = undefined
    oauthUrl = 'https://example.invalid/mcp'
    challenge = undefined
    closeCalls = 0
    release!: () => void
    closed = new Promise<void>((resolve) => {
      this.release = resolve
    })
    constructor() {
      instances.push(this)
    }
    async getClient() {
      return {}
    }
    oauthSettings() {
      return {}
    }
    async reconnect() {}
    close() {
      this.closeCalls++
      return this.closeCalls === 1 ? this.closed : Promise.resolve()
    }
  }
  mock.module(adapterPath, () => ({
    ...adapter,
    mcpSdk: async () => ({
      ...sdk,
      runtime: {
        ...sdk.runtime,
        McpServerConnection: FakeConnection,
        signInMcpServer: ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signInStarted()
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          })
      }
    })
  }))
  const manager = await import('../src/main/mcp/manager')
  const contents = Object.assign(new EventEmitter(), { send: () => {}, isDestroyed: () => false })
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  try {
    const probe = manager.testMcpServer('fixture', win)
    while (!instances[0]?.closeCalls) await new Promise((resolve) => setTimeout(resolve, 1))
    let cancelled = false
    const cancelling = manager.cancelMcpOperations('fixture').then(() => {
      cancelled = true
    })
    await Promise.resolve()
    assert.equal(
      cancelled,
      false,
      'cancellation must await the first close, not a duplicate early-return close'
    )
    assert.equal(instances[0].closeCalls, 1)
    instances[0].release()
    await cancelling
    assert.equal((await probe).state, 'ready')
    assert.equal(contents.listenerCount('destroyed'), 0)
    const login = manager.loginMcpServer(win, 'fixture').then(
      () => null,
      (error: unknown) => error
    )
    await signingIn
    assert.throws(() => manager.loginMcpServer(win, 'fixture'), /already in progress/)
    contents.emit('destroyed')
    assert.equal(instances[1].closeCalls, 1)
    instances[1].release()
    assert.ok(await login)
    assert.equal(contents.listenerCount('destroyed'), 0)
    await manager.cancelMcpOperations()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--fixture')) await fixture()
else
  test('MCP management: serialized login, window abort and awaiting exactly one connection close', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 5000)
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, err || out)
    } finally {
      clearTimeout(timer)
    }
  }, 7000)

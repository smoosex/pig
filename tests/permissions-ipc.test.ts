import { expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const sent: string[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, mainFrame: {}, send: (channel: string) => sent.push(channel) }
  }
  mock.module('electron', () => ({
    app: { isPackaged: false },
    BrowserWindow: { getAllWindows: () => [win] },
    ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(name, handler) }
  }))
  mock.module('../src/main/ipc/window', () => ({ windowForEvent: () => win }))
  mock.module('../src/main/sandbox/service', () => ({ ensureSandbox: async () => ({ state: 'ready' }), refreshSandboxHosts: () => {} }))
  const root = mkdtempSync(join(tmpdir(), 'pig-permissions-ipc-'))
  const previous = process.env.PIG_DIR
  process.env.PIG_DIR = root
  try {
    const { registerPermissionsIpc } = await import('../src/main/ipc/permissions')
    registerPermissionsIpc()
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    const call = (name: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(name)!(event, ...args))
    const requests: [string, unknown[]][] = [
      ['permissions:get', []], ['permissions:set-default-mode', ['full-access']],
      ['permissions:remove-domain', [null, 'example.com']], ['permissions:get-session', ['one']],
      ['permissions:set-session', ['one', 'full-access']], ['permissions:set-mcp-approval', ['docs', 'prompt']]
    ]
    for (const [channel, args] of requests) {
      for (const foreign of [{ ...event, senderFrame: {} }, { ...event, sender: {} }]) {
        await expect(Promise.resolve().then(() => handlers.get(channel)!(foreign, ...args))).rejects.toThrow('owning UI main frame')
      }
    }
    await expect(call('permissions:set-default-mode', 'unknown')).rejects.toThrow('Invalid permission mode')
    await expect(call('permissions:set-session', '../escape', 'full-access')).rejects.toThrow('Invalid session id')
    await expect(call('permissions:set-session', 'one', false)).rejects.toThrow('Invalid permission mode')
    await expect(call('permissions:remove-domain', null, 'https://example.com')).rejects.toThrow('Invalid permission host')
    await expect(call('permissions:set-mcp-approval', 'docs', 'never')).rejects.toThrow('Invalid MCP approval')
    await expect(call('permissions:set-mcp-approval', '', 'prompt')).rejects.toThrow('Invalid MCP approval')
    expect(existsSync(join(root, 'permissions.json'))).toBe(false)
    expect(sent).toEqual([])

    expect(await call('permissions:set-default-mode', 'read-only')).toMatchObject({ defaultMode: 'read-only', sandbox: { state: 'ready' } })
    expect(await call('permissions:get-session', 'one')).toEqual({ mode: 'read-only', overridden: false })
    expect(await call('permissions:set-session', 'one', 'full-access')).toEqual({ mode: 'full-access', overridden: true })
    expect(await call('permissions:set-session', 'one', null)).toEqual({ mode: 'read-only', overridden: false })
    expect(await call('permissions:set-mcp-approval', 'docs', 'prompt')).toMatchObject({ mcp: { docs: 'prompt' } })
    // auto is the default and is not stored.
    expect(await call('permissions:set-mcp-approval', 'docs', 'auto')).toMatchObject({ mcp: {} })
    expect(JSON.parse(readFileSync(join(root, 'permissions.json'), 'utf8')).mcp).toBeUndefined()
    expect(sent).toEqual(Array(5).fill('permissions:changed'))

    writeFileSync(join(root, 'permissions.json'), '{')
    await expect(call('permissions:get')).rejects.toThrow()
    await expect(call('permissions:set-default-mode', 'full-access')).rejects.toThrow()
    expect(readFileSync(join(root, 'permissions.json'), 'utf8')).toBe('{')
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR
    else process.env.PIG_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--permissions-ipc-fixture')) {
  await fixture()
} else {
  test('permission IPC rejects guests and invalid inputs; UI updates broadcast and corrupt policy stays untouched', async () => {
    const child = Bun.spawn([process.execPath, import.meta.filename, '--permissions-ipc-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`Permission IPC fixture exited ${code}: ${stdout}\n${stderr}`)
    } finally { clearTimeout(timeout) }
  }, 15_000)
}

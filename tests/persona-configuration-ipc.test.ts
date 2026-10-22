import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { IpcMainInvokeEvent } from 'electron'

async function fixture(): Promise<void> {
  const { mock } = await import('bun:test')
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const webContents = { mainFrame: {}, isDestroyed: () => false }
  const win = { webContents, isDestroyed: () => false }
  mock.module('electron', () => ({
    BrowserWindow: { fromWebContents: (sender: unknown) => sender === webContents ? win : undefined },
    ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler) }
  }))
  let reloads = 0
  let failSave = false
  const calls: unknown[][] = []
  mock.module('../src/main/pi/session-registry', () => ({ refreshPluginSessions: async (force: boolean) => {
    assert.equal(force, true)
    reloads++
  } }))
  mock.module('../src/main/plugins/pi-persona/service', () => ({
    getPersona: async () => { calls.push(['get']); return { active: false } },
    savePersonaFile: async (...args: unknown[]) => {
      if (failSave) throw new Error('revision conflict')
      calls.push(['save', ...args]); return { active: true }
    },
    setPersonaEmotion: async (...args: unknown[]) => { calls.push(['emotion', ...args]); return { active: true } },
    setPersonaAutomatic: async (...args: unknown[]) => { calls.push(['automatic', ...args]); return { active: true } }
  }))
  const { registerPersonaIpc } = await import('../src/main/ipc/persona')
  registerPersonaIpc()
  const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, source = event, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!(source, ...args))
  for (const channel of handlers.keys()) {
    await assert.rejects(invoke(channel, { ...event, senderFrame: {} } as IpcMainInvokeEvent), /owning UI main frame/)
  }
  assert.equal(calls.length, 0)
  await invoke('persona:get')
  const document = { name: 'SOUL.md', content: 'A persona', revision: null }
  await invoke('persona:save-file', event, document)
  await invoke('persona:set-emotion', event, 'joy', 0.5)
  await invoke('persona:set-automatic', event, false)
  assert.deepEqual(calls, [['get'], ['save', document], ['emotion', 'joy', 0.5], ['automatic', false]])
  assert.equal(reloads, 1, 'only persona file changes require resource reloads')
  failSave = true
  await assert.rejects(invoke('persona:save-file', event, document), /revision conflict/)
  assert.equal(reloads, 1, 'failed saves never report a successful refresh')
}

if (process.argv.includes('--fixture')) await fixture()
else test('persona IPC restricts configuration to the UI main frame and refreshes after file saves', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, errors || output)
})

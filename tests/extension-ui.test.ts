import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionUIEvent } from '../src/shared/api'

async function fixture(): Promise<void> {
  const launchError = Object.assign(new Error('Browser launch failed'), { code: 'E_BROWSER_LAUNCH' })
  mock.module('electron', () => ({ shell: { openExternal: async () => { throw launchError } } }))
  mock.module(fileURLToPath(new URL('../src/main/mcp/sdk.ts', import.meta.url)), () => ({
    mcpSdk: async () => ({ theme: {} })
  }))
  const { createExtensionUI, replyExtensionUI, cancelExtensionUI, openMcpUrl } = await import(
    '../src/main/extension-ui'
  )
  const events: ExtensionUIEvent[] = []
  const contents = Object.assign(new EventEmitter(), {
    send: (_channel: string, event: ExtensionUIEvent) => events.push(event),
    isDestroyed: () => false
  })
  const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
  const sender = contents as unknown as WebContents
  const ui = await createExtensionUI(win, 'session')
  const input = ui.input('Input', 'placeholder')
  const request = events.at(-1)!
  assert.equal(request.kind, 'prompt')
  if (request.kind !== 'prompt') throw new Error('Missing request')
  replyExtensionUI({} as WebContents, request.id, 'forged')
  assert.equal(events.at(-1)?.kind, 'prompt')
  replyExtensionUI(sender, request.id, 'owned response')
  assert.equal(await input, 'owned response')
  assert.deepEqual(events.at(-1), { kind: 'dismiss', id: request.id })
  assert.equal(contents.listenerCount('destroyed'), 0)
  const signal = new AbortController()
  const selecting = ui.select('Select', ['one', 'two'], { signal: signal.signal })
  signal.abort()
  assert.equal(await selecting, undefined)
  const confirm = ui.confirm('Confirm', 'Message')
  const editor = ui.editor('Editor', 'original')
  cancelExtensionUI('session')
  assert.equal(await confirm, false)
  assert.equal(await editor, undefined)
  assert.equal(contents.listenerCount('destroyed'), 0)
  assert.equal(await ui.input('Timeout', '', { timeout: 1 }), undefined)
  const closing = ui.input('Closing')
  contents.emit('destroyed')
  assert.equal(await closing, undefined)
  assert.equal(contents.listenerCount('destroyed'), 0)
  assert.throws(() => openMcpUrl('javascript:alert(1)'), /HTTP/)
  assert.throws(() => openMcpUrl('file:///etc/passwd'), /HTTP/)
  await assert.rejects(openMcpUrl('https://example.invalid/authorize'), { code: 'E_BROWSER_LAUNCH' })
}
if (process.argv.includes('--fixture')) await fixture()
else
  test('extension UI: sender ownership, responses, cancellation, timeout and window teardown', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    assert.equal(code, 0, err || out)
  })

import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionUIEvent } from '../src/shared/api'

async function fixture(): Promise<void> {
  const launchError = Object.assign(new Error('Browser launch failed'), { code: 'E_BROWSER_LAUNCH' })
  mock.module('electron', () => ({ shell: { openExternal: async () => { throw launchError } } }))
  let sdkGate: Promise<void> | undefined
  mock.module(fileURLToPath(new URL('../src/main/mcp/sdk.ts', import.meta.url)), () => ({
    mcpSdk: async () => { await sdkGate; return { theme: {} } }
  }))
  const tracked: Array<{ owner: string; id: string; title: string; options: string[]; reply(option: string): void }> = []
  const retired: string[] = []
  mock.module(fileURLToPath(new URL('../src/main/approval-notification.ts', import.meta.url)), () => ({
    trackApproval: (owner: string, _win: unknown, notice: { id: string; title: string; options: string[]; reply(option: string): void }) => tracked.push({ owner, ...notice }),
    retireApproval: (_owner: string, id: string) => retired.push(id)
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
  assert.equal(contents.listenerCount('destroyed'), 1)
  const signal = new AbortController()
  const selecting = ui.select('Select', ['one', 'two'], { signal: signal.signal })
  signal.abort()
  assert.equal(await selecting, undefined)
  // Permission requests carry their detail through the options object Pi forwards unchanged.
  const approving = ui.select('Allow?', ['once', 'session', 'deny'], { approval: { message: 'write: /x' } } as never)
  const approval = events.at(-1)!
  assert.ok(approval.kind === 'prompt' && approval.approval === true && approval.message === 'write: /x')
  if (approval.kind === 'prompt') replyExtensionUI(sender, approval.id, 'session')
  assert.equal(await approving, 'session')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(approval.kind === 'prompt')
  assert.deepEqual(tracked.map(({ owner, id, title, options }) => ({ owner, id, title, options })), [{ owner: 'session', id: approval.id, title: 'Allow?', options: ['once', 'session', 'deny'] }])
  assert.deepEqual(retired, [approval.id], 'answering in the app retires the notification')
  const fromNotification = ui.select('Allow again?', ['once', 'deny'], { approval: { message: 'write: /y' } } as never)
  await new Promise((resolve) => setTimeout(resolve, 10))
  tracked.at(-1)!.reply('deny')
  assert.equal(await fromNotification, 'deny', 'a notification action answers the request')
  assert.equal(events.at(-1)?.kind, 'dismiss')
  ui.select('Plain', ['a'])
  const plain = events.at(-1)!
  assert.ok(plain.kind === 'prompt' && plain.approval === undefined)
  if (plain.kind === 'prompt') replyExtensionUI(sender, plain.id, null)
  assert.equal(tracked.length, 2, 'ordinary selects never notify')
  const confirm = ui.confirm('Confirm', 'Message')
  const editor = ui.editor('Editor', 'original')
  cancelExtensionUI('session')
  assert.equal(await confirm, false)
  assert.equal(await editor, undefined)
  assert.equal(contents.listenerCount('destroyed'), 1)
  assert.equal(await ui.input('Timeout', '', { timeout: 1 }), undefined)
  const processUI = await createExtensionUI(win, 'session', 'process')
  const extensionPrompt = ui.input('Extension')
  const processPrompt = processUI.input('Process')
  const processRequest = events.at(-1)!
  assert.equal(processRequest.kind === 'prompt' && processRequest.owner, 'session')
  cancelExtensionUI('session', 'extension')
  assert.equal(await extensionPrompt, undefined)
  assert.equal(events.at(-1)?.kind, 'dismiss')
  if (processRequest.kind !== 'prompt') throw new Error('Missing process prompt')
  replyExtensionUI(sender, processRequest.id, 'still pending')
  assert.equal(await processPrompt, 'still pending')
  const processCancelled = processUI.input('Process cancellation')
  const extensionKept = ui.input('Extension kept')
  const keptRequest = events.at(-1)!
  cancelExtensionUI('session', 'process')
  assert.equal(await processCancelled, undefined)
  if (keptRequest.kind !== 'prompt') throw new Error('Missing extension prompt')
  replyExtensionUI(sender, keptRequest.id, 'kept')
  assert.equal(await extensionKept, 'kept')
  const source = { kind: 'subagent' as const, id: 'abcd1234', title: 'Inspect code' }
  const childUI = await createExtensionUI(win, 'session', 'subagent', source)
  const childSignal = new AbortController()
  const childApproval = childUI.select('Child approval', ['once', 'deny'], { signal: childSignal.signal, approval: { message: 'write: /x' } } as never)
  const childRequest = events.at(-1)!
  assert.ok(childRequest.kind === 'prompt' && childRequest.owner === 'session' && childRequest.approval === true)
  if (childRequest.kind !== 'prompt') throw new Error('Missing child approval')
  assert.deepEqual(childRequest.approvalSource, source)
  cancelExtensionUI('session', 'extension')
  assert.equal(events.at(-1), childRequest, 'parent extension reload leaves child approvals open')
  childSignal.abort()
  assert.equal(await childApproval, undefined)
  replyExtensionUI(sender, childRequest.id, 'once')
  assert.deepEqual(events.at(-1), { kind: 'dismiss', id: childRequest.id })
  const allExtension = ui.input('All extension')
  const allProcess = processUI.input('All process')
  const allChild = childUI.select('All child', ['once'])
  cancelExtensionUI('session')
  assert.equal(await allExtension, undefined)
  assert.equal(await allProcess, undefined)
  assert.equal(await allChild, undefined)

  // Electron 44 exposes navigation properties on its typed event object (the positional
  // arguments are deprecated). Child frames and same-document history must leave prompts alone.
  const navigate = (isMainFrame: boolean, isSameDocument: boolean) =>
    contents.emit('did-start-navigation', { url: 'https://pig.invalid/', isMainFrame, isSameDocument, frame: null },
      'https://pig.invalid/', isSameDocument, isMainFrame, 1, 1)
  const preserved = ui.input('Preserved')
  const preservedRequest = events.at(-1)!
  const before = events.length
  navigate(false, false)
  navigate(true, true)
  assert.equal(events.length, before)
  if (preservedRequest.kind !== 'prompt') throw new Error('Missing preserved prompt')
  replyExtensionUI(sender, preservedRequest.id, 'preserved')
  assert.equal(await preserved, 'preserved')

  const reloading = ui.input('Reload')
  const processReloading = processUI.input('Process reload')
  let release!: () => void
  sdkGate = new Promise<void>((resolve) => { release = resolve })
  const creating = createExtensionUI(win, 'pending-create')
  navigate(true, false)
  assert.equal(await reloading, undefined)
  assert.equal(await processReloading, undefined)
  // Register during reload too: it cannot show a prompt until the document is ready.
  release()
  sdkGate = undefined
  assert.equal(await (await createExtensionUI(win, 'during-reload')).input('Not ready'), undefined)
  contents.emit('dom-ready')
  assert.equal(await (await creating).input('Stale context'), undefined)
  const resumed = ui.input('Existing context after reload')
  const resumedRequest = events.at(-1)!
  if (resumedRequest.kind !== 'prompt') throw new Error('Missing resumed prompt')
  replyExtensionUI(sender, resumedRequest.id, 'resumed')
  assert.equal(await resumed, 'resumed')
  const restored = await createExtensionUI(win, 'session')
  const restoredInput = restored.input('Restored')
  const restoredRequest = events.at(-1)!
  if (restoredRequest.kind !== 'prompt') throw new Error('Missing restored prompt')
  replyExtensionUI(sender, restoredRequest.id, 'restored')
  assert.equal(await restoredInput, 'restored')
  const gone = restored.confirm('Gone', 'Renderer crash')
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  assert.equal(await gone, false)
  assert.equal(await (await createExtensionUI(win, 'crashed')).input('Not ready'), undefined)
  contents.emit('dom-ready')
  const recovered = await createExtensionUI(win, 'session')
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(await recovered.input('Already aborted', '', { signal: aborted.signal }), undefined)
  // No prompt adds its own window listeners.
  for (const event of ['destroyed', 'did-start-navigation', 'dom-ready', 'render-process-gone'])
    assert.equal(contents.listenerCount(event), 1)
  const closing = recovered.input('Closing')
  contents.emit('destroyed')
  assert.equal(await closing, undefined)
  assert.equal(await recovered.input('Destroyed'), undefined)
  for (const event of ['destroyed', 'did-start-navigation', 'dom-ready', 'render-process-gone'])
    assert.equal(contents.listenerCount(event), 0)
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

import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionUIEvent } from '../src/shared/api'
import type { ApprovalOptions } from '../src/main/permissions/approval'
import { runSelf } from './helpers/subprocess.ts'

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
  let denialReason: string | undefined
  const denied = ui.select('With reason', ['once', 'deny'], { approval: {
    message: 'write: /z', onDeny: reason => { denialReason = reason }
  } } as ApprovalOptions)
  const denial = events.at(-1)!
  assert.ok(denial.kind === 'prompt')
  replyExtensionUI(sender, denial.id, 'once', 'not an approval')
  replyExtensionUI(sender, denial.id, 'deny', 'x'.repeat(2001))
  replyExtensionUI(sender, denial.id, 'deny', 42 as never)
  replyExtensionUI({} as WebContents, denial.id, 'deny', 'wrong sender')
  assert.equal(events.at(-1), denial, 'invalid reasons, positive choices and foreign senders cannot consume the request')
  assert.equal(denialReason, undefined)
  replyExtensionUI(sender, denial.id, 'deny', '  Wrong target.\nUse the selected directory.  ')
  replyExtensionUI(sender, denial.id, 'once')
  assert.equal(await denied, 'deny', 'a reason never changes denial into permission')
  assert.equal(denialReason, 'Wrong target.\nUse the selected directory.')
  assert.equal(events.at(-1)?.kind, 'dismiss')

  denialReason = undefined
  const cancelledReason = ui.select('Cancelled reason', ['once', 'deny'], { approval: {
    message: 'write: /z', onDeny: reason => { denialReason = reason }
  } } as ApprovalOptions)
  const cancelledReasonRequest = events.at(-1)!
  assert.ok(cancelledReasonRequest.kind === 'prompt')
  cancelExtensionUI('session')
  replyExtensionUI(sender, cancelledReasonRequest.id, 'deny', 'Late reason')
  assert.equal(await cancelledReason, undefined)
  assert.equal(denialReason, undefined)
  ui.select('Plain', ['a'])
  const plain = events.at(-1)!
  assert.ok(plain.kind === 'prompt' && plain.approval === undefined)
  if (plain.kind === 'prompt') {
    replyExtensionUI(sender, plain.id, 'a', 'Not an approval')
    assert.equal(events.at(-1), plain, 'ordinary selects cannot accept a denial reason')
    replyExtensionUI(sender, plain.id, null)
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tracked.length, 4, 'ordinary selects never notify')
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

  const { delegateApprovals } = await import('../src/main/permissions/delegation')
  const { hasPendingApproval } = await import('../src/main/extension-ui')
  const releaseRoute = delegateApprovals('session', { controllerId: 'controller', check() {}, allows: () => false })
  const mirrored = childUI.select('Mirrored child', ['once', 'deny'], { approval: { message: 'write: /mirrored' } } as never)
  const shared = events.at(-1)!
  assert.ok(shared.kind === 'prompt')
  assert.equal(shared.owner, 'session')
  assert.equal(shared.approvalController, 'controller')
  assert.deepEqual(shared.approvalSource, source)
  replyExtensionUI(sender, shared.id, 'invalid choice')
  assert.equal(hasPendingApproval('session'), true, 'invalid replies cannot consume a valid request')
  const beforeShared = events.length
  replyExtensionUI(sender, shared.id, 'once')
  replyExtensionUI(sender, shared.id, 'deny')
  assert.equal(await mirrored, 'once', 'first decision wins in either visible card')
  assert.equal(events.length, beforeShared + 1, 'only one dismiss is emitted')
  assert.equal(hasPendingApproval('session'), false)
  await new Promise(resolve => setTimeout(resolve, 10))
  const staleNotice = tracked.find(item => item.id === shared.id)!
  assert.equal(staleNotice.owner, 'controller')
  staleNotice.reply('deny')
  assert.equal(events.length, beforeShared + 1, 'a late native notification cannot decide twice')
  let mirroredReason: string | undefined
  const mirroredDenial = childUI.select('Mirrored refusal', ['once', 'deny'], { approval: {
    message: 'write: /mirrored', onDeny: reason => { mirroredReason = reason }
  } } as ApprovalOptions)
  const mirroredRequest = events.at(-1)!
  assert.ok(mirroredRequest.kind === 'prompt' && mirroredRequest.approvalController === 'controller')
  replyExtensionUI(sender, mirroredRequest.id, 'deny', 'Ask before modifying shared files.')
  replyExtensionUI(sender, mirroredRequest.id, 'once')
  assert.equal(await mirroredDenial, 'deny')
  assert.equal(mirroredReason, 'Ask before modifying shared files.', 'the controlling pane can explain a target or subagent refusal')
  assert.equal(hasPendingApproval('session'), false)
  const cancelledRoute = childUI.select('Route ends', ['once', 'deny'], { approval: { message: 'x' } } as never)
  const staleRoute = events.at(-1)!
  assert.ok(staleRoute.kind === 'prompt')
  releaseRoute()
  assert.equal(await cancelledRoute, undefined)
  replyExtensionUI(sender, staleRoute.id, 'once')
  const releaseNext = delegateApprovals('session', { controllerId: 'controller', check() {}, allows: () => false })
  const controllerClosed = childUI.select('Controller closes', ['once', 'deny'], { approval: { message: 'x' } } as never)
  cancelExtensionUI('controller', 'extension')
  assert.equal(hasPendingApproval('session'), true, 'controller extension reload does not cancel target child approvals')
  cancelExtensionUI('controller')
  assert.equal(await controllerClosed, undefined)
  releaseNext()

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
    const { exitCode: code, stdout: out, stderr: err } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 25_000 })
    assert.equal(code, 0, err || out)
  })

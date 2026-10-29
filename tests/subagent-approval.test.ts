import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionUIEvent } from '../src/shared/api'

async function fixture() {
  mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
  let gate: Promise<void> | undefined
  mock.module(fileURLToPath(new URL('../src/main/mcp/sdk.ts', import.meta.url)), () => ({
    mcpSdk: async () => { await gate; return { theme: {} } }, privateJson: () => {}
  }))
  const { subagentApprovalUI } = await import('../src/main/subagents/approval')
  const { replyExtensionUI, cancelExtensionUI } = await import('../src/main/extension-ui')
  const { approve } = await import('../src/main/permissions/approval')
  const { forgetSessionGrants, hasSessionGrant } = await import('../src/main/permissions/grants')
  const events: ExtensionUIEvent[] = []
  const sender = Object.assign(new EventEmitter(), {
    send: (_channel: string, event: ExtensionUIEvent) => events.push(event),
    isDestroyed: () => false
  })
  const win = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow
  let parent: { win?: BrowserWindow } | undefined = { win }
  const find = () => parent
  const firstLife = new AbortController()
  const secondLife = new AbortController()
  const first = subagentApprovalUI({ id: '11111111', title: 'First\u202e child', parentSessionId: 'parent', signal: firstLife.signal }, find)
  const second = subagentApprovalUI({ id: '22222222', title: 'Second', parentSessionId: 'parent', signal: secondLife.signal }, find)
  const pending1 = approve(first, 'parent', ['file:write:/one'], 'First?', '/one', firstLife.signal)
  const pending2 = approve(second, 'parent', ['file:write:/two'], 'Second?', '/two', secondLife.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const requests = events.filter((event): event is Extract<ExtensionUIEvent, { kind: 'prompt' }> => event.kind === 'prompt')
  assert.equal(requests.length, 2)
  assert.equal(requests[0]!.owner, 'parent')
  assert.deepEqual(requests[0]!.approvalSource, { kind: 'subagent', id: '11111111', title: 'First\\u202e child' })
  assert.equal(requests[1]!.approvalSource?.id, '22222222')
  cancelExtensionUI('parent', 'extension')
  assert.equal(events.filter(event => event.kind === 'dismiss').length, 0)
  firstLife.abort(new Error('child stopped'))
  await assert.rejects(pending1, /child stopped/)
  replyExtensionUI(sender as unknown as WebContents, requests[0]!.id, requests[0]!.options![1]!)
  assert.equal(hasSessionGrant('parent', ['file:write:/one']), false)
  replyExtensionUI(sender as unknown as WebContents, requests[1]!.id, requests[1]!.options![1]!)
  await pending2
  assert.equal(hasSessionGrant('parent', ['file:write:/two']), true)
  await assert.rejects(approve(second, 'parent', ['file:write:/two'], 'Again?', '', firstLife.signal), /child stopped/)

  const third = subagentApprovalUI({ id: '33333333', title: 'Third', parentSessionId: 'parent' }, find)
  const late = approve(third, 'parent', ['file:write:/three'], 'Third?', '/three')
  await new Promise(resolve => setTimeout(resolve, 0))
  const request = events.findLast((event): event is Extract<ExtensionUIEvent, { kind: 'prompt' }> => event.kind === 'prompt')!
  parent = { win } // Reopening the same ID in the same window is a different session instance.
  replyExtensionUI(sender as unknown as WebContents, request.id, request.options![1]!)
  await assert.rejects(late, /no longer open/)
  assert.equal(hasSessionGrant('parent', ['file:write:/three']), false)

  let release!: () => void
  gate = new Promise<void>((resolve) => { release = resolve })
  const delayedLife = new AbortController()
  const delayed = subagentApprovalUI({ id: '44444444', title: 'Delayed', parentSessionId: 'parent', signal: delayedLife.signal }, find)
  const count = events.length
  const delayedCall = delayed.select('Delayed?', ['once'], { signal: delayedLife.signal })
  delayedLife.abort(new Error('stopped during setup'))
  release()
  await assert.rejects(delayedCall, /stopped during setup/)
  assert.equal(events.length, count)
  parent = undefined
  await assert.rejects(third.select('No parent?', ['once']), /no longer open/)
  forgetSessionGrants('parent')
}

if (process.argv.includes('--fixture')) await fixture()
else test('subagent approvals are owned by the parent, isolated and invalidated by child or parent lifecycle', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally { clearTimeout(timeout) }
}, 15_000)

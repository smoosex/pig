/** Keep React, module mocks and happy-dom isolated from the other test workers. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'

const flag = '--approval-prompt-fixture'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: Parameters<typeof translate>[1]) => translate('en', key) }))
  const replies: Array<[string, string | null]> = []
  mock.module('../src/renderer/src/ipc/api', () => ({ api: { replyExtensionUI: async (id: string, value: string | null) => { replies.push([id, value]) } } }))
  // The card ignores keys briefly after taking focus; tests advance this clock past that window.
  let now = 0
  performance.now = () => now
  const { useExtensionPrompts } = await import('../src/renderer/src/stores/extension-prompts')
  const { ApprovalPrompt } = await import('../src/renderer/src/components/composer/ApprovalPrompt')

  const options = ['Allow once', 'Allow for this session', 'Deny']
  const add = (id: string, owner = 'one', approval = true) => act(() => useExtensionPrompts.getState().add({
    kind: 'prompt', id, owner, method: 'select', title: 'Allow writing this path?', message: 'write: /tmp/x', options,
    ...(approval ? { approval: true as const } : {})
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(ApprovalPrompt, { sessionId: 'one' })))
  const card = () => container.querySelector<HTMLFormElement>('[data-approval-prompt]')
  const key = (target: Element, value: string) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })

  // Dialog prompts and other sessions' approvals are not this composer's.
  await add('plain', 'one', false)
  await add('foreign', 'two')
  assert.equal(card(), null)

  await add('by-key')
  assert.ok(card()?.textContent?.includes('write: /tmp/x'))
  const labels = [...card()!.querySelectorAll('label')].map((label) => label.textContent)
  assert.deepEqual(labels, ['1Allow once', '2Allow for this session', '3Deny'])
  // The first choice takes focus so number keys work without clicking.
  assert.equal(document.activeElement?.getAttribute('type'), 'radio')
  // A digit or Enter still being typed into the draft when the card appears is not an answer.
  await key(card()!.querySelector('input')!, '2')
  await key(card()!.querySelector('input')!, 'Enter')
  assert.deepEqual(replies, [])
  now += 1000
  await key(card()!.querySelector('input')!, 'ArrowDown')
  assert.deepEqual(replies, [])
  await key(card()!.querySelector('input')!, '2')
  await key(card()?.querySelector('input') ?? document.body, '2')
  assert.deepEqual(replies, [['by-key', 'Allow for this session']])

  await add('by-escape')
  now += 1000
  await key(card()!.querySelector('input')!, 'Escape')
  assert.deepEqual(replies.at(-1), ['by-escape', 'Deny'])

  await add('by-click')
  // A keyboard-driven click (detail 0) only selects; a mouse click answers.
  await act(() => { card()!.querySelectorAll('label')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })) })
  assert.equal(replies.at(-1)?.[0], 'by-escape')
  await act(() => { card()!.querySelectorAll('label')[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
  assert.deepEqual(replies.at(-1), ['by-click', 'Allow once'])
  assert.equal(card(), null)
  assert.deepEqual(useExtensionPrompts.getState().prompts.map((prompt) => prompt.id), ['plain', 'foreign'])
  // A pane that is not active shows the card but leaves the keyboard alone until it becomes active.
  const outside = document.createElement('button')
  document.body.append(outside)
  outside.focus()
  await act(async () => root.render(h(ApprovalPrompt, { sessionId: 'one', autoFocus: false })))
  await add('background')
  assert.equal(document.activeElement, outside)
  await act(async () => root.render(h(ApprovalPrompt, { sessionId: 'one', autoFocus: true })))
  assert.equal(document.activeElement?.getAttribute('type'), 'radio')
  // Taking focus later re-arms the guard.
  await key(document.activeElement!, '1')
  assert.notDeepEqual(replies.at(-1)?.[0], 'background')
  now += 1000
  await key(document.activeElement!, '1')
  assert.deepEqual(replies.at(-1), ['background', 'Allow once'])
  await act(async () => root.unmount())
}

if (process.argv.includes(flag)) {
  await fixture()
} else {
  test('permission approvals render above their own composer and answer by number, mouse click or Esc', async () => {
    const child = Bun.spawn([process.execPath, import.meta.filename, flag], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timer) }
  }, 15_000)
}

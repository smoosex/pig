/** Keep React, module mocks and happy-dom isolated from the other test workers. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'

const flag = '--approval-prompt-fixture'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  class GeometryResizeObserver {
    static instances = new Set<GeometryResizeObserver>()
    private targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) { GeometryResizeObserver.instances.add(this) }
    observe(target: Element) { this.targets.add(target) }
    disconnect() { this.targets.clear(); GeometryResizeObserver.instances.delete(this) }
    static notify(target: Element) {
      for (const observer of this.instances) {
        if (observer.targets.has(target)) observer.callback([], observer as unknown as ResizeObserver)
      }
    }
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: GeometryResizeObserver })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params) }))
  const replies: Array<[string, string | null]> = []
  mock.module('../src/renderer/src/ipc/api', () => ({ api: { replyExtensionUI: async (id: string, value: string | null) => { replies.push([id, value]) } } }))
  // The card ignores keys briefly after taking focus; tests advance this clock past that window.
  let now = 0
  performance.now = () => now
  const { useExtensionPrompts } = await import('../src/renderer/src/stores/extension-prompts')
  const { ApprovalPrompt } = await import('../src/renderer/src/components/composer/ApprovalPrompt')

  const options = ['Allow once', 'Allow for this session', 'Deny']
  const add = (id: string, owner = 'one', approval = true, message = 'write: /tmp/x') => act(() => useExtensionPrompts.getState().add({
    kind: 'prompt', id, owner, method: 'select', title: 'Allow writing this path?', message, options,
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
  assert.equal(card()?.querySelector('[aria-label="Approval details"]')?.getAttribute('tabindex'), null)
  assert.equal(card()?.textContent?.includes('More details'), false)
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

  // Enter confirms the highlighted choice, including the initially focused one that is not checked.
  await add('by-enter')
  now += 1000
  await key(document.activeElement!, 'Enter')
  assert.deepEqual(replies.at(-1), ['by-enter', 'Allow once'])
  await add('by-focus-enter')
  now += 1000
  const second = card()!.querySelectorAll('input')[1]!
  await act(() => second.focus())
  await key(second, 'Enter')
  assert.deepEqual(replies.at(-1), ['by-focus-enter', 'Allow for this session'])

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

  await act(() => useExtensionPrompts.getState().add({
    kind: 'prompt', id: 'child', owner: 'one', method: 'select', title: 'Allow writing?',
    message: 'write: /tmp/child', options, approval: true,
    approvalSource: { kind: 'subagent', id: 'abcd1234', title: 'Inspect code' }
  }))
  assert.ok(card()?.querySelector('[data-approval-source]')?.textContent?.includes('Inspect code (abcd1234)'))
  assert.ok(card()?.querySelector('[data-approval-source]')?.textContent?.includes('shared with the main agent'))
  now += 1000
  await key(card()!.querySelector('input')!, 'Escape')
  assert.deepEqual(replies.at(-1), ['child', 'Deny'])

  const input = `${'a'.repeat(3000)}; dangerous-tail`
  const message = translate('en', 'permissions.terminalMessage', { terminal: 'terminal:1', detail: 'Type text', input })
  await add('long', 'one', true, message)
  const details = card()!.querySelector<HTMLElement>('[aria-label="Approval details"]')!
  const content = details.querySelector('p')!
  assert.equal(details.textContent, message)
  assert.ok(details.closest('fieldset')?.getAttribute('aria-describedby')?.split(' ').includes(content.id))
  assert.equal(content.getAttribute('aria-label'), null)
  assert.ok(details.classList.contains('overflow-y-auto'))
  assert.ok(!details.className.includes('scrollbar-width:none'))
  assert.ok(!details.className.includes('scrollbar]:hidden'))
  let scrollHeight = 600
  Object.defineProperties(details, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => 160 }
  })
  await act(() => GeometryResizeObserver.notify(content))
  const hint = document.getElementById(details.getAttribute('aria-describedby')!)
  assert.ok(hint?.textContent?.includes('More details'))
  assert.equal(details.tabIndex, 0)
  scrollHeight = 100
  await act(() => GeometryResizeObserver.notify(details))
  assert.equal(details.hasAttribute('tabindex'), false)
  assert.equal(card()?.textContent?.includes('More details'), false)
  scrollHeight = 600
  await act(() => GeometryResizeObserver.notify(content))
  await act(() => details.focus())
  assert.equal(document.activeElement, details)
  now += 1000
  for (const value of ['ArrowDown', 'PageDown', 'End']) {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    await act(() => details.dispatchEvent(event))
    assert.equal(event.defaultPrevented, false, `${value} must remain available for scrolling`)
  }
  assert.deepEqual(replies.at(-1), ['child', 'Deny'])
  await key(details, 'Escape')
  assert.deepEqual(replies.at(-1), ['long', 'Deny'])
  assert.equal(GeometryResizeObserver.instances.size, 0)
  await act(async () => root.unmount())
}

if (process.argv.includes(flag)) {
  await fixture()
} else {
  test('terminal warnings precede arbitrarily long input in both locales', () => {
    for (const [locale, warning] of [['en', 'This terminal is not sandboxed'], ['zh-CN', '终端不在沙箱中']] as const) {
      const input = `${'x'.repeat(3000)}; dangerous-tail`
      const message = translate(locale, 'permissions.terminalMessage', { terminal: 'terminal:1', detail: 'type', input })
      assert.ok(message.indexOf(warning) >= 0 && message.indexOf(warning) < message.indexOf(input))
      assert.ok(message.endsWith(input))
    }
  })
  test('permission approvals render above their own composer, expose overflow and answer by number, mouse click or Esc', async () => {
    const child = Bun.spawn([process.execPath, import.meta.filename, flag], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timer) }
  }, 15_000)
}

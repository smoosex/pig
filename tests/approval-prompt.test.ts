/** Keep React, module mocks and happy-dom isolated from the other test workers. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'
import { runSelf } from './helpers/subprocess.ts'

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
  const replies: Array<[string, string | null, string?]> = []
  mock.module('../src/renderer/src/ipc/api', () => ({ api: { replyExtensionUI: async (id: string, value: string | null, reason?: string) => { replies.push(reason === undefined ? [id, value] : [id, value, reason]) } } }))
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
  assert.deepEqual(labels, ['1Allow once', '2Allow for this session', '3Deny', '4Deny with a reason…'])
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
  const openReason = () => act(() => {
    const row = [...card()!.querySelectorAll('label')].find(item => item.textContent === '4Deny with a reason…')!
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
  })
  await add('reason')
  const beforeReason = replies.length
  now += 1000
  await key(document.activeElement!, '4')
  const reasonInput = card()!.querySelector<HTMLTextAreaElement>('textarea')!
  assert.equal(document.activeElement, reasonInput)
  assert.equal(reasonInput.maxLength, 2000)
  assert.equal(reasonInput.getAttribute('rows'), '1')
  assert.equal(card()!.querySelector('button'), null, 'reason submission has no confirmation button')
  for (const name of ['max-h-12', 'min-h-6', 'field-sizing-content', 'overflow-y-auto', 'resize-none', 'border-b', 'border-glass-border', 'bg-glass-prompt-foreground/6', 'solid:bg-input/30', 'focus-visible:ring-0', '[scrollbar-width:none]', '[&::-webkit-scrollbar]:hidden']) {
    assert.ok(reasonInput.classList.contains(name), name)
  }
  assert.equal(card()!.querySelectorAll('input[type="radio"]').length, 4, 'all four options stay visible while entering a reason')
  assert.equal(replies.length, beforeReason, 'opening the editor does not decide the approval')
  await act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(reasonInput, '  Wrong directory.\nCheck target 123 first.  ')
    reasonInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  now += 1000
  for (const value of ['1', '3', ' ']) {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    await act(() => reasonInput.dispatchEvent(event))
    assert.equal(event.defaultPrevented, false, 'normal text must work in the reason')
  }
  const newline = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
  await act(() => reasonInput.dispatchEvent(newline))
  assert.equal(newline.defaultPrevented, false, 'Shift+Enter inserts a new line instead of submitting')
  await act(() => reasonInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  await act(() => reasonInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })))
  assert.equal(replies.length, beforeReason, 'typing and IME must never select an approval')
  await key(reasonInput, 'Escape')
  assert.equal(replies.length, beforeReason, 'Esc returns to the choices without submitting a partial reason')
  assert.equal(card()?.querySelector<HTMLInputElement>('input:focus')?.value, 'Deny', 'returning focuses denial, not allow')
  await openReason()
  assert.equal(card()!.querySelector<HTMLTextAreaElement>('textarea')!.value, '  Wrong directory.\nCheck target 123 first.  ')
  await key(document.activeElement!, 'Enter')
  assert.deepEqual(replies.at(-1), ['reason', 'Deny', 'Wrong directory.\nCheck target 123 first.'])
  assert.equal(card(), null)

  await add('empty-reason')
  await openReason()
  assert.equal(card()!.querySelector<HTMLTextAreaElement>('textarea')!.value, '', 'new approvals never inherit the previous reason')
  await key(document.activeElement!, 'Enter')
  assert.deepEqual(replies.at(-1), ['empty-reason', 'Deny'], 'a reason is optional')

  await act(() => useExtensionPrompts.getState().add({
    kind: 'prompt', id: 'two-options', owner: 'one', method: 'select',
    title: 'Allow once?', options: ['Allow once', 'Deny'], approval: true
  }))
  assert.deepEqual([...card()!.querySelectorAll('label')].map(item => item.textContent), ['1Allow once', '2Deny', '3Deny with a reason…'])
  now += 1000
  await key(document.activeElement!, '3')
  assert.ok(card()!.querySelector('textarea'))
  await key(document.activeElement!, 'Escape')
  now += 1000
  await key(document.activeElement!, 'Escape')
  assert.deepEqual(replies.at(-1), ['two-options', 'Deny'], 'Esc still submits the original denial, never the extra UI option')

  await add('cancel-editing')
  await openReason()
  const beforeCancel = replies.length
  await act(() => useExtensionPrompts.getState().remove('cancel-editing'))
  assert.equal(card(), null)
  assert.equal(replies.length, beforeCancel, 'cancelled approvals cannot submit their draft reason')
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
  await act(() => useExtensionPrompts.getState().add({
    kind: 'prompt', id: 'mirrored', owner: 'controlled', approvalController: 'one',
    method: 'select', title: 'Shared approval', message: 'write: /tmp/shared', options, approval: true
  }))
  await act(async () => root.render(h('div', {},
    h(ApprovalPrompt, { sessionId: 'one', autoFocus: false }),
    h(ApprovalPrompt, { sessionId: 'controlled', autoFocus: false })
  )))
  assert.equal(container.querySelectorAll('[data-approval-prompt]').length, 2)
  assert.ok(container.querySelector('[data-approval-session]')?.textContent?.includes('controlled'))
  const cards = container.querySelectorAll('[data-approval-prompt]')
  const replyCount = replies.length
  await act(() => {
    cards[1]!.querySelector('label')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    cards[0]!.querySelector('label')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
  })
  assert.equal(replies.length, replyCount + 1, 'two simultaneous pane clicks submit just once')
  assert.equal(container.querySelectorAll('[data-approval-prompt]').length, 0)
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
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, [flag], { timeoutMs: 10_000 })
    assert.equal(code, 0, stderr || stdout)
  }, 15_000)
}

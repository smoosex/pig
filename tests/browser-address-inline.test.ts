/** Inline completion in the address bar: selection after the caret, typing through it, Esc and Enter. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BrowserHistoryEntry } from '../src/shared/browser'

test('typed pages complete inline and Enter opens their real URL', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: string) => key }))
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    observe() {} unobserve() {} disconnect() {}
  } })
  const entry = (url: string, typedCount: number): BrowserHistoryEntry => ({ url, title: '', visitCount: 1, typedCount, lastVisitAt: 1 })
  const queries: string[] = []
  let delayResults = false
  const pending: Array<(entries: BrowserHistoryEntry[]) => void> = []
  const entries = [entry('https://gitlab.com/', 0), entry('http://git.internal:8080/', 2)]
  Object.defineProperty(window, 'api', { configurable: true, value: { browser: {
    queryHistory: async (text: string) => {
      queries.push(text)
      return delayResults ? new Promise<BrowserHistoryEntry[]>((resolve) => pending.push(resolve)) : entries
    },
    removeHistory: async () => {}
  } } })
  const { act, createElement, useRef, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BrowserAddressInput } = await import('../src/renderer/src/components/browser/BrowserAddressInput')
  const picked: string[] = []
  let current = ''
  function Harness() {
    const [value, setValue] = useState('')
    const composing = useRef(false)
    current = value
    return createElement(BrowserAddressInput, { value, onValueChange: setValue, onPick: (url: string) => { picked.push(url) }, composing })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(Harness)) })
  const input = container.querySelector('input')!
  const key = async (name: string) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    await act(async () => { input.dispatchEvent(event) })
    return event
  }
  const input_ = async (value: string, inputType: string, wait = true) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.setSelectionRange(value.length, value.length)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }))
      if (wait) await new Promise((resolve) => setTimeout(resolve, 150))
    })
  }
  const settle = async () => {
    assert.equal(pending.length, 1, 'one query is waiting for its result')
    await act(async () => { pending.shift()!(entries) })
  }
  const selected = () => input.value.slice(input.selectionStart!, input.selectionEnd!)
  const labels = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)

  await act(async () => { input.focus() })
  await input_('gi', 'insertText')
  assert.equal(current, 'git.internal:8080', 'only the typed page completes, ahead of a more highly ranked one')
  assert.equal(selected(), 't.internal:8080')
  assert.equal(labels()[0], 'http://git.internal:8080/', 'the completed page leads the list')

  const before = queries.length
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'git')
    input.setSelectionRange(3, 3)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })
  assert.equal(current, 'git.internal:8080', 'typing what is selected keeps the completion without waiting for a query')
  assert.equal(selected(), '.internal:8080')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
  assert.equal(queries.length, before + 1)

  assert.equal((await key('Escape')).defaultPrevented, true)
  assert.equal(current, 'git', 'the first Esc drops only the completion')
  assert.equal(labels().length, 2, 'the first Esc keeps the suggestions open')

  // A kept completion can have another query queued before its debounce fires.
  await input_('gi', 'insertText')
  const queuedBefore = queries.length
  await input_('git', 'insertText', false)
  await key('Escape')
  assert.equal(current, 'git')
  assert.equal(labels().length, 2)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
  assert.equal(queries.length, queuedBefore, 'Esc invalidates a queued completion query')
  assert.equal(current, 'git')

  await input_('gi', 'insertText')
  delayResults = true
  await input_('git', 'insertText')
  await key('Escape')
  assert.equal(current, 'git')
  assert.equal(labels().length, 2)
  await settle()
  assert.equal(current, 'git', 'a late result cannot restore the cancelled completion')
  assert.equal(selected(), '')

  await input_('git.', 'insertText')
  await key('Escape')
  assert.equal(labels().length, 0, 'Esc without a completion closes the list')
  await settle()
  assert.equal(current, 'git.')
  assert.equal(labels().length, 0, 'a late result cannot reopen the dismissed list')

  await input_('git', 'insertText')
  await key('Escape')
  await settle()
  assert.equal(current, 'git', 'Esc also invalidates queries before any list is open')
  assert.equal(labels().length, 0)

  delayResults = false
  await input_('git.', 'insertText')
  await input_('git', 'deleteContentBackward')
  assert.equal(current, 'git', 'deleting never completes')

  await input_('git.', 'insertText')
  assert.equal(current, 'git.internal:8080')
  const enter = await key('Enter')
  assert.equal(enter.defaultPrevented, true)
  assert.deepEqual(picked, ['http://git.internal:8080/'], 'Enter keeps the page\'s own scheme and port')

  await act(async () => { root.unmount() })
  await GlobalRegistrator.unregister()
})

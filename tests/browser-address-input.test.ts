/** Address bar history suggestions in happy-dom: keyboard selection, removal and restoring typed text. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BrowserHistoryEntry } from '../src/shared/browser'

test('history suggestions follow the keyboard without stealing focus or the typed text', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: string) => key }))
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    observe() {} unobserve() {} disconnect() {}
  } })
  const entry = (url: string, title: string): BrowserHistoryEntry => ({ url, title, visitCount: 1, typedCount: 0, lastVisitAt: 1 })
  const queries: string[] = []
  const removed: string[] = []
  Object.defineProperty(window, 'api', { configurable: true, value: { browser: {
    queryHistory: async (text: string) => {
      queries.push(text)
      return [entry('https://github.com/', 'GitHub'), entry('https://gitlab.com/', '')]
    },
    removeHistory: async (url: string) => { removed.push(url) }
  } } })
  const { act, createElement, useRef, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BrowserAddressInput } = await import('../src/renderer/src/components/browser/BrowserAddressInput')
  const picked: string[] = []
  let current = ''
  function Harness() {
    const [value, setValue] = useState('https://page.test/')
    const composing = useRef(false)
    current = value
    return createElement(BrowserAddressInput, { value, onValueChange: setValue, onPick: (url: string) => { picked.push(url) }, composing })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(Harness)) })
  const input = container.querySelector('input')!
  const options = () => [...document.querySelectorAll('[role="option"]')]
  const key = async (name: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })
    await act(async () => { input.dispatchEvent(event) })
    return event
  }
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
  }

  await act(async () => { input.focus() })
  assert.equal(options().length, 0, 'the page URL alone queries nothing')
  await type('git')
  assert.deepEqual(queries, ['git'])
  assert.equal(options().length, 2)
  assert.equal(input.getAttribute('aria-expanded'), 'true')
  assert.equal(document.activeElement, input, 'opening the list keeps focus in the field')
  assert.equal(options().some((option) => option.getAttribute('aria-selected') === 'true'), false, 'Enter opens the typed text by default')

  await key('ArrowDown')
  assert.equal(current, 'https://github.com/')
  assert.equal(options()[0]!.getAttribute('aria-selected'), 'true')
  await key('ArrowUp')
  assert.equal(current, 'git', 'stepping above the first suggestion returns to the typed text')
  await key('ArrowUp')
  assert.equal(current, 'https://gitlab.com/', 'selection wraps')

  assert.equal((await key('Delete', { shiftKey: true })).defaultPrevented, true)
  assert.deepEqual(removed, ['https://gitlab.com/'])
  assert.equal(options().length, 1)
  assert.equal(current, 'https://github.com/', 'the neighbour takes the removed slot')

  await key('Escape')
  assert.equal(current, 'git')
  assert.equal(options().length, 0)

  await type('gith')
  await act(async () => { (options()[0] as HTMLElement).click() })
  assert.deepEqual(picked, ['https://github.com/'])
  assert.equal(current, 'https://github.com/')
  assert.equal(options().length, 0)

  await act(async () => { input.focus() })
  await type('git')
  await act(async () => { input.dispatchEvent(new Event('compositionstart', { bubbles: true })) })
  await key('ArrowDown', { isComposing: true })
  assert.equal(current, 'git', 'IME composition keeps its own arrow keys')
  await act(async () => { input.dispatchEvent(new Event('compositionend', { bubbles: true })) })
  await key('Enter')
  assert.equal(options().length, 0, 'submitting closes the list')

  await act(async () => { root.unmount() })
  await GlobalRegistrator.unregister()
})

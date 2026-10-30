/** History dialog in happy-dom: day groups, search, paging, removal, pause, clear and live refresh. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BrowserHistoryCursor, BrowserHistoryEntry, BrowserHistoryPage } from '../src/shared/browser'

test('the history dialog reads pages from main and keeps them current', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: string) => key }))
  const now = Date.now()
  const entry = (url: string, title: string, lastVisitAt: number): BrowserHistoryEntry => ({ url, title, visitCount: 1, typedCount: 0, lastVisitAt })
  let rows = [
    entry('https://today.test/', 'Today page', now),
    entry('https://yesterday.test/', '', now - 24 * 60 * 60 * 1000),
    entry('https://old.test/', 'Old page', now - 10 * 24 * 60 * 60 * 1000)
  ]
  const calls: unknown[][] = []
  let recording = true
  let changed = () => {}
  const list = async (text: string, cursor: BrowserHistoryCursor | null, limit = 50): Promise<BrowserHistoryPage> => {
    calls.push(['list', text, cursor, limit])
    const matches = rows.filter((row) => row.url.includes(text) || row.title.toLowerCase().includes(text))
    const start = cursor ? matches.findIndex((row) => row.url === cursor.url) + 1 : 0
    const page = matches.slice(start, start + 2)
    const last = page.at(-1)
    return { entries: page, next: start + 2 < matches.length && last ? { lastVisitAt: last.lastVisitAt, url: last.url } : null }
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { browser: {
    listHistory: (text: string, cursor: BrowserHistoryCursor | null) => list(text, cursor, 2),
    removeHistory: async (url: string) => { calls.push(['remove', url]); rows = rows.filter((row) => row.url !== url) },
    clearHistory: async () => { calls.push(['clear']); rows = [] },
    getHistoryRecording: async () => recording,
    setHistoryRecording: async (enabled: boolean) => { calls.push(['recording', enabled]); recording = enabled },
    onHistoryChanged: (listener: () => void) => { changed = listener; return () => { changed = () => {} } }
  } } })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BrowserHistoryDialog } = await import('../src/renderer/src/components/browser/BrowserHistoryDialog')
  const opened: string[] = []
  let open = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async () => {
    await act(async () => {
      root.render(createElement(BrowserHistoryDialog, { open, onOpenChange: (next: boolean) => { open = next }, onOpenUrl: (url: string) => { opened.push(url) } }))
    })
    await settle()
  }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) }) }
  const dialog = () => document.querySelector('[role="dialog"]')!
  const urls = () => [...dialog().querySelectorAll('li button[title^="https"]')].map((button) => button.getAttribute('title'))
  const button = (label: string) => [...dialog().querySelectorAll('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label) as HTMLButtonElement

  await render()
  assert.deepEqual([...dialog().querySelectorAll('h3')].map((heading) => heading.textContent), ['browser.historyToday', 'browser.historyYesterday'])
  assert.deepEqual(urls(), ['https://today.test/', 'https://yesterday.test/'])
  assert.ok(dialog().textContent!.includes('yesterday.test'), 'an untitled page shows its URL')

  await act(async () => { button('browser.historyMore').click() })
  await settle()
  assert.deepEqual(urls(), ['https://today.test/', 'https://yesterday.test/', 'https://old.test/'])
  assert.equal(dialog().querySelectorAll('h3').length, 3, 'older days are labelled by date')
  assert.equal(button('browser.historyMore'), undefined)

  const search = dialog().querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'old')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
  assert.deepEqual(urls(), ['https://old.test/'])
  assert.deepEqual(calls.filter(([kind]) => kind === 'list').at(-1), ['list', 'old', null, 2])

  await act(async () => { button('browser.historyRemove').click() })
  await settle()
  assert.deepEqual(calls.at(-1), ['remove', 'https://old.test/'])
  assert.ok(dialog().textContent!.includes('browser.historyNoMatches'))

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
  rows = [entry('https://new.test/', 'Fresh', now + 1), ...rows]
  await act(async () => { changed() })
  await settle()
  assert.equal(urls()[0], 'https://new.test/', 'another tab browsing refreshes the open list')

  await act(async () => { (dialog().querySelector('[role="switch"]') as HTMLButtonElement).click() })
  await settle()
  assert.deepEqual(calls.filter(([kind]) => kind === 'recording'), [['recording', false]])
  assert.ok(dialog().textContent!.includes('browser.historyPaused'))

  await act(async () => { button('browser.historyClear').click() })
  assert.equal(dialog().querySelector('h2')?.textContent, 'browser.historyConfirmClear')
  assert.ok(!calls.some(([kind]) => kind === 'clear'), 'clearing waits for confirmation')
  await act(async () => { button('browser.historyClear').click() })
  await settle()
  assert.ok(calls.some(([kind]) => kind === 'clear'))
  await act(async () => { changed() })
  await settle()
  assert.ok(dialog().textContent!.includes('browser.historyEmpty'))

  rows = [entry('https://again.test/', 'Again', now)]
  await act(async () => { changed() })
  await settle()
  await act(async () => { (dialog().querySelector('li button[title^="https"]') as HTMLButtonElement).click() })
  assert.deepEqual(opened, ['https://again.test/'])
  assert.equal(open, false, 'opening a page closes the dialog')

  await act(async () => { root.unmount() })
  await GlobalRegistrator.unregister()
})

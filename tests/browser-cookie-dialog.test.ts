/** Isolated DOM fixture: metadata-only mocks never touch browsers, files or Keychain. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BrowserApi, BrowserCookiePreview, BrowserCookieSources } from '../src/shared/browser'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: string, params?: unknown) => key + (params ? JSON.stringify(params) : '') }))
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const skips = { expired: 2, partitioned: 3, unsupported: 4 }
  const data = (count = 5): BrowserCookiePreview => ({ site: 'example.com', count, domains: [{ domain: '.example.com', count }], skipped: skips })
  let site: string | null = 'example.com'
  let listFail = false
  let permissionFail = false
  let delayPreview = false
  let delayList = false
  let previewResolve!: (value: BrowserCookiePreview) => void
  let listResolve!: (value: BrowserCookieSources) => void
  let importResolve: (() => void) | null = null
  let refreshFail = false
  let refreshes = 0
  const previews: string[] = []
  const imports: unknown[][] = []
  const clears: unknown[][] = []
  const metadata = (): BrowserCookieSources => ({ supported: true, site, sources: [{ id: 'default', browser: 'chrome', name: 'Default profile' }, { id: 'chrome', browser: 'chrome', name: 'Chrome profile' }] })
  const browser = {
    listCookieSources: async () => {
      if (delayList) return new Promise<BrowserCookieSources>((resolve) => { listResolve = resolve })
      if (listFail) throw new Error('sources unavailable')
      return metadata()
    },
    previewCookies: async (_id, source, scope) => {
      previews.push(`${source}:${scope}`)
      if (delayPreview) return new Promise<BrowserCookiePreview>((resolve) => { previewResolve = resolve })
      if (permissionFail) throw new Error('Chrome: Keychain access denied')
      return data()
    },
    importCookies: async (...args) => {
      imports.push(args)
      if (importResolve) await new Promise<void>((resolve) => { importResolve = resolve })
      return { imported: 2, failed: 1, skipped: skips }
    },
    clearSiteCookies: async (...args) => { clears.push(args); return { removed: 3, failed: 1 } }
  } satisfies Pick<BrowserApi, 'listCookieSources' | 'previewCookies' | 'importCookies' | 'clearSiteCookies'>
  Object.defineProperty(window, 'api', { configurable: true, value: { browser } })
  const { CookieImportDialog } = await import('../src/renderer/src/components/browser/CookieImportDialog')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let open = true
  let url = 'https://example.com/'
  const changed = async () => { refreshes++; if (refreshFail) throw new Error('reload unavailable') }
  const render = async () => {
    await act(async () => { root.render(createElement(CookieImportDialog, { browserId: 'browser:a', url, open, onOpenChange: (next) => { open = next }, onChanged: changed })) })
  }
  const button = (key: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === `browser.${key}`)!
  const click = async (key: string) => {
    assert.ok(button(key), key)
    await act(async () => { button(key).click() })
  }
  const reopen = async () => { open = false; await render(); open = true; await render() }
  const text = () => document.body.textContent ?? ''

  await render()
  assert.ok(document.querySelector('[role="dialog"]'))
  assert.equal(previews.at(-1), 'default:site', 'each open defaults to current site')
  assert.ok(text().includes('.example.com'))
  assert.ok(!button('cookieImportAction').disabled)
  await click('cookieImportAction')
  assert.deepEqual(imports[0], ['browser:a', 'default', 'site', 'example.com'])
  assert.equal(refreshes, 1)
  assert.ok(text().includes('browser.cookiePartial'))
  assert.ok(text().includes('"imported":2,"failed":1,"expired":2,"partitioned":3,"unsupported":4'))

  await reopen()
  await click('cookieAll')
  assert.equal(previews.at(-1), 'default:all')
  await click('cookieImportAction')
  assert.ok(text().includes('browser.cookieConfirmAll'))
  assert.equal(imports.length, 1, 'all scope requires separate confirmation')
  await click('cancel')
  await click('cookieImportAction')
  refreshFail = true
  importResolve = () => {}
  await click('cookieConfirm')
  assert.ok(text().includes('browser.cookieImporting'))
  assert.ok(button('cookieClose').disabled)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(open, true, 'mutation blocks closing')
  await act(async () => { importResolve?.() })
  importResolve = null
  assert.equal(imports.length, 2)
  assert.ok(text().includes('browser.cookiePartial'), 'refresh error must not erase import result')
  assert.ok(text().includes('browser.cookieRefreshFailed'))
  assert.ok(text().includes('reload unavailable'))
  refreshFail = false

  await reopen()
  await click('cookieClear')
  assert.equal(clears.length, 0)
  assert.ok(text().includes('browser.cookieConfirmClear'))
  await click('cookieConfirm')
  assert.deepEqual(clears[0], ['browser:a', 'example.com'])
  assert.ok(text().includes('"removed":3,"failed":1'))

  delayPreview = true
  await reopen()
  const oldPreview = previewResolve
  await click('cookieAll')
  assert.ok(button('cookieImportAction').disabled)
  await act(async () => { oldPreview(data(999)) })
  assert.ok(button('cookieImportAction').disabled, 'old site preview cannot authorize all import')
  assert.ok(!text().includes('999'))
  await act(async () => { previewResolve(data(8)) })
  assert.ok(!button('cookieImportAction').disabled)
  url = 'https://other.example/'
  await render()
  assert.ok(button('cookieImportAction').disabled, 'navigation invalidates the preview')
  const staleNavigationPreview = previewResolve
  delayPreview = false
  await reopen()
  await act(async () => { staleNavigationPreview(data(777)) })
  assert.ok(!text().includes('777'), 'closed session cannot change a new session')

  permissionFail = true
  await reopen()
  assert.ok(text().includes('Chrome: Keychain access denied'))
  assert.ok(button('cookieImportAction').disabled)
  assert.ok(previews.every((call) => call.startsWith('default:')), 'permission failure never changes source')
  permissionFail = false
  await click('cookieRetry')
  assert.ok(!button('cookieImportAction').disabled)

  listFail = true
  await reopen()
  assert.ok(text().includes('sources unavailable'))
  listFail = false
  await click('cookieRetry')
  assert.ok(!button('cookieImportAction').disabled, 'initial source failure can be retried')

  delayList = true
  await reopen()
  const staleList = listResolve
  delayList = false
  site = null
  url = ''
  await reopen()
  await act(async () => { staleList({ supported: true, site: 'stale.site', sources: [{ id: 'chrome', browser: 'chrome', name: 'Old profile' }] }) })
  assert.ok(!text().includes('stale.site'))
  assert.ok(text().includes('browser.cookieNoSite'))
  assert.ok(button('cookieSite').disabled)
  assert.ok(button('cookieImportAction').disabled)
  await click('cookieAll')
  assert.ok(!button('cookieImportAction').disabled, 'all scope is available with no page URL')
  assert.ok(button('cookieClear').disabled)

  delayPreview = true
  await click('cookieRetry')
  const oldSourcePreview = previewResolve
  await act(async () => { document.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const chrome = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === 'Chrome profile')
  assert.ok(chrome, 'profile options use the existing Select')
  await act(async () => { chrome.click() })
  assert.equal(previews.at(-1), 'chrome:all')
  await act(async () => { oldSourcePreview(data(888)) })
  assert.ok(button('cookieImportAction').disabled, 'a previous profile cannot authorize import')
  assert.ok(!text().includes('888'))
  await act(async () => { previewResolve(data(9)) })
  assert.ok(!button('cookieImportAction').disabled)
  await act(async () => { root.unmount() })
  container.remove()
  await GlobalRegistrator.unregister()
}

if (process.argv[2] === '--cookie-fixture') {
  await fixture()
} else {
  test('cookie dialog: confirmations, metadata races, permissions and partial results', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--cookie-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timeout); child.kill() }
  }, 15_000)
}

/** Real React/native-view lifecycle with an isolated happy-dom bridge; no browser automation. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BrowserApi, BrowserBounds, BrowserSelection, BrowserState, BrowserScreenshot } from '../src/shared/browser'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: string) => key }))
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    observe() {} unobserve() {} disconnect() {}
  } })
  const state = (browserId = 'a', documentId = 'd'): BrowserState => ({ browserId, documentId, url: 'http://localhost', title: documentId, loading: false, canGoBack: true, canGoForward: false, selecting: false, devtools: false, annotations: [], error: null, certificate: null, agentSessionId: null })
  let pushState: (next: BrowserState) => void = () => {}
  let pushSelection: (next: BrowserSelection) => void = () => {}
  let requestClose: (browserId: string) => void = () => {}
  let initial!: (next: BrowserState) => void
  let capture!: (next: BrowserScreenshot) => void
  let captures = 0
  const bounds: { browserId: string; bounds: BrowserBounds | null }[] = []
  let reads = 0
  let created = 0
  let closed = 0
  let snapshotFailure = false
  let hideFailures = 0
  const appliedBounds = new Map<string, BrowserBounds | null>()
  const navigations: { browserId: string; url: string }[] = []
  const pageActions: [string, string][] = []
  const controlActions: unknown[][] = []
  let finishAbort!: () => void
  let resizeDevtools: (browserId: string, clientY: number) => void = () => {}
  let failAbort = false
  const api: BrowserApi = {
    create: async (browserId) => { created++; return state(browserId) },
    getState: async (browserId) => { reads++; return browserId === 'a' ? new Promise((resolve) => { initial = resolve }) : state(browserId) },
    navigate: async (browserId, url) => { navigations.push({ browserId, url }) }, back: async () => {}, forward: async () => {}, reload: async () => {},
    removeAnnotations: async () => {},
    setSelecting: async (_id, _selecting, options) => { assert.ok(options?.labels.add); assert.ok(options?.theme.foreground) }, close: async () => { closed++ },
    setBounds: async (browserId, rect) => {
      bounds.push({ browserId, bounds: rect })
      if (browserId === 'two' && rect === null && hideFailures > 0) {
        hideFailures--
        throw new Error('hide failed')
      }
      appliedBounds.set(browserId, rect)
    },
    capture: async () => { captures++; return new Promise((resolve) => { capture = resolve }) },
    snapshot: async (browserId) => {
      if (browserId === 'two' && snapshotFailure) throw new Error('snapshot failed')
      return 'data:image/jpeg;base64,YWJj'
    },
    copyUrl: async (id) => { pageActions.push(['copyUrl', id]) },
    openExternal: async (id) => { pageActions.push(['openExternal', id]) },
    inspect: async (id) => { pageActions.push(['inspect', id]) },
    allowCertificate: async (id, fingerprint) => { pageActions.push(['allowCertificate', `${id} ${fingerprint}`]) },
    listCookieSources: async () => ({ supported: false, site: null, sources: [] }),
    previewCookies: async () => ({ site: null, count: 0, domains: [], skipped: { expired: 0, partitioned: 0, unsupported: 0 } }),
    importCookies: async () => ({ imported: 0, failed: 0, skipped: { expired: 0, partitioned: 0, unsupported: 0 } }),
    clearSiteCookies: async () => ({ removed: 0, failed: 0 }),
    releaseAgent: async (id, expected) => { controlActions.push(['release', id, expected]) },
    onAgentOpenRequest: () => () => {},
    answerAgentOpen: async () => {},
    onShortcutRequested: () => () => {},
    onDevtoolsResize: (listener) => { resizeDevtools = listener; return () => { resizeDevtools = () => {} } },
    onCloseRequested: (listener) => { requestClose = listener; return () => { requestClose = () => {} } },
    onState: (listener) => { pushState = listener; return () => { pushState = () => {} } },
    onSelection: (listener) => { pushSelection = listener; return () => { pushSelection = () => {} } }
  }
  Object.defineProperty(window, 'api', { value: { browser: api, abort: async (id: string) => {
    controlActions.push(['abort', id])
    if (failAbort) throw new Error('stop failed')
    await new Promise<void>((resolve) => { finishAbort = resolve })
  } }, configurable: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BrowserPanel } = await import('../src/renderer/src/components/browser/BrowserPanel')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { useComposerDraftsStore: drafts } = await import('../src/renderer/src/stores/composer-drafts')
  const { useSessionsStore: sessions } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const closedTabs: string[] = []
  sessions.setState({ closeTab: (id) => { closedTabs.push(id) } })
  const { serializeComposerDocument, textToComposerDocument } = await import('../src/renderer/src/components/composer/document')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)) }) }
  const render = async (browserId = 'a', active = true, targetSessionId: string | null = 'session-a') => {
    await act(async () => { root.render(createElement(TooltipProvider, null, createElement(BrowserPanel, { browserId, active, targetSessionId }))) })
    const viewport = container.querySelector('[data-browser-viewport]')!
    viewport.getBoundingClientRect = () => new DOMRect(400, 100, 500, 600)
    window.dispatchEvent(new Event('resize'))
    await flush()
  }
  const click = async (key: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="browser.${key}"]`)!
    assert.ok(button)
    await act(async () => { button.click() })
  }
  const selection = (documentId = 'fresh'): BrowserSelection => ({
    id: 'pick', browserId: 'a', documentId, url: 'http://localhost', title: 'Page', capturedAt: 1,
    element: { selector: '#save', tagName: 'BUTTON', role: 'button', name: 'Save', text: 'Page text', bounds: { x: 0, y: 0, width: 10, height: 10 }, styles: {} }
  })
  await render()
  await act(async () => { requestClose('other-browser') })
  assert.deepEqual(closedTabs, [], 'a native shortcut only closes its owning browser tab')
  await act(async () => { requestClose('a') })
  assert.deepEqual(closedTabs, ['a'], 'native Cmd+W uses the existing closeTab store action')
  const oldCloseListener = requestClose
  await act(async () => { pushState(state('b', 'wrong')) })
  assert.ok(!container.textContent!.includes('wrong'))
  await act(async () => { pushState(state('a', 'fresh')); initial(state('a', 'old')) })
  await flush()
  assert.equal(container.querySelector('[role="status"]')?.textContent, 'fresh')
  const address = container.querySelector('input')!
  const toolbar = address.closest('form')!
  assert.equal(container.querySelector('button[type="submit"]'), null)
  for (const action of ['back', 'forward', 'reload', 'select', 'screenshot', 'copyUrl', 'openExternal', 'inspect']) {
    assert.ok(toolbar.querySelector(`button[aria-label="browser.${action}"]`), 'all actions share one toolbar')
  }
  const buttons = [...toolbar.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
  assert.deepEqual(buttons, ['browser.back', 'browser.forward', 'browser.reload', 'browser.select', 'browser.screenshot', 'browser.chooseSession', 'browser.cookieImport', 'browser.copyUrl', 'browser.openExternal', 'browser.inspect'])
  assert.ok(address.compareDocumentPosition(toolbar.querySelector('[aria-label="browser.copyUrl"]')!) & Node.DOCUMENT_POSITION_FOLLOWING, 'page actions follow the address bar')
  for (const action of ['copyUrl', 'openExternal', 'inspect']) await click(action)
  assert.deepEqual(pageActions, [['copyUrl', 'a'], ['openExternal', 'a'], ['inspect', 'a']])
  assert.equal(container.querySelector('[data-devtools-divider]'), null)
  await act(async () => { pushState({ ...state('a', 'fresh'), devtools: true }) })
  const divider = container.querySelector<HTMLElement>('[data-devtools-divider]')!
  assert.ok(divider, 'open DevTools get a marker where they begin')
  assert.equal(divider.querySelector('button'), null, 'the toolbar inspect toggle closes DevTools')
  const ratio = () => Number(divider.style.getPropertyValue('--devtools-ratio')).toFixed(2)
  assert.equal(ratio(), '0.45')
  await act(async () => { resizeDevtools('other', 200) })
  assert.equal(ratio(), '0.45', 'another pane\'s drag is ignored')
  await act(async () => { resizeDevtools('a', 200) })
  assert.equal(ratio(), '0.83', 'dragging the native DevTools edge follows the pointer')
  await act(async () => { pushState(state('a', 'fresh')) })
  assert.equal(container.querySelector('[data-devtools-divider]'), null)
  const certificate = { url: 'https://intranet.test/sso', host: 'intranet.test', error: 'net::ERR_CERT_AUTHORITY_INVALID', issuer: 'Intranet CA', subject: 'intranet.test', validExpiry: 1_900_000_000, fingerprint: 'sha256/A' }
  const certificateOverlay = document.createElement('div')
  certificateOverlay.setAttribute('role', 'dialog')
  document.body.append(certificateOverlay)
  await flush()
  assert.ok(container.querySelector('[data-browser-viewport] img'), 'a dialog freezes the previous page before Agent navigation')
  await act(async () => { pushState({ ...state('a', 'fresh'), error: 'ERR_CERT_AUTHORITY_INVALID', certificate }) })
  certificateOverlay.remove()
  await flush()
  assert.equal(container.querySelector('[data-browser-viewport] img'), null, 'the old frozen page cannot cover the certificate warning after the dialog closes')
  assert.ok(container.textContent!.includes('browser.certificateTitle'))
  assert.equal(container.querySelector('[role="alert"]'), null, 'the interstitial replaces the error banner')
  assert.ok(container.textContent!.includes('sha256/A'), 'the interstitial shows the certificate it would trust')
  assert.equal(bounds.findLast((entry) => entry.browserId === 'a')?.bounds, null, 'the native page is hidden behind the interstitial')
  const proceed = [...container.querySelectorAll('button')].find((button) => button.textContent === 'browser.certificateProceed')!
  await act(async () => { proceed.click() })
  await flush()
  assert.deepEqual(pageActions.at(-1), ['allowCertificate', 'a sha256/A'])
  await act(async () => { pushState({ ...state('a', 'fresh'), error: 'other failure' }) })
  assert.equal([...container.querySelectorAll('button')].find((button) => button.textContent === 'browser.certificateProceed'), undefined, 'other errors cannot be bypassed')
  await act(async () => { pushState(state('a', 'fresh')) })
  const dialogButton = (key: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent === `browser.${key}`)
    assert.ok(button)
    return button
  }
  await act(async () => {
    sessions.setState({ runtime: { controller: { ...emptyRuntime(), isStreaming: true } } })
    pushState({ ...state('a', 'fresh'), agentSessionId: 'controller' })
  })
  await click('releaseAgent')
  assert.equal(controlActions.length, 0, 'opening confirmation does not release control')
  assert.ok(document.querySelector('[role="alertdialog"]')?.textContent?.includes('browser.releaseAgentWarning'))
  await act(async () => { dialogButton('releaseDirectly').click() })
  assert.deepEqual(controlActions, [['release', 'a', 'controller']])
  await click('releaseAgent')
  failAbort = true
  await act(async () => { dialogButton('stopAndRelease').click() })
  assert.ok(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent?.includes('stop failed'))
  assert.equal(controlActions.filter(([action]) => action === 'release').length, 1, 'stop failure does not silently release')
  failAbort = false
  await act(async () => { dialogButton('stopAndRelease').click() })
  assert.equal(dialogButton('releaseDirectly').disabled, true)
  assert.equal(controlActions.filter(([action]) => action === 'release').length, 1, 'release waits for abort completion')
  await act(async () => { finishAbort() })
  assert.deepEqual(controlActions.at(-1), ['release', 'a', 'controller'])
  assert.equal(document.querySelector('[role="alertdialog"]'), null)
  await click('releaseAgent')
  await act(async () => { sessions.setState({ runtime: { controller: emptyRuntime() } }) })
  assert.ok(document.querySelector('[role="alertdialog"]')?.textContent?.includes('browser.releaseAgentIdle'))
  assert.ok(!document.querySelector('[role="alertdialog"]')?.textContent?.includes('browser.stopAndRelease'))
  const beforeCancel = controlActions.length
  await act(async () => { dialogButton('cancel').click() })
  assert.equal(controlActions.length, beforeCancel)
  await click('releaseAgent')
  await act(async () => { dialogButton('releaseControl').click() })
  assert.equal(controlActions.length, beforeCancel + 1, 'idle release does not call abort')
  assert.deepEqual(controlActions.at(-1), ['release', 'a', 'controller'])
  await act(async () => { pushState(state('a', 'fresh')) })
  await act(async () => {
    address.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })
    address.dispatchEvent(enter)
    assert.equal(enter.defaultPrevented, true)
    toolbar.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  assert.equal(navigations.length, 0)
  await act(async () => {
    address.dispatchEvent(new Event('compositionend', { bubbles: true }))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    address.dispatchEvent(enter)
    assert.equal(enter.defaultPrevented, false)
    if (!enter.defaultPrevented) toolbar.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  assert.deepEqual(navigations, [{ browserId: 'a', url: 'http://localhost' }])
  const viewportStyle = getComputedStyle(container.querySelector('[data-browser-viewport]')!)
  assert.ok(!viewportStyle.backgroundColor || ['transparent', 'rgba(0, 0, 0, 0)'].includes(viewportStyle.backgroundColor))

  assert.equal(bounds.at(-1)?.bounds?.width, 500)
  const before = bounds.length
  container.querySelector('input')!.setAttribute('title', 'irrelevant stream update')
  await flush()
  assert.equal(bounds.length, before)
  const hint = document.createElement('div')
  hint.setAttribute('data-slot', 'tooltip-content')
  hint.getBoundingClientRect = () => new DOMRect(10, 10, 120, 30)
  document.body.append(hint)
  await flush()
  assert.ok(bounds.at(-1)?.bounds, 'toolbar tooltips outside the viewport must not disable the native picker')
  hint.getBoundingClientRect = () => new DOMRect(450, 150, 120, 30)
  hint.setAttribute('style', 'opacity:1')
  await flush()
  assert.equal(bounds.at(-1)?.bounds, null, 'a tooltip over the webpage must not be covered by the native view')
  assert.equal(container.querySelector('[data-browser-viewport] img')?.getAttribute('src'), 'data:image/jpeg;base64,YWJj', 'a still frame replaces the hidden page')
  hint.remove()
  await flush()
  assert.ok(bounds.at(-1)?.bounds)
  assert.equal(container.querySelector('[data-browser-viewport] img'), null)
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  document.body.append(overlay)
  await flush()
  assert.equal(bounds.at(-1)?.bounds, null)
  overlay.remove()
  await flush()
  assert.ok(bounds.at(-1)?.bounds)
  document.documentElement.setAttribute('data-surface-reveal', 'glass')
  await flush()
  assert.equal(bounds.at(-1)?.bounds, null)
  document.documentElement.removeAttribute('data-surface-reveal')
  await flush()
  assert.ok(bounds.at(-1)?.bounds)

  drafts.getState().setContent('session-a', textToComposerDocument('Existing'))
  drafts.getState().setImages('session-a', [])
  drafts.getState().setBashMode('session-a', true)
  await act(async () => { pushSelection(selection('old')) })
  assert.equal(container.querySelector('textarea'), null)
  await act(async () => { pushSelection(selection()) })
  assert.equal(container.querySelector('textarea'), null, 'comments are owned by the guest')
  await render('a', true, null)
  await click('select')
  await click('screenshot')
  assert.ok(document.querySelector('[role="menu"]'), 'without a chosen chat, the screenshot button opens the destination menu')
  assert.equal(captures, 0, 'nothing is captured before a destination exists')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await flush()
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="browser.chooseSession"]')!
  assert.equal(document.activeElement, trigger, 'Esc hands focus back to the destination trigger')
  await act(async () => { trigger.blur() })
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })) })
  assert.ok(document.querySelector('[role="menu"]'))
  await act(async () => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
  })
  await flush()
  assert.equal(document.querySelector('[role="menu"]'), null)
  assert.notEqual(document.activeElement, trigger, 'an outside click closes the menu without focusing its trigger')
  await act(async () => { pushState({ ...state('a', 'fresh'), selecting: true, annotations: [{ ...selection(), ordinal: 1, comment: '' }] }) })
  assert.equal(container.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label'), 'browser.select')
  assert.ok(container.querySelector('[aria-label="browser.sendMarks"]'))
  assert.ok(container.querySelector('[aria-label="browser.clearMarks"]'))
  assert.equal(document.querySelector('[role="menu"]'), null)
  const destinationButton = container.querySelector<HTMLButtonElement>('[aria-label="browser.chooseSession"]')!
  await act(async () => { destinationButton.focus() })
  await flush()
  assert.ok(document.querySelector('[role="tooltip"]')?.textContent?.includes('browser.chooseSession'), 'the destination arrow has its own tooltip')
  await act(async () => { destinationButton.blur() })
  await click('sendMarks')
  assert.equal(document.querySelector('[role="tooltip"]'), null, 'the destination tooltip closes while choosing a chat')
  assert.ok(document.querySelector('[role="menu"]'), 'without a chosen chat, Send opens the target menu instead of writing anywhere')
  assert.equal(serializeComposerDocument(drafts.getState().drafts['session-a']!.content!).text, 'Existing')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(drafts.getState().drafts['session-a']!.bashMode, true)
  await render()
  await act(async () => { pushState(state('a', 'next')) })

  await click('screenshot')
  await act(async () => { pushState(state('a', 'navigated')); capture({ mimeType: 'image/png', data: 'YWJj' }) })
  assert.equal(drafts.getState().drafts['session-a']!.images!.length, 0)
  await click('screenshot')
  await render('a', true, 'session-b')
  await act(async () => { capture({ mimeType: 'image/png', data: 'YWJj' }) })
  assert.equal(drafts.getState().drafts['session-b'], undefined, 'a target switch cannot redirect an in-flight screenshot')
  assert.equal(drafts.getState().drafts.a, undefined, 'browser ids must never own Pi drafts')
  await click('screenshot')
  await render('b', true, 'session-b')
  await act(async () => { capture({ mimeType: 'image/png', data: 'YWJj' }) })
  assert.equal(drafts.getState().drafts['session-b'], undefined)
  assert.equal(drafts.getState().drafts['session-a']!.images!.length, 0)
  assert.equal(bounds.at(-1)?.browserId, 'b')
  assert.ok(bounds.at(-1)?.bounds)
  await render('b', false, 'session-b')
  assert.equal(bounds.at(-1)?.bounds, null)
  await render('b', true, 'session-b')
  assert.equal(reads, 2, 'hiding must not recreate the preview')
  assert.equal(created, 0, 'tab creation, not the panel, owns preview creation')
  await click('screenshot')
  await act(async () => { capture({ mimeType: 'image/png', data: 'YWJj' }) })
  assert.equal(drafts.getState().drafts['session-b']!.images!.length, 1)
  const saved = structuredClone(drafts.getState().drafts['session-b'])
  await click('screenshot')
  await act(async () => { capture({ mimeType: 'image/png', data: '' }) })
  assert.ok(container.querySelector('[role="alert"]'))
  assert.deepEqual(drafts.getState().drafts['session-b'], saved)
  assert.equal(closed, 0, 'the pane lifecycle, not the page toolbar, owns closing')
  await act(async () => { root.unmount() })
  const closesBeforeUnmount = closedTabs.length
  oldCloseListener('a')
  requestClose('a')
  assert.equal(closedTabs.length, closesBeforeUnmount, 'disposed panels ignore delayed shortcut messages')
  await flush()
  assert.equal(bounds.at(-1)?.bounds, null)
  container.remove()

  const { useBrowserBounds } = await import('../src/renderer/src/components/browser/useBrowserBounds')
  const { useRef } = await import('react')
  const errors: unknown[] = []
  const report = (reason: unknown) => { errors.push(reason) }
  const freeze = () => {}
  function BoundsProbe({ browserId, x }: { browserId: string; x: number }) {
    const viewport = useRef<HTMLDivElement>(null)
    useBrowserBounds(browserId, true, viewport, report, freeze)
    return createElement('div', { ref: (node: HTMLDivElement | null) => {
      viewport.current = node
      if (node) node.getBoundingClientRect = () => new DOMRect(x, 0, 300, 400)
    } })
  }
  const probes = document.createElement('div')
  document.body.append(probes)
  const probeRoot = createRoot(probes)
  const showProbes = async (duplicate = false, keepFirst = true) => {
    await act(async () => { probeRoot.render(createElement('div', null,
      keepFirst ? createElement(BoundsProbe, { key: 'first', browserId: 'one', x: 10 }) : null,
      createElement(BoundsProbe, { key: 'second', browserId: 'two', x: 400 }),
      duplicate ? createElement(BoundsProbe, { key: 'duplicate', browserId: 'one', x: 800 }) : null
    )) })
    window.dispatchEvent(new Event('resize'))
    await flush()
  }
  const lastBounds = (browserId: string) => bounds.findLast((entry) => entry.browserId === browserId)?.bounds
  await showProbes()
  assert.equal(lastBounds('one')?.x, 10)
  assert.equal(lastBounds('two')?.x, 400, 'different browser ids can both show native views')
  await showProbes(true)
  assert.equal(lastBounds('one')?.x, 800, 'the latest owner wins for a duplicate browser id')
  assert.equal(lastBounds('two')?.x, 400)
  await showProbes(true, false)
  assert.equal(lastBounds('one')?.x, 800, 'unmounting an old owner must not hide its replacement')
  snapshotFailure = true
  hideFailures = 1
  document.body.append(overlay)
  await flush()
  assert.ok(appliedBounds.get('two'), 'the rejected hide has not changed native visibility')
  assert.ok(errors.some(error => error instanceof Error && error.message === 'snapshot failed'))
  assert.ok(errors.some(error => error instanceof Error && error.message === 'hide failed'), 'both IPC failures are reported')
  const attempts = bounds.filter(entry => entry.browserId === 'two' && entry.bounds === null).length
  window.dispatchEvent(new Event('resize'))
  await flush()
  assert.equal(bounds.filter(entry => entry.browserId === 'two' && entry.bounds === null).length, attempts + 1, 'a failed transition must not suppress a same-layout retry')
  assert.equal(appliedBounds.get('two'), null, 'snapshot rejection still allows the native view to be hidden')
  snapshotFailure = false
  overlay.remove()
  await flush()
  assert.ok(appliedBounds.get('two'), 'closing the overlay restores native visibility')
  await act(async () => { probeRoot.unmount() })
  await flush()
  assert.equal(lastBounds('one'), null)
  assert.equal(lastBounds('two'), null)
  probes.remove()
  await GlobalRegistrator.unregister()
}

if (process.argv[2] === '--browser-fixture') {
  await fixture()
} else {
  test('browser panel: state ordering, overlay visibility, draft append and stale captures', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--browser-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timeout); child.kill() }
  }, 15_000)
}

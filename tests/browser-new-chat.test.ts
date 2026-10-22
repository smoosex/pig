/** Isolated React/store regression for chat creation racing with tab selection. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionRef } from '../src/shared/api'
import type { BrowserState } from '../src/shared/browser'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: string) => key }))
  mock.module('../src/renderer/src/components/browser/useBrowserBounds', () => ({ useBrowserBounds: () => {} }))
  let resolve!: (ref: SessionRef) => void
  let reject!: (error: Error) => void
  let creations = 0
  const removed: string[][] = []
  const browserState: BrowserState = {
    browserId: 'browser:preview', documentId: 'document', url: 'https://example.com', title: 'Page',
    loading: false, canGoBack: false, canGoForward: false, selecting: false, devtools: false, error: null, agentSessionId: null,
    annotations: [{
      id: 'mark', browserId: 'browser:preview', documentId: 'document', url: 'https://example.com', title: 'Page',
      capturedAt: 1, ordinal: 1, comment: 'Fix this',
      element: { selector: '#save', tagName: 'BUTTON', role: 'button', name: 'Save', text: 'Save',
        bounds: { x: 0, y: 0, width: 10, height: 10 }, styles: {} }
    }]
  }
  Object.defineProperty(window, 'api', { configurable: true, value: {
    createChat: () => { creations++; return new Promise<SessionRef>((done, fail) => { resolve = done; reject = fail }) },
    saveOpenChatTabs: async () => {},
    saveOpenToolTabs: async () => {},
    saveOpenSplitLayout: async () => {},
    browser: {
      getState: async () => browserState,
      onState: () => () => {},
      onCloseRequested: () => () => {},
      releaseAgent: async () => {},
      onAgentOpenRequest: () => () => {},
      answerAgentOpen: async () => {},
      setSelecting: async () => {},
      removeAnnotations: async (_id: string, ids: string[]) => { removed.push(ids) }
    }
  } })
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { useComposerDraftsStore: drafts } = await import('../src/renderer/src/stores/composer-drafts')
  const { serializeComposerDocument, textToComposerDocument } = await import('../src/renderer/src/components/composer/document')
  store.setState({
    workspaceRestoreReady: true,
    loadControls: async () => {},
    openTabs: [
      { id: 'browser:preview', kind: 'browser', cwd: '', title: 'Preview', loadState: 'ready' },
      { id: 'other', kind: 'chat', cwd: '/chats/other', title: 'Other', loadState: 'ready' }
    ], activeTabId: 'browser:preview'
  })
  const pending = store.getState().newChat()
  await store.getState().activateTab('other')
  resolve({ sessionId: 'direct-new', cwd: '/chats/direct-new' })
  assert.equal(await pending, 'direct-new', 'the result identifies the created chat, not the selected tab')
  assert.equal(store.getState().activeTabId, 'other', 'creation preserves a newer selection')

  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BrowserPanel } = await import('../src/renderer/src/components/browser/BrowserPanel')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  drafts.getState().setContent('other', textToComposerDocument('Unrelated draft'))
  const otherDraft = structuredClone(drafts.getState().drafts.other)
  await act(async () => { root.render(createElement(TooltipProvider, null,
    createElement(BrowserPanel, { browserId: 'browser:preview', targetSessionId: null }))) })
  const startNewChat = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="browser.sendMarks"]')!.click() })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === 'browser.newChat')
    assert.ok(item)
    await act(async () => { item.click() })
  }
  await act(async () => { await store.getState().activateTab('browser:preview') })
  await startNewChat()
  assert.equal(creations, 2)
  await act(async () => { await store.getState().activateTab('other') })
  await act(async () => { resolve({ sessionId: 'panel-new', cwd: '/chats/panel-new' }) })
  assert.deepEqual(drafts.getState().drafts.other, otherDraft)
  assert.equal(drafts.getState().drafts['browser:preview'], undefined)
  const saved = serializeComposerDocument(drafts.getState().drafts['panel-new']!.content!)
  assert.equal(saved.attachments.length, 1)
  assert.ok(saved.attachments[0]!.text.includes('Fix this'))
  assert.equal(store.getState().openTabs.find((tab) => tab.id === 'browser:preview')?.browserTargetSessionId, 'panel-new')
  assert.equal(store.getState().activeTabId, 'panel-new')
  assert.deepEqual(removed, [['mark']])

  await startNewChat()
  await act(async () => { reject(new Error('chat creation failed')) })
  assert.ok(container.textContent?.includes('chat creation failed'), 'creation errors surface through the panel catch')
  assert.deepEqual(removed, [['mark']], 'failed creation does not consume annotations')
  assert.deepEqual(drafts.getState().drafts.other, otherDraft)
  await act(async () => { root.unmount() })
  container.remove()
  await GlobalRegistrator.unregister()
}

if (process.argv.includes('--browser-new-chat-fixture')) {
  await fixture()
} else {
  test('newChat returns its own ID across tab switches and browser marks use that draft only', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--browser-new-chat-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timeout); child.kill() }
  }, 15_000)
}

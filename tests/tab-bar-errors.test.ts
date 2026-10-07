/** A tab failure stays visible and named for assistive technology, not only in a native tooltip. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  const { act, createElement: h } = await import('react')
  let renameError: string | null = null
  let exportError: string | null = null
  mock.module('../src/renderer/src/components/SessionRenameField', () => ({
    SessionRenameField: () => null,
    useSessionRename: () => ({
      editing: false, error: renameError, start: () => {}, cancel: () => {}, commit: () => {}
    })
  }))
  mock.module('../src/renderer/src/components/sidebar/project-action', () => ({
    useProjectAction: () => ({ pending: null, error: exportError, runAction: async () => {} })
  }))
  const { createRoot } = await import('react-dom/client')
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { TabBar } = await import('../src/renderer/src/components/TabBar')
  const tab: OpenTab = { id: 'chat', cwd: '/chats/c', kind: 'chat', title: 'Chat', loadState: 'ready' }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    for (const reason of ['load failed', 'rename failed', 'export failed']) {
      renameError = reason === 'rename failed' ? reason : null
      exportError = reason === 'export failed' ? reason : null
      await act(async () => {
        store.setState({
          openTabs: [{ ...tab, loadState: reason === 'load failed' ? 'error' : 'ready', loadError: reason }],
          activeTabId: tab.id, currentProjectCwd: null
        })
        root.render(h(TabBar, { sidebarTab: 'chats' }))
      })
      const icon = container.querySelector<SVGElement>('[role="img"].lucide-circle-alert')
      assert.ok(icon, `${reason} must have a visible error icon`)
      assert.equal(icon.getAttribute('aria-label'), reason)
      assert.notEqual(icon.getAttribute('aria-hidden'), 'true')
      assert.equal(icon.closest('[title]')?.getAttribute('title'), reason)
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--tab-errors-fixture') {
  await runFixture()
} else {
  test('tab load, rename and export errors have visible accessible indicators', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--tab-errors-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}

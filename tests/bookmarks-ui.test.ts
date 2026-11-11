import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BookmarkSnapshot, ReplyBookmark } from '../src/shared/bookmarks'
import { runSelf } from './helpers/subprocess'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let snapshot: BookmarkSnapshot = { revision: 0, items: [] }
  let changed = () => {}
  let branch = true
  let failRemove = false
  const item = (sessionId: string): ReplyBookmark => ({
    id: `${sessionId}/reply`, entryId: 'reply', turnId: 'user', kind: 'project', preview: `Saved ${sessionId}`, createdAt: 1,
    session: { id: sessionId, path: `/sessions/${sessionId}.jsonl`, cwd: '/project', name: `Chat ${sessionId}`, created: '', modified: '', size: 0, firstMessage: 'Question' }
  })
  Object.assign(window, { api: { bookmarks: {
    list: async () => snapshot,
    onChanged: (listener: () => void) => { changed = listener; return () => { changed = () => {} } },
    locate: async () => ({ turnIndex: branch ? 214 : null }),
    remove: async (id: string) => {
      if (failRemove) throw new Error('Write failed')
      snapshot = { revision: snapshot.revision + 1, items: snapshot.items.filter(item => item.id !== id) }
      return snapshot
    }
  } } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { useBookmarksStore } = await import('../src/renderer/src/stores/bookmarks')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { ReplyBookmarks } = await import('../src/renderer/src/components/ReplyBookmarks')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  useSettingsStore.setState({ locale: 'zh-CN', localeSetting: 'zh-CN' })
  const opens: string[] = []
  const branches: string[] = []
  const navigated: string[] = []
  useSessionsStore.setState({
    activeTabId: 'current',
    openTabs: ['current', 'other'].map(id => ({ id, title: id, cwd: '/project', kind: 'project', loadState: 'ready', meta: item(id).session })),
    openExisting: async (meta, kind) => {
      opens.push(meta.id)
      useSessionsStore.setState({ activeTabId: meta.id, openTabs: [{ id: meta.id, title: 'Chat', cwd: meta.cwd, kind: kind ?? 'project', loadState: 'ready', meta }], runtime: { [meta.id]: emptyRuntime() } })
    },
    viewBranch: async (_id, entryId) => { branches.push(entryId); branch = true; return true }
  })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="书签"]')!
  const popover = () => document.querySelector('[data-slot="popover-content"]')!
  const visit = () => popover().querySelector<HTMLButtonElement>('button[title="Saved current"]')!
  const open = async () => { await act(async () => toggle().click()); await flush() }
  try {
    await act(async () => root.render(h(TooltipProvider, null, h(ReplyBookmarks, { onNavigate: kind => navigated.push(kind) }))))
    await flush(); await open()
    assert.match(popover().textContent!, /留住值得重读的回复/)
    assert.ok(popover().textContent!.startsWith('留住值得重读的回复'), 'no title or count precedes the empty state')
    assert.ok(popover().querySelector('[data-slot="empty"]')?.classList.contains('py-3'), 'the illustration keeps compact vertical padding')
    assert.ok(popover().querySelector('[data-slot="empty-description"]')?.classList.contains('text-xs/relaxed'), 'supporting copy is one size below the title')
    assert.match(popover().textContent!, /点击回复下方的书签按钮/)
    const preview = popover().querySelector('[data-bookmark-preview]')!
    assert.equal(preview.getAttribute('aria-hidden'), 'true', 'the illustration is decorative; the text provides the instructions')
    assert.equal(preview.querySelectorAll('button, a, [tabindex]').length, 0, 'illustrated controls cannot be mistaken for real actions')
    assert.equal(preview.querySelectorAll('svg').length, 3)
    assert.ok(preview.querySelector('svg')?.classList.contains('fill-current'), 'only the bookmark icon is highlighted')
    assert.equal(preview.querySelectorAll('svg.fill-current').length, 1)
    assert.equal(preview.querySelectorAll('.animate-pulse').length, 0, 'the preview is not a loading skeleton')
    snapshot = { revision: 1, items: [item('other'), item('current')] }
    await act(async () => changed()); await flush()
    assert.equal(popover().querySelector('[data-bookmark-preview]'), null, 'saved replies replace the empty-state illustration')
    assert.deepEqual([...popover().querySelectorAll('h3')].map(node => node.textContent), ['此聊天', 'Chat other'])
    assert.ok(popover().querySelector('.overflow-y-auto')?.className.includes('scrollbar-width:none'))
    const group = (name: string) => [...popover().querySelectorAll('h3')].find(node => node.textContent === name)!.closest('[data-slot="collapsible"]')!
    assert.equal(group('此聊天').getAttribute('data-state'), 'open')
    assert.equal(group('Chat other').getAttribute('data-state'), 'closed', 'other conversations are collapsed by default')
    assert.equal(popover().querySelector('button[title="Saved other"]'), null)
    await act(async () => group('Chat other').querySelector<HTMLButtonElement>('button')!.click()); await flush()
    assert.ok(popover().querySelector('button[title="Saved other"]'), 'other groups can be expanded manually')
    assert.equal(visit().getAttribute('data-size'), 'xs', 'bookmark text uses the smaller button type')
    const row = visit().closest('[data-sidebar-hover-row]')!
    const remove = row.querySelector<HTMLButtonElement>('[aria-label="移除书签"]')!
    for (const button of [visit(), remove]) {
      assert.ok(button.classList.contains('!bg-transparent'), 'the shared row owns the background')
      assert.ok(button.classList.contains('hover:text-foreground'), 'individual controls only change foreground on hover')
    }
    await act(async () => remove.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 }))); await flush()
    assert.ok(row.hasAttribute('data-sidebar-hover-target'), 'hovering the remove icon highlights the complete row')
    const { useSplitLayoutStore } = await import('../src/renderer/src/stores/split-layout')
    await act(async () => {
      useSplitLayoutStore.setState({ groups: [{
        root: { id: 'split', direction: 'horizontal', sizes: [50, 50], children: [
          { id: 'pane-current', tabId: 'current' }, { id: 'pane-other', tabId: 'other' }
        ] }, activePaneId: 'pane-current'
      }] })
      useSplitLayoutStore.getState().setActivePane('pane-other')
      useSessionsStore.setState({ activeTabId: 'other' })
    }); await flush()
    assert.deepEqual([...popover().querySelectorAll('h3')].map(node => node.textContent), ['此聊天', 'Chat current'])
    assert.ok(popover().querySelector('button[title="Saved other"]'), 'the activated split conversation is the current expanded group')
    assert.equal(group('Chat current').getAttribute('data-state'), 'closed', 'the still-visible but inactive conversation is no longer current')
    await act(async () => {
      useSplitLayoutStore.getState().setActivePane('pane-current')
      useSessionsStore.setState({ activeTabId: 'current' })
    }); await flush()
    assert.equal(group('Chat other').getAttribute('data-state'), 'closed')
    await act(async () => visit().click()); await flush()
    assert.deepEqual(opens, ['current'])
    assert.deepEqual(navigated, ['project'])
    assert.equal(document.querySelector('[data-slot="popover-content"]'), null)
    assert.equal(useBookmarksStore.getState().jump?.turnIndex, 214, 'jump requests use the saved turn, including unloaded history')
    assert.deepEqual(branches, [], 'a reply on the current branch never changes branches')
    await open(); branch = false
    await act(async () => visit().click()); await flush()
    assert.deepEqual(branches, ['reply'], 'off-branch replies use the saved entry, not a neighboring turn')
    await open(); branch = false
    const openExisting = useSessionsStore.getState().openExisting
    useSessionsStore.setState({ openExisting: async () => {}, runtime: { current: { ...emptyRuntime(), isStreaming: true } } })
    await act(async () => visit().click()); await flush()
    assert.match(popover().querySelector('[role="alert"]')!.textContent!, /先停止/)
    assert.deepEqual(branches, ['reply'], 'a busy target cannot change branches')
    useSessionsStore.setState({ openExisting })
    branch = true
    failRemove = true
    await act(async () => popover().querySelector<HTMLButtonElement>('[aria-label="移除书签"]')!.click()); await flush()
    assert.match(popover().querySelector('[role="alert"]')!.textContent!, /Write failed/)
    assert.equal(useBookmarksStore.getState().items.length, 2, 'a failed remove keeps the bookmark')
    failRemove = false
    await act(async () => popover().querySelector<HTMLButtonElement>('[aria-label="移除书签"]')!.click()); await flush()
    assert.equal(useBookmarksStore.getState().items.length, 1)

    const oldRead = Promise.withResolvers<BookmarkSnapshot>()
    window.api.bookmarks.list = () => oldRead.promise
    const pending = useBookmarksStore.getState().refresh()
    await act(async () => useBookmarksStore.getState().remove('other/reply'))
    await act(async () => { oldRead.resolve({ revision: 1, items: [item('other'), item('current')] }); await pending })
    assert.equal(useBookmarksStore.getState().items.length, 0, 'late refresh cannot resurrect a removed bookmark')
    assert.ok(popover().querySelector('[data-bookmark-preview]'), 'removing the final bookmark restores the illustration')
  } finally {
    await act(async () => root.unmount())
    host.remove(); GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('bookmark library groups chats, navigates saved replies and preserves failed or newer mutations', async () => {
  const result = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 20_000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})

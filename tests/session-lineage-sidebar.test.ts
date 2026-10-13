/**
 * The sidebar threads a worktree's open sessions by fork lineage: a fork renders as its own row
 * carrying the fork icon. Session identity must survive metadata-driven reordering.
 */
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { OpenTab } from '../src/renderer/src/stores/sessions'
import type { SessionMeta } from '../src/shared/api'

async function fixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })

  const parent: SessionMeta = {
    id: 'parent', cwd: '/project', path: '/sessions/parent.jsonl',
    created: '', modified: '2026-01-01T00:00:00Z', size: 1, firstMessage: '原始会话'
  }
  const fork: SessionMeta = {
    ...parent, id: 'fork', path: '/sessions/fork.jsonl',
    modified: '2026-01-02T00:00:00Z', firstMessage: '分支会话', parentSession: parent.path
  }
  // Strip order puts the fork first; the tree still hangs it under its parent.
  const tab = (meta: SessionMeta): OpenTab => ({
    id: meta.id, cwd: meta.cwd, title: meta.firstMessage, kind: 'project', loadState: 'ready', meta
  })
  const tabs = [tab(fork), tab(parent)]
  store.setState({
    openTabs: tabs,
    activeTabId: 'fork',
    runtime: { fork: emptyRuntime(), parent: emptyRuntime() }
  })

  const { SessionList } = await import('../src/renderer/src/components/sidebar/SessionList')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(h(SessionList, { sessions: tabs }))
    })
    if (name === 'fork-icon') {
      const rows = [...container.querySelectorAll('[data-sidebar-hover-row]')]
      const [parentRow, forkRow] = rows
      assert.equal(rows.length, 2)
      assert.equal(parentRow!.querySelector('.lucide-corner-down-right'), null, 'a root is unmarked')
      assert.ok(forkRow!.querySelector('.lucide-corner-down-right'), 'a fork carries the corner icon')
      assert.equal(forkRow!.textContent, '分支会话', 'the icon is decoration, not copy')
      return
    }

    if (name === 'rename-reorder') {
      const first = { ...fork, id: 'first', path: '/sessions/first.jsonl' }
      const sibling = { ...fork, id: 'sibling', path: '/sessions/sibling.jsonl' }
      const nested = { ...fork, id: 'nested', path: '/sessions/nested.jsonl', parentSession: first.path }
      const sameTitleTabs = [parent, first, sibling, nested].map((meta) => ({
        ...tab(meta), title: '相同标题', meta: meta.id === nested.id ? undefined : meta
      }))
      const renames: { sessionId: string; name: string; path?: string }[] = []
      await act(async () => {
        store.setState({
          openTabs: sameTitleTabs,
          renameSession: async (sessionId, name, path) => { renames.push({ sessionId, name, path }) }
        })
        root.render(h(SessionList, { sessions: sameTitleTabs }))
      })
      const before = [...container.querySelectorAll<HTMLElement>('[data-sidebar-hover-row]')]
      await act(async () => {
        before[3]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
      })
      const renameItem = document.querySelector<HTMLElement>('[data-slot="context-menu-item"]')
      assert.ok(renameItem, 'the nested fork opens its rename menu')
      await act(async () => {
        renameItem.click()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      const input = before[3]!.querySelector<HTMLInputElement>('input')
      assert.ok(input, 'renaming starts on the nested fork')
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setValue.call(input, '嵌套分支的新名字')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })

      const resolvedTabs = sameTitleTabs.map((item) => item.id === nested.id ? { ...item, meta: nested } : item)
      await act(async () => {
        store.setState({ openTabs: resolvedTabs })
        root.render(h(SessionList, { sessions: resolvedTabs }))
      })
      const after = [...container.querySelectorAll<HTMLElement>('[data-sidebar-hover-row]')]
      assert.ok(after[2] === before[3], 'the nested fork moves with its own row identity')
      assert.ok(after[3] === before[2], 'the sibling retains its own row identity')
      assert.ok(after[2]!.querySelector('input') === input, 'the draft survives metadata arrival')
      assert.equal(after[3]!.querySelector('input'), null, 'the sibling does not inherit rename state')
      assert.equal(input.value, '嵌套分支的新名字')
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.deepEqual(renames, [{ sessionId: nested.id, name: '嵌套分支的新名字', path: nested.path }])
      return
    }

    if (name === 'chat-locale') {
      const { ChatList } = await import('../src/renderer/src/components/sidebar/ChatList')
      const metas: SessionMeta[] = [
        { ...parent, id: 'image', path: '/sessions/image.jsonl', firstMessage: '', previewFallback: 'image' },
        { ...parent, id: 'pasted', path: '/sessions/pasted.jsonl', firstMessage: '', previewFallback: 'pastedText' },
        { ...parent, id: 'empty', path: '/sessions/empty.jsonl', firstMessage: '' },
        { ...parent, id: 'image-only', path: '/sessions/image-only.jsonl', firstMessage: '', firstMessageIsImage: true },
        { ...parent, id: 'named', path: '/sessions/named.jsonl', name: '固定标题' }
      ]
      const chats = metas.map((session) => ({ cwd: `/chats/${session.id}`, name: session.id, sessions: [session] }))
      await act(async () => {
        store.setState({ chats })
        root.render(h(ChatList))
      })
      const titles = () => [...container.querySelectorAll('[data-sidebar-hover-row] .truncate')]
        .map((element) => element.textContent)
      assert.deepEqual(titles(), ['图片', '粘贴的文本', '新对话', '图片', '固定标题'])
      await act(async () => {
        useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
      })
      assert.ok(store.getState().chats === chats, 'switching locale does not refresh the catalog')
      assert.deepEqual(titles(), ['Image', 'Pasted text', 'New chat', 'Image', '固定标题'])
      return
    }

    throw new Error(`Unknown fixture: ${name}`)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--session-lineage-fixture') {
  await fixture(process.argv[3]!)
} else {
  for (const [name, title] of [
    ['fork-icon', 'a worktree fork carries the corner icon under its parent'],
    ['rename-reorder', 'renaming a same-title fork survives metadata-driven reordering'],
    ['chat-locale', 'chat fallback titles update on locale changes without refreshing the catalog']
  ] as const) {
    test(title, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--session-lineage-fixture', name], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    })
  }
}

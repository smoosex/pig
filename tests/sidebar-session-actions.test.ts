/** Real sidebar rows share the running/close slot; only the canvas animation is mocked. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { OpenTab } from '../src/renderer/src/stores/sessions'
import type { SessionMeta } from '../src/shared/api'

async function runFixture(kind: 'project' | 'chat'): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  const { act, createElement: h, Fragment } = await import('react')
  mock.module('thinking-orbs', () => ({
    ThinkingOrb: ({ state, size, theme, ...props }: Record<string, unknown>) => h('span', {
      ...props, 'data-orb': state, 'data-size': size, 'data-theme': theme
    })
  }))
  const { createRoot } = await import('react-dom/client')
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const session: SessionMeta = {
    id: 'running', cwd: '/project', path: '/project/running.jsonl',
    created: '', modified: '', size: 0, firstMessage: '正在运行的对话'
  }
  const tab: OpenTab = {
    id: session.id, cwd: session.cwd, title: session.firstMessage, kind, loadState: 'ready', meta: session
  }
  const closed: string[] = []
  const deleted: string[] = []
  const selected: string[] = []
  store.setState({
    openTabs: [tab], activeTabId: tab.id, currentProjectCwd: kind === 'project' ? session.cwd : null,
    chats: [{ cwd: session.cwd, name: 'chat', sessions: [session] }],
    runtime: { [session.id]: { ...emptyRuntime(), isStreaming: true } },
    closeTab: (id) => { closed.push(id) },
    deleteChat: async (cwd) => { deleted.push(cwd) },
    activateTab: async (id) => { selected.push(id) },
    openExisting: async (meta) => { selected.push(meta.id) }
  })
  const { SessionList } = await import('../src/renderer/src/components/sidebar/SessionList')
  const { ChatList } = await import('../src/renderer/src/components/sidebar/ChatList')
  const { TabBar } = await import('../src/renderer/src/components/TabBar')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let rowClicks = 0
  try {
    await act(async () => {
      root.render(h(Fragment, null,
        h('div', { onClick: () => { rowClicks++ } },
          kind === 'project' ? h(SessionList, { sessions: [tab] }) : h(ChatList)
        ),
        h('div', { 'data-tabs': '' }, h(TabBar, { sidebarTab: kind === 'project' ? 'projects' : 'chats' }))
      ))
    })
    const row = container.querySelector<HTMLElement>('[data-sidebar-hover-row]')!
    assert.ok(row)
    const close = row.querySelector<HTMLButtonElement>('button[aria-label]')!
    assert.ok(close)
    assert.equal(close.getAttribute('aria-label'), `关闭 ${tab.title}`)
    const orb = row.querySelector<HTMLElement>('[data-orb="weaving"]')!
    assert.ok(orb)
    assert.equal(orb.getAttribute('data-size'), '20')
    assert.equal(orb.getAttribute('data-theme'), 'light')
    // Pig pins the scheme with the root `dark` class only; the orb must follow it,
    // not prefers-color-scheme, which a forced light appearance overrides.
    document.documentElement.classList.add('dark')
    await act(async () => {})
    assert.equal(orb.getAttribute('data-theme'), 'dark')
    document.documentElement.classList.remove('dark')
    await act(async () => {})
    assert.equal(orb.getAttribute('data-theme'), 'light')
    assert.equal(orb.getAttribute('aria-hidden'), 'true')
    assert.equal(orb.parentElement, close.parentElement, 'the orb occupies the close slot, not another column')
    assert.ok(close.parentElement!.classList.contains('size-6'))
    assert.equal(row.children.length, 2)
    assert.ok(row.classList.contains('group/session'))
    assert.ok(row.classList.contains('close-reveal'))
    assert.ok(close.parentElement!.classList.contains('group/close-slot'))
    for (const selector of ['group-hover/session', 'group-focus-within/close-slot']) {
      assert.ok(orb.classList.contains(`${selector}:opacity-0`))
      assert.ok(close.classList.contains(`${selector}:opacity-100`))
      assert.ok(close.classList.contains(`${selector}:pointer-events-auto`))
    }
    assert.ok(close.classList.contains('absolute'))
    assert.ok(close.classList.contains('opacity-0'))
    assert.ok(close.classList.contains('pointer-events-none'))
    const circle = close.querySelector('.close-spin')!
    assert.ok(circle)
    const topClose = [...container.querySelectorAll<HTMLButtonElement>('[data-tabs] button')]
      .find((button) => button.getAttribute('aria-label') === close.getAttribute('aria-label'))!
    assert.ok(topClose)
    assert.equal(circle.closest('svg')!.outerHTML, topClose.querySelector('.close-spin')!.closest('svg')!.outerHTML)
    const css = await Bun.file(new URL('../src/renderer/src/styles.css', import.meta.url)).text()
    assert.ok(css.includes('.close-reveal:hover .close-spin'))
    assert.ok(css.includes('.close-reveal:focus-within .close-spin'))
    assert.ok(!css.includes('group\\/session:hover .close-spin'), 'no per-host group selectors left behind')
    await act(async () => {
      close.focus()
      close.click()
    })
    assert.equal(document.activeElement, close)
    assert.deepEqual(closed, [session.id])
    assert.deepEqual(deleted, [])
    assert.deepEqual(selected, [])
    assert.equal(rowClicks, 0)
    await act(async () => { store.getState().setStreaming(session.id, false) })
    assert.equal(row.querySelector('[data-orb]'), null)
    assert.equal(row.querySelector('.close-spin'), null)
    assert.equal(row.children.length, 2)
    if (kind === 'project') {
      assert.ok(row.querySelector('.lucide-x'))
    } else {
      assert.ok(row.querySelector('.lucide-trash-2'), 'settled chats keep their hold-to-delete action')
      assert.equal(row.querySelector('.lucide-x'), null)
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--sidebar-actions-fixture') {
  const kind = process.argv[3]
  assert.ok(kind === 'project' || kind === 'chat')
  await runFixture(kind)
} else {
  for (const kind of ['project', 'chat'] as const) {
    test(`sidebar ${kind}: weaving shares the close slot and hover/focus reveals the tab-style close ring`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--sidebar-actions-fixture', kind], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}

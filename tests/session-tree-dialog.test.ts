import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, SessionTreeRow, SessionTreeView } from '../src/shared/api'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
  Object.assign(window, { ResizeObserver: NoopResizeObserver })

  const row = (id: string, text: string, label?: string): SessionTreeRow => ({
    id,
    parentId: null,
    indent: 0,
    gutters: [],
    showConnector: false,
    isLast: true,
    isVirtualRootChild: false,
    foldable: false,
    onPath: true,
    current: true,
    kind: 'user',
    text,
    label
  })
  const toolRow = (): SessionTreeRow => ({ ...row('r1', '[read: a.ts]'), kind: 'tool' })
  const record = (rows: SessionTreeRow[]): Record<SessionTreeView, SessionTreeRow[]> => ({
    default: rows,
    'no-tools': rows,
    'user-only': rows,
    'labeled-only': rows,
    all: rows
  })
  const manyRows = (count: number): SessionTreeRow[] =>
    Array.from({ length: count }, (_, index) => row(`r${index}`, `user: 行${index}`))
  const calls: [string, SessionTreeView[] | undefined][] = []
  const labels: { sessionId: string; targetId: string; label: string; path?: string }[] = []
  const resolvers: ((views: Partial<Record<SessionTreeView, SessionTreeRow[]>>) => void)[] = []
  Object.assign(window, {
    api: {
      getSessionTrees: (sessionId: string, views?: SessionTreeView[]) => {
        calls.push([sessionId, views])
        if (name === 'tree-label-refetch-order') {
          return new Promise<Partial<Record<SessionTreeView, SessionTreeRow[]>>>((resolve) => resolvers.push(resolve))
        }
        let full: Record<SessionTreeView, SessionTreeRow[]> =
          sessionId === 's2'
            ? record([row('x1', 'user: 别的')])
            : name === 'tree-view-tabs'
              ? {
                  ...record([row('u1', 'user: 问题')]),
                  'labeled-only': [row('u1', 'user: 起点')]
                }
              : name === 'tree-window-limits'
                ? record(manyRows(300))
              : {
                  ...record([row('u1', 'user: 问题', '旧标')]),
                  default: [row('u1', 'user: 问题', '旧标'), toolRow(), row('u2', 'user: 继续')]
                }
        if (name === 'tree-filter-scroll') {
          const all = manyRows(2388).map<SessionTreeRow>((item, index) => ({
            ...item, current: index === 2387, kind: index < 289 ? 'user' : 'assistant',
            text: `${index < 289 ? 'user' : 'assistant'}: 行${index}`
          }))
          full = { ...record(all), 'user-only': all.slice(0, 289) }
        }
        if (!views?.length) return Promise.resolve(full)
        return Promise.resolve(Object.fromEntries(views.map((view) => [view, full[view]])))
      },
      setSessionLabel: async (sessionId: string, targetId: string, label: string, path?: string) => {
        labels.push({ sessionId, targetId, label, path })
      }
    } as unknown as SessionApi
  })

  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  useSessionsStore.setState({
    openTabs: [
      {
        id: 's1',
        cwd: '/project',
        title: '会话',
        kind: 'project',
        loadState: 'ready',
        meta: {
          id: 's1',
          path: '/project/s1.jsonl',
          cwd: '/project',
          created: '',
          modified: '',
          size: 0,
          firstMessage: '问题'
        }
      },
      {
        id: 's2',
        cwd: '/other',
        title: '别的',
        kind: 'project',
        loadState: 'ready',
        meta: {
          id: 's2',
          path: '/other/s2.jsonl',
          cwd: '/other',
          created: '',
          modified: '',
          size: 0,
          firstMessage: '别的'
        }
      }
    ],
    activeTabId: 's1'
  })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { SessionTreeButton } = await import('../src/renderer/src/components/SessionTreeDialog')

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(h(SessionTreeButton, null)) })
  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label
    )
    assert.ok(found, label)
    return found
  }
  const labelInput = () => document.querySelector<HTMLInputElement>('input[aria-label="标注"]')
  const openMenuOnRow = async (rowText: string) => {
    const rowButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes(rowText)
    )
    assert.ok(rowButton, `a row shows ${rowText}`)
    await act(async () => {
      rowButton.parentElement!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
      )
    })
    await flush()
    const item = document.querySelector<HTMLElement>('[data-slot="context-menu-item"]')
    assert.ok(item, 'the context menu opened')
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()
  }
  const typeIntoLabel = async (typed: string) => {
    const input = labelInput()
    assert.ok(input, 'the label field replaced the row')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, typed)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await flush()
  }

  if (name === 'tree-window-limits') {
    await act(async () => { button('会话树').click() })
    await flush()
    const mounted = document.querySelectorAll('div.font-mono button').length
    // happy-dom reports no layout, so the window falls back to its default height: what this guards
    // is that the list is a window at all, not the exact number of rows it keeps.
    assert.ok(mounted > 0 && mounted < 60, `only a window of rows is mounted (${mounted})`)
    assert.ok(document.body.textContent?.includes('user: 行0'), 'the window starts at the top')
    assert.equal(
      document.body.textContent?.includes('user: 行299'),
      false,
      'the far end of the list is not mounted'
    )
    return
  }

  if (name === 'tree-filter-scroll') {
    await act(async () => { button('会话树').click() })
    await flush()
    const list = document.querySelector<HTMLDivElement>('div.font-mono')!
    assert.ok(list.scrollTop > 289 * 26, 'the default tree starts near its current final assistant row')
    assert.ok(list.textContent?.includes('assistant: 行2387'))
    list.scrollLeft = 600
    await act(async () => { button('用户').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('289/289'))
    assert.equal(list.scrollTop, 0, 'when the current node is filtered out, reset the actual viewport')
    assert.equal(list.scrollLeft, 0, 'filtered rows cannot remain off-screen horizontally')
    assert.ok(list.textContent?.includes('user: 行0'))

    await act(async () => { button('默认').click() })
    await flush()
    assert.ok(list.scrollTop > 289 * 26, 'returning to the full tree locates its current node')
    const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索节点"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'user: 行0')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(list.scrollTop, 0, 'search also synchronizes the real viewport after reducing the virtual range')
    assert.ok(list.textContent?.includes('user: 行0'))
    return
  }

  if (name === 'tree-view-tabs') {
    await act(async () => { button('会话树').click() })
    await flush()
    assert.deepEqual(calls, [['s1', ['default']]], 'opening the dialog reads only the default view')
    assert.ok(document.body.textContent?.includes('user: 问题'))
    assert.equal(document.body.textContent?.includes('user: 起点'), false)

    // The idle fill has not run yet (its timer outlives the flush), so this tab asks on demand.
    await act(async () => { button('标注').click() })
    await flush()
    assert.deepEqual(
      calls,
      [['s1', ['default']], ['s1', ['labeled-only']]],
      'a tab clicked early reads its own view'
    )
    assert.ok(document.body.textContent?.includes('user: 起点'))
    assert.equal(document.body.textContent?.includes('user: 问题'), false)

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)) })
    await flush()
    assert.deepEqual(
      calls,
      [['s1', ['default']], ['s1', ['labeled-only']], ['s1', undefined]],
      'the idle fill still brings the rest'
    )
    assert.ok(document.body.textContent?.includes('user: 起点'))
    return
  }

  if (name === 'tree-label-menu') {
    await act(async () => { button('会话树').click() })
    await flush()
    assert.deepEqual(calls, [['s1', ['default']]])
    await openMenuOnRow('旧标')
    const input = labelInput()
    assert.ok(input, 'the label field replaced the row')
    assert.equal(input.value, '旧标', 'the field starts from the current label')
    assert.equal(document.activeElement, input, 'the field keeps the focus the menu gave it')
    await typeIntoLabel('新标')
    assert.deepEqual(
      labels,
      [{ sessionId: 's1', targetId: 'u1', label: '新标', path: '/project/s1.jsonl' }],
      'Enter writes the typed label with the tab path'
    )
    assert.deepEqual(calls, [['s1', ['default']], ['s1', undefined]], 'the tree rereads after labeling')
    assert.equal(labelInput(), null, 'the field closes once it commits')
    return
  }

  if (name === 'tree-label-close-cancels') {
    await act(async () => { button('会话树').click() })
    await flush()
    await openMenuOnRow('旧标')
    assert.ok(labelInput(), 'editing started')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-slot="dialog-close"]')!.click()
    })
    await flush()
    assert.equal(
      document.querySelector('[data-slot="dialog-content"]'),
      null,
      'the close button shuts the dialog mid-edit'
    )
    await act(async () => { button('会话树').click() })
    await flush()
    assert.equal(labelInput(), null, 'no phantom field returns with the next open')
    assert.ok(document.body.textContent?.includes('旧标'), 'the rows reread instead')
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    assert.equal(
      document.querySelector('[data-slot="dialog-content"]'),
      null,
      'Escape closes the dialog once no edit is stranded'
    )
    return
  }

  if (name === 'tree-label-session-switch') {
    await act(async () => { button('会话树').click() })
    await flush()
    await openMenuOnRow('旧标')
    assert.ok(labelInput(), 'editing started')
    // Switching tabs never moves focus, so the field unmounts without a blur-commit.
    await act(async () => { useSessionsStore.setState({ activeTabId: 's2' }) })
    await flush()
    assert.equal(labelInput(), null, 'the field leaves with its session')
    assert.ok(
      calls.some(([id]) => id === 's2'),
      'switching sessions rereads the tree'
    )
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    assert.equal(
      document.querySelector('[data-slot="dialog-content"]'),
      null,
      'Escape closes the dialog once no edit is stranded'
    )
    return
  }

  if (name === 'tree-label-refetch-order') {
    await act(async () => { button('会话树').click() })
    await flush()
    assert.equal(resolvers.length, 1, 'the open read is in flight')
    await act(async () => { resolvers[0]!(record([row('u1', 'user: 问题', '旧标')])) })
    await flush()
    await openMenuOnRow('旧标')
    await typeIntoLabel('一')
    assert.equal(resolvers.length, 2, 'the first commit rereads')
    await openMenuOnRow('旧标')
    await typeIntoLabel('二')
    assert.equal(resolvers.length, 3, 'the second commit rereads')
    await act(async () => { resolvers[2]!(record([row('u1', 'user: 二')])) })
    await act(async () => { resolvers[1]!(record([row('u1', 'user: 一')])) })
    await flush()
    assert.ok(document.body.textContent?.includes('user: 二'))
    assert.equal(
      document.body.textContent?.includes('user: 一'),
      false,
      'the slower first read must not paint over the newer one'
    )
    return
  }

  throw new Error(`unknown fixture: ${name}`)
}

if (process.argv.includes('--session-tree-dialog-fixture')) {
  await runFixture(process.argv[process.argv.indexOf('--session-tree-dialog-fixture') + 1]!)
} else {
  for (const [flag, title] of [
    ['tree-view-tabs', 'tree: tabs switch the session view pi cycles with Ctrl+O'],
    ['tree-window-limits', 'tree: a long session mounts only the window it can show'],
    ['tree-filter-scroll', 'tree: switching to user-only from a long tree tail shows the filtered rows'],
    ['tree-label-menu', 'tree: the context menu labels a row in place'],
    ['tree-label-close-cancels', 'tree: closing mid-edit strands no label field'],
    ['tree-label-session-switch', 'tree: switching sessions strands no label field'],
    ['tree-label-refetch-order', 'tree: a slower label reread never paints over a newer one']
  ] as const) {
    test(title, async () => {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, '--session-tree-dialog-fixture', flag],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}

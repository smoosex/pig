import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, SessionTreeRow, SessionTreeView } from '../src/shared/api'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  const observed: Element[] = []
  class NoopResizeObserver {
    observe(target: Element) { observed.push(target) }
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
  const aborts: string[] = []
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
              : name === 'tree-deep-indent'
                ? record([5, 6, 7, 10, 11, 17].map((indent) => ({
                    ...row(`d${indent}`, `user: 深${indent}`),
                    indent,
                    gutters: Array.from({ length: indent }, (_, position) => ({ position, show: true }))
                  })))
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
      abortBranchSummary: async (sessionId: string) => { aborts.push(sessionId) },
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

  const branchCalls: Parameters<ReturnType<typeof useSessionsStore.getState>['viewBranch']>[] = []
  let finishBranch: (value: boolean) => void = () => {}
  let rejectBranch: (reason: Error) => void = () => {}
  useSessionsStore.setState({
    viewBranch: (...args) => {
      branchCalls.push(args)
      return new Promise<boolean>((resolve, reject) => { finishBranch = resolve; rejectBranch = reject })
    }
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
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  await act(async () => { root.render(h(TooltipProvider, null, h(SessionTreeButton, null))) })
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
  const openMenuOnRow = async (rowText: string, itemText = '标注') => {
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
    const item = [...document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].find((entry) => entry.textContent === itemText)
    assert.ok(item, `the context menu offers ${itemText}`)
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

  if (name.startsWith('branch-')) {
    await act(async () => { button('会话树').click() })
    await flush()
    const summarizing = name === 'branch-summary' || name === 'branch-pending' || name === 'branch-custom'
    const node = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes('user: 问题'))!
    const navigate = async () => {
      if (name === 'branch-custom') {
        await openMenuOnRow('user: 问题', '自定义提示词总结')
        assert.equal(branchCalls.length, 0, 'custom summary first asks for a prompt')
        assert.equal(button('总结并跳转').disabled, true, 'the custom prompt must not be empty')
        await act(async () => { button('返回').click() })
        await flush()
        assert.equal(document.querySelector('textarea'), null, 'back closes the prompt without switching')
        await openMenuOnRow('user: 问题', '自定义提示词总结')
        const input = document.querySelector<HTMLTextAreaElement>('textarea')!
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  仅总结关键决定  ')
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => { button('总结并跳转').click() })
        await flush()
      } else if (summarizing) {
        await openMenuOnRow('user: 问题', '总结并跳转')
      } else {
        await act(async () => { node().click() })
      }
    }
    await navigate()
    assert.deepEqual(branchCalls, [['s1', 'u1', {
      restoreUserInput: true,
      summarize: summarizing,
      ...(name === 'branch-custom' ? { customInstructions: '仅总结关键决定' } : {})
    }]], 'left click jumps directly; the context menu chooses a summary')
    const content = document.querySelector('[data-slot="dialog-content"]')!
    assert.equal(content.getAttribute('aria-busy'), 'true')
    const status = document.querySelector('[role="status"]')!
    assert.equal(status.textContent, summarizing ? '正在总结分支…停止总结' : '正在切换分支…', 'only summaries can be stopped')
    assert.ok(status.querySelector('svg.animate-spin'), 'status includes a spinning loader')
    assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="搜索节点"]')!.disabled, true)
    await act(async () => {
      node().click()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      document.querySelector('[data-slot="dialog-overlay"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }))
    })
    await flush()
    assert.equal(branchCalls.length, 1, 'a pending switch cannot run twice')
    assert.ok(document.querySelector('[data-slot="dialog-content"]'), 'pending dialog cannot close')
    assert.equal(document.querySelector('button[data-slot="dialog-close"]'), null)

    if (name === 'branch-failure') {
      await act(async () => { rejectBranch(new Error('总结失败')) })
      assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes('总结失败'))
      assert.equal(document.querySelector('[role="status"]'), null)
      await act(async () => { node().click() })
      assert.equal(branchCalls.length, 2, 'failure can retry')
      assert.equal(document.querySelector('[role="alert"]'), null, 'a retry clears the old error')
      await act(async () => { finishBranch(false) })
      assert.ok(document.querySelector('[data-slot="dialog-content"]'), 'SDK cancel keeps the tree open')
      await act(async () => { document.querySelector<HTMLButtonElement>('button[data-slot="dialog-close"]')!.click() })
      assert.equal(document.querySelector('[data-slot="dialog-content"]'), null)
      return
    }
    if (name === 'branch-session-switch') {
      await act(async () => { useSessionsStore.setState({ activeTabId: 's2' }) })
      await flush()
      assert.equal(document.querySelector('[role="status"]'), null, 'switching tabs clears the old switch status')
      await act(async () => { finishBranch(true) })
      assert.ok(document.querySelector('[data-slot="dialog-content"]'), 'old request must not close the new session tree')
      assert.ok(document.body.textContent?.includes('user: 别的'))
      return
    }
    if (name === 'branch-cancelled') {
      await act(async () => { finishBranch(false) })
      assert.ok(document.querySelector('[data-slot="dialog-content"]'))
      assert.equal(document.querySelector('[role="status"]'), null, 'cancel/stale unlocks the tree')
      assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="搜索节点"]')!.disabled, false)
      return
    }
    if (name === 'branch-pending') {
      await act(async () => { button('停止总结').click() })
      assert.deepEqual(aborts, ['s1'], 'a long summary can be stopped instead of looking stuck')
      assert.equal(button('停止总结').disabled, true, 'stop is sent once')
    }
    await act(async () => { finishBranch(true) })
    assert.equal(document.querySelector('[data-slot="dialog-content"]'), null, 'successful navigation closes the dialog')
    return
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

  if (name === 'tree-deep-indent') {
    await act(async () => { button('会话树').click() })
    await flush()
    const tip = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null
    const prefixOf = (text: string) => {
      const node = [...document.querySelectorAll<HTMLButtonElement>('div.font-mono button')].find((item) => item.textContent?.includes(text))!
      return node.closest('[data-hover-highlight-row]')!.firstElementChild as HTMLElement
    }
    const levels = (text: string) => (prefixOf(text).textContent!.match(/│/g) ?? []).length
    assert.equal(levels('user: 深5'), 5)
    assert.equal(levels('user: 深6'), 6, 'up to six levels are drawn in full')
    assert.equal(prefixOf('user: 深6').getAttribute('data-slot'), null, 'shallow rows have no depth tip')
    assert.equal(levels('user: 深7'), 3, 'deeper rows drop leftmost levels in a chunk')
    assert.equal(levels('user: 深10'), 6, 'rows inside one chunk keep their relative indent')
    assert.equal(levels('user: 深11'), 3)
    assert.equal(levels('user: 深17'), 5, 'no row draws more than six levels')
    assert.ok(prefixOf('user: 深17').textContent!.startsWith('…+12 '))
    const deep = [...document.querySelectorAll<HTMLButtonElement>('div.font-mono button')].find((item) => item.textContent?.includes('user: 深17'))!
    await act(async () => { deep.focus() })
    await flush()
    assert.ok(tip()?.includes('user: 深17'), 'the full node text shows in a tooltip')
    assert.equal(prefixOf('user: 深17').getAttribute('data-slot'), 'tooltip-trigger', 'hidden levels explain themselves in a tooltip')
    return
  }

  if (name === 'tree-filter-scroll') {
    await act(async () => { button('会话树').click() })
    await flush()
    const list = document.querySelector<HTMLDivElement>('div.font-mono')!
    assert.ok(list.scrollTop > 289 * 26, 'the default tree starts near its current final assistant row')
    assert.ok(list.textContent?.includes('assistant: 行2387'))
    assert.ok(observed.includes(list), 'the portal-mounted list is measured once it exists')
    // The other views fill in after an idle delay; that refresh must not drag a list the user moved.
    await act(async () => {
      list.scrollTop = 260
      list.dispatchEvent(new Event('scroll'))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    assert.equal(list.scrollTop, 260, 'the idle fill keeps the user scroll position')
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
    ['branch-none', 'tree: left click jumps directly without a summary'],
    ['branch-summary', 'tree: context menu summarizes before jumping'],
    ['branch-custom', 'tree: custom summary prompt requires and trims instructions'],
    ['branch-pending', 'tree: pending summary locks dismissal and duplicate requests with busy status'],
    ['branch-failure', 'tree: failed navigation shows the error and can retry or close'],
    ['branch-cancelled', 'tree: cancelled or stale navigation unlocks the tree'],
    ['branch-session-switch', 'tree: session switches invalidate the pending switch'],
    ['tree-view-tabs', 'tree: tabs switch the session view pi cycles with Ctrl+O'],
    ['tree-window-limits', 'tree: a long session mounts only the window it can show'],
    ['tree-deep-indent', 'tree: deep forks cap drawn indent so node text stays visible'],
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

import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import type { DreamRecord, DreamRequest, DreamStatus } from '../src/shared/dream'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-ui-fixture')) {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mock.module('../src/renderer/src/components/sidebar/ChatList', () => ({ ChatList: () => null }))
  mock.module('../src/renderer/src/components/sidebar/ProjectList', () => ({ ProjectList: () => null }))
  let status: DreamStatus = { state: 'idle', changes: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costKnown: true, requests: 0 }
  const starts: DreamRequest[] = []
  let stops = 0, reads = 0, resolveInitial!: (value: DreamStatus) => void
  const initial = new Promise<DreamStatus>(resolve => { resolveInitial = resolve })
  Object.assign(window, { api: {
    getMemorySettings: async () => ({ fileMemory: { enabled: true } }),
    dream: {
      list: async (offset?: number) => offset === 30 ? { items: [{ id: 'old-archived', topic: 'Archived clue', state: 'done', startedAt: 5, endedAt: 6 }] } : ({ nextOffset: 30, items: [
        { id: 'old-dream', topic: 'Earlier topic', state: 'done', startedAt: 1, endedAt: 2 },
        { id: 'old-repair', repair: true, state: 'done', startedAt: 3, endedAt: 4 }
      ] }),
      read: async (id: string): Promise<DreamRecord> => ({ ...status, id, repair: id === 'old-repair', topic: 'Earlier topic', state: 'done', report: '**Stored report**', usageIncomplete: true, costKnown: false, startedAt: 1, endedAt: 2 }),
      status: async () => ++reads === 1 ? initial : status,
      start: async (request: DreamRequest) => { starts.push(request); status = { ...status, id: 'run-id', sessionFile: 'session.jsonl', topic: 'topic' in request ? request.topic : undefined, repair: 'repair' in request, state: 'running', phase: 'searching', current: 'DETAILED SEARCH QUERY' }; return status },
      stop: async () => { stops++; status = { ...status, state: 'cancelled', phase: undefined }; return status }
    }
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useDreamStore } = await import('../src/renderer/src/stores/dream')
  const { DreamSettings, DreamDialogHost } = await import('../src/renderer/src/components/settings/DreamSettings')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
  useSettingsStore.setState({ locale: 'zh-CN', localeSetting: 'zh-CN', supportsGlass: true })
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  const toggleStatistics = async () => {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="统计"]')!.click())
    await flush()
  }
  try {
    await act(async () => root.render(h(TooltipProvider, null,
      h(Sidebar, { tab: 'chats', preferencesError: null, onOpenSettings: () => {} }),
      h(DreamSettings, { enabled: true }), h(DreamDialogHost))))
    await act(async () => button('做梦…').click()); await flush()
    assert.equal(reads, 1, 'the sidebar and dialog share one pending status read')
    await act(async () => { resolveInitial(status) }); await flush()
    assert.equal(starts.length, 0)
    assert.ok(document.querySelector('[data-dream-history]'))
    assert.ok(document.querySelector('[data-slot="dialog-description"]')!.classList.contains('sr-only'), 'the history subtitle is not visible')
    const historyRows = [...document.querySelectorAll<HTMLElement>('[data-dream-history-list] [data-dream-record]')]
    assert.equal(historyRows.length, 2)
    for (const row of historyRows) {
      assert.ok(row.hasAttribute('data-hover-highlight-row'))
      assert.ok(row.classList.contains('data-selected:bg-transparent!'), 'the moving highlight owns the row background')
      assert.ok(row.classList.contains('text-sm'), 'rows use the same font size as the provider chooser')
      assert.equal(row.getAttribute('data-slot'), 'command-item')
    }
    await act(async () => historyRows[0]!.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 }))); await flush()
    assert.ok(historyRows[0]!.hasAttribute('data-hover-highlight-target'))
    await act(async () => historyRows[1]!.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 40 }))); await flush()
    assert.ok(!historyRows[0]!.hasAttribute('data-hover-highlight-target'))
    assert.ok(historyRows[1]!.hasAttribute('data-hover-highlight-target'), 'the shared hover target moves between rows')
    for (const label of ['刷新', '新增做梦', '关闭']) {
      await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.focus()); await flush()
      assert.ok([...document.querySelectorAll('[role="tooltip"]')].some(tooltip => tooltip.textContent?.includes(label)), `${label} has a Tooltip`)
    }
    const search = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')!
    const searchFor = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, value)
        search.dispatchEvent(new Event('input', { bubbles: true }))
      }); await flush()
    }
    await searchFor('Archived clue')
    await flush()
    assert.ok(document.querySelector('[data-dream-record="old-archived"]'), 'search loads older pages rather than searching only the first page')
    await searchFor('NO MATCH FOR THIS QUERY')
    assert.match(document.querySelector('[data-slot="command-empty"]')!.textContent!, /没有匹配/)
    await searchFor('修复')
    assert.ok(document.querySelector('[data-dream-record="old-repair"]'), 'records can be searched by their displayed kind')
    assert.equal(document.querySelector('[data-dream-record="old-dream"]'), null)
    await searchFor('')
    assert.equal(document.querySelector('textarea'), null, 'settings opens the record list, not a new run')
    assert.match(document.querySelector('[data-dream-record="old-dream"]')!.textContent!, /做梦/)
    assert.match(document.querySelector('[data-dream-record="old-repair"]')!.textContent!, /修复/)
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="新增做梦"]')!.click()); await flush()
    assert.equal(button('开始做梦').disabled, true)
    const content = document.querySelector('[role="dialog"]')!
    const title = content.querySelector('[data-slot="dialog-title"]')!
    assert.ok(title.querySelector('[data-dream-title-icon] .lucide-moon'))
    assert.equal(title.querySelector('[data-dream-title-spinner]'), null)
    assert.ok(title.classList.contains('min-h-7') && title.classList.contains('items-center'))
    assert.ok(content.classList.contains('p-4'))
    assert.ok(content.classList.contains('gap-4'))
    assert.ok(!content.classList.contains('p-0') && !content.classList.contains('gap-0'))
    const header = content.querySelector('[data-slot="dialog-header"]')!
    assert.ok(![...header.classList].some(token => /^(?:px|pt|pb)-/.test(token)), 'header uses the shared dialog inset')
    const closeButton = content.querySelector('[data-slot="dialog-close"]')!
    assert.ok(closeButton.classList.contains('top-4') && closeButton.classList.contains('right-4'))
    assert.equal(content.querySelector('[data-slot="dialog-close"]')!.getAttribute('data-size'), 'icon-sm')
    const footer = document.querySelector('[role="dialog"] [data-slot="dialog-footer"]')!
    assert.ok(!footer.classList.contains('p-4'), 'the shared dialog provides the outer footer inset')
    assert.ok(footer.classList.contains('border-t'))
    assert.ok(![...footer.classList].some(token => token.includes('bg-')), 'the footer shares the dialog surface')
    assert.equal(button('关闭').getAttribute('data-variant'), 'ghost')
    assert.ok(!footer.classList.contains('-mx-4') && !footer.classList.contains('-mb-4'), 'footer retains the shared dialog inset')
    assert.equal(document.querySelector('[data-dream-status]'), null)
    assert.ok(!document.body.textContent?.includes('最近 7 天'))
    const input = document.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '  Permission lessons  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('开始做梦').click()); await flush()
    assert.deepEqual(starts, [{ topic: 'Permission lessons' }])
    assert.equal(document.querySelector('textarea'), null, 'running and result views are not the new-topic form')
    assert.match(document.body.textContent!, /可以关闭此窗口/)
    assert.match(document.body.textContent!, /搜索线索/)
    assert.match(document.querySelector('[data-dream-heading-status]')!.textContent!, /运行中.*搜索线索/)
    assert.ok(document.querySelector('[data-slot="dialog-header"]')!.contains(document.querySelector('[data-dream-heading-status]')))
    assert.match(document.querySelector('[data-dream-topic]')!.textContent!, /Permission lessons/)
    const topicCard = document.querySelector('[data-dream-topic]')!
    assert.equal(topicCard.getAttribute('data-slot'), 'alert')
    assert.ok(topicCard.classList.contains('items-center') && topicCard.classList.contains('gap-y-0'))
    const topicIcon = topicCard.querySelector('svg')!
    assert.ok(topicIcon.classList.contains('row-span-1!') && topicIcon.classList.contains('translate-y-0!'))
    assert.ok(!document.body.textContent?.includes('DETAILED SEARCH QUERY'))
    assert.ok(!document.body.textContent?.includes('正在按主题搜索、核实并维护相关记忆。'))
    assert.equal(document.querySelector('[data-dream-usage]'), null, 'statistics are hidden until requested')
    const statisticsButton = document.querySelector<HTMLButtonElement>('[aria-label="统计"]')!
    assert.ok(statisticsButton.classList.contains('right-12'))
    assert.ok(statisticsButton.classList.contains('top-4'))
    assert.ok(document.querySelector('[data-dream-title-icon] .lucide-moon'))
    assert.ok(document.querySelector('[data-dream-title-spinner]')!.classList.contains('animate-spin'))
    const indicator = document.querySelector<HTMLButtonElement>('[data-dream-status]')!
    assert.equal(indicator.getAttribute('data-running'), 'true')
    assert.equal(indicator.nextElementSibling?.getAttribute('role'), 'switch', 'Dream is immediately left of the glass/solid control')
    await act(async () => button('后台运行').click()); await flush()
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(stops, 0)
    await act(async () => indicator.click()); await flush()
    assert.match(document.body.textContent!, /Permission lessons/)
    assert.equal(starts.length, 1, 'reopening a running Dream never restarts it')
    await act(async () => button('停止').click()); await flush()
    assert.equal(stops, 1)
    assert.match(document.body.textContent!, /已停止/)
    const hash = 'a'.repeat(64)
    status = { ...status, state: 'done', current: 'STALE QUERY', report: '## Findings\n\n**Verified preference**\n\n- First clue\n- Second clue', requests: 27, input: 1371773,
      changes: ['global/MEMORY.md', `projects/${hash}/package-managers.md`] }
    await act(async () => { await useDreamStore.getState().refresh() }); await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    assert.equal(dialog.querySelector('textarea'), null)
    assert.ok(dialog.querySelector('[data-dream-title-icon] .lucide-moon'))
    assert.equal(dialog.querySelector('[data-dream-title-spinner]'), null)
    assert.equal(dialog.querySelector('[data-dream-usage]'), null)
    await toggleStatistics()
    const usage = document.querySelector('[data-slot="popover-content"] [data-dream-usage]')!
    assert.equal(usage.tagName, 'DL')
    assert.equal(usage.children.length, 7)
    for (const metric of usage.children) {
      assert.ok(metric.classList.contains('grid-cols-[minmax(0,1fr)_auto]'))
      assert.ok(metric.querySelector('dd')!.classList.contains('text-right'))
    }
    await toggleStatistics()
    assert.equal(document.querySelector('[data-dream-usage]'), null)
    assert.equal(dialog.querySelector('strong')?.textContent, 'Verified preference')
    assert.ok(dialog.querySelector('[data-dream-topic]')?.textContent?.includes('Permission lessons'))
    assert.ok(!dialog.textContent?.includes('STALE QUERY'))
    assert.ok(!dialog.textContent?.includes('单次上限'))
    const files = dialog.querySelector('[data-dream-changes]')!
    assert.match(files.textContent!, /package-managers.md/)
    assert.ok(!files.textContent?.includes(hash), 'long project hashes stay in tooltips, not the visible file name')
    assert.ok(!dialog.textContent?.includes('session.jsonl'))
    assert.ok(!dialog.textContent?.includes('完整会话已保存'))
    assert.equal(document.querySelector('[data-dream-status]')?.getAttribute('data-running'), 'false')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click()); await flush()
    assert.equal(document.querySelector('[data-dream-status]'), null, 'viewing and closing a Dream result dismisses its indicator')
    await act(async () => { await useDreamStore.getState().refresh() }); await flush()
    assert.equal(document.querySelector('[data-dream-status]'), null)
    await act(async () => useDreamStore.getState().openDialog(true)); await flush()
    await act(async () => button('新的主题').click()); await flush()
    assert.ok(document.querySelector('textarea'))
    assert.equal(document.querySelector('[data-dream-changes]'), null)
    assert.equal(starts.length, 1)
    await act(async () => useDreamStore.setState({ compose: false, status: { ...status, id: 'failed-run', state: 'error', error: 'DREAM_TOOL' } }))
    assert.ok(document.querySelector('[data-dream-problem]'))
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /DREAM_TOOL/)
    await act(async () => useDreamStore.setState({ status: { ...status, state: 'limited', error: 'DREAM_TOKEN_BUDGET',
      input: 1_000_000, cacheRead: 18_000_000, cacheWrite: 999_999, output: 1, costKnown: false,
      budgetStop: { kind: 'tokens', used: 20_000_000, limit: 20_000_000 } } }))
    const limited = document.querySelector('[role="dialog"]')!
    assert.match(limited.textContent!, /达到累计 tokens 上限：20,000,000 \/ 20,000,000/)
    await toggleStatistics()
    const popover = document.querySelector('[data-slot="popover-content"]')!
    const metrics = [...popover.querySelectorAll('[data-dream-usage] > div')].map(row => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent])
    assert.deepEqual(metrics, [['累计 tokens', '20,000,000'], ['模型请求', '27'], ['模型估算费用', '未知'], ['新输入', '1,000,000'], ['输出', '1'], ['缓存读取', '18,000,000'], ['缓存写入', '999,999']])
    assert.match(popover.querySelector('[data-dream-usage]')!.textContent!, /未知/)
    assert.ok(!popover.textContent?.includes('$0.0000'))
    await toggleStatistics()
    await act(async () => useDreamStore.setState({ status: { ...status, state: 'running', wrappingUp: 'tokens', phase: 'wrappingUp' } }))
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /停止扩大搜索/)
    status = { ...status, state: 'done', repair: true, id: 'repair-run' }
    await act(async () => useDreamStore.setState({ status }))
    assert.equal(document.querySelector('[data-slot="dialog-footer"]'), null, 'repair results have no bottom actions')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await flush()
    assert.ok(document.querySelector('[role="dialog"]'), 'repair details close only through the close icon')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click()); await flush()
    assert.equal(document.querySelector('[data-dream-status]'), null, 'viewing and closing a repair result dismisses the indicator')
    await act(async () => { await useDreamStore.getState().refresh() }); await flush()
    assert.equal(document.querySelector('[data-dream-status]'), null, 'polling the same result does not restore its indicator')
    await act(async () => button('做梦…').click()); await flush()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-dream-record="old-repair"]')!.click()); await flush()
    const recordDialog = document.querySelector('[role="dialog"]')!
    assert.equal(recordDialog.querySelector('[data-slot="dialog-footer"]'), null)
    assert.equal(recordDialog.querySelector('textarea'), null)
    assert.match(recordDialog.textContent!, /Stored report/)
    await toggleStatistics()
    const legacyUsage = document.querySelector('[data-dream-usage]')!
    assert.equal(legacyUsage.querySelector('dd')!.textContent, '未知')
    assert.match(document.querySelector('[data-slot="popover-content"]')!.textContent!, /旧记录未单独记录缓存用量/)
    await toggleStatistics()
    assert.equal(starts.length, 1, 'reading old records does not run the agent')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="返回记录"]')!.click()); await flush()
    assert.ok(document.querySelector('[data-dream-history]'))
    await act(async () => useDreamStore.getState().openDialog(true)); await flush()
    status = { ...status, id: 'next-repair', state: 'running', repair: true }
    await act(async () => useDreamStore.setState({ status }))
    assert.equal(document.querySelector('[data-slot="dialog-footer"]'), null)
    assert.ok(document.querySelector('[aria-label="停止"]'), 'running repair keeps a stop control in its header')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click()); await flush()
    assert.ok(document.querySelector('[data-dream-status]'), 'closing a running repair does not dismiss its indicator')
  } finally { await act(async () => root.unmount()); host.remove(); GlobalRegistrator.unregister() }
} else test('Dream sidebar status and shared dialog preserve background work and render a separate Markdown result', async () => {
  const result = await runSelf(import.meta.path, ['--dream-ui-fixture'], { timeoutMs: 15000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})

import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import type { DreamRequest, DreamStatus } from '../src/shared/dream'
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
      status: async () => ++reads === 1 ? initial : status,
      start: async (request: DreamRequest) => { starts.push(request); status = { ...status, id: 'run-id', sessionFile: 'session.jsonl', topic: request.topic, state: 'running', phase: 'searching', current: 'DETAILED SEARCH QUERY' }; return status },
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
    await act(async () => button('新的主题').click()); await flush()
    assert.ok(document.querySelector('textarea'))
    assert.equal(document.querySelector('[data-dream-changes]'), null)
    assert.equal(starts.length, 1)
    await act(async () => useDreamStore.setState({ compose: false, status: { ...status, state: 'error', error: 'DREAM_TOOL' } }))
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
  } finally { await act(async () => root.unmount()); host.remove(); GlobalRegistrator.unregister() }
} else test('Dream sidebar status and shared dialog preserve background work and render a separate Markdown result', async () => {
  const result = await runSelf(import.meta.path, ['--dream-ui-fixture'], { timeoutMs: 15000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})

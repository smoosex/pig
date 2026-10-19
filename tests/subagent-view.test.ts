import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SubagentInfo } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Reflect.deleteProperty(Element.prototype, 'animate')
  Object.assign(window, { api: { onSubagentsChanged: () => () => {}, listSubagents: async () => [] } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSubagentStore: store } = await import('../src/renderer/src/stores/subagents')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { SpawnToolBody } = await import('../src/renderer/src/components/subagents/SubagentLinks')
  const { SubagentStatus } = await import('../src/renderer/src/components/composer/SubagentStatus')
  useSettingsStore.setState({ locale: 'en' })
  const item: SubagentInfo = {
    id: 'child', parentSessionId: 'parent', title: 'Historical task', prompt: 'test', toolCallId: 'call',
    background: true, status: 'completed', createdAt: 1, turns: 0, maxTurns: 0,
    turnTools: [], toolCounts: {}, editedFiles: [], tokens: { input: 0, output: 0 }, cost: 0, cleared: true
  }
  store.setState({ bySession: { parent: [item] }, card: null, clearing: null })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const view = () => host.querySelector<HTMLButtonElement>('[data-tool-row] button')!
  try {
    await act(async () => {
      root.render(h(TooltipProvider, { children: h('div', null,
        h('div', { 'data-tool-row': true }, h(SpawnToolBody, { toolCallId: 'call' })),
        h('div', { 'data-footer': true }, h(SubagentStatus, { sessionId: 'parent' }))) }))
    })
    assert.equal(host.querySelector('[data-subagent-status]'), null)
    await act(async () => { view().click() })
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    assert.ok(popup?.querySelector('[data-subagent-selected="child"]'))
    assert.equal(view().getAttribute('aria-expanded'), 'true')
    assert.equal(view().getAttribute('aria-controls'), popup.id, 'historical content is anchored to View itself')
    assert.equal(popup.querySelector('[aria-label="Switch subagent"]'), null)
    assert.equal(host.querySelector('[data-subagent-status]'), null, 'viewing cleared history never resurrects the footer status')
    assert.equal(store.getState().card, null)
    await act(async () => { popup.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click() })
    assert.equal(view().getAttribute('aria-expanded'), 'false')

    const other: SubagentInfo = { ...item, id: 'other', toolCallId: 'other-call', title: 'Other active task', status: 'running', cleared: false }
    await act(async () => { store.getState().apply({ parentSessionId: 'parent', subagents: [item, other] }) })
    await act(async () => { view().click() })
    assert.equal(view().getAttribute('aria-expanded'), 'true', 'cleared history stays local even if a different child is active')
    assert.equal(document.querySelector('[aria-label="Switch subagent"]'), null)
    assert.equal(host.querySelector('[data-subagent-status]')?.getAttribute('aria-expanded'), 'false')
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click() })

    const statuses = ['running', 'queued', 'completed', 'failed', 'timeout', 'turn_limit', 'aborted', 'interrupted'] as const
    const mixed = statuses.map((status) => ({ ...item, id: status, toolCallId: status, status, cleared: false }))
    await act(async () => {
      store.getState().apply({ parentSessionId: 'parent', subagents: [item, ...mixed] })
    })
    const statusButton = host.querySelector<HTMLButtonElement>('[data-subagent-status]')!
    assert.equal(statusButton.textContent, '', 'the footer is icon-only')
    assert.equal(statusButton.querySelector('[data-subagent-ring]')?.getAttribute('data-running'), 'true')
    assert.ok(statusButton.querySelector('[data-subagent-problem]'), 'problems remain visible without hovering')
    await act(async () => { statusButton.focus() })
    const tooltip = document.querySelector('[data-slot="tooltip-content"]')!
    assert.ok(tooltip, 'focusing the icon shows the same details as hovering')
    const expected = 'subagent: working x 1 | Queued x 1 | Done x 1 | Failed x 1 | Timed out x 1 | Turn limit x 1 | Stopped x 1 | Interrupted x 1'
    assert.equal(tooltip.firstChild?.textContent, expected, 'one-line summary distinguishes terminal states and excludes cleared history')
    assert.equal(statusButton.getAttribute('aria-label'), expected)
    await act(async () => { statusButton.click() })
    assert.equal(store.getState().card?.id, 'running', 'the icon still opens the existing task card')
    assert.ok(document.querySelector('[data-subagent-selected="running"]'))
    assert.equal(document.querySelector('[data-slot="tooltip-content"]'), null, 'tooltip does not cover the task card')
    await act(async () => {
      statusButton.blur()
      store.getState().closeCard()
      store.getState().apply({ parentSessionId: 'parent', subagents: [{ ...item, status: 'queued', cleared: false }] })
    })
    assert.equal(statusButton.querySelector('[data-subagent-ring]')?.getAttribute('data-running'), 'false', 'queued-only work does not animate')
    assert.equal(statusButton.querySelector('[data-subagent-problem]'), null)
    await act(async () => { statusButton.focus() })
    assert.equal(document.querySelector('[data-slot="tooltip-content"]')?.firstChild?.textContent, 'subagent: Queued x 1', 'only nonzero statuses are shown')
    await act(async () => {
      useSettingsStore.setState({ locale: 'zh-CN' })
      store.getState().apply({ parentSessionId: 'parent', subagents: [
        { ...item, id: 'working', status: 'running', cleared: false },
        { ...item, id: 'done-1', cleared: false },
        { ...item, id: 'done-2', cleared: false }
      ] })
    })
    assert.equal(document.querySelector('[data-slot="tooltip-content"]')?.firstChild?.textContent, '子代理: 运行中 x 1 | 已完成 x 2')
    await act(async () => { statusButton.blur(); useSettingsStore.setState({ locale: 'en' }) })

    for (const status of ['running', 'completed'] as const) {
      await act(async () => {
        store.getState().closeCard()
        store.getState().apply({ parentSessionId: 'parent', subagents: [{ ...item, status, cleared: false }] })
      })
      await act(async () => { view().click() })
      assert.equal(store.getState().card?.id, item.id)
      assert.equal(host.querySelector('[data-subagent-status]')?.getAttribute('aria-expanded'), 'true')
      assert.ok(document.querySelector('[aria-label="Switch subagent"]'), 'active and uncleared completed tasks use the footer switcher')
      assert.equal(host.querySelector('[data-subagent-ring]')?.getAttribute('data-running'), String(status === 'running'))
    }
  } finally {
    await act(async () => { root.unmount(); store.getState().closeCard() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('View anchors cleared history locally without resurrecting the footer or switcher', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally {
    clearTimeout(timer)
  }
}, 15_000)

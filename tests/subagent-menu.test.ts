import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SubagentInfo } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // Happy DOM rejects cancelled WAAPI promises; exercise Motion's JS fallback instead.
  Reflect.deleteProperty(Element.prototype, 'animate')
  const stopped: string[] = []
  const cleared: string[] = []
  let onClear = () => {}
  Object.assign(window, { api: {
    abortAllSubagents: async (id: string) => { stopped.push(id) },
    clearFinishedSubagents: async (id: string) => { cleared.push(id); onClear() }
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { SubagentCard } = await import('../src/renderer/src/components/subagents/SubagentCard')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const card = (items: SubagentInfo[], selected: SubagentInfo) => h(TooltipProvider, { delayDuration: 0, children: h(SubagentCard, { sessionId: 'parent', items, selected }) })
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en' })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const done: SubagentInfo = {
    id: 'done', parentSessionId: 'parent', title: 'Finished child', prompt: 'test', toolCallId: 'call',
    background: true, status: 'completed', createdAt: 1, turns: 0, maxTurns: 0,
    turnTools: [], toolCounts: {}, editedFiles: [], tokens: { input: 0, output: 0 }, cost: 0
  }
  const running: SubagentInfo = { ...done, id: 'running', title: 'Running child', status: 'running' }
  try {
    await act(async () => { root.render(card([done, running], done)) })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Switch subagent"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!
    assert.ok(menu)
    assert.ok(menu.classList.contains('no-drag'), 'a menu overlapping the title bar must remain clickable instead of dragging the window')
    const stop = menu.querySelector<HTMLButtonElement>('button[aria-label="Stop all"]')!
    assert.ok(stop?.querySelector('.lucide-circle-stop'))
    assert.equal(stop.textContent, '', 'the action is icon-only')
    assert.ok(stop.parentElement?.querySelector('[data-slot="dropdown-menu-label"]'), 'the button shares the menu title row')
    assert.equal(menu.querySelectorAll('[aria-label="Stop all"]').length, 1)
    const clear = menu.querySelector<HTMLButtonElement>('button[aria-label="Clear finished"]')!
    assert.ok(clear?.querySelector('.lucide-circle-check'))
    assert.equal(clear.textContent, '')
    for (const button of [stop, clear]) {
      assert.equal(button.hasAttribute('title'), false)
      assert.ok(button.classList.contains('size-5'))
      assert.ok(button.querySelector('svg')?.classList.contains('size-3.5'))
    }
    assert.deepEqual([...stop.parentElement!.querySelectorAll('button')], [stop, clear], 'clear follows stop in the title row')
    await act(async () => {
      clear.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Clear finished')
    await act(async () => { clear.click() })
    assert.deepEqual(cleared, ['parent'])
    await act(async () => { stop.click() })
    assert.deepEqual(stopped, ['parent'])
    assert.ok(document.querySelector('[data-slot="dropdown-menu-content"]'), 'stopping does not dismiss the switcher')
    await act(async () => { root.render(card([done], done)) })
    assert.equal(menu.querySelector('[aria-label="Stop all"]'), null, 'the button disappears when no children are active')
    assert.ok(menu.querySelector('button[aria-label="Clear finished"]'))
    await act(async () => { root.render(card([running], running)) })
    assert.equal(menu.querySelector('[aria-label="Clear finished"]'), null, 'clear is hidden when nothing has finished')
    assert.ok(menu.querySelector('button[aria-label="Stop all"]'))

    const { useSubagentStore: store } = await import('../src/renderer/src/stores/subagents')
    function ConnectedCard() {
      const state = store()
      const items = state.bySession.parent
      const selected = items?.find((item) => item.id === state.card?.id)
      return selected ? card(items, selected) : h('p', { 'data-card-closed': true }, 'Closed')
    }
    await act(async () => {
      store.setState({ bySession: { parent: [done, running] }, card: { sessionId: 'parent', id: done.id }, clearing: null })
      root.render(h(ConnectedCard))
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Switch subagent"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const liveMenu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!
    onClear = () => { throw new Error('Clear failed') }
    await act(async () => { liveMenu.querySelector<HTMLButtonElement>('[aria-label="Clear finished"]')!.click() })
    assert.equal(store.getState().clearing, null, 'a failed request must not start a presentation transition')
    assert.equal(store.getState().card?.id, done.id)

    onClear = () => store.getState().apply({ parentSessionId: 'parent', subagents: store.getState().bySession.parent.map((item) => item.status === 'completed' ? { ...item, cleared: true } : item) })
    await act(async () => { liveMenu.querySelector<HTMLButtonElement>('[aria-label="Clear finished"]')!.click() })
    assert.equal(host.querySelector('[data-subagent-clear-phase]')?.getAttribute('data-subagent-clear-phase'), 'removing')
    assert.equal(store.getState().card?.id, done.id)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    assert.equal(host.querySelector('[data-subagent-selected]')?.getAttribute('data-subagent-selected'), running.id)
    assert.equal(document.querySelector('[data-slot="dropdown-menu-content"]'), liveMenu, 'switching to a running child preserves the open menu')

    await act(async () => { store.getState().apply({ parentSessionId: 'parent', subagents: [{ ...done, cleared: true }, { ...running, status: 'completed' }] }) })
    await act(async () => { liveMenu.querySelector<HTMLButtonElement>('[aria-label="Clear finished"]')!.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
    assert.ok(host.textContent?.includes('All finished tasks cleared'))
    assert.ok(liveMenu.textContent?.includes('All finished tasks cleared'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
    assert.ok(host.querySelector('[data-card-closed]'))
    assert.equal(document.querySelector('[data-slot="dropdown-menu-content"]'), null)
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('subagent switcher puts stop-all in an icon button beside its title only while active', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally {
    clearTimeout(timer)
  }
}, 15_000)

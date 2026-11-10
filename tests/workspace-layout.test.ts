/** Settings replace the main content while shared rail widths animate in all four sidebar states. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h, useState } = await import('react')
  const { createPortal } = await import('react-dom')
  const { createRoot } = await import('react-dom/client')
  const { WorkspaceLayout } = await import('../src/renderer/src/components/WorkspaceLayout')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const renderSettings = (target: HTMLElement | null) => h('div', { 'data-settings-body': '' },
    target ? createPortal(h('nav', null, 'Settings navigation'), target) : null)
  function Sidebar() {
    const [value, setValue] = useState(0)
    return h('button', { 'data-sidebar-state': '', onClick: () => setValue(value + 1) }, value)
  }
  const render = async (leftCollapsed: boolean, rightCollapsed: boolean, settingsOpen: boolean, floating = false) => {
    await act(async () => root.render(h(WorkspaceLayout, {
      settingsOpen, leftCollapsed, rightCollapsed,
      leftFloating: floating && leftCollapsed, rightFloating: floating && rightCollapsed,
      left: h(Sidebar), right: h('aside', { 'data-right-sidebar': '' }, 'Files'), renderSettings,
      children: h('main', null, 'Workspace')
    })))
  }
  const rail = (side: string) => host.querySelector<HTMLElement>(`[data-workspace-${side}-rail]`)!
  const width = (side: string, expanded: boolean) => {
    const element = rail(side)
    assert.ok(element.classList.contains(expanded ? 'w-62' : 'w-0'))
    assert.ok(element.classList.contains('transition-[width]'))
    assert.ok(element.classList.contains('duration-200'))
    assert.ok(element.classList.contains('motion-reduce:transition-none'))
  }
  const widthOnly = () => {
    for (const element of host.querySelectorAll<HTMLElement>('[class]')) {
      assert.ok(!/opacity|translate|transform/.test(element.className), 'only rail widths animate, never content position or opacity')
    }
  }
  try {
    for (const leftCollapsed of [false, true]) {
      for (const rightCollapsed of [false, true]) {
        await render(leftCollapsed, rightCollapsed, false)
        const left = rail('left'), right = rail('right')
        const sidebar = host.querySelector<HTMLButtonElement>('[data-sidebar-state]')!
        const rightSidebar = host.querySelector('[data-right-sidebar]')!
        const navigation = host.querySelector<HTMLElement>('[data-settings-navigation]')!
        const center = host.querySelector<HTMLElement>('[data-workspace-center]')!
        await act(async () => sidebar.click())
        const value = sidebar.textContent
        width('left', !leftCollapsed)
        width('right', !rightCollapsed)
        assert.ok(navigation.classList.contains('hidden'))
        widthOnly()

        await render(leftCollapsed, rightCollapsed, true)
        assert.equal(rail('left'), left)
        assert.equal(rail('right'), right)
        width('left', true)
        width('right', false)
        assert.equal(sidebar.textContent, value, 'switching settings does not reset the original list')
        assert.equal(host.querySelector('[data-right-sidebar]'), rightSidebar)
        assert.ok((sidebar.parentElement as HTMLElement).classList.contains('hidden'))
        assert.ok(navigation.classList.contains('flex') && navigation.classList.contains('left-0'))
        assert.ok(left.classList.contains('overflow-hidden'), 'the expanding left rail reveals its stationary menu')
        assert.ok(navigation.querySelector('nav'), 'the menu uses the existing left rail, not a second column')
        assert.equal(center.querySelector('nav'), null)
        assert.equal(center.querySelector('main'), null, 'main switches to settings immediately')
        assert.equal(center.firstElementChild, host.querySelector('[data-settings-body]'), 'settings participate in main flex layout rather than an animated overlay')
        assert.ok(right.inert)
        widthOnly()

        await render(leftCollapsed, rightCollapsed, false)
        width('left', !leftCollapsed)
        width('right', !rightCollapsed)
        assert.equal(right.inert, false)
        assert.ok(center.querySelector('main'), 'the workspace returns immediately while rail widths restore')
        assert.equal(host.querySelector('[data-settings-body]'), null)
        assert.equal(navigation.querySelector('nav'), null, 'no outgoing settings menu remains over the workspace')
        assert.ok(navigation.classList.contains('hidden'))
        assert.ok((sidebar.parentElement as HTMLElement).classList.contains('flex'))
        assert.equal(host.querySelector('[data-sidebar-overlay]'), null, 'no delayed settings overlay blocks returning native pages')
        assert.equal(host.querySelector('[data-sidebar-state]'), sidebar)
        widthOnly()
      }
    }
    await render(true, true, false, true)
    assert.ok(rail('left').classList.contains('overflow-visible'))
    assert.ok(rail('right').classList.contains('overflow-visible'))
    assert.ok(host.querySelector<HTMLElement>('[data-settings-navigation]')!.classList.contains('hidden'))
    await render(true, true, true, true)
    assert.ok(rail('left').classList.contains('overflow-hidden'))
    assert.ok(rail('right').classList.contains('overflow-hidden'))
    await render(true, true, false)
    await render(true, true, true)
    assert.ok(host.querySelector('[data-settings-body]'), 'rapid reopening uses the current mode without delayed transition state')
    width('left', true)
    width('right', false)
    widthOnly()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else test('settings replace main immediately and animate only rail widths across all four sidebar combinations', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 8000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 10000)

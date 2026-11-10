/**
 * The sidebar shows one list at a time: the projects half its project list, the chats half the chat
 * list plus the header action that starts a new one.
 */
import { afterEach, describe, mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import type { SurfaceStyle } from '../src/shared/api'

// The store graph reads window.api the first time it is evaluated and that evaluation is shared
// across test files, so this one pins the module rather than freezing `undefined` for everyone.
mock.module('../src/renderer/src/ipc/api', () => ({
  api: { supportsGlass: true }
}))
mock.module('../src/renderer/src/components/sidebar/ProjectList', () => ({
  ProjectList: () => createElement('div', { 'data-stub': 'project-list' })
}))
mock.module('../src/renderer/src/components/sidebar/ChatList', () => ({
  ChatList: () => createElement('div', { 'data-stub': 'chat-list' })
}))
mock.module('../src/renderer/src/components/diff/ChangesPanel', () => ({
  ChangesPanel: () => createElement('div', { 'data-stub': 'changes-panel' })
}))

let domReady = false
let domOurs = false
async function ensureDom(): Promise<void> {
  if (domReady) return
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  try {
    GlobalRegistrator.register({ url: 'http://localhost' })
    domOurs = true
  } catch {
    // Another fixture in this process holds the document; the containers below keep this scoped.
    domOurs = false
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  domReady = true
}

afterEach(async () => {
  if (!domReady || !domOurs) return
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  await GlobalRegistrator.unregister()
  domReady = false
  domOurs = false
})

describe('sidebar list per half', () => {
  test('settings replacement removes the rail immediately and restores it without changing its width or list', async () => {
    await ensureDom()
    const { act, createElement: h } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
    const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      for (const hidden of [false, true]) {
        const render = async (replaced: boolean) => {
          await act(async () => root.render(h(TooltipProvider, null,
            h(Sidebar, { hidden, replaced, onOpenSettings: () => {}, tab: 'projects', preferencesError: null })
          )))
        }
        await render(false)
        const rail = container.querySelector('aside')!
        const list = container.querySelector('[data-stub="project-list"]')!
        const width = hidden ? 'w-0' : 'w-62'
        for (const replaced of [true, false]) {
          await render(replaced)
          assert.equal(container.querySelector('aside'), rail)
          assert.equal(container.querySelector('[data-stub="project-list"]'), list, 'replacement preserves list state')
          assert.equal(rail.classList.contains('hidden'), replaced, 'page switching uses display, not a width transition')
          assert.equal(rail.classList.contains('flex'), !replaced)
          assert.ok(rail.classList.contains(width), 'settings do not change the saved rail width')
          assert.equal(rail.getAttribute('aria-hidden'), String(hidden || replaced))
          assert.equal(rail.inert, hidden || replaced)
        }
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  test('floating sidebars close without a width transition; docked sidebars retain it', async () => {
    await ensureDom()
    const { act, createElement: h } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
    const { WorkspacePanel } = await import('../src/renderer/src/components/panel/WorkspacePanel')
    const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      for (const floating of [false, true]) {
        await act(async () => root.render(h(TooltipProvider, null,
          h(Sidebar, { hidden: true, floating, onOpenSettings: () => {}, tab: 'projects', preferencesError: null }),
          h(WorkspacePanel, { cwd: '/sidebar-transition-test', hidden: true, floating })
        )))
        const rails = container.querySelectorAll('aside')
        assert.equal(rails.length, 2)
        for (const rail of rails) {
          assert.ok(rail.classList.contains('w-0'))
          assert.equal(rail.classList.contains('transition-[width,background-color]'), !floating)
          assert.equal(rail.classList.contains('transition-[background-color]'), floating,
            'a floating rail must reach zero width as soon as its occlusion marker is removed')
        }
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
  test('each half renders only its own list and action', async () => {
    await ensureDom()
    const { act, createElement: h } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
    const originalSettings = useSettingsStore.getState()
    const styleChanges: SurfaceStyle[] = []
    useSettingsStore.setState({
      localeSetting: 'zh-CN', locale: 'zh-CN', surfaceStyle: 'glass', supportsGlass: true, error: null,
      setTheme: async (patch) => {
        if (!patch.surfaceStyle) return
        styleChanges.push(patch.surfaceStyle)
        useSettingsStore.setState({ surfaceStyle: patch.surfaceStyle })
      }
    })
    const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
    const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')

    for (const tab of ['projects', 'chats'] as const) {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          h(TooltipProvider, null, h(Sidebar, { onOpenSettings: () => {}, tab, preferencesError: null }))
        )
      })
      const highlight = container.querySelector('span.will-change-transform')!
      assert.ok(highlight.classList.contains('bg-sidebar-foreground/6'), 'sidebar rows share a sliding foreground tint')
      assert.ok(!highlight.className.includes('backdrop-blur'))
      assert.ok(highlight.classList.contains('solid:bg-sidebar-accent'), 'both styles keep the same sliding layer')
      const sidebar = container.querySelector('aside')!
      assert.ok(sidebar.classList.contains('solid:bg-sidebar'))
      assert.ok(sidebar.classList.contains('w-62'), 'both sidebars share the same width utility')
      assert.ok(sidebar.firstElementChild!.classList.contains('w-62'))
      const switcher = container.querySelector<HTMLButtonElement>('button[role=switch][aria-label="界面风格"]')!
      assert.equal(switcher.getAttribute('aria-checked'), 'true')
      const before = styleChanges.length
      await act(async () => { switcher.click() })
      assert.equal(switcher.getAttribute('aria-checked'), 'false')
      await act(async () => { switcher.click() })
      assert.deepEqual(styleChanges.slice(before), ['solid', 'glass'])
      assert.equal(switcher.getAttribute('aria-checked'), 'true')
      await act(async () => { useSettingsStore.setState({ supportsGlass: false, surfaceStyle: 'solid' }) })
      assert.equal(container.querySelector('[aria-label="界面风格"]'), null, 'unsupported platforms never offer a material switch')
      await act(async () => { useSettingsStore.setState({ supportsGlass: true, surfaceStyle: 'glass' }) })
      const actions = container.querySelectorAll('button[aria-label="设置"], button[aria-label="打开项目"]')
      assert.equal(actions.length, 2)
      for (const button of actions) {
        assert.ok(button.classList.contains('hover:bg-sidebar-foreground/6!'))
        assert.ok(button.classList.contains('duration-100'))
        assert.ok(!button.className.includes('backdrop-blur'))
      }
      assert.equal(
        container.querySelector('[data-stub="project-list"]') !== null,
        tab === 'projects',
        `${tab} tab project list`
      )
      assert.equal(
        container.querySelector('[data-stub="chat-list"]') !== null,
        tab === 'chats',
        `${tab} tab chat list`
      )
      assert.equal(
        container.querySelector('button[aria-label="新建对话"]') !== null,
        tab === 'chats',
        `${tab} tab new-chat action`
      )
      await act(async () => { root.unmount() })
      container.remove()
    }
    useSettingsStore.setState({
      setTheme: originalSettings.setTheme,
      supportsGlass: originalSettings.supportsGlass,
      surfaceStyle: originalSettings.surfaceStyle
    })
  })
})

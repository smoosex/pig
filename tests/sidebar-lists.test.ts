/**
 * The sidebar shows one list at a time: the projects half its project list, the chats half the chat
 * list plus the header action that starts a new one.
 */
import { afterEach, describe, mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { DEFAULT_REVIEW_WIDTH, MAX_REVIEW_WIDTH, MIN_REVIEW_WIDTH, type SurfaceStyle } from '../src/shared/api'

// The store graph reads window.api the first time it is evaluated and that evaluation is shared
// across test files, so this one pins the module rather than freezing `undefined` for everyone.
mock.module('../src/renderer/src/ipc/api', () => ({
  api: { supportsGlass: true },
  DEFAULT_REVIEW_WIDTH,
  MAX_REVIEW_WIDTH,
  MIN_REVIEW_WIDTH
}))
mock.module('../src/renderer/src/components/sidebar/ProjectList', () => ({
  ProjectList: () => createElement('div', { 'data-stub': 'project-list' })
}))
mock.module('../src/renderer/src/components/sidebar/ChatList', () => ({
  ChatList: () => createElement('div', { 'data-stub': 'chat-list' })
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
      assert.ok(container.querySelector('aside')!.classList.contains('solid:bg-sidebar'))
      const switcher = container.querySelector<HTMLElement>('[data-slot=toggle-group][aria-label="界面风格"]')!
      assert.equal(switcher.getAttribute('data-size'), 'xs')
      const [glass, solid] = [...switcher.querySelectorAll<HTMLButtonElement>('button')]
      assert.deepEqual([glass.textContent, solid.textContent], ['glass', 'solid'])
      assert.equal(glass.getAttribute('data-state'), 'on')
      const before = styleChanges.length
      await act(async () => { glass.click() })
      assert.equal(styleChanges.length, before, 'the active style cannot be deselected')
      await act(async () => { solid.click() })
      assert.equal(solid.getAttribute('data-state'), 'on')
      await act(async () => { glass.click() })
      assert.deepEqual(styleChanges.slice(before), ['solid', 'glass'])
      assert.equal(glass.getAttribute('data-state'), 'on')
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

/** Glass changes local surfaces, never pane ownership, editor drafts or reading-tab backings. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { GroupProps, PanelProps } from 'react-resizable-panels'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'

async function fixture(scenario: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const noop = () => {}
  Object.assign(window, { api: {
    supportsGlass: true,
    onMcpChanged: () => noop,
    onNotificationClick: () => noop,
    getCommands: async () => [],
    onPluginsChanged: () => noop
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore: settings } = await import('../src/renderer/src/stores/settings')
  const { useSessionsStore: sessions } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const tabs: OpenTab[] = [
    { id: 'chat', kind: 'chat', cwd: '/chats/a', title: 'Chat', loadState: 'ready' },
    { id: 'project', kind: 'project', cwd: '/p', title: 'Project', loadState: 'ready' },
    { id: 'file', kind: 'file', cwd: '/p', path: 'a.ts', title: 'a.ts', loadState: 'ready' },
    { id: 'diff', kind: 'diff', cwd: '/p', title: 'Changes', loadState: 'ready' }
  ]
  sessions.setState({
    openTabs: tabs, activeTabId: 'chat', currentProjectCwd: null,
    runtime: { chat: emptyRuntime(), project: emptyRuntime() }, loadChats: async () => {}
  })
  settings.setState({ locale: 'en', localeSetting: 'en', loaded: true, beamBorderEnabled: false, load: async () => {} })
  const { applyDocumentTheme } = await import('../src/renderer/src/lib/theme')
  const theme = (surfaceStyle: 'glass' | 'solid', appearance: 'light' | 'dark', palette: 'pig' | 'everforest') => {
    const prefs = { surfaceStyle, appearance, lightTheme: palette, darkTheme: palette }
    settings.setState(prefs)
    applyDocumentTheme(prefs)
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    if (scenario === 'canvas') {
      for (const name of ['useEventBridge', 'useSessionNames', 'useSessionWindows', 'useWorktreeDeletions', 'useModelCatalog']) {
        mock.module(`../src/renderer/src/hooks/${name}`, () => ({ [name]: noop }))
      }
      mock.module('../src/renderer/src/components/sidebar/use-sidebar-preferences', () => ({
        useSidebarPreferences: () => ({ tab: 'chats', setTab: noop, ready: false, error: null })
      }))
      for (const [path, name] of [
        ['Sidebar', 'Sidebar'], ['Composer', 'Composer'], ['SessionGreeting', 'SessionGreeting'],
        ['ChatView', 'ChatView'], ['diff/ChangesView', 'ChangesView'], ['settings/SettingsPage', 'SettingsPage'],
        ['panel/WorkspacePanel', 'WorkspacePanel'], ['ProjectSessionHome', 'ProjectSessionHome'],
        ['SystemPluginUI', 'SystemPluginUI'], ['ExtensionUI', 'ExtensionUI'], ['ui/googly-eyes-button', 'GooglyEyesButton']
      ]) {
        mock.module(`../src/renderer/src/components/${path}`, () => ({ [name]: () => h('div', { 'data-view': name }) }))
      }
      mock.module('../src/renderer/src/components/files/FileView', () => ({ default: () => h('div', { 'data-view': 'FileView' }) }))
      mock.module('../src/renderer/src/lib/highlight', () => ({ prewarmHighlighter: async () => {} }))
      Object.assign(globalThis, { requestIdleCallback: () => 0, cancelIdleCallback: noop })
      mock.module('react-resizable-panels', () => ({
        Group: (props: GroupProps) => h('div', null, props.children),
        Panel: (props: PanelProps) => h('div', null, props.children),
        Separator: () => null
      }))
      const { useDiffStore } = await import('../src/renderer/src/stores/diff')
      useDiffStore.setState({ loadReviewPrefs: async () => {} })
      const { useSplitLayoutStore: split } = await import('../src/renderer/src/stores/split-layout')
      const { default: App } = await import('../src/renderer/src/App')
      await act(async () => { theme('glass', 'light', 'pig'); root.render(h(App)) })
      const surface = host.querySelector<HTMLElement>('[data-content-surface]')!
      const chat = host.querySelector('[data-view="ChatView"]')
      const windowSurface = host.querySelector<HTMLElement>('[data-app-surface]')!
      assert.ok(windowSurface.classList.contains('bg-glass-window-background/10'))
      assert.ok(windowSurface.classList.contains('solid:bg-background'))
      assert.ok(!windowSurface.classList.contains('bg-background/10'), 'theme tint cannot leak through the neutral chat material')
      assert.ok(surface.classList.contains('bg-glass-background'))
      assert.ok(surface.classList.contains('backdrop-blur-xl'))
      assert.ok(surface.classList.contains('shadow-glass-panel'))
      assert.ok(surface.classList.contains('ring-glass-border'))
      assert.ok(surface.classList.contains('solid:bg-chat-background'))
      assert.ok(surface.classList.contains('solid:backdrop-blur-none'))
      assert.ok(surface.classList.contains('solid:shadow-md'))
      assert.ok(surface.classList.contains('solid:ring-0'))
      assert.ok(!surface.classList.contains('bg-chat-background'))
      assert.ok(surface.classList.contains('transition-[background-color,box-shadow,backdrop-filter]'))
      assert.ok(surface.classList.contains('duration-200'))
      assert.ok(surface.classList.contains('motion-reduce:transition-none'))
      assert.ok(!surface.className.includes('opacity-'))
      const activeTab = host.querySelector<HTMLElement>('.group\\/tab.bg-foreground\\/12')!
      assert.ok(activeTab.classList.contains('solid:bg-card'))
      for (const palette of ['pig', 'everforest'] as const) {
        for (const appearance of ['light', 'dark'] as const) {
          for (const style of ['solid', 'glass'] as const) {
            await act(async () => { theme(style, appearance, palette) })
            assert.equal(host.querySelector('[data-content-surface]'), surface)
            assert.equal(host.querySelector('[data-view="ChatView"]'), chat)
            assert.equal(document.documentElement.dataset.surfaceStyle, style)
          }
        }
      }
      for (const id of ['file', 'diff']) {
        await act(async () => { sessions.setState({ activeTabId: id }) })
        assert.ok(surface.classList.contains('bg-chat-background'), `${id} preserves the opaque reading surface`)
        assert.ok(!surface.classList.contains('bg-glass-background'))
        assert.ok(!surface.classList.contains('backdrop-blur-xl'))
        assert.ok(surface.classList.contains('shadow-md'))
        assert.ok(host.querySelector(`[data-view="${id === 'file' ? 'FileView' : 'ChangesView'}"]`))
      }
      await act(async () => {
        const pane = split.getState().initLayout('chat')
        split.getState().splitPane(pane, 'project', 'right')
        split.getState().splitPane(pane, 'file', 'bottom')
        split.getState().splitPane(pane, 'diff', 'left')
      })
      assert.ok(surface.classList.contains('bg-glass-background'), 'a selected reading tab cannot replace the shared material in a mixed split')
      assert.equal(host.querySelectorAll('.backdrop-blur-xl').length, 1, 'mixed panes share one material layer')
      const panes = [...host.querySelectorAll<HTMLElement>('[data-split-pane]')]
      assert.equal(panes.length, 4)
      assert.equal(panes.filter((pane) => pane.classList.contains('bg-transparent')).length, 2)
      assert.equal(panes.filter((pane) => pane.classList.contains('bg-card')).length, 2)
      for (const pane of panes) {
        assert.ok(pane.classList.contains('duration-200'))
        assert.ok(!pane.className.includes('opacity-') && !pane.className.includes('backdrop-'))
      }
      await act(async () => { theme('solid', 'dark', 'everforest') })
      assert.deepEqual([...host.querySelectorAll('[data-split-pane]')], panes, 'changing materials never remounts panes')
    } else if (scenario === 'composer') {
      const { Composer } = await import('../src/renderer/src/components/Composer')
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      await act(async () => {
        theme('glass', 'light', 'pig')
        root.render(h(TooltipProvider, null, h<NonNullable<Parameters<typeof Composer>[0]>>(Composer, { explicitSessionId: 'chat', isActive: false })))
      })
      const group = host.querySelector<HTMLElement>('[data-slot="input-group"]')!
      const editor = host.querySelector<HTMLElement>('.ProseMirror')!
      assert.ok(group.classList.contains('bg-glass-composer-background/60!'), 'neutral control backing wins over primitive dark/disabled fills')
      assert.ok(group.classList.contains('solid:bg-composer-background!'))
      assert.ok(group.classList.contains('text-glass-prompt-foreground'))
      assert.ok(group.classList.contains('solid:text-foreground'))
      assert.ok(group.classList.contains('border-glass-border'))
      assert.ok(group.classList.contains('solid:border-border'))
      assert.ok(group.classList.contains('has-[[data-slot=input-group-control]:focus-visible]:border-glass-border'))
      assert.ok(group.classList.contains('solid:has-[[data-slot=input-group-control]:focus-visible]:border-border'))
      assert.ok(group.classList.contains('has-disabled:opacity-100'))
      assert.ok(group.classList.contains('duration-200'))
      assert.ok(group.classList.contains('motion-reduce:transition-none'))
      assert.ok(!group.className.includes('backdrop-'))
      const { useComposerDraftsStore: drafts } = await import('../src/renderer/src/stores/composer-drafts')
      const { textToComposerDocument } = await import('../src/renderer/src/components/composer/document')
      await act(async () => {
        drafts.getState().restoreDraft('chat', { content: textToComposerDocument('unsent draft'), images: [] })
      })
      const draft = drafts.getState().drafts.chat!.content
      for (const palette of ['pig', 'everforest'] as const) {
        for (const appearance of ['light', 'dark'] as const) {
          for (const style of ['solid', 'glass'] as const) {
            await act(async () => { theme(style, appearance, palette) })
            assert.equal(host.querySelector('[data-slot="input-group"]'), group)
            assert.equal(host.querySelector('.ProseMirror'), editor)
            assert.equal(editor.textContent, 'unsent draft')
            assert.deepEqual(drafts.getState().drafts.chat!.content, draft)
          }
        }
      }
      const { useSystemUIStore } = await import('../src/renderer/src/stores/system-ui')
      await act(async () => { useSystemUIStore.setState({ returningReviewSessions: { chat: true } }) })
      assert.equal(editor.getAttribute('aria-disabled'), 'true')
      assert.ok(group.classList.contains('bg-glass-composer-background/60!'))
      assert.ok(group.classList.contains('has-disabled:opacity-100'))
    } else if (scenario === 'prompt') {
      const { UserBubble } = await import('../src/renderer/src/components/turn/TurnMessages')
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      await act(async () => {
        theme('glass', 'light', 'pig')
        root.render(h(TooltipProvider, null, h(UserBubble, { message: { role: 'user', content: 'sent prompt', timestamp: 1000 } })))
      })
      const bubble = host.querySelector<HTMLElement>('[data-slot="bubble"]')!
      const content = host.querySelector<HTMLElement>('[data-slot="bubble-content"]')!
      assert.ok(bubble.classList.contains('*:data-[slot=bubble-content]:bg-glass-prompt-background'))
      assert.ok(bubble.classList.contains('*:data-[slot=bubble-content]:text-glass-prompt-foreground'))
      assert.ok(bubble.classList.contains('solid:*:data-[slot=bubble-content]:bg-user-message-background'))
      assert.ok(bubble.classList.contains('solid:*:data-[slot=bubble-content]:text-user-message-foreground'))
      assert.ok(!bubble.className.includes('opacity-') && !bubble.className.includes('backdrop-'))
      for (const palette of ['pig', 'everforest'] as const) {
        for (const appearance of ['light', 'dark'] as const) {
          for (const style of ['solid', 'glass'] as const) {
            await act(async () => { theme(style, appearance, palette) })
            assert.equal(host.querySelector('[data-slot="bubble"]'), bubble)
            assert.equal(host.querySelector('[data-slot="bubble-content"]'), content)
            assert.equal(content.textContent, 'sent prompt')
          }
        }
      }
    } else throw new Error(`Unknown fixture: ${scenario}`)
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--fixture') await fixture(process.argv[3])
else {
  for (const scenario of ['canvas', 'composer', 'prompt']) {
    test(`chat glass: ${scenario} preserves reading surfaces and lifecycle in both palettes and schemes`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--fixture', scenario], { stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => child.kill(), 12_000)
      try {
        const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(code, 0, output + errors)
      } finally {
        clearTimeout(timer)
        child.kill()
      }
    }, 15_000)
  }

  test('chat glass: 50% neutral surfaces are palette-independent while solid stays themed', async () => {
    const contracts: string[][] = []
    const materials = new Map<string, [string, string][]>()
    const solidSurfaces = new Map<string, string[]>()
    const luminance = (hex: string) => [1, 3, 5].map((offset) => {
      const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
    for (const palette of ['pig', 'everforest']) {
      const css = await Bun.file(new URL(`../src/renderer/src/themes/theme-${palette}.css`, import.meta.url)).text()
      const blocks = [...css.matchAll(/(html[^{}]+)\{([^{}]+)\}/g)]
      assert.equal(blocks.length, 2)
      for (const [, selector, body] of blocks) {
        const appearance = selector.includes('.dark') ? 'dark' : 'light'
        const values = new Map([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]))
        contracts.push([...values.keys()].sort())
        const glass = [...values.entries()].filter(([role]) => role.startsWith('glass-'))
        assert.equal(glass.length, 8)
        if (materials.has(appearance)) assert.deepEqual(glass, materials.get(appearance), 'glass colors cannot follow the palette')
        else materials.set(appearance, glass)
        assert.match(values.get('glass-background')!, /^color-mix\(in srgb, #[\da-f]{6} 50%, transparent\)$/)
        for (const role of ['glass-window-background', 'glass-composer-background', 'glass-prompt-background', 'glass-prompt-foreground']) {
          assert.match(values.get(role)!, /^#[\da-f]{6}$/)
        }
        const foreground = luminance(values.get('glass-prompt-foreground')!)
        const background = luminance(values.get('glass-prompt-background')!)
        assert.ok((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5)
        const solid = ['chat-background', 'composer-background', 'user-message-background'].map((role) => values.get(role)!)
        if (solidSurfaces.has(appearance)) assert.notDeepEqual(solid, solidSurfaces.get(appearance), 'solid keeps its palette')
        else solidSurfaces.set(appearance, solid)
      }
    }
    for (const contract of contracts.slice(1)) assert.deepEqual(contract, contracts[0])
    assert.notDeepEqual(materials.get('light'), materials.get('dark'), 'neutral glass still adapts to appearance')
    const css = await Bun.file(new URL('../src/renderer/src/styles.css', import.meta.url)).text()
    for (const role of ['glass-background', 'glass-window-background', 'glass-composer-background', 'glass-prompt-background', 'glass-prompt-foreground', 'glass-border']) {
      assert.ok(css.includes(`--color-${role}: var(--${role})`))
    }
    assert.ok(css.includes('--shadow-glass-panel:'))
  })
}

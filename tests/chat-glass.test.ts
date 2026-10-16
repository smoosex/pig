/** Glass changes local surfaces, never pane ownership or editor drafts; every tab kind shares one backplate. */
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
    isMemoryPluginEnabled: async () => false,
    onPluginsChanged: () => noop,
    setSidebarPrefs: async ({ reviewOpen }: { reviewOpen?: boolean }) => ({ sidebarTab: 'projects', split: 0.5, reviewOpen: reviewOpen ?? false })
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
    if (scenario === 'canvas' || scenario === 'tab-layout' || scenario === 'tab-sizing') {
      const closedTabs: string[] = []
      sessions.setState({ openTabs: [...tabs, { id: 'chat-two', kind: 'chat', cwd: '/chats/b', title: 'Another chat with a much longer title', loadState: 'ready' }] })
      for (const name of ['useEventBridge', 'useSessionNames', 'useSessionWindows', 'useWorktreeDeletions', 'useModelCatalog']) {
        mock.module(`../src/renderer/src/hooks/${name}`, () => ({ [name]: noop }))
      }
      mock.module('../src/renderer/src/components/sidebar/use-sidebar-preferences', () => ({
        useSidebarPreferences: () => ({ tab: scenario === 'tab-layout' ? 'projects' : 'chats', setTab: noop, ready: false, error: null })
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
      if (scenario === 'tab-sizing') {
        const manyTabs: OpenTab[] = Array.from({ length: 16 }, (_, index) => ({
          id: `chat-${index}`, kind: 'chat', cwd: `/chats/${index}`, title: `Chat ${index}`, loadState: 'ready'
        }))
        sessions.setState({
          openTabs: manyTabs, activeTabId: manyTabs[0].id,
          runtime: Object.fromEntries(manyTabs.map((tab) => [tab.id, emptyRuntime()])),
          setActive: (id) => sessions.setState({ activeTabId: id }),
          closeTab: (id) => { closedTabs.push(id) }
        })
      }
      if (scenario === 'tab-layout') {
        sessions.setState({ activeTabId: 'project', currentProjectCwd: '/p' })
        useDiffStore.setState({ reviewOpen: true })
        for (const name of ['Sidebar', 'WorkspacePanel']) {
          const path = name === 'Sidebar' ? 'Sidebar' : 'panel/WorkspacePanel'
          mock.module(`../src/renderer/src/components/${path}`, () => ({
            [name]: ({ hidden }: { hidden: boolean }) => h('div', { 'data-view': name, 'aria-hidden': hidden })
          }))
        }
      }
      const { useSplitLayoutStore: split } = await import('../src/renderer/src/stores/split-layout')
      const { default: App } = await import('../src/renderer/src/App')
      await act(async () => { theme('glass', 'light', 'pig'); root.render(h(App)) })
      const surface = host.querySelector<HTMLElement>('[data-content-surface]')!
      if (scenario === 'tab-sizing') {
        const faces = [...host.querySelectorAll<HTMLElement>('[data-session-tab]')]
        assert.equal(faces.length, 16)
        for (const index of [1, 7, 15, 0]) {
          await act(async () => { faces[index].click() })
          assert.equal(sessions.getState().activeTabId, `chat-${index}`)
          assert.equal(host.querySelectorAll('[data-tab-active]').length, 1)
          for (const [other, face] of faces.entries()) {
            assert.ok(face.classList.contains(other === index ? 'basis-56' : 'basis-7'))
            assert.ok(face.classList.contains('shrink-0'), 'a full active tab cannot be compressed by many icons')
            assert.equal(face.style.transition, '', 'width motion is not replaced by the sortable inline transition')
          }
          assert.deepEqual([...host.querySelectorAll('[data-session-tab]')], faces, 'switching animates existing nodes instead of remounting tabs')
        }
        await act(async () => { faces[7].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 100, clientY: 20 })) })
        const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('Rename'))!
        assert.ok(rename)
        await act(async () => { rename.click() })
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
        assert.equal(sessions.getState().activeTabId, 'chat-7', 'renaming an icon tab selects it so the editor has full width')
        const editor = faces[7].querySelector('input')!
        assert.ok(editor)
        assert.equal(document.activeElement, editor)
        await act(async () => { editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
        await act(async () => { faces[7].querySelector<HTMLButtonElement>('[data-tab-close-slot] button')!.click() })
        assert.deepEqual(closedTabs, ['chat-7'])
        assert.equal(sessions.getState().activeTabId, 'chat-7', 'closing never bubbles into a second selection')
        return
      }
      if (scenario === 'tab-layout') {
        const headerTabs = host.querySelector<HTMLElement>('[data-header-tabs]')!
        const strip = host.querySelector<HTMLElement>('[data-tab-strip]')!
        const newButton = host.querySelector<HTMLButtonElement>('[data-new-tab]')!
        const toolbar = host.querySelector<HTMLElement>('[data-header-trailing]')!
        const buttons = [...toolbar.querySelectorAll('button')]
        assert.equal(buttons[0], newButton)
        assert.equal(buttons[1].getAttribute('aria-pressed'), 'true', 'the add button immediately precedes the right sidebar toggle')
        assert.ok(!strip.contains(newButton), 'the add action cannot take width from the tab rail')
        const initialClass = headerTabs.className
        const checkBounds = () => {
          assert.ok(headerTabs.classList.contains('inset-x-64'), 'both sidebar widths and card gutters stay reserved')
          assert.equal(headerTabs.className, initialClass)
          assert.equal(headerTabs.style.cssText, '', 'no measurements move or resize the header tabs')
          assert.equal(host.querySelector('[data-tab-strip]'), strip)
        }
        checkBounds()
        for (const [shiftKey, leftHidden, rightHidden] of [
          [false, true, false], [true, true, true], [false, false, true], [true, false, false]
        ]) {
          await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true, shiftKey })) })
          assert.equal(host.querySelector('[data-view="Sidebar"]')!.getAttribute('aria-hidden'), String(leftHidden))
          assert.equal(host.querySelector('[data-view="WorkspacePanel"]')!.getAttribute('aria-hidden'), String(rightHidden))
          checkBounds()
        }
        await act(async () => { buttons[1].click() })
        assert.equal(useDiffStore.getState().reviewOpen, false)
        checkBounds()

        const created: string[] = []
        let finishCreate!: () => void
        await act(async () => { sessions.setState({
          newSession: async (cwd) => {
            created.push(cwd)
            await new Promise<void>((resolve) => { finishCreate = resolve })
            return 'created-project'
          },
          newChat: async () => { created.push('chat') }
        }) })
        await act(async () => { newButton.click() })
        assert.equal(newButton.disabled, true)
        assert.equal(newButton.getAttribute('aria-busy'), 'true')
        await act(async () => { finishCreate() })
        assert.equal(newButton.disabled, false)
        await act(async () => { sessions.setState({ newSession: async () => { throw new Error('cannot create session') } }) })
        await act(async () => { newButton.click() })
        assert.equal(newButton.title, 'cannot create session')
        assert.ok(newButton.querySelector('.lucide-circle-alert'))
        await act(async () => { sessions.setState({ activeTabId: 'chat', currentProjectCwd: null }) })
        assert.equal(toolbar.querySelectorAll('button').length, 1, 'chats still have the add action without a project sidebar toggle')
        await act(async () => { newButton.click() })
        assert.deepEqual(created, ['/p', 'chat'])
        assert.ok(newButton.querySelector('.lucide-plus'), 'a successful retry clears the creation error')
        checkBounds()
        return
      }
      const chat = host.querySelector('[data-view="ChatView"]')
      const windowSurface = host.querySelector<HTMLElement>('[data-app-surface]')!
      assert.ok(windowSurface.classList.contains('solid:bg-background'))
      assert.ok(![...windowSurface.classList].some((name) => name.startsWith('bg-')), 'glass leaves the window to its native material')
      assert.ok(surface.classList.contains('bg-glass-background'))
      for (const bare of [windowSurface, surface]) {
        assert.ok(!bare.className.includes('backdrop-'), 'nothing web-painted lies under the window surfaces, so a backdrop-filter only reads back its own last frame')
      }
      assert.ok(surface.classList.contains('shadow-glass-panel'))
      assert.ok(surface.classList.contains('ring-glass-border'))
      assert.ok(surface.classList.contains('solid:bg-chat-background'))
      assert.ok(surface.classList.contains('solid:shadow-md'))
      assert.ok(surface.classList.contains('solid:ring-0'))
      assert.ok(!surface.classList.contains('bg-chat-background'))
      assert.ok(surface.classList.contains('transition-[background-color,box-shadow]'))
      assert.ok(surface.classList.contains('duration-200'))
      assert.ok(surface.classList.contains('motion-reduce:transition-none'))
      assert.ok(!surface.className.includes('opacity-'))
      const header = host.querySelector<HTMLElement>('[data-app-header]')!
      const strip = host.querySelector<HTMLElement>('[data-tab-strip]')!
      const headerTabs = host.querySelector<HTMLElement>('[data-header-tabs]')!
      assert.ok(header.contains(strip) && !surface.contains(strip), 'session tabs live only in the header')
      assert.ok(header.classList.contains('drag') && strip.classList.contains('no-drag'))
      assert.ok(headerTabs.classList.contains('justify-center'))
      assert.ok(strip.classList.contains('w-max') && strip.classList.contains('max-w-full'), 'the rail fits its bounded tabs, not an empty full-width track')
      const tabList = strip.querySelector<HTMLElement>('[data-session-tab-list]')!
      assert.ok(tabList.classList.contains('bg-glass-tab-bar-background'))
      assert.ok(tabList.classList.contains('solid:bg-tab-bar-background'))
      assert.ok(tabList.classList.contains('overflow-x-auto'))
      assert.ok(!tabList.className.includes('backdrop-'), 'the rail sits on the bare window, like the card')
      const faces = [...strip.querySelectorAll<HTMLElement>('[data-session-tab]')]
      assert.equal(faces.length, 2)
      for (const face of faces) {
        for (const layout of ['@container/session-tab', 'w-56', 'min-w-7', 'max-w-56', 'shrink-0', 'rounded-full', 'session-tab-motion', 'motion-reduce:transition-none']) assert.ok(face.classList.contains(layout))
        assert.ok(!face.className.includes('before:bg-primary'))
      }
      const activeTab = strip.querySelector<HTMLElement>('[data-tab-active]')!
      assert.ok(activeTab.classList.contains('basis-56') && activeTab.classList.contains('grow-0'))
      assert.equal(activeTab.style.transition, '', 'sortable transform easing cannot override width motion')
      for (const effect of ['bg-glass-tab-active-background', 'bg-(image:--glass-tab-active-sheen)', 'shadow-glass-tab-active', 'inset-ring-glass-tab-active-border']) {
        assert.ok(activeTab.classList.contains(effect))
      }
      assert.ok(!activeTab.className.includes('backdrop-'), 'the selected face paints optics, not a blur')
      for (const effect of ['solid:bg-tab-active-background', 'solid:bg-none', 'solid:shadow-xs', 'solid:inset-ring-border']) {
        assert.ok(activeTab.classList.contains(effect), 'solid has no transparent lens or sheen')
      }
      assert.ok(!activeTab.classList.contains('hover:bg-glass-prompt-foreground/8'), 'hover cannot accumulate on the active capsule')
      assert.ok(!activeTab.classList.contains('solid:hover:bg-tab-hover-background'))
      const inactiveTab = faces.find((face) => face !== activeTab)!
      assert.ok(inactiveTab.classList.contains('basis-7') && inactiveTab.classList.contains('grow'))
      const closeSlot = inactiveTab.querySelector<HTMLElement>('[data-tab-close-slot]')!
      assert.ok(closeSlot.classList.contains('invisible') && closeSlot.classList.contains('@min-[7rem]/session-tab:visible'))
      assert.ok(inactiveTab.querySelector('[data-tab-label]')!.classList.contains('max-w-0'))
      assert.ok(inactiveTab.classList.contains('hover:bg-glass-prompt-foreground/8'))
      assert.ok(inactiveTab.classList.contains('solid:hover:bg-tab-hover-background'))
      assert.ok(!inactiveTab.classList.contains('shadow-glass-tab-active'), 'hover remains a flat highlight')
      assert.ok(!inactiveTab.classList.contains('bg-(image:--glass-tab-active-sheen)'))
      assert.ok(headerTabs.classList.contains('inset-x-64'))
      const newButton = header.querySelector('[data-new-tab]')!
      assert.ok(newButton && !strip.contains(newButton), 'header actions are outside the bounded rail')
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
        await act(async () => { sessions.setState({ activeTabId: id, currentProjectCwd: '/p' }) })
        assert.ok(surface.classList.contains('bg-glass-background'), `${id} shows the shared glass backplate`)
        assert.ok(surface.classList.contains('solid:bg-chat-background'), `${id} stays opaque in solid`)
        assert.ok(!surface.classList.contains('bg-chat-background'))
        assert.ok(host.querySelector(`[data-view="${id === 'file' ? 'FileView' : 'ChangesView'}"]`))
        assert.ok(host.querySelector('[data-header-trailing] [data-new-tab]'))
      }
      await act(async () => {
        const pane = split.getState().initLayout('chat')
        split.getState().splitPane(pane, 'project', 'right')
        split.getState().splitPane(pane, 'file', 'bottom')
        split.getState().splitPane(pane, 'diff', 'left')
      })
      assert.ok(surface.classList.contains('bg-glass-background'), 'a selected reading tab cannot replace the shared material in a mixed split')
      assert.equal(host.querySelectorAll('.bg-glass-background').length, 1, 'mixed panes share one material layer')
      const panes = [...host.querySelectorAll<HTMLElement>('[data-split-pane]')]
      assert.equal(panes.length, 4)
      for (const pane of panes) {
        assert.ok(pane.classList.contains('bg-transparent') && pane.classList.contains('solid:bg-card'), 'reading panes paint nothing over the glass')
        assert.ok(!pane.classList.contains('bg-card'))
      }
      for (const pane of panes) {
        assert.ok(pane.classList.contains('duration-200'))
        assert.ok(!pane.className.includes('opacity-') && !pane.className.includes('backdrop-'))
      }
      await act(async () => { theme('solid', 'dark', 'everforest') })
      assert.deepEqual([...host.querySelectorAll('[data-split-pane]')], panes, 'changing materials never remounts panes')
      await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: ',', metaKey: true })) })
      assert.ok(!host.querySelector('[data-tab-strip]'), 'settings have no session strip')
      assert.ok(!host.querySelector('[data-new-tab]'), 'settings hide the session creation action')
      await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: ',', metaKey: true })) })
      assert.ok(host.querySelector('[data-header-tabs]')!.classList.contains('inset-x-64'))
      assert.ok(host.querySelector('[data-new-tab]'))
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
  for (const scenario of ['canvas', 'tab-layout', 'tab-sizing', 'composer', 'prompt']) {
    const name = scenario === 'tab-layout'
      ? 'header tabs: reserve both sidebar widths through every toggle and keep creation in the trailing toolbar'
      : scenario === 'tab-sizing'
        ? 'header tabs: selection keeps full width and stable nodes while icon tabs remain renamable and closable'
        : `chat glass: ${scenario} preserves reading surfaces and lifecycle in both palettes and schemes`
    test(name, async () => {
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
        assert.equal(glass.length, 13)
        if (materials.has(appearance)) assert.deepEqual(glass, materials.get(appearance), 'glass colors cannot follow the palette')
        else materials.set(appearance, glass)
        assert.match(values.get('glass-background')!, /^color-mix\(in srgb, #[\da-f]{6} 50%, transparent\)$/)
        assert.match(values.get('glass-tab-bar-background')!, /^color-mix\(in srgb, #[\da-f]{6} 12%, transparent\)$/)
        if (appearance === 'dark') {
          assert.match(values.get('glass-tab-active-sheen')!, /^linear-gradient\(/)
          assert.match(values.get('glass-tab-active-shadow')!, /inset 0 1px/)
          assert.match(values.get('glass-tab-active-shadow')!, /inset 0 -1px/)
          assert.notEqual(values.get('glass-tab-active-background'), values.get('glass-highlight'), 'the lens is not a flat white selection fill')
        } else {
          assert.equal(values.get('glass-tab-active-sheen'), 'none', 'light glass keeps its existing appearance')
          assert.equal(values.get('glass-tab-active-background'), 'rgb(255 255 255 / 0.65)')
          assert.equal(values.get('glass-tab-active-border'), 'rgb(255 255 255 / 0.65)')
          assert.equal(values.get('glass-tab-active-shadow'), '0 1px 2px 0 rgb(0 0 0 / 0.05)')
        }
        for (const role of ['glass-window-background', 'glass-composer-background', 'glass-prompt-background', 'glass-prompt-foreground']) {
          assert.match(values.get(role)!, /^#[\da-f]{6}$/)
        }
        const foreground = luminance(values.get('glass-prompt-foreground')!)
        const background = luminance(values.get('glass-prompt-background')!)
        assert.ok((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5)
        const tabForeground = luminance(values.get('foreground')!)
        const tabRoles = ['tab-bar-background', 'tab-active-background', 'tab-hover-background']
        const tabSurfaces = tabRoles.map((role) => {
          const color = values.get(role)!
          assert.match(color, /^#[\da-f]{6}$/)
          const background = luminance(color)
          const contrast = (Math.max(tabForeground, background) + 0.05) / (Math.min(tabForeground, background) + 0.05)
          assert.ok(contrast >= 4.5, `${palette} ${appearance} ${role} must preserve tab text contrast`)
          return color
        })
        assert.equal(new Set(tabSurfaces).size, 3, 'rail, selection and hover have distinct colors')
        assert.notEqual(tabSurfaces[0], values.get('background'), 'the tab rail cannot disappear into the page')
        const solid = ['chat-background', 'composer-background', 'user-message-background', ...tabRoles].map((role) => values.get(role)!)
        if (solidSurfaces.has(appearance)) assert.notDeepEqual(solid, solidSurfaces.get(appearance), 'solid keeps its palette')
        else solidSurfaces.set(appearance, solid)
      }
    }
    for (const contract of contracts.slice(1)) assert.deepEqual(contract, contracts[0])
    assert.notDeepEqual(materials.get('light'), materials.get('dark'), 'neutral glass still adapts to appearance')
    const css = await Bun.file(new URL('../src/renderer/src/styles.css', import.meta.url)).text()
    for (const role of ['glass-background', 'glass-window-background', 'glass-composer-background', 'glass-prompt-background', 'glass-prompt-foreground', 'glass-border', 'glass-tab-bar-background', 'glass-tab-active-background', 'glass-tab-active-border', 'tab-bar-background', 'tab-active-background', 'tab-hover-background']) {
      assert.ok(css.includes(`--color-${role}: var(--${role})`))
    }
    assert.ok(css.includes('--shadow-glass-panel:'))
    assert.ok(css.includes('--shadow-glass-tab-active: var(--glass-tab-active-shadow)'))
    for (const surface of ['@utility glass-code-surface', '--code-surface-background: transparent', '--code-surface-background: var(--code-background)', '--code-surface-gutter-background: var(--glass-composer-background)', '--code-surface-gutter-background: var(--code-background)']) assert.ok(css.includes(surface))
    const diffOptions = await Bun.file(new URL('../src/renderer/src/components/diff/diff-options.ts', import.meta.url)).text()
    assert.ok(diffOptions.includes('--diffs-bg: var(--code-surface-background, var(--code-background))'), 'tool-output diffs outside reading panes keep the opaque code background')
    assert.ok(diffOptions.includes('[data-gutter] { background-color: var(--code-surface-gutter-background, var(--diffs-bg)) }'), 'the sticky gutter stays opaque over horizontally scrolled code')
    for (const motion of ['@utility session-tab-motion', 'flex-basis 200ms', 'flex-grow 200ms', 'var(--tab-drag-transition, transform 0s)']) assert.ok(css.includes(motion))
  })
}

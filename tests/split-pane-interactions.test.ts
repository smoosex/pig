/** Exercise pane lifecycle and pointer boundaries with real stores/editors, without browser E2E. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { GroupProps, PanelProps } from 'react-resizable-panels'
import type { DragEndEvent, DndContextProps } from '@dnd-kit/core'
import type { OpenTab } from '../src/renderer/src/stores/sessions/types'
import type { PaneNode } from '../src/renderer/src/stores/split-layout'
import type { Turn } from '../src/renderer/src/chat/turns'

async function fixture(scenario: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const queries: string[] = []
  const orders: string[][] = []
  const closed: string[] = []
  Object.assign(window, {
    api: {
      getCommands: async () => [],
      onPluginsChanged: () => () => {},
      listSubagents: async () => [],
      onSubagentsChanged: () => () => {},
      closeSession: async (id: string) => {
        closed.push(id)
      },
      selectOpenProjectWorkspace: async () => {},
      saveOpenProjectChangesTab: async () => {},
      saveOpenChatTabs: async () => {},
      suggestFiles: async (cwd: string) => {
        queries.push(cwd)
        return []
      },
      saveOpenProjectTabOrder: async (_cwd: string, ids: string[]) => {
        orders.push(ids)
      }
    }
  })
  const { act, createElement: h, Fragment } = await import('react')
  const groups = new Map<string, GroupProps>()
  mock.module('react-resizable-panels', () => ({
    Group: (props: GroupProps) => {
      groups.set(String(props.id), props)
      return h(
        'div',
        { 'data-group': props.id, 'data-orientation': props.orientation },
        props.children
      )
    },
    Panel: (props: PanelProps) =>
      h('div', { 'data-panel': props.id, 'data-size': props.defaultSize }, props.children),
    Separator: () => h('div')
  }))
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ locale: 'en', localeSetting: 'en' })
  const { useSessionsStore: sessions } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const {
    useSplitLayoutStore: split,
    collectPaneNodes,
    isSplitNode
  } = await import('../src/renderer/src/stores/split-layout')
  const tabs: OpenTab[] = ['A', 'B', 'C', 'D'].map((id) => ({
    id,
    cwd: '/p',
    kind: 'project',
    title: id,
    loadState: 'ready'
  }))
  sessions.setState({
    openTabs: tabs,
    currentProjectCwd: '/p',
    activeTabId: 'A',
    runtime: Object.fromEntries(tabs.map((tab) => [tab.id, emptyRuntime()])),
    setActive: (id) => {
      sessions.setState({ activeTabId: id })
    }
  })
  const { SplitPaneContainer } =
    await import('../src/renderer/src/components/chat/SplitPaneContainer')
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const renderContainer = () =>
    root.render(h(SplitPaneContainer, { renderPane: (node) => h('div', null, node.tabId) }))
  const tabIds = () => collectPaneNodes(split.getState().root).map((pane) => pane.tabId)
  try {
    if (scenario === 'loading') {
      mock.module('../src/renderer/src/components/ChatView', () => ({
        ChatView: () => h('div', { 'data-chat': true })
      }))
      mock.module('../src/renderer/src/components/Composer', () => ({
        Composer: () => h('div', { 'data-composer': true })
      }))
      mock.module('../src/renderer/src/components/diff/ChangesView', () => ({
        ChangesView: () => null
      }))
      mock.module('../src/renderer/src/components/panel/WorkspacePanel', () => ({
        WorkspacePanel: () => null
      }))
      const { PaneViewContent } = await import('../src/renderer/src/App')
      let requests = 0
      const update = (loadState: OpenTab['loadState']) =>
        sessions.setState({
          openTabs: [{ ...tabs[0], loadState, loadError: 'Unreadable session' }]
        })
      sessions.setState({
        runtime: {},
        activateTab: async () => {
          requests++
          update('opening')
          await Promise.resolve()
          update('error')
        }
      })
      update('cold')
      const render = () =>
        root.render(
          h(PaneViewContent, {
            node: { id: 'pane-A', tabId: 'A' },
            isActive: true,
            composerWorkspace: null
          })
        )
      await act(async () => {
        render()
      })
      assert.equal(requests, 1)
      assert.equal(host.querySelector('[role="alert"]')?.textContent, 'Unreadable session')
      assert.equal(host.querySelector('[data-composer]'), null)
      await act(async () => {
        update('error')
        render()
        await Bun.sleep(20)
      })
      assert.equal(requests, 1, 'a failed load must not automatically retry')
      await act(async () => {
        root.render(null)
      })
      await act(async () => {
        render()
      })
      assert.equal(requests, 1, 'remounting an error pane must not retry either')
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')!.click()
      })
      assert.equal(requests, 2, 'only the explicit retry performs another load')
    } else if (scenario === 'memory-readiness') {
      const failures: string[] = []
      mock.module('sonner', () => ({
        Toaster: () => null,
        toast: { error: (message: string) => { failures.push(message) } }
      }))
      mock.module('../src/renderer/src/components/ChatView', () => ({ ChatView: () => null }))
      mock.module('../src/renderer/src/components/diff/ChangesView', () => ({ ChangesView: () => null }))
      mock.module('../src/renderer/src/components/panel/WorkspacePanel', () => ({ WorkspacePanel: () => null }))
      const { PaneViewContent } = await import('../src/renderer/src/App')
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      const memoryQueries: string[] = []
      const memoryDetails: string[] = []
      const pluginListeners = new Set<() => void>()
      const failure = Object.assign(new Error('Plugin registry cannot be read'), { code: 'EACCES' })
      let failQuery = false
      let registered = false
      let register!: () => void
      const opening = new Promise<void>((resolve) => { register = resolve })
      const meta: NonNullable<OpenTab['meta']> = {
        id: 'B', path: '/sessions/B.jsonl', cwd: '/p', size: 1, firstMessage: 'Restored',
        created: '2026-01-01', modified: '2026-01-01'
      }
      Object.assign(window.api, {
        openSession: async (path: string) => {
          assert.equal(path, meta.path)
          await opening
          registered = true
          return {
            sessionId: 'B', cwd: '/p',
            display: { leafId: null, turns: [], startIndex: 0, totalTurns: 0 }
          }
        },
        getControls: async () => ({
          model: null, thinkingLevel: 'off', thinkingLevels: ['off'], contextUsage: null,
          followUpMessages: [], steeringMessages: []
        }),
        isMemoryPluginEnabled: async (sessionId: string) => {
          memoryQueries.push(sessionId)
          if (sessionId === 'B' && !registered) {
            throw Object.assign(new Error('Session is not registered'), { code: 'ERR_SESSION_NOT_FOUND' })
          }
          if (sessionId === 'B' && failQuery) throw failure
          return true
        },
        getMemoryDetail: async (sessionId: string) => { memoryDetails.push(sessionId); return 'Visible memory for B' },
        getTokenStats: async () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
        onPluginsChanged: (listener: () => void) => {
          pluginListeners.add(listener)
          return () => { pluginListeners.delete(listener) }
        }
      })
      sessions.setState({
        openTabs: [tabs[0], { ...tabs[1], loadState: 'cold', meta }],
        runtime: { A: emptyRuntime() }
      })
      const a = split.getState().initLayout('A')
      const b = split.getState().splitPane(a, 'B', 'right')
      await act(async () => {
        root.render(h(TooltipProvider, null, h(SplitPaneContainer, {
          renderPane: (node, isActive) => h(PaneViewContent, { node, isActive, composerWorkspace: null })
        })))
      })
      const pane = host.querySelector<HTMLElement>(`[data-pane-id="${b}"]`)!
      const meter = pane.querySelector<HTMLButtonElement>('[aria-label="Context window"]')!
      assert.ok(meter, 'the restored pane mounts its composer while opening')
      assert.equal(sessions.getState().openTabs.find((tab) => tab.id === 'B')?.loadState, 'opening')
      assert.deepEqual(memoryQueries.filter((id) => id === 'B'), [], 'opening tabs must not query main before registration')
      assert.equal(meter.disabled, true)
      await act(async () => { register() })
      assert.equal(sessions.getState().openTabs.find((tab) => tab.id === 'B')?.loadState, 'ready')
      assert.deepEqual(memoryQueries.filter((id) => id === 'B'), ['B'], 'readiness triggers the query without a plugin-change event')
      assert.equal(meter.disabled, false)
      assert.deepEqual(failures, [])
      await act(async () => { meter.click() })
      const view = document.querySelector<HTMLButtonElement>('[aria-label="View memory"]')
      assert.ok(document.querySelector('[aria-label="Memory status"]'))
      assert.ok(view)
      await act(async () => { view.click() })
      assert.deepEqual(memoryDetails, ['B'])
      assert.ok(document.body.textContent?.includes('Visible memory for B'))
      failQuery = true
      await act(async () => { for (const listener of pluginListeners) listener() })
      assert.deepEqual(failures, [`Could not load memory: ${failure.message}`], 'unexpected failures are reported at the toolbar UI boundary')
      assert.ok(document.querySelector('[data-slot="dialog-content"]'), 'query failures must not masquerade as disabling memory')
    } else if (scenario === 'drafts') {
      const { EditorContent } = await import('@tiptap/react')
      const { useComposer } = await import('../src/renderer/src/components/composer/useComposer')
      const drafts: Record<string, ReturnType<typeof useComposer>> = {}
      function DraftPane({ node, isActive }: { node: PaneNode; isActive: boolean }) {
        const state = useComposer(undefined, undefined, node.tabId, isActive)
        drafts[node.tabId] = state
        return h('div', { 'data-editor': node.tabId }, h(EditorContent, { editor: state.editor }))
      }
      const a = split.getState().initLayout('A')
      split.getState().splitPane(a, 'B', 'right')
      const render = () =>
        root.render(
          h(SplitPaneContainer, {
            renderPane: (node, isActive) => h(DraftPane, { node, isActive })
          })
        )
      await act(async () => {
        render()
      })
      await act(async () => {
        drafts.A.editor!.commands.insertContent('unsent A')
        drafts.B.editor!.commands.insertContent('unsent B')
        drafts.A.attachments.restore([
          { id: 'image-A', mimeType: 'image/png', data: 'AA==', url: 'blob:old' }
        ])
      })
      const original = drafts.A.editor
      await act(async () => {
        split.getState().splitPane(a, 'C', 'bottom')
      })
      assert.notEqual(
        drafts.A.editor,
        original,
        'splitting changes ownership and really remounts this editor'
      )
      assert.equal(drafts.A.editor!.getText(), 'unsent A')
      assert.equal(drafts.B.editor!.getText(), 'unsent B')
      assert.equal(drafts.A.attachments.images[0].data, 'AA==')
      assert.equal(drafts.A.attachments.images[0].url, 'data:image/png;base64,AA==')
      await act(async () => {
        split
          .getState()
          .closePane(collectPaneNodes(split.getState().root).find((pane) => pane.tabId === 'C')!.id)
      })
      assert.equal(
        drafts.A.editor!.getText(),
        'unsent A',
        'collapsing the split also preserves the draft'
      )
      assert.equal(drafts.A.attachments.images.length, 1)
      const shortcut = () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'l', metaKey: true, cancelable: true })
        )
      await act(async () => {
        split.getState().setActivePane(a)
        shortcut()
        await Bun.sleep(50)
      })
      assert.equal(
        document.activeElement?.closest('[data-editor]')?.getAttribute('data-editor'),
        'A'
      )
      const b = collectPaneNodes(split.getState().root).find((pane) => pane.tabId === 'B')!.id
      await act(async () => {
        split.getState().setActivePane(b)
      })
      await act(async () => {
        shortcut()
        await Bun.sleep(50)
      })
      assert.equal(
        document.activeElement?.closest('[data-editor]')?.getAttribute('data-editor'),
        'B'
      )
      // An explicit composer keeps its workspace even if the global selection belongs to a file.
      await act(async () => {
        sessions.setState({
          openTabs: [
            { ...tabs[0], cwd: '/workspace-A' },
            { ...tabs[1], cwd: '/workspace-B' },
            {
              id: 'file',
              cwd: '/other',
              title: 'file',
              kind: 'file',
              loadState: 'ready',
              path: 'x.ts'
            }
          ],
          activeTabId: 'file'
        })
        drafts.A.editor!.commands.setContent({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '@' }] }]
        })
        drafts.B.editor!.commands.setContent({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '@' }] }]
        })
        drafts.A.editor!.commands.setTextSelection(2)
        drafts.B.editor!.commands.setTextSelection(2)
      })
      await act(async () => {
        await Bun.sleep(200)
      })
      assert.deepEqual([...new Set(queries)].sort(), ['/workspace-A', '/workspace-B'])
      await act(async () => {
        drafts.A.editor!.commands.setContent({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '!echo draft' }] }]
        })
      })
      assert.equal(drafts.A.bashMode, true)
      await act(async () => {
        root.render(null)
      })
      await act(async () => {
        render()
      })
      assert.equal(drafts.A.bashMode, true)
      assert.equal(drafts.A.editor!.getText(), 'echo draft')
      await act(async () => {
        drafts.A.editor!.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
      })
      assert.equal(drafts.A.bashMode, false)
      await act(async () => {
        root.render(null)
      })
      await act(async () => {
        render()
      })
      assert.equal(drafts.A.bashMode, false, 'Esc remains a literal-text choice after remount')
      assert.equal(drafts.A.editor!.getText(), '!echo draft')
      await act(async () => {
        drafts.A.attachments.clear()
        drafts.A.editor!.commands.clearContent()
      })
      await act(async () => {
        root.render(null)
      })
      await act(async () => {
        render()
      })
      assert.equal(drafts.A.editor!.getText(), '')
      assert.equal(drafts.A.attachments.images.length, 0, 'cleared attachments must not reappear')
    } else if (scenario === 'headers') {
      const a = split.getState().initLayout('A')
      const b = split.getState().splitPane(a, 'B', 'right')
      await act(async () => {
        renderContainer()
      })
      const frame = host.firstElementChild as HTMLElement
      assert.ok(frame.classList.contains('p-1'), 'split panes retain equal padding on all four sides')
      host.dataset.paneId = 'A'
      const source = host.querySelector<HTMLElement>(`[data-split-pane][data-pane-id="${a}"]`)!
      const target = host.querySelector<HTMLElement>(`[data-split-pane][data-pane-id="${b}"]`)!
      source.getBoundingClientRect = () => new DOMRect(0, 100, 400, 300)
      target.getBoundingClientRect = () => new DOMRect(400, 100, 400, 300)
      host.getBoundingClientRect = () => new DOMRect(0, 100, 800, 300)
      let hit: Element[] = [source, host]
      document.elementsFromPoint = () => hit
      const down = () =>
        source.querySelector('[data-pane-header]')!.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 1,
            clientX: 100,
            clientY: 200
          })
        )
      const pointer = (type: string, x = 110, y = 200) =>
        window.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y }))
      const original = split.getState().root
      await act(async () => {
        down()
        pointer('pointermove')
      })
      assert.equal(split.getState().dragOver, null)
      await act(async () => {
        pointer('pointerup')
      })
      assert.equal(
        split.getState().root,
        original,
        'self and outer wrapper drops cannot reshape the tree'
      )
      hit = [target, host]
      await act(async () => {
        down()
        pointer('pointermove', 600, 380)
      })
      assert.deepEqual(split.getState().dragOver, { paneId: b, position: 'bottom' })
      await act(async () => {
        pointer('pointercancel', 0, 0)
        pointer('pointerup', 600, 380)
      })
      assert.equal(split.getState().root, original, 'cancellation cannot submit the previewed drop')
      assert.equal(split.getState().dragOver, null)
      const strip = document.createElement('div')
      strip.dataset.tabStrip = 'true'
      hit = [strip]
      await act(async () => {
        down()
        pointer('pointermove', 100, 20)
      })
      assert.ok(split.getState().reintegratingTab)
      await act(async () => {
        pointer('pointercancel', 0, 0)
      })
      assert.equal(split.getState().root, original)
      assert.equal(split.getState().reintegratingTab, null)
      hit = [target, host]
      await act(async () => {
        down()
        pointer('pointermove', 600, 380)
        pointer('pointerup', 600, 380)
      })
      assert.deepEqual(tabIds(), ['B', 'A'])
      assert.ok(isSplitNode(split.getState().root!))
      assert.equal((split.getState().root! as { direction: string }).direction, 'vertical')
      assert.equal(sessions.getState().activeTabId, 'A')
      const nextA = collectPaneNodes(split.getState().root).find((pane) => pane.tabId === 'A')!
      const c = split.getState().splitPane(nextA.id, 'C', 'right')
      sessions.setState({ activeTabId: 'C' })
      await act(async () => {
        renderContainer()
      })
      await act(async () => {
        host.querySelector<HTMLButtonElement>(`[data-pane-id="${c}"] button`)!.click()
      })
      assert.equal(
        sessions.getState().activeTabId,
        'B',
        'closing the active pane selects a surviving pane'
      )
      assert.deepEqual(tabIds(), ['B', 'A'])
      assert.deepEqual(closed, ['C'])
      assert.equal(
        sessions.getState().openTabs.some((tab) => tab.id === 'C'),
        false
      )
      assert.equal(sessions.getState().runtime.C, undefined)
      const layout = split.getState().root!
      assert.ok(isSplitNode(layout))
      await act(async () => {
        groups.get(layout.id)!.onLayoutChanged!(
          { [layout.children[0].id]: 65, [layout.children[1].id]: 35 },
          {
            isUserInteraction: true,
            requestedLayout: { [layout.children[0].id]: 70, [layout.children[1].id]: 30 }
          }
        )
      })
      await act(async () => {
        root.render(null)
      })
      await act(async () => {
        renderContainer()
      })
      assert.equal(
        host.querySelector(`[data-panel="${layout.children[0].id}"]`)!.getAttribute('data-size'),
        '70%'
      )
      assert.equal(
        host.querySelector(`[data-panel="${layout.children[1].id}"]`)!.getAttribute('data-size'),
        '30%'
      )
      await act(async () => {
        groups.get(layout.id)!.onLayoutChanged!(
          { [layout.children[0].id]: 50, [layout.children[1].id]: 50 },
          { isUserInteraction: false }
        )
      })
      assert.deepEqual((split.getState().root! as { sizes: number[] }).sizes, [70, 30])
    } else if (scenario.startsWith('close-')) {
      const a = split.getState().initLayout('A')
      const b = split.getState().splitPane(a, 'B', 'right')
      if (scenario === 'close-collapse') {
        sessions.setState({ activeTabId: 'B', activeSessionByCwd: { '/p': 'B' } })
        await act(async () => {
          sessions.getState().closeTab(sessions.getState().activeTabId!)
        })
        assert.deepEqual(tabIds(), ['A'])
        assert.equal(sessions.getState().activeTabId, 'A')
        await act(async () => {
          sessions.getState().closeTab('A')
        })
        assert.equal(split.getState().root, null)
        assert.equal(sessions.getState().activeTabId, 'C')
        assert.deepEqual(closed, ['B', 'A'])
      } else if (scenario === 'close-cross-scope') {
        sessions.setState({
          openTabs: tabs.map((tab) =>
            tab.id === 'B' ? { ...tab, kind: 'chat', cwd: '/chats/B' } : tab
          ),
          activeTabId: 'A',
          activeSessionByCwd: { '/p': 'A' }
        })
        split.getState().setActivePane(a)
        await act(async () => {
          sessions.getState().closeTab('A')
        })
        assert.deepEqual(tabIds(), ['B'])
        assert.equal(sessions.getState().activeTabId, 'B')
        assert.equal(sessions.getState().currentProjectCwd, null)
        assert.equal(sessions.getState().activeSessionByCwd['/p'], 'C')
        assert.deepEqual(closed, ['A'])
      } else if (scenario === 'close-file' || scenario === 'close-diff') {
        const kind = scenario === 'close-file' ? 'file' : 'diff'
        sessions.setState({
          openTabs: tabs.map((tab) =>
            tab.id === 'B' ? { ...tab, kind, path: kind === 'file' ? 'x.ts' : undefined } : tab
          ),
          activeTabId: 'B',
          activeSessionByCwd: { '/p': 'C' }
        })
        split.getState().splitPane(b, 'C', 'bottom')
        split.getState().setActivePane(b)
        await act(async () => {
          sessions.getState().closeTab('B')
        })
        assert.deepEqual(tabIds(), ['A', 'C'])
        assert.equal(sessions.getState().activeTabId, 'A')
        assert.equal(sessions.getState().activeSessionByCwd['/p'], 'A')
        assert.deepEqual(closed, [], 'file and diff panes do not own an SDK session')
      } else {
        const c = split.getState().splitPane(b, 'C', 'bottom')
        const selected =
          scenario === 'close-hidden' ? 'D' : scenario === 'close-inactive' ? 'A' : 'C'
        split.getState().setActivePane(selected === 'A' ? a : c)
        sessions.setState({ activeTabId: selected, activeSessionByCwd: { '/p': selected } })
        if (scenario === 'close-sidebar') {
          const { SessionList } = await import('../src/renderer/src/components/sidebar/SessionList')
          function SidebarPane() {
            const openTabs = sessions((state) => state.openTabs)
            return h(
              Fragment,
              null,
              h('div', { 'data-test-sidebar': true }, h(SessionList, { sessions: openTabs })),
              h(SplitPaneContainer, { renderPane: (node) => h('div', null, node.tabId) })
            )
          }
          await act(async () => {
            root.render(h(SidebarPane))
          })
          await act(async () => {
            host
              .querySelector<HTMLButtonElement>('[data-test-sidebar] button[aria-label="Close C"]')!
              .click()
          })
          assert.equal(host.querySelector('[data-test-sidebar] button[aria-label="Close C"]'), null)
        } else
          await act(async () => {
            sessions.getState().closeTab('C')
          })
        assert.deepEqual(tabIds(), ['A', 'B'])
        assert.equal(sessions.getState().activeTabId, selected === 'D' ? 'D' : 'A')
        assert.equal(sessions.getState().activeSessionByCwd['/p'], selected === 'D' ? 'D' : 'A')
        assert.deepEqual(closed, ['C'])
        assert.equal(sessions.getState().runtime.C, undefined)
        assert.equal(
          sessions.getState().openTabs.some((tab) => tab.id === 'C'),
          false
        )
        if (selected !== 'D') assert.equal(split.getState().activePaneId, a)
      }
      assert.equal(sessions.getState().workspaceError, null)
    } else if (scenario === 'tab-dnd') {
      const core = await import('@dnd-kit/core')
      const OriginalContext = core.DndContext
      let context!: DndContextProps
      mock.module('@dnd-kit/core', () => ({
        ...core,
        DndContext: (props: DndContextProps) => {
          context = props
          return h(OriginalContext, props)
        }
      }))
      const { TabBar } = await import('../src/renderer/src/components/TabBar')
      const a = split.getState().initLayout('A')
      split.getState().splitPane(a, 'B', 'right')
      sessions.setState({ activeTabId: 'C' })
      await act(async () => {
        root.render(h(TabBar, { sidebarTab: 'projects' }))
      })
      await act(async () => {
        split.getState().setDragOver({ paneId: 'C', position: 'right' })
        context.onDragEnd!({ active: { id: 'D' }, over: null } as DragEndEvent)
      })
      assert.deepEqual(
        tabIds(),
        ['C', 'D'],
        'a hidden A/B group is not the base of the visible C/D split'
      )
      assert.equal(sessions.getState().activeTabId, 'D')
      const newA = split.getState().initLayout('A')
      split.getState().splitPane(newA, 'B', 'right')
      await act(async () => {
        sessions.setState({ openTabs: tabs.slice(0, 3), activeTabId: 'B' })
        root.render(h(TabBar, { sidebarTab: 'projects' }))
      })
      await act(async () => {
        context.onDragEnd!({ active: { id: 'C' }, over: { id: 'B' } } as DragEndEvent)
      })
      assert.deepEqual(
        sessions.getState().openTabs.map((tab) => tab.id),
        ['C', 'A', 'B']
      )
      assert.deepEqual(orders.at(-1), ['C', 'A', 'B'])
      await act(async () => {
        context.onDragEnd!({ active: { id: 'B' }, over: { id: 'C' } } as DragEndEvent)
      })
      assert.deepEqual(
        sessions.getState().openTabs.map((tab) => tab.id),
        ['A', 'B', 'C']
      )
      const { computeSplitPosition } =
        await import('../src/renderer/src/components/use-tab-strip-dnd')
      const rect = new DOMRect(0, 100, 800, 400)
      assert.equal(computeSplitPosition(rect, 500, 120), 'top')
      assert.equal(computeSplitPosition(rect, 100, 490), 'bottom')
      assert.equal(computeSplitPosition(rect, 100, 300), 'left')
      assert.equal(computeSplitPosition(rect, 700, 300), 'right')
      assert.equal(computeSplitPosition(rect, 900, 300), null)
      assert.equal(computeSplitPosition(new DOMRect(), 0, 0), null)
    } else if (scenario === 'timers') {
      const { TurnView } = await import('../src/renderer/src/components/TurnView')
      const { formatElapsed } = await import('../src/renderer/src/chat/turns')
      const { translate } = await import('../src/shared/i18n')
      const originalNow = Date.now
      Date.now = () => 10_000
      try {
        sessions.setState({
          activeTabId: 'B',
          runtime: {
            A: { ...emptyRuntime(), streamStartedAt: 1_000, streamElapsedMs: 15_000 },
            B: { ...emptyRuntime(), streamStartedAt: 7_000, streamElapsedMs: 1_000 }
          }
        })
        const turn: Turn = {
          id: 'live:clock',
          process: [],
          answer: [],
          hasProcess: true,
          startedAt: 1_000,
          endedAt: 10_000,
          streaming: true,
          waitingForModel: false
        }
        const t = (
          key: Parameters<typeof translate>[1],
          params?: Parameters<typeof translate>[2]
        ) => translate('en', key, params)
        const label = (id: string) =>
          host.querySelector(`[data-clock="${id}"] [data-slot="marker-content"]`)!.textContent
        await act(async () => {
          root.render(
            h(
              Fragment,
              null,
              h('div', { 'data-clock': 'A' }, h(TurnView, { turn, sessionId: 'A' })),
              h('div', { 'data-clock': 'B' }, h(TurnView, { turn, sessionId: 'B' }))
            )
          )
        })
        assert.equal(label('A'), t('turn.worked', { duration: formatElapsed(9_000, t) }))
        assert.equal(label('B'), t('turn.worked', { duration: formatElapsed(3_000, t) }))
        await act(async () => {
          sessions.setState({ activeTabId: null })
        })
        assert.equal(label('A'), t('turn.worked', { duration: formatElapsed(9_000, t) }))
        await act(async () => {
          root.render(
            h(
              'div',
              { 'data-clock': 'A' },
              h(TurnView, { turn: { ...turn, streaming: false }, sessionId: 'A' })
            )
          )
        })
        assert.equal(label('A'), t('turn.workedFor', { duration: formatElapsed(15_000, t) }))
      } finally {
        Date.now = originalNow
      }
    } else throw new Error(`Unknown fixture: ${scenario}`)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--fixture') await fixture(process.argv[3])
else
  for (const scenario of [
    'loading',
    'memory-readiness',
    'drafts',
    'headers',
    'close-active',
    'close-sidebar',
    'close-inactive',
    'close-hidden',
    'close-collapse',
    'close-cross-scope',
    'close-file',
    'close-diff',
    'tab-dnd',
    'timers'
  ]) {
    test(`split pane regressions: ${scenario}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--fixture', scenario], {
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const timer = setTimeout(() => child.kill(), 12_000)
      try {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(code, 0, err || out)
      } finally {
        clearTimeout(timer)
        child.kill()
      }
    }, 15_000)
  }

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type {
  AppSettings,
  ProjectGroup,
  SessionApi,
  SessionMeta,
  SettingsAuthEvent,
  SettingsProvider,
  SidebarPrefs,
  ThemePrefs,
  WorktreeCreateInfo,
  WorktreeDeletionInfo
} from '../src/shared/api'
import type { OpenTab } from '../src/renderer/src/stores/sessions'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    appearance: 'light',
    lightTheme: 'pig',
    darkTheme: 'pig',
    sendShortcut: 'enter',
    completionNotifications: true,
    beamBorderEnabled: true,
    localeSetting: 'zh-CN',
    systemLocale: 'zh-CN',
    defaultModel: null,
    defaultThinkingLevel: null,
    thinkingLevels: [],
    models: [],
    providers: [],
    ...patch
  }
}

const provider: SettingsProvider = {
  id: 'test',
  name: 'Test',
  oauth: { name: 'Test', subscription: false },
  apiKey: null,
  configured: true,
  using: 'oauth'
}

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const api: Partial<SessionApi> = { getSettings: async () => settings() }
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })

  if (name === 'save-order' || name === 'save-failure') {
    await useSettingsStore.getState().load()
    const themes: ReturnType<typeof deferred<ThemePrefs>>[] = []
    const shortcuts: string[] = []
    api.setTheme = () => {
      const request = deferred<ThemePrefs>()
      themes.push(request)
      return request.promise
    }
    api.setSendShortcut = async (shortcut) => {
      shortcuts.push(shortcut)
      return { sendShortcut: shortcut }
    }
    const first = useSettingsStore.getState().setTheme({ appearance: 'dark' })
    const second = useSettingsStore.getState().setTheme({ lightTheme: 'everforest' })
    assert.equal(useSettingsStore.getState().appearance, 'dark')
    assert.equal(useSettingsStore.getState().lightTheme, 'everforest')
    assert.equal(document.documentElement.style.colorScheme, 'dark')
    await Promise.resolve()
    assert.equal(themes.length, 1)

    if (name === 'save-order') {
      const third = useSettingsStore.getState().setSendShortcut('shift-enter')
      assert.deepEqual(shortcuts, [])
      themes[0].resolve({ appearance: 'dark', lightTheme: 'pig', darkTheme: 'pig' })
      await first
      assert.equal(useSettingsStore.getState().lightTheme, 'everforest')
      assert.equal(themes.length, 2)
      themes[1].resolve({ appearance: 'dark', lightTheme: 'everforest', darkTheme: 'pig' })
      await Promise.all([second, third])
      assert.deepEqual(shortcuts, ['shift-enter'])
      assert.equal(useSettingsStore.getState().sendShortcut, 'shift-enter')
      assert.equal(useSettingsStore.getState().appearance, 'dark')
      assert.equal(useSettingsStore.getState().error, null)
    } else {
      themes[0].reject(new Error('first save failed'))
      await first
      assert.equal(useSettingsStore.getState().appearance, 'light')
      assert.equal(useSettingsStore.getState().lightTheme, 'everforest')
      assert.equal(document.documentElement.dataset.palette, 'everforest')
      themes[1].resolve({ appearance: 'light', lightTheme: 'everforest', darkTheme: 'pig' })
      await second
      assert.equal(useSettingsStore.getState().error, 'first save failed')
      const last = useSettingsStore.getState().setTheme({ appearance: 'dark' })
      await Promise.resolve()
      themes[2].reject(new Error('last save failed'))
      await last
      assert.equal(useSettingsStore.getState().appearance, 'light')
      assert.equal(document.documentElement.style.colorScheme, 'light')
      assert.equal(useSettingsStore.getState().error, 'last save failed')
      await useSettingsStore.getState().setSendShortcut('shift-enter')
      assert.equal(useSettingsStore.getState().error, null)
      assert.equal(useSettingsStore.getState().sendShortcut, 'shift-enter')
    }
    await GlobalRegistrator.unregister()
    return
  }

  if (name === 'load-race') {
    const stale = deferred<AppSettings>()
    let persisted = settings()
    let reads = 0
    api.getSettings = () => (++reads === 1 ? stale.promise : Promise.resolve(persisted))
    api.setTheme = async (patch) => {
      persisted = { ...persisted, ...patch }
      return persisted
    }
    const first = useSettingsStore.getState().load()
    assert.equal(first, useSettingsStore.getState().load())
    await Promise.resolve()
    await useSettingsStore.getState().setTheme({ appearance: 'dark' })
    persisted = { ...persisted, providers: [provider] }
    useSettingsStore.getState().setProviders([provider])
    const appearances: string[] = []
    const unsubscribe = useSettingsStore.subscribe((state) => {
      appearances.push(state.appearance)
    })
    stale.resolve(settings())
    await first
    assert.equal(reads, 2)
    assert.equal(useSettingsStore.getState().loaded, true)
    assert.deepEqual(useSettingsStore.getState().providers, [provider])
    assert.equal(useSettingsStore.getState().appearance, 'dark')
    assert.ok(appearances.every((appearance) => appearance === 'dark'))
    unsubscribe()
    await GlobalRegistrator.unregister()
    return
  }

  if (name === 'notification-setting') {
    await useSettingsStore.getState().load()
    let persisted = true
    api.setCompletionNotifications = async (enabled) => {
      persisted = enabled
      return { completionNotifications: enabled }
    }
    await useSettingsStore.getState().setCompletionNotifications(false)
    assert.equal(persisted, false)
    assert.equal(useSettingsStore.getState().completionNotifications, false)
    await useSettingsStore.getState().setCompletionNotifications(true)
    assert.equal(persisted, true)
    assert.equal(useSettingsStore.getState().completionNotifications, true)
    await GlobalRegistrator.unregister()
    return
  }

  if (name === 'notification-navigation') {
    const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
    const { openNotifiedSession } = await import('../src/renderer/src/chat/notification-navigation')
    const selected: string[] = []
    const switched: string[] = []
    const restoreModes: boolean[] = []
    let closes = 0
    const setTab = (tab: 'chats' | 'projects') => switched.push(tab)
    const setRestoreMode = (chat: boolean) => restoreModes.push(chat)
    const closeSettings = () => { closes++ }
    useSessionsStore.setState({
      openTabs: [
        { id: 'project', kind: 'project', cwd: '/project', title: 'Project', loadState: 'ready' },
        { id: 'chat', kind: 'chat', cwd: '/chat', title: 'Chat', loadState: 'ready' },
        { id: 'diff', kind: 'diff', cwd: '/project', title: 'Diff', loadState: 'ready' }
      ],
      setActive: (id) => { selected.push(id) }
    })
    openNotifiedSession('project', 'chats', setTab, setRestoreMode, closeSettings)
    openNotifiedSession('chat', 'projects', setTab, setRestoreMode, closeSettings)
    openNotifiedSession('project', 'projects', setTab, setRestoreMode, closeSettings)
    openNotifiedSession('diff', 'projects', setTab, setRestoreMode, closeSettings)
    openNotifiedSession('closed', 'projects', setTab, setRestoreMode, closeSettings)
    assert.deepEqual(selected, ['project', 'chat', 'project'])
    assert.deepEqual(switched, ['projects', 'chats'])
    assert.deepEqual(restoreModes, [false, true])
    assert.equal(closes, 3)
    await GlobalRegistrator.unregister()
    return
  }

  if (name === 'locale') {
    const writes: string[] = []
    api.getSettings = async () => settings({ localeSetting: 'system', systemLocale: 'zh-CN' })
    api.setLocaleSetting = async (locale) => {
      writes.push(locale)
      return { localeSetting: locale, systemLocale: 'zh-CN' }
    }
    const { t } = await import('../src/renderer/src/lib/i18n')
    const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
    useSessionsStore.setState({
      openTabs: [
        { id: 'draft', cwd: '/project', title: '新对话', kind: 'project', loadState: 'ready' }
      ]
    })

    await useSettingsStore.getState().load()
    assert.equal(useSettingsStore.getState().localeSetting, 'system')
    assert.equal(useSettingsStore.getState().locale, 'zh-CN')
    assert.equal(document.documentElement.lang, 'zh-CN')
    assert.equal(document.documentElement.dataset.locale, 'zh-CN')
    assert.equal(localStorage.getItem('pig.locale'), 'zh-CN')
    assert.equal(t('sessions.newTitle'), '新对话')

    await useSettingsStore.getState().setLocale('en')
    assert.deepEqual(writes, ['en'])
    assert.equal(useSettingsStore.getState().locale, 'en')
    assert.equal(useSettingsStore.getState().localeSetting, 'en')
    assert.equal(document.documentElement.lang, 'en')
    assert.equal(localStorage.getItem('pig.locale'), 'en')
    assert.equal(t('sessions.newTitle'), 'New chat')
    assert.equal(useSessionsStore.getState().openTabs[0]?.title, 'New chat')

    await GlobalRegistrator.unregister()
    return
  }

  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let unmounted = false
  try {
    if (name === 'beam-border-setting') {
      let persisted = true
      api.setBeamBorderEnabled = async (enabled) => {
        persisted = enabled
        return { beamBorderEnabled: enabled }
      }
      await useSettingsStore.getState().load()
      const { GeneralPane } = await import('../src/renderer/src/components/settings/GeneralPane')
      await act(async () => { root.render(createElement(GeneralPane)) })
      const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Beam 动态边框"]')!
      assert.equal(toggle().getAttribute('aria-checked'), 'true')
      await act(async () => { toggle().click() })
      assert.equal(persisted, false)
      assert.equal(useSettingsStore.getState().beamBorderEnabled, false)
      assert.equal(toggle().getAttribute('aria-checked'), 'false')
      await act(async () => { toggle().click() })
      assert.equal(persisted, true)
      assert.equal(toggle().getAttribute('aria-checked'), 'true')
    } else if (name === 'auth') {
      const listeners = new Set<(event: SettingsAuthEvent) => void>()
      const requests: ReturnType<typeof deferred<SettingsProvider[]>>[] = []
      const replies: { id: string; value: string | null }[] = []
      let cancellations = 0
      api.onAuthEvent = (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
      api.loginProvider = () => {
        const request = deferred<SettingsProvider[]>()
        requests.push(request)
        return request.promise
      }
      api.cancelLogin = async () => {
        cancellations += 1
      }
      api.replyAuthPrompt = async (id, value) => {
        replies.push({ id, value })
      }
      const { useProviderAuth } =
        await import('../src/renderer/src/components/settings/use-provider-auth')
      let state!: ReturnType<typeof useProviderAuth>
      function Probe() {
        state = useProviderAuth()
        return null
      }
      const emit = (event: SettingsAuthEvent) => {
        for (const listener of listeners) listener(event)
      }
      await act(async () => {
        root.render(createElement(Probe))
      })
      await act(async () => {
        emit({ kind: 'notify', event: { type: 'info', message: 'unowned' } })
      })
      assert.deepEqual(state.lines, [])
      let first!: Promise<void>
      await act(async () => {
        first = state.startLogin(provider, 'oauth')
        void state.startLogin(provider, 'oauth')
      })
      assert.equal(requests.length, 1)
      await act(async () => {
        emit({ kind: 'prompt', id: 'one', prompt: { type: 'text', message: 'Code' } })
      })
      await act(async () => {
        state.submit('a')
        state.submit('b')
      })
      assert.deepEqual(replies, [{ id: 'one', value: 'a' }])
      await act(async () => {
        state.cancel()
        state.cancel()
      })
      assert.equal(cancellations, 1)
      assert.equal(state.login, null)
      assert.equal(state.busy, true)
      await act(async () => {
        emit({ kind: 'prompt', id: 'late', prompt: { type: 'text', message: 'Late' } })
        emit({ kind: 'notify', event: { type: 'info', message: 'late' } })
        void state.startLogin(provider, 'oauth')
      })
      assert.equal(state.prompt, null)
      assert.deepEqual(state.lines, [])
      assert.equal(requests.length, 1)
      await act(async () => {
        requests[0].reject(new Error('Login cancelled'))
        await first
      })
      assert.equal(state.busy, false)
      assert.equal(state.error, null)
      let second!: Promise<void>
      await act(async () => {
        second = state.startLogin(provider, 'oauth')
      })
      await act(async () => {
        root.unmount()
      })
      unmounted = true
      assert.equal(cancellations, 2)
      assert.equal(listeners.size, 0)
      requests[1].resolve([provider])
      await second
      assert.deepEqual(useSettingsStore.getState().providers, [])
      assert.deepEqual(replies, [{ id: 'one', value: 'a' }])
    } else if (name === 'sidebar-timeout') {
      const initial = deferred<SidebarPrefs>()
      api.getSidebarPrefs = () => initial.promise
      const { useSidebarPreferences } =
        await import('../src/renderer/src/components/sidebar/use-sidebar-preferences')
      let state!: ReturnType<typeof useSidebarPreferences>
      function Probe() {
        state = useSidebarPreferences()
        return null
      }
      const originalSetTimeout = globalThis.setTimeout
      const pendingTimeouts: Array<() => void> = []
      globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
        if (delay === 2000) {
          pendingTimeouts.push(callback)
          return 0 as unknown as ReturnType<typeof setTimeout>
        }
        return originalSetTimeout(callback, delay, ...args)
      }) as typeof setTimeout
      try {
        await act(async () => { root.render(createElement(Probe)) })
        assert.equal(state.ready, false)
        assert.equal(pendingTimeouts.length, 1)
        await act(async () => { pendingTimeouts[0]() })
        assert.equal(state.ready, true, 'an unanswered preference read cannot block workspace restore')
        assert.equal(state.tab, 'projects', 'a timed-out read falls back to Projects')
        await act(async () => {
          initial.resolve({ sidebarTab: 'chats', split: 0.5, reviewOpen: false, reviewWidth: 320 })
        })
        assert.equal(state.tab, 'projects', 'a late preference cannot steal the pane after fallback')
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    } else if (name === 'sidebar-restore') {
      const initial = deferred<SidebarPrefs>()
      api.getSidebarPrefs = () => initial.promise
      const { useSidebarPreferences } =
        await import('../src/renderer/src/components/sidebar/use-sidebar-preferences')
      let state!: ReturnType<typeof useSidebarPreferences>
      function Probe() {
        state = useSidebarPreferences()
        return null
      }
      await act(async () => { root.render(createElement(Probe)) })
      assert.equal(state.ready, false)
      await act(async () => {
        initial.resolve({ sidebarTab: 'chats', split: 0.5, reviewOpen: false, reviewWidth: 320 })
      })
      assert.equal(state.ready, true)
      assert.equal(state.tab, 'chats', 'a restored Chats preference can drive the initial workspace selection')
    } else if (name === 'sidebar') {
      const initial = deferred<SidebarPrefs>()
      const saves: {
        patch: Partial<SidebarPrefs>
        result: ReturnType<typeof deferred<SidebarPrefs>>
      }[] = []
      api.getSidebarPrefs = () => initial.promise
      api.setSidebarPrefs = (patch) => {
        const result = deferred<SidebarPrefs>()
        saves.push({ patch, result })
        return result.promise
      }
      const { useSidebarPreferences } =
        await import('../src/renderer/src/components/sidebar/use-sidebar-preferences')
      let state!: ReturnType<typeof useSidebarPreferences>
      function Probe() {
        state = useSidebarPreferences()
        return null
      }
      await act(async () => {
        root.render(createElement(Probe))
      })
      assert.equal(state.ready, false, 'the workspace must wait for the sidebar selection')
      await act(async () => {
        state.setTab('chats')
      })
      await act(async () => {
        initial.resolve({ sidebarTab: 'projects', split: 0.5, reviewOpen: false, reviewWidth: 320 })
      })
      assert.equal(state.tab, 'chats', 'a switch made before the prefs land wins over them')
      assert.equal(state.ready, true)
      await act(async () => {
        state.setTab('projects')
      })
      assert.equal(saves.length, 1, 'the second write waits for the first')
      assert.deepEqual(
        saves.map((save) => save.patch),
        [{ sidebarTab: 'chats' }]
      )
      await act(async () => {
        saves[0].result.reject(new Error('save failed'))
      })
      assert.equal(state.error, 'save failed')
      assert.equal(saves.length, 2, 'settling the first releases the second')
      assert.deepEqual(
        saves.map((save) => save.patch),
        [{ sidebarTab: 'chats' }, { sidebarTab: 'projects' }]
      )
      await act(async () => {
        saves[1].result.resolve({ sidebarTab: 'projects', split: 0.5, reviewOpen: false, reviewWidth: 320 })
      })
      assert.equal(state.error, null, 'a write that landed clears the message')
      assert.equal(state.tab, 'projects')
    } else if (name === 'worktree') {
      const { useProjectAction } =
        await import('../src/renderer/src/components/sidebar/project-action')
      const { CreateWorktreeButton } =
        await import('../src/renderer/src/components/sidebar/WorktreeActions')
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      let action!: ReturnType<typeof useProjectAction>
      const checks: ReturnType<typeof deferred<WorktreeCreateInfo>>[] = []
      const creates: boolean[] = []
      api.worktreeCreateInfo = () => {
        const request = deferred<WorktreeCreateInfo>()
        checks.push(request)
        return request.promise
      }
      function Probe() {
        action = useProjectAction()
        return createElement(
          TooltipProvider,
          null,
          createElement(CreateWorktreeButton, {
            projectCwd: '/project',
            hasGit: false,
            disabled: action.pending !== null,
            busy: action.pending !== null,
            runAction: action.runAction,
            onCreate: async (initGit) => {
              creates.push(initGit)
            }
          })
        )
      }
      await act(async () => {
        root.render(createElement(Probe))
      })
      const button = () =>
        container.querySelector<HTMLButtonElement>('[aria-label="初始化 Git"]')!
      await act(async () => {
        button().click()
        button().click()
      })
      assert.equal(checks.length, 1)
      await act(async () => {
        checks[0].reject(new Error('cannot inspect repository'))
      })
      assert.deepEqual(creates, [])
      assert.equal(action.error, 'cannot inspect repository')
      await act(async () => {
        button().click()
      })
      await act(async () => {
        checks[1].resolve({ hasGit: false, hasHead: false })
      })
      const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '初始化并创建'
      )
      assert.ok(confirm)
      await act(async () => {
        confirm.click()
      })
      assert.deepEqual(creates, [true])
      assert.equal(action.error, null)
    } else if (name === 'worktree-delete') {
      const { useProjectAction } =
        await import('../src/renderer/src/components/sidebar/project-action')
      const { WorktreeDeleteButton } =
        await import('../src/renderer/src/components/sidebar/WorktreeActions')
      let action!: ReturnType<typeof useProjectAction>
      const checks: ReturnType<typeof deferred<WorktreeDeletionInfo>>[] = []
      const deletions: boolean[] = []
      api.worktreeDeletionInfo = () => {
        const request = deferred<WorktreeDeletionInfo>()
        checks.push(request)
        return request.promise
      }
      function Probe() {
        action = useProjectAction()
        return createElement(WorktreeDeleteButton, {
          projectCwd: '/project',
          cwd: '/worktree',
          branch: 'branch',
          disabled: action.pending !== null,
          busy: action.pending !== null,
          runAction: action.runAction,
          onConfirm: async (force) => {
            deletions.push(force)
          }
        })
      }
      const button = (label: string) => {
        const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent === label || button.getAttribute('aria-label') === label
        )
        assert.ok(found, label)
        return found
      }
      await act(async () => {
        root.render(createElement(Probe))
      })
      await act(async () => {
        button('删除 branch').click()
      })
      assert.throws(() => button('删除'), 'no dialog opens before the check answers')
      await act(async () => {
        checks[0].reject(new Error('cannot inspect deletion'))
      })
      assert.deepEqual(deletions, [])
      assert.equal(action.error, 'cannot inspect deletion')
      await act(async () => {
        button('删除 branch').click()
      })
      await act(async () => {
        checks[1].resolve({
          cwd: '/worktree',
          branch: 'branch',
          dirty: true,
          unmerged: true,
          missing: false
        })
      })
      assert.deepEqual(deletions, [])
      assert.ok(
        document.body.textContent?.includes('包含未提交、未跟踪或被忽略的文件。'),
        'the risk joins the same dialog'
      )
      await act(async () => {
        const confirm = button('仍然删除')
        confirm.click()
        confirm.click()
      })
      assert.deepEqual(deletions, [true])
      await act(async () => {
        button('删除 branch').click()
      })
      await act(async () => {
        checks[2].resolve({
          cwd: '/worktree',
          branch: 'branch',
          dirty: false,
          unmerged: false,
          missing: false
        })
      })
      await act(async () => {
        const confirm = button('删除')
        confirm.click()
        confirm.click()
      })
      assert.deepEqual(deletions, [true, false])
    } else if (name === 'reveal-active-session') {
      class NoopResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
      Object.assign(window, { ResizeObserver: NoopResizeObserver })
      const { DndContext } = await import('@dnd-kit/core')
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      const { ProjectRow } =
        await import('../src/renderer/src/components/sidebar/ProjectRow')
      const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
      const meta = (id: string, cwd: string, firstMessage: string): SessionMeta => ({
        id,
        cwd,
        path: `${cwd}/${id}.jsonl`,
        created: '2026-09-22T00:00:00.000Z',
        modified: '2026-09-22T00:00:00.000Z',
        size: 100,
        firstMessage
      })
      const tab = (id: string, cwd: string, title: string): OpenTab => ({
        id,
        cwd,
        title,
        kind: 'project',
        loadState: 'ready'
      })
      const project: ProjectGroup = {
        cwd: '/project',
        name: 'project',
        sessions: [],
        worktrees: [
          {
            cwd: '/project',
            branch: 'main',
            isPrimary: true,
            locked: false,
            missing: false,
            managed: true,
            sessions: [meta('s1', '/project', 'First session')]
          },
          {
            cwd: '/project-feature',
            branch: 'feature',
            isPrimary: false,
            locked: false,
            missing: false,
            managed: true,
            sessions: [meta('s2', '/project-feature', 'Second session')]
          }
        ]
      }
      useSessionsStore.setState({
        projects: [project],
        openTabs: [],
        activeTabId: null,
        currentProjectCwd: null
      })
      await act(async () => {
        root.render(
          createElement(
            TooltipProvider,
            null,
            createElement(
              DndContext,
              null,
              createElement(ProjectRow, {
                project,
                index: 0,
                disabled: false,
                clickGuard: { current: false }
              })
            )
          )
        )
      })
      const shown = (text: string) => document.body.textContent?.includes(text) ?? false
      assert.equal(shown('First session'), false)
      await act(async () => {
        useSessionsStore.setState({
          openTabs: [tab('s1', '/project', 'First session')],
          activeTabId: 's1'
        })
      })
      assert.equal(shown('First session'), true)
      assert.equal(shown('Second session'), false)
      await act(async () => {
        useSessionsStore.setState({ activeTabId: null })
      })
      assert.equal(shown('First session'), true, 'leaving the session never folds it back')
      await act(async () => {
        useSessionsStore.setState({
          openTabs: [tab('s1', '/project', 'First session'), tab('s2', '/project-feature', 'Second session')],
          activeTabId: 's2'
        })
      })
      assert.equal(shown('First session'), true)
      assert.equal(shown('Second session'), true)
    } else {
      throw new Error(`Unknown fixture: ${name}`)
    }
  } finally {
    if (!unmounted)
      await act(async () => {
        root.unmount()
      })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--settings-sidebar-fixture') {
  await runFixture(process.argv[3])
} else {
  for (const [name, title] of Object.entries({
    'save-order': 'serial saves preserve all pending UI choices',
    'save-failure': 'failed saves roll back only their patch and keep the queue usable',
    'load-race': 'a stale settings load cannot replace later edits or provider updates',
    locale: 'the language setting follows the system, persists and re-titles placeholders',
    'notification-setting': 'the completion notification setting persists through the settings store',
    'beam-border-setting': 'the Beam border switch updates and persists its preference',
    'notification-navigation': 'notification clicks select only open session tabs across sidebar halves',
    auth: 'auth cancellation owns its prompts until completion and cleans up on unmount',
    sidebar: 'late preferences preserve user changes and writes remain ordered',
    'sidebar-restore': 'sidebar preferences expose the saved Chats selection before workspace restore',
    'sidebar-timeout': 'an unanswered sidebar read falls back without applying a late response',
    worktree: 'worktree inspection is guarded and failures never start creation',
    'worktree-delete':
      'failed deletion checks never delete and dirty worktrees require explicit force',
    'reveal-active-session':
      'opening a session unfolds its project and branch, and leaving never folds back'
  })) {
    test(`settings/sidebar: ${title}`, async () => {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, '--settings-sidebar-fixture', name],
        {
          cwd: new URL('..', import.meta.url).pathname,
          stdout: 'pipe',
          stderr: 'pipe'
        }
      )
      const timeout = setTimeout(() => child.kill(), 12_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

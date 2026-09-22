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

  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let unmounted = false
  try {
    if (name === 'auth') {
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
      await act(async () => {
        state.setSectionCollapsed('projects', true)
      })
      await act(async () => {
        initial.resolve({ projectsCollapsed: false, chatsCollapsed: true, split: 0.5, reviewOpen: false, reviewWidth: 320 })
      })
      assert.deepEqual(state.collapsed, { projects: true, chats: true })
      await act(async () => {
        state.setSectionCollapsed('chats', false)
      })
      assert.equal(saves.length, 1)
      await act(async () => {
        saves[0].result.reject(new Error('save failed'))
      })
      assert.equal(saves.length, 2)
      assert.equal(state.error, 'save failed')
      assert.deepEqual(
        saves.map((save) => save.patch),
        [{ projectsCollapsed: true }, { chatsCollapsed: false }]
      )
      await act(async () => {
        saves[1].result.resolve({ projectsCollapsed: false, chatsCollapsed: false, split: 0.5, reviewOpen: false, reviewWidth: 320 })
      })
      assert.deepEqual(state.collapsed, { projects: true, chats: false })
      assert.equal(
        state.error,
        'save failed',
        'a later save of another section leaves the failure alone: projects never reached the disk'
      )

      await act(async () => {
        state.setSectionCollapsed('chats', true)
      })
      assert.equal(saves.length, 3, 'the next write goes out on its own')
      await act(async () => {
        saves[2].result.reject(new Error('still failing'))
      })
      assert.equal(state.error, 'still failing')
      await act(async () => {
        state.setSectionCollapsed('chats', false)
      })
      assert.equal(saves.length, 4)
      await act(async () => {
        saves[3].result.resolve({ projectsCollapsed: false, chatsCollapsed: false, split: 0.5, reviewOpen: false, reviewWidth: 320 })
      })
      assert.equal(
        state.error,
        'save failed',
        'saving chats again clears only chats, so the projects failure is what is left to report'
      )

      await act(async () => {
        state.setSectionCollapsed('projects', false)
      })
      assert.equal(saves.length, 5)
      await act(async () => {
        saves[4].result.resolve({ projectsCollapsed: false, chatsCollapsed: false, split: 0.5, reviewOpen: false, reviewWidth: 320 })
      })
      assert.equal(state.error, null, 'and saving the section that failed clears the message')
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
    auth: 'auth cancellation owns its prompts until completion and cleans up on unmount',
    sidebar: 'late preferences preserve user changes and writes remain ordered',
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

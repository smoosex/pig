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
  WorktreeDeletionInfo,
  WorktreeGroup
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
    surfaceStyle: 'glass',
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
  const api: Partial<SessionApi> = { supportsGlass: name !== 'surface-style-unsupported', getSettings: async () => settings() }
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  const bootstrap = async () => {
    const html = await Bun.file(new URL('../src/renderer/index.html', import.meta.url)).text()
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
    new Function('localStorage', 'document', 'matchMedia', script)(localStorage, document, window.matchMedia.bind(window))
  }
  if (name === 'theme-cache-malformed') {
    const { storedThemePrefs } = await import('../src/renderer/src/lib/theme')
    for (const value of ['{invalid JSON', '']) {
      localStorage.setItem('pig.theme', value)
      assert.throws(() => storedThemePrefs(true), SyntaxError)
      await assert.rejects(bootstrap(), SyntaxError)
      assert.equal(localStorage.getItem('pig.theme'), value, 'bad mirrors are not replaced with guessed preferences')
    }
    await assert.rejects(import('../src/renderer/src/stores/settings'), SyntaxError)
    await GlobalRegistrator.unregister()
    return
  }
  if (name === 'theme-cache-read-failure') {
    const { storedThemePrefs } = await import('../src/renderer/src/lib/theme')
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    const error = new Error('Storage unavailable')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => { throw error } }
    })
    try {
      assert.throws(() => storedThemePrefs(true), (caught) => caught === error)
      await assert.rejects(bootstrap(), (caught) => caught === error)
      await assert.rejects(import('../src/renderer/src/stores/settings'), (caught) => caught === error)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor)
      await GlobalRegistrator.unregister()
    }
    return
  }
  if (name === 'surface-style-restore' || name === 'surface-style-unsupported') {
    localStorage.setItem('pig.theme', JSON.stringify(settings({
      surfaceStyle: name === 'surface-style-restore' ? 'solid' : 'glass', lightTheme: 'everforest'
    })))
    await bootstrap()
    assert.equal(document.documentElement.dataset.surfaceStyle, 'solid')
    assert.equal(document.documentElement.dataset.palette, 'everforest')
  }
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
      themes[0].resolve({ appearance: 'dark', lightTheme: 'pig', darkTheme: 'pig', surfaceStyle: 'glass' })
      await first
      assert.equal(useSettingsStore.getState().lightTheme, 'everforest')
      assert.equal(themes.length, 2)
      themes[1].resolve({ appearance: 'dark', lightTheme: 'everforest', darkTheme: 'pig', surfaceStyle: 'glass' })
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
      themes[1].resolve({ appearance: 'light', lightTheme: 'everforest', darkTheme: 'pig', surfaceStyle: 'glass' })
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

  if (name === 'surface-style-restore' || name === 'surface-style-unsupported') {
    assert.equal(useSettingsStore.getState().surfaceStyle, 'solid', 'first paint and store agree, including unsupported platforms with glass mirrors')
    assert.equal(useSettingsStore.getState().supportsGlass, name === 'surface-style-restore')
    assert.equal(useSettingsStore.getState().lightTheme, 'everforest')
    api.getSettings = async () => settings({ surfaceStyle: 'solid', lightTheme: 'everforest' })
    await useSettingsStore.getState().load()
    assert.equal(document.documentElement.dataset.surfaceStyle, 'solid')
    await GlobalRegistrator.unregister()
    return
  }

  if (name === 'surface-style') {
    const requests: ReturnType<typeof deferred<ThemePrefs>>[] = []
    const patches: Partial<ThemePrefs>[] = []
    api.getSettings = async () => settings({ lightTheme: 'everforest' })
    api.setTheme = (patch) => {
      patches.push(patch)
      const request = deferred<ThemePrefs>()
      requests.push(request)
      return request.promise
    }
    await useSettingsStore.getState().load()
    const solid = useSettingsStore.getState().setTheme({ surfaceStyle: 'solid' })
    assert.equal(document.documentElement.dataset.surfaceStyle, 'solid', 'opaque CSS covers the window before main removes material')
    await Promise.resolve()
    requests[0].resolve(settings({ surfaceStyle: 'solid', lightTheme: 'everforest' }))
    await solid
    const glass = useSettingsStore.getState().setTheme({ surfaceStyle: 'glass' })
    assert.equal(document.documentElement.dataset.surfaceStyle, 'solid', 'transparent CSS waits for native material acknowledgement')
    await Promise.resolve()
    requests[1].resolve(settings({ lightTheme: 'everforest' }))
    await glass
    assert.equal(document.documentElement.dataset.surfaceStyle, 'glass')
    assert.equal(document.documentElement.dataset.palette, 'everforest', 'style never changes the palette')
    assert.equal(document.documentElement.style.colorScheme, 'light')
    assert.equal(JSON.parse(localStorage.getItem('pig.theme')!).surfaceStyle, 'glass')

    const failure = useSettingsStore.getState().setTheme({ surfaceStyle: 'solid' })
    assert.equal(useSettingsStore.getState().surfaceStyle, 'solid')
    await Promise.resolve()
    requests[2].reject(new Error('style could not be saved'))
    await failure
    assert.equal(document.documentElement.dataset.surfaceStyle, 'glass')
    assert.equal(JSON.parse(localStorage.getItem('pig.theme')!).surfaceStyle, 'glass')
    assert.equal(useSettingsStore.getState().error, 'style could not be saved')

    const queuedSolid = useSettingsStore.getState().setTheme({ surfaceStyle: 'solid' })
    const queuedGlass = useSettingsStore.getState().setTheme({ surfaceStyle: 'glass' })
    await Promise.resolve()
    assert.equal(requests.length, 4)
    requests[3].resolve(settings({ surfaceStyle: 'glass', lightTheme: 'everforest' }))
    await queuedSolid
    assert.equal(document.documentElement.dataset.surfaceStyle, 'glass', 'a queued reverse coalesces obsolete solid material changes')
    requests[4].reject(new Error('glass could not be saved'))
    await queuedGlass
    assert.equal(document.documentElement.dataset.surfaceStyle, 'glass', 'a failed duplicate keeps the coalesced confirmed style')
    assert.deepEqual(patches.map((patch) => patch.surfaceStyle), ['solid', 'glass', 'solid', 'glass', 'glass'])
    await GlobalRegistrator.unregister()
    return
  }

  if (name === 'surface-style-animation') {
    const surface = document.createElement('div')
    surface.setAttribute('data-app-surface', '')
    document.body.append(surface)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const frames = new Map<number, FrameRequestCallback>()
    let frameId = 0
    globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId }
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
    const tick = () => {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(0)
    }
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
    const fade = deferred<void>()
    const animation = { transitionProperty: 'background-color', playState: 'running', finished: fade.promise }
    let animations = [animation]
    surface.getAnimations = () => animations as unknown as Animation[]
    let persisted = settings()
    const patches: Partial<ThemePrefs>[] = []
    api.setTheme = async (patch) => {
      if (patch.surfaceStyle === 'glass' && persisted.surfaceStyle === 'solid') {
        assert.equal(document.documentElement.dataset.surfaceStyle, 'solid', 'native glass is enabled before CSS uncovers it')
      }
      patches.push(patch)
      persisted = { ...persisted, ...patch }
      return persisted
    }
    await useSettingsStore.getState().load()
    const solid = useSettingsStore.getState().setTheme({ surfaceStyle: 'solid' })
    await flush()
    assert.equal(patches.length, 0, 'native material cannot close during the background fade')
    animations = []
    fade.resolve(undefined)
    await flush()
    assert.equal(frames.size, 1)
    tick()
    await flush()
    assert.equal(patches.length, 0, 'the final opaque frame must be painted before the IPC')
    tick()
    await solid
    assert.deepEqual(patches, [{ surfaceStyle: 'solid' }])
    await useSettingsStore.getState().setTheme({ surfaceStyle: 'glass' })
    assert.equal(document.documentElement.dataset.surfaceStyle, 'glass')

    const unfinished = deferred<void>()
    animations = [{ transitionProperty: 'background-color', playState: 'running', finished: unfinished.promise }]
    const obsolete = useSettingsStore.getState().setTheme({ surfaceStyle: 'solid', lightTheme: 'everforest' })
    await flush()
    const reversed = useSettingsStore.getState().setTheme({ surfaceStyle: 'glass' })
    await Promise.all([obsolete, reversed])
    assert.deepEqual(patches.slice(2), [
      { surfaceStyle: 'glass', lightTheme: 'everforest' }, { surfaceStyle: 'glass' }
    ], 'a reversed fade never toggles native solid; unrelated palette patches are preserved')
    assert.equal(useSettingsStore.getState().surfaceStyle, 'glass')
    assert.equal(useSettingsStore.getState().lightTheme, 'everforest')
    assert.equal(useSettingsStore.getState().error, null)
    assert.equal(frames.size, 0)

    const finalFade = deferred<void>()
    animations = [{ transitionProperty: 'background-color', playState: 'running', finished: finalFade.promise }]
    const firstSolid = useSettingsStore.getState().setTheme({ surfaceStyle: 'solid' })
    await flush()
    const skippedGlass = useSettingsStore.getState().setTheme({ surfaceStyle: 'glass' })
    const lastSolid = useSettingsStore.getState().setTheme({ surfaceStyle: 'solid' })
    await flush()
    assert.equal(patches.length, 4, 'solid → glass → solid still waits for the current fade')
    animations = []
    finalFade.resolve(undefined)
    await flush()
    tick()
    await flush()
    tick()
    await Promise.all([firstSolid, skippedGlass, lastSolid])
    assert.deepEqual(patches.slice(4).map((patch) => patch.surfaceStyle), ['solid', 'solid', 'solid'])
    assert.equal(useSettingsStore.getState().surfaceStyle, 'solid')
    assert.equal(useSettingsStore.getState().error, null)
    assert.equal(frames.size, 0)
    surface.remove()
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
          initial.resolve({ sidebarTab: 'chats', split: 0.5, reviewOpen: false })
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
        initial.resolve({ sidebarTab: 'chats', split: 0.5, reviewOpen: false })
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
        initial.resolve({ sidebarTab: 'projects', split: 0.5, reviewOpen: false })
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
        saves[1].result.resolve({ sidebarTab: 'projects', split: 0.5, reviewOpen: false })
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
          onConfirm: async () => {
            deletions.push(true)
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
      assert.equal(action.error, null)
      assert.ok(
        document.body.textContent?.includes('尚未合入项目的提交，工作目录里还有未提交的修改'),
        'unmerged commits with dirty files get the combined warning'
      )
      assert.ok(
        document.querySelector<HTMLElement>('[role="dialog"]')?.textContent?.includes(
          '删除未合并的分支'
        ),
        'the unmerged case also retitles the dialog'
      )
      await act(async () => {
        const confirm = button('删除')
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
      assert.ok(
        document.body.textContent?.includes('已经合入项目，没有未提交的内容'),
        'a clean merged branch gets its own copy'
      )
      assert.ok(
        !document.querySelector<HTMLElement>('[role="dialog"]')
          ?.textContent?.includes('删除未合并的分支'),
        'the merged case keeps the plain title'
      )
      await act(async () => {
        const confirm = button('删除')
        confirm.click()
        confirm.click()
      })
      assert.deepEqual(deletions, [true, true])

      const { translate } = await import('../src/shared/i18n')
      const cases = [
        { dirty: false, unmerged: false, missing: false, body: 'worktree.deleteBodyClean' },
        { dirty: true, unmerged: false, missing: false, body: 'worktree.deleteBodyDirty' },
        { dirty: false, unmerged: false, missing: true, body: 'worktree.deleteBodyMissing' },
        { dirty: false, unmerged: true, missing: false, body: 'worktree.deleteBodyUnmerged' },
        { dirty: true, unmerged: true, missing: false, body: 'worktree.deleteBodyUnmergedDirty' }
      ] as const
      for (const locale of ['zh-CN', 'en'] as const) {
        await act(async () => { useSettingsStore.setState({ localeSetting: locale, locale }) })
        for (const { body, ...flags } of cases) {
          const requestIndex = checks.length
          await act(async () => {
            button(translate(locale, 'worktree.deleteAria', { branch: 'branch' })).click()
          })
          await act(async () => {
            checks[requestIndex].resolve({ cwd: '/worktree', branch: 'branch', ...flags })
          })
          const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
          assert.ok(dialog)
          assert.ok(dialog.textContent?.includes(translate(locale, body)), `${locale}: ${body}`)
          assert.ok(
            dialog.textContent?.includes(locale === 'en' ? 'Pi session history' : 'Pi 会话历史'),
            'every confirmation mentions the Pi session history'
          )
          assert.ok(
            dialog.textContent?.includes(locale === 'en' ? 'permanently deleted' : '永久删除'),
            'every confirmation warns about permanent deletion'
          )
          const before = deletions.length
          await act(async () => {
            const confirm = button(translate(locale, 'common.delete'))
            confirm.click()
            confirm.click()
          })
          assert.equal(deletions.length, before + 1)
        }
      }
    } else if (name === 'worktree-naming-retry') {
      class NoopResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
      Object.assign(window, { ResizeObserver: NoopResizeObserver })
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      const { WorktreeRow } =
        await import('../src/renderer/src/components/sidebar/WorktreeRow')
      const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
      const retried: string[][] = []
      let answering: ReturnType<typeof deferred<void>> | null = null
      api.retryWorktreeNaming = (projectCwd, cwd) => {
        retried.push([projectCwd, cwd])
        answering = deferred<void>()
        return answering.promise
      }
      useSessionsStore.setState({ projects: [], openTabs: [], activeTabId: null, currentProjectCwd: null })
      const row = (patch: Partial<WorktreeGroup> = {}) => ({
        cwd: '/project-worktree',
        branch: 'b4e4a1f0-0000-0000-0000-000000000000',
        isPrimary: false,
        locked: false,
        missing: false,
        managed: true,
        naming: 'failed' as const,
        namingError: '命名模型未返回有效的 conventional 分支名',
        sessions: [],
        ...patch
      })
      const renderRow = (patch: Partial<WorktreeGroup> = {}) =>
        root.render(
          createElement(TooltipProvider, null, createElement(Probe, patch))
        )
      const { useProjectAction } =
        await import('../src/renderer/src/components/sidebar/project-action')
      let action!: ReturnType<typeof useProjectAction>
      function Probe(patch: Partial<WorktreeGroup>) {
        action = useProjectAction()
        return createElement(WorktreeRow, {
          projectCwd: '/project',
          worktree: row(patch),
          open: false,
          onOpenChange: () => {},
          pending: action.pending,
          runAction: action.runAction
        })
      }
      const retry = () =>
        container.querySelector<HTMLButtonElement>('[aria-label^="重新命名 "]')
      await act(async () => {
        renderRow()
      })
      // The failed row drops the error label in favour of the retry; a healthy row offers neither.
      assert.equal(document.body.textContent?.includes('命名失败'), false)
      const button = retry()
      assert.ok(button, 'a failed naming offers a retry')
      assert.ok(button.classList.contains('text-destructive'), 'failed naming stays red without hover')
      assert.ok(button.classList.contains('hover:text-destructive'))
      assert.ok(!button.classList.contains('text-muted-foreground'), 'secondary actions cannot mask the error')
      for (const selector of ['.lucide-history', '.lucide-plus']) {
        const actionButton = container.querySelector(selector)?.closest('button')
        assert.ok(actionButton)
        assert.ok(actionButton.classList.contains('text-muted-foreground'), 'normal branch actions stay secondary')
      }
      assert.equal(button.disabled, false)
      assert.equal(button.getAttribute('aria-busy'), 'false')
      await act(async () => {
        button.click()
      })
      assert.deepEqual(retried, [['/project', '/project-worktree']])
      assert.equal(button.getAttribute('aria-busy'), 'true', 'the retry spins while it is in flight')
      await act(async () => {
        answering?.resolve()
      })
      assert.equal(button.getAttribute('aria-busy'), 'false')
      await act(async () => {
        renderRow({ naming: undefined, namingError: undefined, branch: 'feat/done' })
      })
      assert.equal(retry(), null, 'a named worktree has nothing to retry')
      assert.deepEqual(retried, [['/project', '/project-worktree']], 'no retry was sent for it')
      assert.equal(action.error, null, 'the retry never failed')
    } else if (name === 'reveal-active-session' || name === 'project-expansion-switch-chat') {
      class NoopResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
      Object.assign(window, { ResizeObserver: NoopResizeObserver })
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
      const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
      api.onProjectsChanged = () => () => {}
      api.discoverOpenedWorktrees = async () => []
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
      const tabs = [tab('s1', '/project', 'First session'), tab('s2', '/project-feature', 'Second session')]
      useSessionsStore.setState({
        projects: [project],
        chats: [],
        openTabs: name === 'reveal-active-session' ? [] : tabs,
        activeTabId: null,
        currentProjectCwd: null,
        selectProjectCwd: async (cwd) => { useSessionsStore.setState({ currentProjectCwd: cwd }) }
      })
      const renderHalf = async (half: 'projects' | 'chats', select?: () => void) => {
        await act(async () => {
          select?.()
          root.render(
            createElement(TooltipProvider, null, createElement(Sidebar, {
              tab: half,
              preferencesError: null,
              onOpenSettings: () => {}
            }))
          )
        })
      }
      const shown = (text: string) => container.textContent?.includes(text) ?? false
      const projectButton = () => {
        const button = container.querySelector('[title="/project"]')?.closest('button')
        assert.ok(button)
        return button
      }
      const branchButton = (branch: string) => {
        const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${branch}"]`)
        assert.ok(button)
        return button
      }
      const roundTrip = async () => {
        const { activeTabId, currentProjectCwd } = useSessionsStore.getState()
        await renderHalf('chats', () => {
          useSessionsStore.setState({ activeTabId: null, currentProjectCwd: null })
        })
        assert.equal(container.querySelector('[title="/project"]'), null)
        assert.equal(shown('First session'), false)
        await renderHalf('projects', () => {
          useSessionsStore.setState({ activeTabId, currentProjectCwd })
        })
      }
      await renderHalf('projects')
      assert.equal(shown('First session'), false)

      if (name === 'reveal-active-session') {
        await act(async () => {
          useSessionsStore.setState({ openTabs: [tabs[0]], activeTabId: 's1' })
        })
        assert.equal(shown('First session'), true)
        assert.equal(shown('Second session'), false)
        await act(async () => {
          useSessionsStore.setState({ activeTabId: null })
        })
        assert.equal(shown('First session'), true, 'leaving the session never folds it back')
        await act(async () => {
          useSessionsStore.setState({ openTabs: tabs, activeTabId: 's2' })
        })
        assert.equal(shown('First session'), true)
        assert.equal(shown('Second session'), true)
      } else {
        await act(async () => { projectButton().click() })
        await act(async () => { branchButton('main').click() })
        assert.equal(shown('First session'), true)
        assert.equal(shown('Second session'), false)
        await roundTrip()
        assert.equal(projectButton().getAttribute('aria-expanded'), 'true')
        assert.equal(branchButton('main').getAttribute('aria-expanded'), 'true')
        assert.equal(branchButton('feature').getAttribute('aria-expanded'), 'false')
        assert.equal(shown('First session'), true, 'manual expansion survives the sidebar switch')

        await act(async () => { useSessionsStore.setState({ activeTabId: 's1' }) })
        await act(async () => { branchButton('main').click() })
        assert.equal(shown('First session'), false)
        await roundTrip()
        assert.equal(branchButton('main').getAttribute('aria-expanded'), 'false',
          'remounting must not reveal the same active branch again')
        await act(async () => { projectButton().click() })
        await roundTrip()
        assert.equal(projectButton().getAttribute('aria-expanded'), 'false',
          'a manually folded active project stays folded')

        await act(async () => { useSessionsStore.setState({ activeTabId: null }) })
        await act(async () => { useSessionsStore.setState({ activeTabId: 's1' }) })
        assert.equal(shown('First session'), true, 'selecting the session again still reveals its branch')
        assert.equal(shown('Second session'), false)
      }
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
    'surface-style': 'surface styles coordinate material acknowledgement, serial saves and rollback without changing theme',
    'surface-style-restore': 'the saved solid style survives first paint and settings loading',
    'surface-style-unsupported': 'unsupported platforms paint solid even with a cached glass preference',
    'theme-cache-malformed': 'malformed and empty theme mirrors fail without overwriting the cache',
    'theme-cache-read-failure': 'theme storage read failures propagate through bootstrap and store initialization',
    'surface-style-animation': 'native material waits for background paint and rapid reversal skips obsolete material changes',
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
      'the confirm dialog swaps its copy for the merge state of the branch',
    'worktree-naming-retry':
      'a failed branch naming offers a retry instead of only naming the error',
    'reveal-active-session':
      'opening a session unfolds its project and branch, and leaving never folds back',
    'project-expansion-switch-chat':
      'project and worktree expansion survives switching to chat and back'
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

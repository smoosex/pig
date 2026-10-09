/** The unified pane retains management actions while discovery remains visible. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type {
  McpMarketServer,
  McpProbeResult,
  McpSettingsState,
  SessionApi
} from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const state: McpSettingsState = {
    codemode: false,
    projects: {},
    pendingSessions: [],
    servers: [
      {
        name: 'docs',
        config: { url: 'https://example.invalid/mcp', enabled: false },
        authenticated: false
      },
      {
        name: 'files',
        config: { command: 'npx', args: ['-y', 'files@latest', '/work'] },
        authenticated: false
      }
    ]
  }
  const recipes: McpMarketServer[] = ['docs', 'browser'].map((name) => ({
    id: name,
    name,
    title: name,
    description: `Recipe ${name}`,
    featured: true,
    config: { url: `https://example.invalid/${name}` },
    inputs: []
  }))
  const calls: Array<[string, ...unknown[]]> = []
  let probeState: 'failed' | 'needs-auth' = 'failed'
  const pendingProbes = new Map<string, Promise<McpProbeResult>>()
  let pendingLogin: Promise<void> | undefined
  const service = {
    getMcpSettings: async () => state,
    searchMcpMarket: async (query: string) => {
      calls.push(['search', query])
      return { servers: recipes }
    },
    setMcpEnabled: async (name: string, enabled: boolean) => {
      calls.push(['enable', name, enabled])
      state.servers.find((server) => server.name === name)!.config.enabled = enabled
      return state
    },
    testMcpServer: async (name: string) => {
      calls.push(['test', name])
      const pending = pendingProbes.get(name)
      if (pending) return pending
      return {
        state: probeState,
        message: probeState === 'needs-auth' ? 'Sign in required' : 'Connection refused',
        tools: []
      }
    },
    loginMcpServer: async (name: string) => {
      calls.push(['login', name])
      if (pendingLogin) await pendingLogin
      state.servers.find((server) => server.name === name)!.authenticated = true
      return { state: 'ready' as const, tools: [{ name: 'lookup', description: 'Find docs' }] }
    },
    logoutMcpServer: async (name: string) => {
      calls.push(['logout', name])
      state.servers.find((server) => server.name === name)!.authenticated = false
      return state
    },
    removeMcpServer: async (name: string) => {
      calls.push(['remove', name])
      state.servers = state.servers.filter((server) => server.name !== name)
      return state
    }
  } satisfies Partial<SessionApi>
  Object.assign(window, { api: service })
  const { act, createElement: h } = await import('react')
  mock.module('../src/renderer/src/components/settings/AddMcpDialog', () => ({
    AddMcpDialog: ({
      server,
      recipe,
      onClose
    }: {
      server?: { name: string }
      recipe?: { name: string }
      onClose(): void
    }) =>
      h(
        'button',
        {
          'data-dialog-mode': server?.name ?? recipe?.name ?? 'form',
          onClick: onClose
        },
        'Close fixture'
      )
  }))
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { useToolSettingsStore: store } = await import('../src/renderer/src/stores/tool-settings')
  store.setState({ state, loaded: true })
  const { McpPane } = await import('../src/renderer/src/components/settings/McpPane')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.getAttribute('aria-label') === label || element.textContent === label
    )
    assert.ok(found, `Missing button: ${label}`)
    return found
  }
  const click = async (label: string) => {
    await act(async () => {
      button(label).click()
    })
  }
  const flush = async () => {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 30))
    })
  }
  try {
    await act(async () => {
      root.render(h(TooltipProvider, null, h(McpPane)))
    })
    await flush()
    const installed = host.querySelector('section[aria-labelledby="mcp-installed"]')!
    const market = host.querySelector('section[aria-labelledby="mcp-market"]')!
    assert.ok(installed)
    const add = button('Add MCP')
    assert.equal(add.parentElement, installed.firstElementChild, 'add stays in the top action row')
    assert.ok(add.querySelector('svg'))
    assert.equal(add.getAttribute('data-variant'), 'ghost')
    assert.equal(
      [...installed.querySelectorAll('button')].filter(
        (element) => element.textContent === 'Add MCP'
      ).length,
      1
    )
    assert.equal(
      [...host.querySelectorAll('button')].some((element) => element.textContent === 'Import JSON'),
      false
    )
    assert.ok(market.querySelector('input'), 'discovery is visible without changing tabs')
    assert.equal(host.querySelector('[data-slot="toggle-group"]'), null)
    assert.equal(installed.querySelectorAll('[data-slot="card"]').length, 2)
    assert.equal(market.querySelectorAll('[data-slot="card"]').length, 2)
    const row = installed.querySelector('[data-slot="card"]')!
    assert.ok(row.querySelector('[data-slot="avatar"]')!.classList.contains('size-10'))
    assert.ok(row.querySelector('[data-slot="card-title"]')!.classList.contains('text-sm'))
    assert.ok(row.querySelector('[data-slot="card-description"]')!.classList.contains('text-xs'))
    assert.equal(
      row.querySelector('[data-slot="card-description"]')!.textContent,
      'https://example.invalid/mcp'
    )
    assert.equal(
      row.querySelector('[data-slot="card-content"]'),
      null,
      'untested rows stay compact'
    )
    assert.equal(row.querySelector('[data-slot="card-footer"]'), null)
    const controls = [...row.querySelectorAll<HTMLButtonElement>('button')]
    assert.deepEqual(
      controls.map((element) => element.getAttribute('aria-label')),
      [
        'Edit configuration docs',
        'Test connection docs',
        'OAuth sign in docs',
        'Remove docs',
        'Globally enabled docs'
      ]
    )
    const icons = ['settings', 'radar', 'badge-check', 'trash-2']
    for (const [index, control] of controls.slice(0, -1).entries()) {
      assert.ok(control.querySelector(`svg.lucide-${icons[index]}`))
      assert.equal(control.textContent, '')
    }
    for (const [locale, labels] of [
      ['en', ['Edit configuration', 'Test connection', 'OAuth sign in', 'Remove']],
      ['zh-CN', ['编辑配置', '测试连接', 'OAuth 登录', '移除']]
    ] as const) {
      await act(async () => {
        useSettingsStore.setState({ localeSetting: locale, locale })
      })
      for (const [index, label] of labels.entries()) {
        await act(async () => {
          controls[index].focus()
        })
        assert.equal(document.querySelector('[role="tooltip"]')?.textContent, label)
        await act(async () => {
          controls[index].blur()
        })
      }
    }
    await act(async () => {
      useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
    })
    assert.equal(controls.at(-1)!.getAttribute('role'), 'switch')
    assert.equal(installed.querySelectorAll('[role="switch"]').length, 2)
    assert.ok(installed.textContent?.includes('npx -y files@latest /work'))
    assert.equal(button('Add docs').disabled, true)
    await click('Edit configuration docs')
    assert.equal(host.querySelector('[data-dialog-mode]')!.getAttribute('data-dialog-mode'), 'docs')
    await click('Close fixture')
    await click('Add MCP')
    assert.equal(host.querySelector('[data-dialog-mode]')!.getAttribute('data-dialog-mode'), 'form')
    await click('Close fixture')
    await click('Add browser')
    assert.equal(
      host.querySelector('[data-dialog-mode]')!.getAttribute('data-dialog-mode'),
      'browser'
    )
    await click('Close fixture')
    await click('Globally enabled docs')
    assert.ok(
      calls.some(
        ([kind, name, enabled]) => kind === 'enable' && name === 'docs' && enabled === true
      )
    )
    await click('Test connection docs')
    assert.equal(
      row.querySelector('[data-slot="card-content"]'),
      null,
      'test results keep the row compact'
    )
    const probeBadge = () => row.querySelector('[data-slot="badge"]')!
    assert.equal(probeBadge().textContent, '0 tools')
    assert.equal(probeBadge().getAttribute('data-variant'), 'secondary')
    assert.ok(probeBadge().firstElementChild!.classList.contains('bg-destructive'))
    const probeTrigger = button('Connection failed · 0 tools · docs')
    for (const override of [
      'hover:bg-transparent',
      'aria-expanded:bg-transparent',
      'dark:hover:bg-transparent'
    ]) {
      assert.ok(probeTrigger.classList.contains(override))
    }
    await click('Connection failed · 0 tools · docs')
    assert.ok(
      document
        .querySelector('[data-slot="popover-content"]')
        ?.textContent?.includes('Connection refused')
    )
    await click('Connection failed · 0 tools · docs')
    probeState = 'needs-auth'
    await click('Test connection docs')
    assert.equal(probeBadge().textContent, '0 tools')
    assert.ok(probeBadge().firstElementChild!.classList.contains('bg-warning'))
    assert.ok(button('Authentication required · 0 tools · docs'))
    assert.ok(market.querySelector('input'), 'test details do not hide discovery')
    await click('OAuth sign in docs')
    assert.ok(calls.some(([kind, name]) => kind === 'login' && name === 'docs'))
    assert.ok(button('Sign out docs').querySelector('svg'))
    assert.equal(probeBadge().textContent, '1 tools')
    assert.ok(probeBadge().firstElementChild!.classList.contains('bg-success'))
    await click('Test passed · 1 tools · docs')
    assert.ok(
      document.querySelector('[data-slot="popover-content"]')?.textContent?.includes('lookup')
    )
    await click('Test passed · 1 tools · docs')
    await click('Sign out docs')
    assert.ok(calls.some(([kind, name]) => kind === 'logout' && name === 'docs'))
    assert.equal(row.querySelector('[data-slot="card-content"]'), null)
    await act(async () => {
      store.setState({ busy: true })
    })
    assert.ok(
      [...installed.querySelectorAll<HTMLButtonElement>('button')].every(
        (element) => element.disabled
      )
    )
    await act(async () => {
      store.setState({ busy: false })
    })
    let finishDocs!: (result: McpProbeResult) => void
    let failFiles!: (error: Error) => void
    pendingProbes.set(
      'docs',
      new Promise((resolve) => {
        finishDocs = resolve
      })
    )
    pendingProbes.set(
      'files',
      new Promise((_, reject) => {
        failFiles = reject
      })
    )
    const docsTests = calls.filter(([kind, name]) => kind === 'test' && name === 'docs').length
    await act(async () => {
      button('Test connection docs').click()
      button('Test connection docs').click()
    })
    assert.equal(
      calls.filter(([kind, name]) => kind === 'test' && name === 'docs').length,
      docsTests + 1,
      'same-server clicks cannot start overlapping connections'
    )
    const filesRow = installed.querySelectorAll('[data-slot="card"]')[1]!
    const loadingDocs = row.querySelector('[role="status"]')!
    assert.equal(loadingDocs.getAttribute('aria-label'), 'Testing docs')
    assert.equal(loadingDocs.textContent, 'Testing')
    await act(async () => {
      useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
    })
    assert.equal(loadingDocs.getAttribute('aria-label'), '正在测试 docs')
    assert.equal(loadingDocs.textContent, '正在测试')
    await act(async () => {
      useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
    })
    assert.ok(loadingDocs.querySelector('svg.animate-spin'))
    assert.equal(
      loadingDocs.parentElement,
      row.querySelector('[data-slot="card-title"]')!.parentElement
    )
    assert.equal(filesRow.querySelector('[role="status"]'), null)
    assert.equal(store.getState().busy, false, 'a probe never takes the global lock')
    for (const action of ['Edit configuration', 'Test connection', 'Remove', 'Globally enabled']) {
      assert.equal(button(`${action} docs`).disabled, true)
      assert.equal(button(`${action} files`).disabled, false)
    }
    assert.equal(button('OAuth sign in docs').disabled, true)
    assert.equal(button('Add MCP').disabled, false)
    await click('Test connection files')
    assert.ok(button('Test connection docs').disabled)
    assert.ok(button('Test connection files').disabled)
    assert.equal(installed.querySelectorAll('[role="status"]').length, 2)

    let finishWrite!: () => void
    let write!: Promise<void | undefined>
    await act(async () => {
      write = store.getState().run(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve
          })
      )
    })
    await act(async () => {
      finishDocs({ state: 'ready', tools: [] })
    })
    await flush()
    assert.equal(store.getState().busy, true, 'finishing a probe cannot release a write lock')
    await act(async () => {
      finishWrite()
      await write
    })
    assert.equal(button('Test connection docs').disabled, false)
    assert.equal(button('Test connection files').disabled, true, 'only files is still testing')
    assert.ok(button('Test passed · 0 tools · docs'))
    assert.equal(row.querySelector('[role="status"]'), null)
    assert.ok(filesRow.querySelector('[role="status"]'))

    let finishLogin!: () => void
    pendingLogin = new Promise<void>((resolve) => {
      finishLogin = resolve
    })
    await click('OAuth sign in docs')
    assert.ok(row.querySelector('[role="status"]'), 'retesting replaces the previous result')
    assert.equal(row.querySelector('[aria-label="Test passed · 0 tools · docs"]'), null)
    assert.ok(button('Cancel sign in'))
    await act(async () => {
      failFiles(new Error('Probe exploded'))
    })
    await flush()
    assert.match(store.getState().error ?? '', /Probe exploded/)
    assert.equal(filesRow.querySelector('[role="status"]'), null, 'failure clears loading')
    assert.equal(store.getState().busy, true, 'a failed probe cannot release the login lock')
    assert.ok(button('Cancel sign in'), 'finishing another probe cannot hide login cancellation')
    pendingProbes.clear()
    await act(async () => {
      finishLogin()
    })
    await flush()
    assert.equal(store.getState().busy, false)
    assert.equal(button('Test connection files').disabled, false, 'errors release the row lock')
    assert.equal(installed.querySelector('[role="status"]'), null)
    await click('Test connection files')
    assert.ok(button('Authentication required · 0 tools · files'))
    await click('Sign out docs')
    await click('Remove docs')
    await flush()
    assert.equal(
      calls.some(([kind]) => kind === 'remove'),
      false,
      'removal still needs confirmation'
    )
    const confirmation = document.querySelector('[data-slot="dialog-content"]')!
    assert.equal(confirmation.getAttribute('role'), 'dialog')
    assert.ok(
      confirmation.querySelector('[data-slot="dialog-title"]')!.classList.contains('text-sm')
    )
    assert.ok(
      confirmation.querySelector('[data-slot="dialog-description"]')!.classList.contains('text-xs')
    )
    assert.equal(confirmation.querySelector('[data-slot="dialog-footer"]'), null)
    assert.equal(confirmation.querySelector('[data-slot="dialog-close"]'), null)
    assert.ok(button('Cancel').classList.contains('border'))
    await click('Cancel')
    await flush()
    assert.equal(document.querySelector('[data-slot="dialog-content"]'), null)
    assert.equal(
      calls.some(([kind]) => kind === 'remove'),
      false
    )
    await click('Remove docs')
    await click('Remove')
    await flush()
    assert.ok(calls.some(([kind, name]) => kind === 'remove' && name === 'docs'))
    assert.equal(installed.querySelectorAll('[data-slot="card"]').length, 1)
    assert.equal(button('Add docs').disabled, false)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--mcp-pane-fixture')) {
  await fixture()
} else {
  test('MCP rows and discovery share one pane with accessible icon actions and the enable switch last', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--mcp-pane-fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 14_000)
}

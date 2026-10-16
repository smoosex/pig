import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { WebSearchSettingsState } from '../src/shared/api'

function state(): WebSearchSettingsState {
  return {
    settings: {
      provider: null,
      allowedProviders: null,
      maxInlineContentChars: null,
      fetchDefaultMode: null,
      fetchAllowedModes: null,
      ssrfAllowRanges: null,
      ssrfTrustEnvProxy: null,
      fetchRedirects: null,
      tools: { webSearch: true, sourceCheck: true, fetchContent: true, getSearchContent: true }
    },
    error: null,
    providers: [
      { id: 'duckduckgo', name: 'DuckDuckGo', kind: 'none', apiKey: '', baseUrl: '', extraValues: {}, source: null },
      { id: 'brave', name: 'Brave', kind: 'key', apiKeyKey: 'braveApiKey', apiKeyEnv: 'BRAVE_API_KEY', apiKey: '', baseUrl: '', extraValues: {}, source: null },
      { id: 'tavily', name: 'Tavily', kind: 'key', apiKeyKey: 'tavilyApiKey', apiKeyEnv: 'TAVILY_API_KEY', apiKey: '', baseUrl: '', extraValues: {}, source: 'env' },
      { id: 'parallel', name: 'Parallel', kind: 'key', apiKeyKey: 'parallelApiKey', apiKeyEnv: 'PARALLEL_API_KEY', apiKey: '', baseUrl: '', extraValues: {}, source: null },
      { id: 'parallel-mcp', name: 'Parallel MCP', kind: 'key', apiKeyKey: 'parallelApiKey', apiKeyEnv: 'PARALLEL_API_KEY', apiKey: '', baseUrl: '', extraValues: {}, source: null },
      { id: 'datalab', name: 'Datalab PDF', kind: 'key', group: 'extract', apiKeyKey: 'datalabApiKey', apiKeyEnv: 'DATALAB_API_KEY', apiKey: '', baseUrl: '', extraValues: { datalabMode: '' }, source: null }
    ]
  }
}

function item(text: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((node) => node.textContent?.includes(text))
  assert.ok(row, `engine row ${text}`)
  return row
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label)
  assert.ok(found, `menu item ${label}`)
  return found
}

function engineManage(title: string): HTMLButtonElement {
  const titleNode = [...document.querySelectorAll<HTMLElement>('div.text-sm.font-medium')].find((node) => node.textContent === title)
  const found = [...(titleNode?.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((node) => node.textContent === '管理')
  assert.ok(found, `manage button for ${title}`)
  return found
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)
  assert.ok(found, `button ${label}`)
  return found
}

test('the web access panel adds engines with their key and saves only changes', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const patches: any[] = []
  const current = state()
  const fakeApi = {
    listPlugins: async () => [{ id: 'pi-web-access', kind: 'system', name: 'Web Access', source: 'Pig built-in', scopes: ['project'], available: true }],
    onPluginsChanged: () => () => {},
    getWebSearchSettings: async () => current,
    // Stores what the panel sends back, so reopening the dialog shows the saved configuration.
    setWebSearchSettings: async (patch: any) => {
      patches.push(patch)
      if (patch.allowedProviders) current.settings.allowedProviders = patch.allowedProviders
      if (patch.provider !== undefined) current.settings.provider = patch.provider
      if (patch.tools) current.settings.tools = { ...current.settings.tools, ...patch.tools }
      if (patch.fetchAllowedModes) current.settings.fetchAllowedModes = patch.fetchAllowedModes
      if (patch.fetchDefaultMode !== undefined) current.settings.fetchDefaultMode = patch.fetchDefaultMode
      for (const [id, values] of Object.entries<any>(patch.providers ?? {})) {
        const provider = current.providers.find((item) => item.id === id)
        if (provider && values.apiKey !== undefined) provider.apiKey = values.apiKey ?? ''
      }
      return current
    },
    testWebSearch: async () => ({ ok: true, message: 'ok' })
  }
  // Other renderer tests replace this module with a partial stub; pin our own before importing.
  const { mock } = await import('bun:test')
  const realApi = await import('../src/renderer/src/ipc/api')
  mock.module('../src/renderer/src/ipc/api', () => ({ ...realApi, api: fakeApi }))
  Object.assign(window, { api: fakeApi })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { PluginsPane } = await import('../src/renderer/src/components/settings/PluginsPane')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 15)) }) }
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  try {
    await act(async () => { root.render(h(PluginsPane)) })
    await flush()
    const open = document.querySelector<HTMLButtonElement>('[aria-label="配置 Web Access"]')
    assert.ok(open, 'the system plugin exposes a settings button')
    await act(async () => { open.click() })
    await flush()
    assert.ok(document.body.textContent?.includes('还没有添加引擎'))
    assert.ok(document.body.textContent?.includes('已添加 0 个引擎'))

    await act(async () => { button('添加引擎').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('选择引擎'))
    const search = document.querySelector<HTMLInputElement>('[cmdk-input]')
    assert.ok(search)
    const engineRows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
    const hoveredRow = () => engineRows().find((row) => row.hasAttribute('data-hover-highlight-target'))
    assert.equal(hoveredRow(), undefined, 'the engine list opens with no row hovering itself')
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    await flush()
    assert.equal(hoveredRow(), engineRows()[0], 'the first row hovers on the first key')
    await act(async () => { setValue.call(search, 'bra'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    await flush()
    assert.deepEqual([...document.querySelectorAll('[cmdk-item]')].map((node) => node.textContent), ['Brave未配置'])
    assert.equal(hoveredRow(), engineRows()[0], 'filtering hovers the first match, so Enter keeps a visible target')
    await act(async () => { item('Brave').click() })
    await flush()
    const keyInput = document.querySelector<HTMLInputElement>('[aria-label="Brave API Key"]')
    assert.ok(keyInput)
    assert.ok(document.body.textContent?.includes('留空则使用环境变量 BRAVE_API_KEY'))
    await act(async () => { setValue.call(keyInput, 'brave-key'); keyInput.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { button('添加').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('已添加 1 个引擎'))
    assert.ok(document.body.textContent?.includes('Brave'))

    await act(async () => { button('添加引擎').click() })
    await flush()
    assert.ok(item('Tavily').textContent?.includes('来自环境变量'))
    await act(async () => { item('Tavily').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('已检测到环境变量 TAVILY_API_KEY'))
    await act(async () => { button('添加').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('已添加 2 个引擎'))

    const sourceCheck = document.querySelector<HTMLElement>('[aria-label="source_check 工具"]')
    assert.ok(sourceCheck)
    await act(async () => { sourceCheck.click() })
    await act(async () => { button('保存设置').click() })
    await flush()
    assert.deepEqual(patches, [{ allowedProviders: ['brave', 'tavily'], tools: { sourceCheck: false }, providers: { brave: { apiKey: 'brave-key' } } }])
    assert.equal(document.body.textContent?.includes('已添加 2 个引擎'), false, 'saving closes the settings dialog')

    // Reopen to check that removing an engine also clears the credentials it stored.
    await act(async () => { open.click() })
    await flush()
    assert.ok(document.body.textContent?.includes('已添加 2 个引擎'))
    const manage = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '管理')
    assert.ok(manage)
    await act(async () => {
      manage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
    })
    await flush()
    await act(async () => { menuItem('移除引擎').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('已添加 1 个引擎'))
    await act(async () => { button('保存设置').click() })
    await flush()
    assert.deepEqual(patches[1], { allowedProviders: ['tavily'], providers: { brave: { apiKey: null } } })
    assert.equal(document.body.textContent?.includes('已添加 1 个引擎'), false)

    // Testing an edited key saves it first, otherwise the extension would test the stored one.
    await act(async () => { open.click() })
    await flush()
    await act(async () => {
      button('管理').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
    })
    await flush()
    await act(async () => { menuItem('修改密钥').click() })
    await flush()
    const editKey = document.querySelector<HTMLInputElement>('[aria-label="Tavily API Key"]')
    assert.ok(editKey)
    await act(async () => { setValue.call(editKey, 'tavily-key'); editKey.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { button('保存密钥').click() })
    await flush()
    await act(async () => { button('测试搜索').click() })
    await flush()
    assert.deepEqual(patches[2], { providers: { tavily: { apiKey: 'tavily-key' } } })
    assert.ok(document.body.textContent?.includes('已添加 1 个引擎'), 'testing keeps the dialog open')
    assert.ok(document.body.textContent?.includes('ok'), 'the test result is shown')

    // The extension rejects an empty fetch.allowedModes, so the last enabled mode cannot be cleared.
    await act(async () => { button('高级选项').click() })
    await flush()
    const modeSwitch = (mode: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${mode}"]`)
    const [readable, raw, answer] = [modeSwitch('readable'), modeSwitch('raw'), modeSwitch('answer')]
    assert.ok(readable && raw && answer)
    await act(async () => { raw.click() })
    await act(async () => { answer.click() })
    await flush()
    assert.equal(readable.disabled, true, 'the last fetch mode stays enabled')
    await act(async () => { button('保存设置').click() })
    await flush()
    assert.deepEqual(patches[3], { fetchAllowedModes: ['readable'] })

    // Dropping the mode the default falls back to has to move the default with it.
    await act(async () => { open.click() })
    await flush()
    await act(async () => { button('高级选项').click() })
    await flush()
    await act(async () => { modeSwitch('raw')!.click() })
    await flush()
    await act(async () => { modeSwitch('readable')!.click() })
    await flush()
    await act(async () => { button('保存设置').click() })
    await flush()
    assert.deepEqual(patches[4], { fetchAllowedModes: ['raw'], fetchDefaultMode: 'raw' })

    // Parallel and Parallel MCP share parallelApiKey, so removing one must not clear the key the
    // other still reads.
    await act(async () => { open.click() })
    await flush()
    await act(async () => { button('添加引擎').click() })
    await flush()
    await act(async () => { item('Parallel').click() })
    await flush()
    const parallelKey = document.querySelector<HTMLInputElement>('[aria-label="Parallel API Key"]')
    assert.ok(parallelKey)
    await act(async () => { setValue.call(parallelKey, 'shared-key'); parallelKey.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { button('添加').click() })
    await flush()
    await act(async () => { button('添加引擎').click() })
    await flush()
    await act(async () => { item('Parallel MCP').click() })
    await flush()
    await act(async () => { button('添加').click() })
    await flush()
    assert.ok(document.body.textContent?.includes('已添加 3 个引擎'))
    await act(async () => {
      engineManage('Parallel').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
    })
    await flush()
    await act(async () => { menuItem('移除引擎').click() })
    await flush()
    await act(async () => { button('保存设置').click() })
    await flush()
    assert.deepEqual(patches[5], {
      allowedProviders: ['tavily', 'parallel-mcp'],
      providers: { parallel: { apiKey: 'shared-key' } }
    })

    // A file the extension rejects still opens a usable panel, and saving rewrites the managed fields.
    current.error = 'Unknown web search provider: nope'
    current.settings.allowedProviders = null
    await act(async () => { open.click() })
    await flush()
    assert.ok(document.body.textContent?.includes('配置文件里有无效值'), 'the panel explains the stored file')
    assert.ok(document.body.textContent?.includes('Unknown web search provider: nope'))
    assert.ok(button('添加引擎'), 'the form is still editable')
    assert.ok(document.body.textContent?.includes('还没有添加引擎'))
    await act(async () => { button('保存设置').click() })
    await flush()
    assert.deepEqual(patches[6], {
      allowedProviders: [],
      provider: null,
      tools: { webSearch: true, sourceCheck: false, fetchContent: true, getSearchContent: true },
      maxInlineContentChars: null,
      fetchDefaultMode: 'raw',
      fetchAllowedModes: ['raw'],
      ssrfAllowRanges: [],
      ssrfTrustEnvProxy: false,
      fetchRedirects: null
    })
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})

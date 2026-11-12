import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import type { WebSearchSettingsPatch, WebSearchSettingsState } from '../src/shared/api'

function fixture(): WebSearchSettingsState {
  return {
    settings: { provider: 'duckduckgo', addedProviders: ['duckduckgo'], maxInlineContentChars: null },
    error: null,
    providers: ['exa', 'deepseek', 'brave', 'tavily', 'duckduckgo'].map(id => ({ id, name: id, kind: id === 'duckduckgo' ? 'none' : 'key', apiKey: '', envAvailable: id === 'deepseek', apiKeySource: id === 'deepseek' ? 'env' : 'config', source: null, ...(id === 'duckduckgo' ? {} : { apiKeyKey: id + 'ApiKey', apiKeyEnv: id.toUpperCase() + '_API_KEY' }) }))
  }
}

test('small web panel saves credentials before testing and exposes no legacy feature controls', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const calls: string[] = []
  const patches: WebSearchSettingsPatch[] = []
  let current = fixture()
  const fakeApi = {
    getWebSearchSettings: async () => current,
    setWebSearchSettings: async (patch: WebSearchSettingsPatch) => {
      patches.push(patch); calls.push('save')
      current = { ...current, settings: { ...current.settings, provider: patch.provider ?? current.settings.provider, addedProviders: patch.addedProviders ?? current.settings.addedProviders,
        maxInlineContentChars: patch.maxInlineContentChars === undefined ? current.settings.maxInlineContentChars : patch.maxInlineContentChars }, providers: current.providers.map(provider => ({ ...provider, apiKey: patch.providers?.[provider.id]?.apiKey ?? provider.apiKey, apiKeySource: patch.providers?.[provider.id]?.apiKeySource ?? provider.apiKeySource })) }
      return current
    },
    testWebSearch: async () => { calls.push('test'); return { ok: true, message: 'search passed' } }
  }
  const original = await import('../src/renderer/src/ipc/api')
  mock.module('../src/renderer/src/ipc/api', () => ({ ...original, api: fakeApi }))
  Object.assign(window, { api: fakeApi })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { WebSearchSettings } = await import('../src/renderer/src/components/settings/WebSearchSettings')
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let closed = 0
  try {
    await act(async () => { root.render(h(WebSearchSettings, { onClose: () => { closed++ } })) })
    assert.equal(document.querySelectorAll('input[type="password"]').length, 0)
    assert.ok(document.querySelector('[aria-label="搜索供应商"]'))
    assert.equal(document.querySelector('[aria-label="网页读取供应商"]'), null)
    assert.doesNotMatch(host.textContent!, /source_check|视频理解|允许的提取模式/)
    assert.doesNotMatch(host.textContent!, /API 基础地址/)
    const buttons = () => [...(document.querySelector('[role="dialog"]') ?? document).querySelectorAll<HTMLButtonElement>('button')]
    assert.equal(document.querySelector('#web-max-chars'), null)
    assert.equal(document.querySelector('#web-ssrf-ranges'), null)
    assert.equal(document.querySelector('#web-trust-proxy'), null)
    assert.doesNotMatch(host.textContent!, /网页读取优先|不包含 PDF/)
    assert.equal(document.querySelector('[aria-label="读取方式与费用说明"]'), null)
    const addButton = buttons().find(button => button.textContent === '添加供应商')!
    assert.ok(addButton.classList.contains('absolute'))
    assert.ok(addButton.classList.contains('right-14'))
    const advanced = buttons().find(button => button.textContent === '高级设置')!
    assert.equal(advanced.getAttribute('aria-expanded'), 'false')
    await act(async () => { advanced.click() })
    assert.equal(document.querySelector('#web-ssrf-ranges'), null)
    assert.equal(document.querySelector('#web-trust-proxy'), null)
    assert.doesNotMatch(host.textContent!, /SSRF|信任已配置代理/)
    const maxChars = document.querySelector<HTMLInputElement>('#web-max-chars')!
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { valueSetter.call(maxChars, '24000'); maxChars.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { advanced.click() })
    assert.equal(document.querySelector('#web-max-chars'), null)
    await act(async () => { advanced.click() })
    assert.equal(document.querySelector<HTMLInputElement>('#web-max-chars')!.value, '24000', 'collapse preserves advanced drafts')
    await act(async () => { advanced.click() })
    await act(async () => { buttons().find(button => button.textContent === '添加供应商')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.equal(document.querySelectorAll('input[type="password"]').length, 1)
    assert.match(dialog.textContent!, /未检测到环境变量 EXA_API_KEY/)
    assert.equal(buttons().find(button => button.textContent === '环境变量')!.disabled, true)
    const input = document.querySelector<HTMLInputElement>('#web-provider-key')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'edited-key'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { dialog.querySelector<HTMLFormElement>('form')!.requestSubmit() })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(document.querySelectorAll('input[type="password"]').length, 0)
    assert.match(host.textContent!, /exa/)
    assert.deepEqual(calls, [], 'adding stages changes until save or test')
    await act(async () => { buttons().find(button => button.textContent === '测试搜索')!.click() })
    assert.deepEqual(calls, ['save', 'test'])
    assert.deepEqual(patches[0].providers?.exa, { apiKeySource: 'config', apiKey: 'edited-key' })
    assert.deepEqual(patches[0].addedProviders, ['duckduckgo', 'exa'])
    assert.equal(patches[0].provider, 'exa')
    assert.equal(patches[0].maxInlineContentChars, 24000, 'collapsed settings are still saved')
    assert.equal(closed, 0)
    assert.match(host.textContent!, /search passed/)
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="编辑供应商 exa"]')!.click() })
    const editingKey = document.querySelector<HTMLInputElement>('#web-provider-key')!
    assert.equal(editingKey.value, 'edited-key')
    await act(async () => { setter.call(editingKey, 'cancelled-key'); editingKey.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { buttons().find(button => button.textContent === '取消')!.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="编辑供应商 exa"]')!.click() })
    const savedKey = document.querySelector<HTMLInputElement>('#web-provider-key')!
    assert.equal(savedKey.value, 'edited-key', 'cancelled edits never change the provider draft')
    await act(async () => { setter.call(savedKey, 'updated-key'); savedKey.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="移除 duckduckgo"]')!.click() })
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="移除 exa"]')!.disabled, true)
    await act(async () => { buttons().find(button => button.textContent === '保存设置')!.click() })
    assert.deepEqual(patches.at(-1)!.addedProviders, ['exa'])
    assert.equal(patches.at(-1)!.providers?.exa.apiKey, 'updated-key')
    assert.equal(closed, 1)
    await act(async () => { buttons().find(button => button.textContent === '添加供应商')!.click() })
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /已检测到环境变量 DEEPSEEK_API_KEY/)
    assert.equal(document.querySelector('#web-provider-key'), null)
    const envChoice = buttons().find(button => button.textContent === '环境变量')!
    assert.equal(envChoice.getAttribute('aria-checked'), 'true')
    await act(async () => { buttons().find(button => button.textContent === '自定义')!.click() })
    const custom = document.querySelector<HTMLInputElement>('#web-provider-key')!
    await act(async () => { setter.call(custom, 'deepseek-custom'); custom.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit() })
    await act(async () => { buttons().find(button => button.textContent === '保存设置')!.click() })
    assert.deepEqual(patches.at(-1)!.providers?.deepseek, { apiKey: 'deepseek-custom', apiKeySource: 'config' })
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="编辑供应商 deepseek"]')!.click() })
    await act(async () => { buttons().find(button => button.textContent === '环境变量')!.click() })
    assert.equal(document.querySelector('#web-provider-key'), null)
    await act(async () => { document.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit() })
    await act(async () => { buttons().find(button => button.textContent === '保存设置')!.click() })
    assert.equal(patches.at(-1)!.providers?.deepseek.apiKeySource, 'env')
    assert.match(host.textContent!, /使用环境变量 DEEPSEEK_API_KEY/)
  } finally {
    await act(async () => { root.unmount() })
    host.remove(); GlobalRegistrator.unregister()
  }
})

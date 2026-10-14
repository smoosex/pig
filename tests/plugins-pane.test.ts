import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { MemoryPluginSettings, MemoryPluginSettingsPatch } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const patches: MemoryPluginSettingsPatch[] = []
  let memoryConfig: MemoryPluginSettings = { observeAfterTokens: 800, compactionCatchUpMaxChunks: 3, consolidateWhenIdle: false }
  Object.assign(window, { api: {
    listPlugins: async () => [{ id: 'observational-memory', kind: 'system', name: 'Observational Memory', source: 'Pig built-in', enabled: true, available: true }],
    onPluginsChanged: () => () => {},
    getMemoryPluginDefaults: async () => ({ observeAfterTokens: 10000, compactionCatchUpMaxChunks: 2 }),
    getMemoryPluginSettings: async () => memoryConfig,
    setMemoryPluginSettings: async (patch: MemoryPluginSettingsPatch) => {
      patches.push(patch)
      memoryConfig = Object.fromEntries(Object.entries({ ...memoryConfig, ...patch }).filter(([, value]) => value !== null)) as MemoryPluginSettings
      return memoryConfig
    }
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  useModelCatalogStore.setState({ revision: 1, refreshing: false, models: [
    { id: 'm1', name: 'M1', provider: 'test', providerName: 'Test', contextWindow: 100000, reasoning: false }
  ] })
  const { PluginsPane } = await import('../src/renderer/src/components/settings/PluginsPane')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 15)) }) }
  try {
    await act(async () => { root.render(h(PluginsPane)) })
    await flush()
    assert.equal(document.querySelector('[aria-label="观察阈值（token）"]'), null, 'settings are hidden until configured')
    const open = document.querySelector<HTMLButtonElement>('[aria-label="配置 Observational Memory"]')
    assert.ok(open)
    await act(async () => { open.click() })
    await flush()
    assert.ok(document.querySelector('[data-slot="dialog-content"]'))
    const input = document.querySelector<HTMLInputElement>('[aria-label="观察阈值（token）"]')
    assert.ok(input)
    assert.equal(input.value, '800')
    assert.equal(input.placeholder, '10000')
    const chunk = document.querySelector<HTMLInputElement>('[aria-label="观察片段上限（token）"]')
    assert.ok(chunk)
    assert.equal(chunk.value, '')
    assert.equal(chunk.placeholder, '自动')
    assert.ok(document.body.textContent?.includes('上次观察后新增 token 达此数量时触发一次观察'))
    const workerSwitch = document.querySelector('[aria-label="记忆任务通知"]')
    assert.ok(workerSwitch)
    assert.equal(workerSwitch.parentElement?.childElementCount, 1)
    const catchUp = document.querySelector<HTMLInputElement>('[aria-label="最多补观察次数"]')
    assert.ok(catchUp)
    assert.equal(catchUp.value, '3')
    assert.equal(catchUp.min, '0')
    assert.equal(catchUp.placeholder, '2')
    const idleSwitch = document.querySelector<HTMLButtonElement>('[aria-label="仅在空闲时运行"]')
    assert.ok(idleSwitch)
    assert.equal(idleSwitch.getAttribute('aria-checked'), 'false')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '900'); input.dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(catchUp, '0'); catchUp.dispatchEvent(new Event('input', { bubbles: true }))
      idleSwitch.click()
    })
    assert.equal(idleSwitch.getAttribute('aria-checked'), 'true')
    const picker = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('选择模型'))
    assert.ok(picker)
    await act(async () => { picker.click() })
    await flush()
    assert.ok(document.querySelector('[data-slot="popover-content"]'))
    const option = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('M1'))
    assert.ok(option)
    await act(async () => { option.click() })
    await flush()
    assert.ok(picker.textContent?.includes('M1'))
    assert.ok(document.querySelector('[aria-label="清除记忆模型"]'))
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存设置')
    assert.ok(save)
    await act(async () => { save.click() })
    await flush()
    assert.deepEqual(patches, [{ observeAfterTokens: 900, compactionCatchUpMaxChunks: 0, consolidateWhenIdle: true, model: { provider: 'test', id: 'm1' } }])
    assert.equal(document.querySelector('[data-slot="dialog-content"]'), null)
    await act(async () => { open.click() })
    await flush()
    const savedCatchUp = document.querySelector<HTMLInputElement>('[aria-label="最多补观察次数"]')
    assert.ok(savedCatchUp)
    assert.equal(savedCatchUp.value, '0', 'zero is an explicit saved value, not the default')
    assert.equal(document.querySelector('[aria-label="仅在空闲时运行"]')?.getAttribute('aria-checked'), 'true')
    await act(async () => { setValue.call(savedCatchUp, ''); savedCatchUp.dispatchEvent(new Event('input', { bubbles: true })) })
    const saveDefault = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存设置')
    assert.ok(saveDefault)
    await act(async () => { saveDefault.click() })
    await flush()
    assert.deepEqual(patches[1], { compactionCatchUpMaxChunks: null })
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--plugins-pane-fixture')) {
  await fixture()
} else {
  test('plugin settings open in a dialog and save Pig-only global config', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--plugins-pane-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timer); child.kill() }
  }, 14_000)
}

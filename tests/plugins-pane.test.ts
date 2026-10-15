import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { MemoryPluginSettings, MemoryPluginSettingsPatch, PluginInfo, PluginScope } from '../src/shared/api'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const patches: MemoryPluginSettingsPatch[] = []
  const scopeChanges: { id: string; scopes: PluginScope[] }[] = []
  const scopeWaits = new Map<string, Promise<void>>()
  const installedSources: string[] = []
  let installation: ReturnType<typeof deferred> | null = null
  let rejectScopeChange = false
  let plugins: PluginInfo[] = [
    { id: 'observational-memory', kind: 'system', name: 'Observational Memory', source: 'Pig built-in', scopes: ['project'], available: true },
    { id: 'pi-review', kind: 'system', name: 'Pi Review', source: 'Pig built-in', scopes: ['project'], available: true },
    { id: 'missing', kind: 'local', name: 'Missing plugin', source: '/missing', scopes: ['project', 'chat'], available: false }
  ]
  let memoryConfig: MemoryPluginSettings = { observeAfterTokens: 800, compactionCatchUpMaxChunks: 3, consolidateWhenIdle: false }
  Object.assign(window, { api: {
    listPlugins: async () => plugins,
    setPluginScopes: async (id: string, scopes: PluginScope[]) => {
      if (rejectScopeChange) throw new Error('Scope save failed')
      scopeChanges.push({ id, scopes })
      plugins = plugins.map((plugin) => plugin.id === id ? { ...plugin, scopes } : plugin)
      const snapshot = plugins
      await scopeWaits.get(id)
      return snapshot
    },
    installPlugin: async (source: string) => {
      installedSources.push(source)
      plugins = [...plugins, { id: 'installed', kind: 'local', name: 'Installed', source, scopes: [], available: true }]
      const snapshot = plugins
      await installation?.promise
      return snapshot
    },
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
    const group = document.querySelector<HTMLElement>('[aria-label="Observational Memory 启用范围"]')
    assert.ok(group)
    assert.equal(group.parentElement?.lastElementChild, group, 'scope selection is the rightmost control')
    assert.equal(group.previousElementSibling, open, 'configuration sits immediately to the left')
    assert.equal(group.dataset.size, 'xs')
    assert.equal(group.dataset.spacing, '0.5')
    assert.ok(group.classList.contains('border') && group.classList.contains('p-px'))
    const [project, chat] = [...group.querySelectorAll<HTMLButtonElement>('button')]
    assert.equal(project.textContent, '项目')
    assert.equal(chat.textContent, 'Chat')
    const selected = () => [project, chat].map((item) => item.getAttribute('aria-pressed'))
    assert.deepEqual(selected(), ['true', 'false'])
    await act(async () => { chat.click() })
    assert.deepEqual(selected(), ['true', 'true'])
    await act(async () => { project.click() })
    assert.deepEqual(selected(), ['false', 'true'])
    await act(async () => { chat.click() })
    assert.deepEqual(selected(), ['false', 'false'])
    await act(async () => { project.click() })
    assert.deepEqual(scopeChanges.map((change) => change.scopes), [['project', 'chat'], ['chat'], [], ['project']])

    const sourceInput = host.querySelector<HTMLInputElement>('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(sourceInput, '/example-plugin')
      sourceInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const choose = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '选择本地路径')!
    const install = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '安装')!
    const assertInstallerIdle = () => {
      assert.equal(choose.disabled, false)
      assert.equal(install.disabled, false)
      assert.equal(install.textContent, '安装')
      assert.equal(sourceInput.disabled, false)
    }
    const otherGroup = document.querySelector('[aria-label="Pi Review 启用范围"]')!
    const [otherProject, otherChat] = [...otherGroup.querySelectorAll<HTMLButtonElement>('button')]
    const first = deferred()
    const second = deferred()
    scopeWaits.set('observational-memory', first.promise)
    scopeWaits.set('pi-review', second.promise)
    await act(async () => { chat.click() })
    assert.equal(project.disabled, true)
    assert.equal(chat.disabled, true)
    assert.equal(otherChat.disabled, false, 'another plugin remains interactive during a slow save')
    assertInstallerIdle()
    await act(async () => { otherChat.click() })
    assert.equal(otherProject.disabled, true)
    await act(async () => { second.resolve() })
    assert.equal(project.disabled, true, 'another save finishing cannot release this plugin’s pending state')
    assert.equal(otherProject.disabled, false)
    assertInstallerIdle()
    await act(async () => { first.resolve() })
    assert.equal(project.disabled, false)
    assert.equal(otherChat.getAttribute('aria-pressed'), 'true', 'a delayed older reply cannot revert another plugin')
    assertInstallerIdle()
    scopeWaits.clear()

    const turningOff = deferred()
    scopeWaits.set('observational-memory', turningOff.promise)
    await act(async () => { chat.click() })
    assertInstallerIdle()
    await act(async () => { turningOff.resolve() })
    assert.deepEqual(selected(), ['true', 'false'])
    assertInstallerIdle()
    scopeWaits.clear()

    installation = deferred()
    await act(async () => { install.click() })
    assert.deepEqual(installedSources, ['/example-plugin'])
    assert.equal(choose.disabled, true)
    assert.equal(install.disabled, true)
    assert.equal(install.textContent, '处理中…')
    assert.equal(sourceInput.disabled, true)
    assert.equal(project.disabled, false, 'installing does not lock unrelated plugin rows')
    await act(async () => { chat.click() })
    assert.equal(choose.disabled, true, 'a scope save cannot release the installation state')
    assert.equal(install.textContent, '处理中…')
    await act(async () => { installation!.resolve() })
    assert.equal(choose.disabled, false)
    assert.equal(install.textContent, '安装')
    assert.equal(install.disabled, true, 'a successful install clears the source')
    assert.equal(sourceInput.disabled, false)
    assert.deepEqual(selected(), ['true', 'true'], 'the installation’s older reply cannot revert a newer scope save')
    await act(async () => { chat.click() })

    rejectScopeChange = true
    await act(async () => { chat.click() })
    assert.deepEqual(selected(), ['true', 'false'], 'failed saves keep the previous selection')
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Scope save failed/)
    rejectScopeChange = false
    const missing = document.querySelector('[aria-label="Missing plugin 启用范围"]')!
    const [missingProject, missingChat] = [...missing.querySelectorAll<HTMLButtonElement>('button')]
    await act(async () => { missingProject.click() })
    assert.equal(missingProject.disabled, true, 'unavailable plugins cannot gain a scope')
    assert.equal(missingChat.disabled, false, 'an unavailable plugin can still shed its remaining scope')
    await act(async () => { missingChat.click() })
    assert.equal(missingChat.disabled, true)
    assert.deepEqual(scopeChanges.at(-1), { id: 'missing', scopes: [] })
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
  test('plugin scopes are independently selectable and settings save Pig-only global config', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--plugins-pane-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timer); child.kill() }
  }, 14_000)
}

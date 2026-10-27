import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { MemoryPluginSettings, MemoryPluginSettingsPatch, PluginInfo, PluginScope } from '../src/shared/api'
import { reviewSettingsSchema } from '../src/main/plugins/pi-review/settings'
import { PERSONA_FILES, type PersonaSnapshot } from '../src/shared/persona'

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
  let reviewConfig: Record<string, string | number | boolean> = {}
  const reviewPatches: Record<string, string | number | boolean | null>[] = []
  const scopeWaits = new Map<string, Promise<void>>()
  const installedSources: string[] = []
  let installation: ReturnType<typeof deferred> | null = null
  let rejectScopeChange = false
  let plugins: PluginInfo[] = [
    { id: 'observational-memory', kind: 'system', name: 'Observational Memory', source: 'Pig built-in', scopes: ['project'], available: true },
    { id: 'pi-review', kind: 'system', name: 'Pi Review', source: 'Pig built-in', scopes: ['project'], available: true, settings: reviewSettingsSchema },
    { id: 'pi-persona', kind: 'system', name: 'Persona', source: 'Pig built-in', scopes: ['project', 'chat'], available: true },
    { id: 'missing', kind: 'local', name: 'Missing plugin', source: '/missing', scopes: ['project', 'chat'], available: false }
  ]
  let memoryConfig: MemoryPluginSettings = { observeAfterTokens: 800, compactionCatchUpMaxChunks: 3, consolidateWhenIdle: false }
  const persona: PersonaSnapshot = {
    active: false,
    files: PERSONA_FILES.map((name) => ({ name, content: '', revision: null })),
    mood: { pleasantness: 0.15, activation: 0.35, energy: 0.75, feeling: '', description: '', automatic: true, observer: { enabled: true }, history: [] }
  }
  Object.assign(window, { api: {
    persona: { get: async () => persona },
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
    getPluginSettings: async () => reviewConfig,
    setPluginSettings: async (_id: string, patch: Record<string, string | number | boolean | null>) => {
      reviewPatches.push(patch)
      reviewConfig = Object.fromEntries(Object.entries({ ...reviewConfig, ...patch }).filter(([, value]) => value !== null)) as typeof reviewConfig
      return reviewConfig
    },
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
    { id: 'm1', name: 'M1', provider: 'test', providerName: 'Test', contextWindow: 100000, reasoning: true, thinkingLevels: ['low', 'medium', 'high'] }
  ] })
  const { PluginsPane } = await import('../src/renderer/src/components/settings/PluginsPane')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 15)) }) }
  try {
    await act(async () => { root.render(h(TooltipProvider, null, h(PluginsPane))) })
    await flush()
    assert.equal(document.querySelector('[aria-label="观察阈值（token）"]'), null, 'settings are hidden until configured')
    const open = document.querySelector<HTMLButtonElement>('[aria-label="配置 Observational Memory"]')
    assert.ok(open)
    const group = document.querySelector<HTMLElement>('[aria-label="Observational Memory 启用范围"]')
    assert.ok(group)
    assert.equal(group.parentElement?.lastElementChild, group, 'scope selection is the rightmost control')
    assert.equal(group.previousElementSibling, open, 'configuration sits immediately to the left')
    assert.equal(group.dataset.slot, 'toggle-group')
    const [all, project, chat] = [...group.querySelectorAll<HTMLButtonElement>('button')]
    assert.deepEqual([all, project, chat].map((item) => item.textContent), ['全部', '仅项目', '仅对话'])
    const selected = () => [all, project, chat].map((item) => item.dataset.state === 'on')
    assert.deepEqual(selected(), [false, true, false])
    await act(async () => { all.click() })
    assert.deepEqual(selected(), [true, false, false])
    await act(async () => { chat.click() })
    assert.deepEqual(selected(), [false, false, true])
    await act(async () => { chat.click() })
    assert.deepEqual(selected(), [false, false, false], 'clicking the lit choice again disables the plugin')
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
    const [, otherProject, otherChat] = [...otherGroup.querySelectorAll<HTMLButtonElement>('button')]
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
    assert.equal(otherChat.dataset.state, 'on', 'a delayed older reply cannot revert another plugin')
    assertInstallerIdle()
    scopeWaits.clear()

    const turningOff = deferred()
    scopeWaits.set('observational-memory', turningOff.promise)
    await act(async () => { chat.click() })
    assertInstallerIdle()
    await act(async () => { turningOff.resolve() })
    assert.deepEqual(selected(), [false, false, false])
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
    assert.deepEqual(selected(), [false, false, true], 'the installation’s older reply cannot revert a newer scope save')
    await act(async () => { chat.click() })

    rejectScopeChange = true
    await act(async () => { chat.click() })
    assert.deepEqual(selected(), [false, false, false], 'failed saves keep the previous selection')
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Scope save failed/)
    rejectScopeChange = false
    const missing = document.querySelector('[aria-label="Missing plugin 启用范围"]')!
    const [missingAll, missingProject] = [...missing.querySelectorAll<HTMLButtonElement>('button')]
    assert.equal(missingProject.disabled, true, 'unavailable plugins cannot change to another scope')
    assert.equal(missingAll.disabled, false, 'an unavailable plugin can still be disabled')
    await act(async () => { missingAll.click() })
    assert.equal(missingAll.disabled, true)
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
    const buttons = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === label)
    const picker = buttons('默认')[0]
    assert.ok(picker, 'an unset memory model shows the default choice')
    await act(async () => { picker.click() })
    await flush()
    const popover = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    const lockedOption = [...popover().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('M1'))!
    assert.equal(lockedOption.disabled, true, 'the default choice locks the model list')
    const defaultToggle = popover().querySelector<HTMLButtonElement>('[role="switch"][aria-label="默认"]')!
    assert.equal(defaultToggle.getAttribute('aria-checked'), 'true')
    await act(async () => { defaultToggle.click() })
    const option = [...popover().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('M1'))!
    assert.equal(option.disabled, false, 'turning the default off unlocks the list')
    await act(async () => { option.click() })
    await flush()
    assert.ok(picker.textContent?.includes('M1'))
    assert.ok(popover(), 'choosing a model keeps the menu open for the thinking level')
    const slider = popover().querySelector<HTMLElement>('[role="slider"]')!
    assert.equal(slider.getAttribute('aria-valuemax'), '2', 'levels follow the model')
    assert.equal(slider.getAttribute('aria-valuetext'), '未指定')
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

    const openReview = document.querySelector<HTMLButtonElement>('[aria-label="配置 Pi Review"]')!
    await act(async () => { openReview.click() })
    await flush()
    assert.equal(document.querySelector('[aria-label="Provider"]'), null, 'provider must not be a text input')
    assert.equal(document.querySelector('[aria-label="Model ID"]'), null, 'model ID must not be a text input')
    const reviewPicker = buttons('默认')[0]
    assert.ok(reviewPicker)
    await act(async () => { reviewPicker.click() })
    await flush()
    await act(async () => { popover().querySelector<HTMLButtonElement>('[role="switch"][aria-label="默认"]')!.click() })
    const reviewOption = [...popover().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Test · test/m1'))!
    assert.ok(reviewOption, 'one picker lists both provider and model')
    await act(async () => { reviewOption.click() })
    await flush()
    const raise = popover().querySelector<HTMLButtonElement>('[aria-label="提高思考强度"]')!
    for (let step = 0; step < 3; step++) await act(async () => { raise.click() })
    await flush()
    assert.equal(raise.disabled, true, 'the highest level ends the slider')
    assert.equal(popover().querySelector('[role="slider"]')?.getAttribute('aria-valuetext'), '高')
    assert.equal(reviewPicker.textContent, 'M1高')
    const saveReview = () => buttons('保存设置')[0]
    await act(async () => { saveReview().click() })
    await flush()
    assert.deepEqual(reviewPatches[0], { provider: 'test', modelId: 'm1', thinking: 'high' })
    await act(async () => { openReview.click() })
    await flush()
    const savedReview = buttons('M1高')[0]
    assert.ok(savedReview, 'the trigger shows the saved model and level')
    await act(async () => { useModelCatalogStore.setState({ models: [] }) })
    await act(async () => { savedReview.click() })
    await flush()
    assert.ok(savedReview.textContent?.includes('test/m1'), 'an unavailable configured model keeps its identity')
    assert.ok(popover().textContent?.includes('该模型不可用'))
    assert.ok(!popover().textContent?.includes('请先选择模型'))
    await act(async () => { popover().querySelector<HTMLButtonElement>('[role="switch"][aria-label="默认"]')!.click() })
    assert.equal(savedReview.textContent, '默认')
    await act(async () => { saveReview().click() })
    await flush()
    assert.deepEqual(reviewPatches[1], { provider: null, modelId: null, thinking: null }, 'the default choice clears both model and thinking')

    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="配置 Persona"]')!.click() })
    await flush()
    const textarea = document.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this persona draft')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const closePersona = () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
    await act(async () => { closePersona().click() })
    await flush()
    assert.ok(document.querySelector('[role="alertdialog"]'), 'closing dirty persona files requires confirmation')
    const action = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!
    await act(async () => { action('继续编辑').click() })
    await flush()
    assert.equal(document.querySelector('textarea')?.value, 'Keep this persona draft')
    await act(async () => { closePersona().click() })
    await flush()
    await act(async () => { action('放弃更改').click() })
    await flush()
    assert.equal(document.querySelector('[data-slot="dialog-content"]'), null, 'explicit discard closes the editor')
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

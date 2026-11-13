import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { MemorySettingsPatch, PluginInfo, PluginScope } from '../src/shared/api'
import { reviewSettingsSchema } from '../src/main/plugins/pig-review/settings'
import { PERSONA_FILES, type PersonaSnapshot } from '../src/shared/persona'
import { runSelf } from './helpers/subprocess.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const scopeChanges: { id: string; scopes: PluginScope[] }[] = []
  let reviewConfig: Record<string, string | number | boolean> = {}
  const reviewPatches: Record<string, string | number | boolean | null>[] = []
  const scopeWaits = new Map<string, Promise<void>>()
  const installedSources: string[] = []
  let installation: ReturnType<typeof deferred> | null = null
  let rejectScopeChange = false
  let plugins: PluginInfo[] = [
    { id: 'example', kind: 'local', name: 'Example', source: '/example', scopes: ['project'], available: true },
    { id: 'pig-review', kind: 'system', name: 'Review', source: 'Pig built-in', scopes: ['project'], available: true, settings: reviewSettingsSchema },
    { id: 'missing', kind: 'local', name: 'Missing plugin', source: '/missing', scopes: ['project', 'chat'], available: false }
  ]
  let fileMemoryEnabled = true
  const persona: PersonaSnapshot = {
    active: false,
    files: PERSONA_FILES.map((name) => ({ name, content: '', revision: null })),
    mood: { pleasantness: 0.15, activation: 0.35, energy: 0.75, feeling: '', description: '', automatic: true, observer: { enabled: true }, history: [] }
  }
  Object.assign(window, { api: {
    persona: {
      get: async () => persona,
      observerUsage: async (range: number) => ({
        range, models: [],
        totals: { requests: 0, measured: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, durationMs: 0, estimatedInput: 0 },
        outcomes: { changed: 0, unchanged: 0, invalid: 0, error: 0, timeout: 0, aborted: 0 }
      }),
      onChanged: () => () => {}
    },
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
    getMemorySettings: async () => ({ fileMemory: { enabled: fileMemoryEnabled } }),
    setMemorySettings: async (patch: MemorySettingsPatch) => {
      fileMemoryEnabled = patch.fileMemory?.enabled ?? true
      return { fileMemory: { enabled: fileMemoryEnabled } }
    }
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  useModelCatalogStore.setState({ revision: 1, refreshing: false, models: [
    { id: 'm1', name: 'M1', provider: 'test', providerName: 'Test', contextWindow: 100000, reasoning: true, thinkingLevels: ['low', 'medium', 'high'] },
    { id: 'm2', name: 'M2', provider: 'test', providerName: 'Test', contextWindow: 100000, reasoning: true, thinkingLevels: ['off', 'low'] }
  ] })
  const { PluginsPane } = await import('../src/renderer/src/components/settings/PluginsPane')
  const { PersonaMemoryPane } = await import('../src/renderer/src/components/settings/PersonaMemoryPane')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 15)) }) }
  try {
    await act(async () => { root.render(h(TooltipProvider, null, h(PluginsPane))) })
    await flush()
    const group = document.querySelector<HTMLElement>('[aria-label="Example 启用范围"]')
    assert.ok(group)
    assert.equal(group.parentElement?.lastElementChild, group)
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
    const otherGroup = document.querySelector('[aria-label="Review 启用范围"]')!
    const [, otherProject, otherChat] = [...otherGroup.querySelectorAll<HTMLButtonElement>('button')]
    const first = deferred()
    const second = deferred()
    scopeWaits.set('example', first.promise)
    scopeWaits.set('pig-review', second.promise)
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
    scopeWaits.set('example', turningOff.promise)
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
    const buttons = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === label)
    const popover = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    await act(async () => { root.render(h(TooltipProvider, null, h(PluginsPane))) })
    await flush()
    const openReview = document.querySelector<HTMLButtonElement>('[aria-label="配置 Review"]')!
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

    let dirty = false
    await act(async () => { root.render(h(TooltipProvider, null, h(PersonaMemoryPane, { onDirtyChange: value => { dirty = value } }))) })
    await flush()
    assert.equal(document.querySelector('textarea'), null, 'persona files are not shown inline')
    const configure = host.querySelector<HTMLButtonElement>('[aria-label="配置灵魂"]')!
    const aboutYou = host.querySelector<HTMLButtonElement>('[aria-label="配置关于你"]')!
    assert.equal(configure.textContent, '灵魂')
    assert.equal(aboutYou.textContent, '关于你')
    const featureTabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const switchFeature = async (label: string) => {
      await act(async () => {
        featureTabs().find(button => button.textContent === label)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      })
      await flush()
    }
    const header = host.querySelector('[role="tablist"]')!.parentElement!
    assert.ok(header.contains(configure) && header.contains(aboutYou), 'both buttons share the tab header')
    assert.equal(host.querySelector('[role="tabpanel"]')!.contains(configure), false, 'old configuration rows are removed')
    await act(async () => { configure.click() })
    await flush()
    assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, '灵魂')
    assert.ok(document.getElementById('persona-SOUL.md'))
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '取消')!.click() })
    await flush()
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(featureTabs().map(button => button.textContent), ['人格', '长期记忆'])
    await switchFeature('长期记忆')
    assert.ok(configure.closest('[hidden]'), 'persona actions are hidden on the file-memory tab')
    const fileMemory = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="文件记忆"]')!
    assert.ok(fileMemory)
    await act(async () => { fileMemory.click() })
    await flush()
    assert.equal(fileMemoryEnabled, false, 'file-memory settings remain independently writable')
    assert.equal(dirty, false)
    await switchFeature('人格')
    assert.equal(configure.closest('[hidden]'), null)
    assert.equal(document.querySelector('[aria-label="人格 默认启用范围"]'), null)
    const mood = document.getElementById('persona-pleasantness')!
    assert.ok(configure.compareDocumentPosition(mood) & Node.DOCUMENT_POSITION_FOLLOWING, 'file buttons are in the header above the mood card')
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
    const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--plugins-pane-fixture'], { timeoutMs: 12_000 })
    assert.equal(code, 0, stderr || stdout)
  }, 14_000)
}

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { MemorySettings, MemorySettingsPatch } from '../src/shared/api'
import { runSelf } from './helpers/subprocess'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let config: MemorySettings = {}
  const patches: MemorySettingsPatch[] = []
  const forgotten: string[] = []
  const deleted: string[] = []
  let waitForSave: Promise<void> | undefined
  let failSave = false
  let failApply = false
  Object.assign(window, { api: {
    getMemorySettings: async () => config,
    setMemorySettings: async (patch: MemorySettingsPatch) => {
      patches.push(patch)
      await waitForSave
      if (failSave) throw new Error('Save failed')
      config = { ...config, ...patch } as MemorySettings
      if (failApply) throw new Error('Apply failed')
      return config
    },
    longTermMemory: {
      list: async (kind: string) => ({
        candidates: kind === 'candidates' && !deleted.length ? [{ id: 'b'.repeat(64), content: '尚未审核的 reflection', sessionId: 'source', recordedAt: '2026-11-06T00:00:00.000Z', status: 'pending' }] : [],
        memories: kind === 'memories' && !forgotten.length ? [{ id: 'a'.repeat(64), content: '<script>not executable</script> 项目使用中文检索', kind: 'decision', scope: 'project', scopeKey: '/repo/.git', status: 'active', assertion: 'user-statement', sourceTime: '2026-11-06T00:00:00.000Z', createdAt: '2026-11-06T01:00:00.000Z' }] : [],
        nextOffset: null,
      }),
      evidence: async () => [{ candidateId: 'a'.repeat(64), sessionId: 'source-session', reflectionEntryId: 'reflection-entry', reflectionId: '123456abcdef', sourceEntryIds: ['user-entry'] }],
      deleteCandidate: async (id: string) => { deleted.push(id) },
      forget: async (id: string) => { forgotten.push(id) },
    },
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  const { LongTermMemorySettings } = await import('../src/renderer/src/components/settings/LongTermMemorySettings')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  useSettingsStore.setState({ locale: 'zh-CN', localeSetting: 'zh-CN' })
  useModelCatalogStore.setState({ models: [{ provider: 'test', providerName: 'Test', id: 'review', name: 'Review Model',
    contextWindow: 32_000, reasoning: true, thinkingLevels: ['low', 'high'] }] })
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  let busy = false
  try {
    await act(async () => { root.render(h(TooltipProvider, null, h(LongTermMemorySettings, { onBusyChange: value => { busy = value } }))) })
    await flush()
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="自动筛选与召回"]')!
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(button('保存设置'), undefined)
    const pending = Promise.withResolvers<void>()
    waitForSave = pending.promise
    await act(async () => { toggle.click() })
    assert.deepEqual(patches, [{ longTerm: { enabled: true } }])
    assert.equal(busy, true)
    await act(async () => { toggle.click() })
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(patches.length, 1, 'overlapping changes are written serially')
    await act(async () => { pending.resolve() }); await flush()
    assert.deepEqual(config.longTerm, { enabled: false })
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'older replies cannot overwrite the latest choice')
    assert.equal(busy, false)
    waitForSave = undefined
    await act(async () => { toggle.click() }); await flush()
    assert.deepEqual(config.longTerm, { enabled: true })
    failSave = true
    await act(async () => { toggle.click() }); await flush()
    assert.equal(toggle.getAttribute('aria-checked'), 'true', 'a failed write restores the saved value')
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Save failed/)
    assert.equal(busy, false)
    failSave = false
    failApply = true
    await act(async () => { toggle.click() }); await flush()
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'application failure does not pretend a persisted write was rolled back')
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Apply failed/)
    failApply = false
    await act(async () => { toggle.click() }); await flush()
    await act(async () => { button('默认').click() }); await flush()
    const inherit = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="默认"]')!
    await act(async () => { inherit.click() }); await flush()
    const modelButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('Review Model'))!
    await act(async () => { modelButton.click() }); await flush()
    assert.deepEqual(config.longTerm, { enabled: true, model: { provider: 'test', id: 'review' } })
    const up = document.querySelector<HTMLButtonElement>('button[aria-label="提高思考强度"]')!
    await act(async () => { up.click() }); await flush()
    assert.equal((config as MemorySettings).longTerm?.model?.thinking, 'low')
    await act(async () => { up.click() }); await flush()
    assert.equal((config as MemorySettings).longTerm?.model?.thinking, 'high')
    await act(async () => { inherit.click() }); await flush()
    assert.deepEqual(config.longTerm, { enabled: true }, 'restoring inheritance saves immediately and clears model and thinking')
    await act(async () => { button('默认').click() }); await flush()
    assert.equal(document.querySelector('[role="alert"]'), null)
    await act(async () => { button('查看长期记忆').click() }); await flush()
    assert.ok(document.querySelector('[role="dialog"]')!.textContent!.includes('项目使用中文检索'))
    assert.equal(document.querySelector('script'), null, 'stored text never executes as HTML')
    await act(async () => { button('来源引用').click() }); await flush()
    assert.ok(document.querySelector('[role="dialog"]')!.textContent!.includes('user-entry'))
    await act(async () => { button('忘记').click() }); assert.deepEqual(forgotten, [])
    await act(async () => { button('确认忘记').click() }); await flush()
    assert.deepEqual(forgotten, ['a'.repeat(64)])
    const candidateTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === '候选')!
    await act(async () => { candidateTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) }); await flush()
    assert.ok(document.querySelector('[role="dialog"]')!.textContent!.includes('尚未审核的 reflection'))
    assert.ok(document.querySelector('[role="dialog"]')!.textContent!.includes('待审'))
    assert.equal(button('忘记'), undefined, 'candidates are not admitted memories')
    await act(async () => { button('删除').click() }); await flush()
    assert.deepEqual(deleted, ['b'.repeat(64)])
    assert.deepEqual(forgotten, ['a'.repeat(64)], 'candidate deletion must not call forgetting')
    assert.ok(!document.querySelector('[role="dialog"]')!.textContent!.includes('尚未审核的 reflection'))
  } finally { await act(async () => { root.unmount() }); GlobalRegistrator.unregister() }
}
if (process.argv.includes('--fixture')) await fixture()
else test('long-term memory settings autosave ordered changes, restore failed writes, save model/thinking and inspect/forget with confirmation', async () => {
  const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 10_000 })
  assert.equal(exitCode, 0, stderr || stdout)
}, 15_000)

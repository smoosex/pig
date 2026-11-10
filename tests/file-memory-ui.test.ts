import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'
import type { MemorySettings, MemorySettingsPatch } from '../src/shared/api'
import type { MemoryFile } from '../src/shared/long-term-memory'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let config: MemorySettings = {}
  let file: MemoryFile | undefined = { path: 'global/MEMORY.md', content: '[Build](build.md)', revision: 'a'.repeat(64) }
  const otherFile: MemoryFile = { path: 'global/other.md', content: 'Another note', revision: 'c'.repeat(64) }
  let fail = false
  let settingsSaveFailure = false
  let settingsReadFailure = false
  let settingsWrites = 0
  let settingsReadGate: Promise<void> | undefined
  let saveGate: Promise<void> | undefined
  let deletes = 0
  const saved: unknown[][] = []
  Object.assign(window, { api: {
    getMemorySettings: async () => {
      await settingsReadGate
      if (settingsReadFailure) throw Object.assign(new Error('Configuration reload unavailable'), { code: 'RELOAD_FAILED' })
      return config
    },
    setMemorySettings: async (patch: MemorySettingsPatch) => {
      settingsWrites++
      config = { ...config, ...patch } as MemorySettings
      if (settingsSaveFailure) throw Object.assign(new Error('Configuration saved but application failed'), { code: 'APPLY_FAILED' })
      return config
    },
    longTermMemory: {
      list: async () => file ? [file, otherFile].map(item => ({ path: item.path, bytes: item.content.length })) : [],
      read: async (path: string) => path === otherFile.path ? otherFile : file,
      save: async (...args: [string, string, string]) => {
        saved.push(args); await saveGate
        if (fail) throw new Error('Memory revision conflict')
        file = { path: args[0], content: args[1], revision: 'b'.repeat(64) }; return file
      },
      delete: async (path: string, revision: string) => { assert.equal(path, file?.path); assert.equal(revision, file?.revision); deletes++; file = undefined }
    }
  } })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { LongTermMemorySettings } = await import('../src/renderer/src/components/settings/LongTermMemorySettings')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  useSettingsStore.setState({ locale: 'zh-CN', localeSetting: 'zh-CN' })
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
  const input = () => document.querySelector<HTMLTextAreaElement>('textarea')!
  const change = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  let dirty = false
  let busy = false
  try {
    await act(async () => root.render(h(TooltipProvider, null, h(LongTermMemorySettings, { onDirtyChange: value => { dirty = value }, onBusyChange: value => { busy = value } }))))
    await flush()
    assert.doesNotMatch(host.textContent!, /长期记忆模型|自动学习|任务经历/)
    const toggle = () => document.querySelector<HTMLButtonElement>('[aria-label="文件记忆"]')!
    settingsSaveFailure = true; settingsReadFailure = true
    await act(async () => toggle().click()); await flush()
    assert.deepEqual(config.fileMemory, { enabled: true }, 'configuration persisted before application failed')
    assert.equal(toggle().disabled, true, 'unknown state must not be editable')
    assert.match(host.textContent!, /配置状态未知/)
    const alert = host.querySelector('[role="alert"]')!
    assert.match(alert.textContent!, /Configuration saved but application failed/)
    assert.match(alert.textContent!, /重新读取配置失败.*Configuration reload unavailable/)
    assert.equal(busy, false)
    await act(async () => toggle().click())
    assert.equal(settingsWrites, 1, 'a stale switch cannot submit another update')
    await act(async () => button('重新读取').click()); await flush()
    assert.equal(toggle().disabled, true, 'a failed manual reload keeps the state unknown')
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Configuration reload unavailable/)
    settingsReadFailure = false; settingsSaveFailure = false
    const reloadGate = Promise.withResolvers<void>(); settingsReadGate = reloadGate.promise
    await act(async () => button('重新读取').click())
    assert.equal(toggle().disabled, true, 'waiting for a reload does not confirm the old value')
    assert.equal(button('重新读取').disabled, true)
    assert.equal(busy, true)
    await act(async () => reloadGate.resolve()); await flush()
    settingsReadGate = undefined
    assert.equal(toggle().disabled, false)
    assert.equal(toggle().getAttribute('aria-checked'), 'true', 'successful reload restores the persisted value')
    assert.equal(host.querySelector('[role="alert"]'), null)
    assert.equal(button('重新读取'), undefined)
    assert.equal(settingsWrites, 1, 'reloading never writes configuration')
    settingsSaveFailure = true
    await act(async () => toggle().click()); await flush()
    assert.deepEqual(config.fileMemory, { enabled: false })
    assert.equal(toggle().disabled, false, 'successful recovery reload confirms the new persisted value')
    assert.equal(toggle().getAttribute('aria-checked'), 'false')
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Configuration saved but application failed/)
    assert.doesNotMatch(host.textContent!, /配置状态未知/)
    settingsSaveFailure = false
    await act(async () => toggle().click()); await flush()
    assert.deepEqual(config.fileMemory, { enabled: true })
    await act(async () => button('浏览记忆文件').click()); await flush()
    await act(async () => button('global/MEMORY.md').click()); await flush()
    assert.equal(input().value, '[Build](build.md)')
    await act(async () => button('删除').click())
    assert.ok(button('确认'))
    await act(async () => button(otherFile.path).click()); await flush()
    assert.equal(input().value, otherFile.content)
    assert.equal(button('确认'), undefined, 'switching files cancels deletion confirmation for the previous note')
    assert.equal(deletes, 0)
    await act(async () => button('global/MEMORY.md').click()); await flush()
    assert.equal(button('确认'), undefined, 'the old confirmation cannot reappear on returning')
    await change('New index')
    assert.equal(dirty, true)
    fail = true
    await act(async () => button('保存').click()); await flush()
    assert.equal(input().value, 'New index')
    assert.equal(dirty, true)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /conflict/)
    assert.deepEqual(saved[0], ['global/MEMORY.md', 'New index', 'a'.repeat(64)])
    fail = false
    const gate = Promise.withResolvers<void>(); saveGate = gate.promise
    await act(async () => button('保存').click())
    assert.equal(busy, true)
    assert.equal(input().disabled, true)
    assert.equal(button('删除').disabled, true)
    await act(async () => gate.resolve()); await flush()
    assert.equal(dirty, false)
    assert.equal(busy, false)
    saveGate = undefined
    await act(async () => button('删除').click())
    assert.equal(deletes, 0, 'deletion needs confirmation')
    await act(async () => button('取消').click())
    assert.equal(deletes, 0)
    await change('Unsaved')
    const closeButton = document.querySelector<HTMLButtonElement>('[role="dialog"] button[data-slot="dialog-close"]')
      ?? [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item => item.querySelector('.sr-only'))!
    await act(async () => closeButton.click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /放弃尚未保存/)
    await act(async () => button('取消').click())
    assert.equal(input().value, 'Unsaved')
    await act(async () => button('删除').click())
    await act(async () => button('确认').click()); await flush()
    assert.equal(deletes, 1)
    assert.equal(dirty, false)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /暂无记忆文件/)
  } finally {
    await act(async () => root.unmount()); host.remove()
    GlobalRegistrator.unregister()
  }
}
if (process.argv.includes('--fixture')) await fixture()
else test('file memory UI marks unconfirmed configuration unknown and preserves conflicted editor drafts', async () => {
  const result = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 15000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
}, 20000)

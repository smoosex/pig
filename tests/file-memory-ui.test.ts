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
  const project = 'a'.repeat(64)
  const nestedFile: MemoryFile = { path: 'global/topics/design.md', content: 'Nested clue', revision: 'd'.repeat(64) }
  const projectFile: MemoryFile = { path: `projects/${project}/MEMORY.md`, content: 'Project clue', revision: 'e'.repeat(64) }
  let lists = 0
  let showIssues = false
  const repairRequests: unknown[] = []
  let maintenanceStatus = { state: 'idle', repair: false, id: 'repair', changes: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0, costKnown: true }
  let fail = false
  let settingsSaveFailure = false
  let settingsReadFailure = false
  let settingsWrites = 0
  let settingsReadGate: Promise<void> | undefined
  let saveGate: Promise<void> | undefined
  let deletes = 0
  const saved: unknown[][] = []
  Object.assign(window, { api: {
    dream: { status: async () => maintenanceStatus, start: async (request: unknown) => { repairRequests.push(request); maintenanceStatus = { ...maintenanceStatus, state: 'running', repair: true }; return maintenanceStatus } },
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
      list: async () => { lists++; return [...(file ? [file, otherFile, nestedFile, projectFile].map(item => ({ path: item.path, bytes: item.content.length, ...(item.path === projectFile.path ? { projectName: 'Pig' } : {}) })) : []), ...(showIssues ? [{ path: 'stray.md', bytes: 12, issue: 'MEMORY_MISPLACED', repairable: true }, { path: 'global/broken.md', bytes: 0, issue: 'MEMORY_UNREADABLE' }] : [])] },
      read: async (path: string) => [otherFile, nestedFile, projectFile].find(item => item.path === path) ?? file,
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
  const fileButton = (path: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-memory-file-tree] button')].find(item => item.title === path)!
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
    assert.equal(toggle().getAttribute('aria-checked'), 'true', 'file memory defaults to enabled')
    await act(async () => toggle().click()); await flush()
    assert.deepEqual(config.fileMemory, { enabled: false })
    settingsWrites = 0
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
    const dialog = document.querySelector('[role="dialog"]')!
    const refresh = dialog.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!
    assert.ok(refresh.classList.contains('right-12') && refresh.classList.contains('top-4'))
    assert.equal(refresh.getAttribute('data-size'), 'icon-sm')
    assert.ok(refresh.querySelector('.lucide-rotate-cw'), 'refresh uses the shared single-arrow icon')
    assert.equal(refresh.querySelector('.lucide-refresh-cw'), null)
    assert.ok(!dialog.querySelector('[data-memory-file-tree]')!.contains(refresh))
    assert.equal(fileButton('global').getAttribute('aria-expanded'), 'true')
    assert.equal(fileButton('global/MEMORY.md').textContent, 'MEMORY.md', 'file labels omit the scope prefix')
    await act(async () => fileButton('global').click()); await flush()
    assert.equal(fileButton('global').getAttribute('aria-expanded'), 'false')
    assert.equal(fileButton('global/MEMORY.md'), undefined)
    await act(async () => fileButton('global').click()); await flush()
    assert.equal(fileButton('global/topics/design.md'), undefined, 'nested directories start collapsed')
    await act(async () => fileButton('global/topics').click()); await flush()
    await act(async () => fileButton(nestedFile.path).click()); await flush()
    assert.equal(input().value, nestedFile.content)
    assert.equal(fileButton(`projects/${project}`).textContent, `Pig (${project})`)
    assert.equal(fileButton(`projects/${project}`).title, `projects/${project}`, 'project names are display labels, not paths')
    await act(async () => fileButton(`projects/${project}`).click()); await flush()
    await act(async () => fileButton(projectFile.path).click()); await flush()
    assert.equal(input().value, projectFile.content, 'identical basenames retain distinct canonical paths')
    assert.equal(fileButton(projectFile.path).getAttribute('aria-pressed'), 'true')
    await act(async () => fileButton('global/MEMORY.md').click()); await flush()
    assert.equal(input().value, '[Build](build.md)')
    const footer = document.querySelector('[role="dialog"] [data-slot="dialog-footer"]')!
    assert.ok(footer.contains(button('保存')) && footer.contains(button('删除')))
    assert.equal(button('取消').getAttribute('data-variant'), 'ghost')
    assert.ok(button('删除').classList.contains('mr-auto'), 'delete is separated from save')
    await act(async () => button('删除').click())
    assert.ok(button('确认'))
    await act(async () => fileButton(otherFile.path).click()); await flush()
    assert.equal(input().value, otherFile.content)
    assert.equal(button('确认'), undefined, 'switching files cancels deletion confirmation for the previous note')
    assert.equal(deletes, 0)
    await act(async () => fileButton('global/MEMORY.md').click()); await flush()
    assert.equal(button('确认'), undefined, 'the old confirmation cannot reappear on returning')
    await change('New index')
    assert.equal(dirty, true)
    const beforeRefresh = lists
    await act(async () => refresh.click()); await flush()
    assert.equal(lists, beforeRefresh + 1)
    assert.equal(input().value, 'New index', 'refreshing the tree does not discard an unsaved draft')
    assert.equal(fileButton('global/MEMORY.md').getAttribute('aria-pressed'), 'true')
    assert.equal(fileButton('global/topics').getAttribute('aria-expanded'), 'true', 'refresh preserves expanded directories')
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
    await act(async () => button('取消').click()); await flush()
    await act(async () => toggle().click()); await flush()
    assert.equal(toggle().getAttribute('aria-checked'), 'false')
    file = { path: 'global/MEMORY.md', content: 'Valid index', revision: 'e'.repeat(64) }
    showIssues = true
    await act(async () => button('浏览记忆文件').click()); await flush()
    assert.ok(fileButton('global/MEMORY.md'), 'broken entries do not hide the normal tree')
    assert.equal(fileButton('stray.md'), undefined)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /stray.md.*错放的记忆/)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /global\/broken.md.*无法安全读取/)
    assert.equal(button('修复记忆').disabled, false, 'manual repair is available with file memory disabled')
    await act(async () => button('修复记忆').click()); await flush()
    assert.deepEqual(repairRequests, [{ repair: true }])
    assert.equal(toggle().getAttribute('aria-checked'), 'false', 'repair never enables file memory')
    assert.equal(button('修复记忆').disabled, true)
    showIssues = false; maintenanceStatus = { ...maintenanceStatus, state: 'done' }
    const { useDreamStore } = await import('../src/renderer/src/stores/dream')
    await act(async () => useDreamStore.getState().refresh()); await flush()
    assert.doesNotMatch(document.querySelector('[role="dialog"]')!.textContent!, /stray.md|global\/broken.md/)
    assert.ok(fileButton('global/MEMORY.md'))
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

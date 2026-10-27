/** Exercise the shared settings boundary used by the settings page and the Agent tools. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'pig-settings-service-'))
  process.env.PIG_DIR = join(root, 'pig')
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  mock.module(fileURLToPath(new URL('../src/main/i18n.ts', import.meta.url)), () => ({ systemLocale: () => 'en' }))
  const defaultsCalls: unknown[] = []
  let defaultsRevision = 'd'.repeat(64)
  let defaultsFail = false
  let defaults: unknown = {
    stored: { model: null, thinkingLevel: null }, modelThinkingLevel: null, revision: defaultsRevision,
    effective: { model: null, thinkingLevel: null, thinkingLevels: [] }
  }
  mock.module(fileURLToPath(new URL('../src/main/pi/model-settings.ts', import.meta.url)), () => ({
    startModelRuntime: async () => {},
    pickerThinkingLevels: (levels: string[]) => levels.filter((level) => level !== 'off' && level !== 'minimal'),
    availableModels: () => [
      { id: 'alpha', name: 'Alpha', provider: 'test', providerName: 'Test', contextWindow: 1, reasoning: true, thinkingLevels: ['off', 'low', 'high'] },
      { id: 'beta', name: 'Beta', provider: 'other', providerName: 'Other', contextWindow: 1, reasoning: false, thinkingLevels: [] }
    ],
    readDefaultSettings: async () => {
      if (defaultsFail) throw new AggregateError([new SyntaxError('Unexpected end of JSON input')], 'Could not read default settings')
      return defaults
    },
    updateDefaultSettings: async (patch: unknown, expected?: string) => {
      defaultsCalls.push([patch, expected])
      defaultsRevision = 'e'.repeat(64)
      defaults = {
        stored: { model: { provider: 'test', id: 'alpha' }, thinkingLevel: 'high' }, modelThinkingLevel: 'high', revision: defaultsRevision,
        effective: { model: { id: 'alpha', provider: 'test' }, thinkingLevel: 'high', thinkingLevels: ['low', 'high'] }
      }
      return defaults
    }
  }))
  const settingsFile = join(process.env.PIG_DIR, 'settings.json')
  const disk = async () => JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
  const exists = async () => readFile(settingsFile).then(() => true, () => false)
  try {
    if (name === 'surface') {
      const { SettingsSurfaceCoordinator } = await import('../src/main/settings/surface')
      const window = () => {
        const win = Object.assign(new EventEmitter(), {
          destroyed: false,
          sent: [] as unknown[],
          isDestroyed: () => win.destroyed,
          webContents: Object.assign(new EventEmitter(), { isDestroyed: () => win.destroyed, send: (_channel: string, value: unknown) => win.sent.push(value) })
        })
        return win
      }
      const coordinator = new SettingsSurfaceCoordinator()
      const [a, b] = [window(), window()]
      coordinator.watch(a as never)
      coordinator.watch(b as never)
      const preparing = coordinator.prepare()
      const request = a.sent[0] as { type: string; requestId: string }
      assert.equal(request.type, 'prepare-solid')
      assert.deepEqual(b.sent, [request], 'every loaded UI receives the same handoff')
      coordinator.reply(a as never, request.requestId)
      b.emit('closed')
      const handoff = await preparing
      handoff.finish('solid')
      assert.deepEqual(a.sent.at(-1), { type: 'finish', requestId: request.requestId, surfaceStyle: 'solid' })

      coordinator.watch(a as never)
      const controller = new AbortController()
      const aborted = coordinator.prepare(controller.signal)
      const next = a.sent.at(-1) as { requestId: string }
      controller.abort(new Error('stopped'))
      await assert.rejects(aborted, /stopped/)
      assert.deepEqual(a.sent.at(-1), { type: 'finish', requestId: next.requestId, surfaceStyle: 'glass' }, 'a cancelled handoff restores the old surface')

      const failing = coordinator.prepare()
      coordinator.reply(a as never, (a.sent.at(-1) as { requestId: string }).requestId, 'paint failed')
      await assert.rejects(failing, /paint failed/)
      a.webContents.emit('did-start-navigation', {}, 'app://ui', false, true)
      await coordinator.prepare()
      assert.ok(true, 'a reloading UI no longer holds the barrier')
      return
    }

    const { SettingsService } = await import('../src/main/settings/service')
    const { supportsGlass } = await import('../src/main/surface-support')
    const log: unknown[] = []
    let applyFails = false
    let prepareFails = false
    const service = new SettingsService({
      prepareSolid: async () => {
        log.push('prepare')
        if (prepareFails) throw new Error('UI did not paint')
        return { finish: (style) => log.push(['finish', style]) }
      },
      applyTheme: (theme) => {
        log.push(['theme', theme.appearance, theme.surfaceStyle])
        if (applyFails) throw new Error('material failed')
      },
      applyShortcuts: (shortcuts) => log.push(['shortcuts', shortcuts]),
      applyLocale: (locale) => log.push(['locale', locale]),
      publish: (event) => log.push(['publish', event]),
      isDark: () => true
    })

    if (name === 'validation') {
      const theme = await service.get('theme')
      assert.match(theme.revision, /^[a-f0-9]{64}$/)
      assert.equal(theme.effective && 'appearance' in theme.effective && theme.effective.appearance, 'dark', 'system appearance reports the effective scheme')
      const invalid: unknown[] = [
        { group: 'theme', expectedRevision: theme.revision, patch: { beamBorderEnabled: false } },
        { group: 'theme', expectedRevision: theme.revision, patch: { appearance: 'auto' } },
        { group: 'theme', expectedRevision: theme.revision, patch: {} },
        { group: 'theme', expectedRevision: 'nope', patch: { appearance: 'dark' } },
        { group: 'theme', patch: { appearance: 'dark' } },
        { group: 'providers', expectedRevision: theme.revision, patch: {} },
        { group: 'general', expectedRevision: (await service.get('general')).revision, patch: { locale: 'fr' } },
        { group: 'shortcuts', expectedRevision: (await service.get('shortcuts')).revision, patch: { bindings: { 'tab.nope': null } } },
        { group: 'shortcuts', expectedRevision: (await service.get('shortcuts')).revision, patch: { bindings: { 'tab.new': 'Mod+KeyW' } } },
        { group: 'defaults', expectedRevision: defaultsRevision, patch: { thinkingLevel: 'off' } },
        { group: 'defaults', expectedRevision: defaultsRevision, patch: { model: { provider: 'test' } } }
      ]
      for (const request of invalid) await assert.rejects(service.update(request as never), JSON.stringify(request))
      await assert.rejects(service.update({ group: 'theme', expectedRevision: theme.revision, patch: { appearance: 'light' } }, undefined, () => {
        throw new Error('The requesting session is no longer open in a Pig window')
      }), /no longer open/)
      const controller = new AbortController()
      controller.abort(new Error('cancelled'))
      await assert.rejects(service.update({ group: 'theme', expectedRevision: theme.revision, patch: { appearance: 'light' } }, controller.signal), /cancelled/)
      assert.equal(await exists(), false, 'rejected changes never touch disk')
      assert.deepEqual(log, [])
      assert.deepEqual(defaultsCalls, [])
      if (!supportsGlass) {
        await assert.rejects(service.update({ group: 'theme', expectedRevision: theme.revision, patch: { surfaceStyle: 'glass' } }), /not supported/)
      }
      return
    }

    if (name === 'updates') {
      const theme = await service.get('theme')
      const result = await service.update({ group: 'theme', expectedRevision: theme.revision, patch: { appearance: 'light', lightTheme: 'everforest' } })
      assert.equal(result.ok, true)
      assert.equal(result.changed, true)
      assert.equal(result.application, 'applied')
      assert.deepEqual(result.after.values, { ...theme.values, appearance: 'light', lightTheme: 'everforest' })
      assert.equal((await disk()).appearance, 'light')
      assert.deepEqual(log.splice(0), [
        ['theme', 'light', theme.values && 'surfaceStyle' in theme.values ? theme.values.surfaceStyle : undefined],
        ['publish', { revision: 1, values: { ...theme.values, appearance: 'light', lightTheme: 'everforest' } }]
      ])
      await assert.rejects(service.update({ group: 'theme', expectedRevision: theme.revision, patch: { appearance: 'dark' } }), /revision conflict/)
      assert.equal((await disk()).appearance, 'light', 'a stale revision cannot overwrite a newer change')

      // The settings page and the Agent race on one field: the UI write lands first, the Agent must re-read.
      const notifications = await service.get('notifications')
      const [ui, agent] = await Promise.allSettled([
        service.updateUi('notifications', { completionNotifications: false }),
        service.update({ group: 'notifications', expectedRevision: notifications.revision, patch: { completionNotifications: true } })
      ])
      assert.equal(ui.status, 'fulfilled')
      if (ui.status === 'fulfilled') assert.deepEqual(ui.value, { completionNotifications: false, settingsRevision: 2 })
      assert.equal(agent.status, 'rejected')
      assert.equal((await disk()).completionNotifications, false)

      const shortcuts = await service.get('shortcuts')
      const taken = await service.update({
        group: 'shortcuts', expectedRevision: shortcuts.revision,
        patch: { sendShortcut: 'shift-enter', bindings: { 'tab.new': 'Mod+KeyW', 'tab.close': null } }
      })
      assert.deepEqual(taken.after.values, { sendShortcut: 'shift-enter', bindings: { 'tab.new': 'Mod+KeyW', 'tab.close': null } })
      const reset = await service.update({
        group: 'shortcuts', expectedRevision: taken.after.revision, patch: { bindings: { 'tab.new': 'default', 'tab.close': 'default' } }
      })
      assert.deepEqual(reset.after.values, { sendShortcut: 'shift-enter', bindings: {} })
      assert.deepEqual(log.filter((entry) => Array.isArray(entry) && entry[0] === 'shortcuts'), [
        ['shortcuts', { 'tab.new': 'Mod+KeyW', 'tab.close': null }], ['shortcuts', {}]
      ])

      const general = await service.get('general')
      await service.update({ group: 'general', expectedRevision: general.revision, patch: { locale: 'zh-CN' } })
      assert.ok(log.some((entry) => JSON.stringify(entry) === JSON.stringify(['locale', 'zh-CN'])))

      const defaults = await service.update({ group: 'defaults', expectedRevision: defaultsRevision, patch: { model: { provider: 'test', id: 'alpha' }, thinkingLevel: 'high' } })
      assert.equal(defaults.application, 'new-sessions')
      assert.deepEqual(defaultsCalls, [[{ model: { provider: 'test', id: 'alpha' }, thinkingLevel: 'high' }, 'd'.repeat(64)]])
      assert.deepEqual(defaults.after.values, { model: { provider: 'test', id: 'alpha' }, thinkingLevel: 'high' })
      assert.deepEqual((log.at(-1) as [string, { values: unknown }])[1].values, {
        defaultModel: { id: 'alpha', provider: 'test' }, defaultThinkingLevel: 'high', thinkingLevels: ['low', 'high'], defaultSettingsError: null
      })

      const catalog = await service.list({ group: 'defaults', query: 'alp' })
      assert.deepEqual(catalog.models?.items.map((model) => [model.id, model.thinkingLevels]), [['alpha', ['low', 'high']]])
      assert.equal(catalog.models?.total, 1)
      const keys = await service.list({ group: 'shortcuts' })
      assert.ok(keys.shortcuts?.some((entry) => entry.id === 'tab.new' && entry.binding === entry.default))
      assert.doesNotMatch(JSON.stringify(await service.list()), /apiKey|auth\.json|token/i)
      return
    }

    if (name === 'surface-order') {
      if (!supportsGlass) return
      await mkdir(process.env.PIG_DIR, { recursive: true })
      await writeFile(settingsFile, '{"version":1,"surfaceStyle":"glass"}')
      prepareFails = true
      await assert.rejects(service.updateUi('theme', { surfaceStyle: 'solid' }), /did not paint/)
      assert.equal((await disk()).surfaceStyle, 'glass', 'a failed paint handoff saves nothing')
      assert.deepEqual(log.splice(0), ['prepare'])
      prepareFails = false
      await service.updateUi('theme', { surfaceStyle: 'solid' })
      assert.deepEqual(log.splice(0).map((entry) => Array.isArray(entry) ? entry[0] === 'publish' ? 'publish' : entry : entry), [
        'prepare', ['theme', 'system', 'solid'], 'publish', ['finish', 'solid']
      ], 'UIs paint solid before the native material is removed and only release their hold after the new value arrives')
      await service.updateUi('theme', { surfaceStyle: 'glass' })
      assert.deepEqual(log.splice(0).map((entry) => Array.isArray(entry) ? entry[0] === 'publish' ? 'publish' : entry : entry), [
        ['theme', 'system', 'glass'], 'publish'
      ], 'glass enables the native material before the page reveals it')

      applyFails = true
      const snapshot = await service.get('theme')
      const failed = await service.update({ group: 'theme', expectedRevision: snapshot.revision, patch: { appearance: 'dark' } })
      assert.equal(failed.ok, false)
      assert.equal(failed.application, 'failed')
      assert.match(failed.error!, /saved but could not be applied: material failed/)
      assert.equal((await disk()).appearance, 'dark', 'saved values are reported honestly instead of pretending to roll back')
      assert.ok(log.some((entry) => Array.isArray(entry) && entry[0] === 'publish'), 'every UI still learns the saved value')
      await assert.rejects(service.updateUi('theme', { appearance: 'light' }), /could not be applied/)
      return
    }

    if (name === 'pi-corrupt') {
      await mkdir(process.env.PIG_DIR, { recursive: true })
      await writeFile(settingsFile, '{"version":1,"appearance":"dark","completionNotifications":false}')
      defaultsFail = true
      const ui = await service.getUi()
      assert.equal(ui.appearance, 'dark', "Pig's own preferences still load")
      assert.equal(ui.completionNotifications, false)
      assert.equal(ui.defaultModel, null)
      assert.deepEqual(ui.thinkingLevels, [])
      assert.equal(ui.defaultSettingsError, 'Could not read default settings: Unexpected end of JSON input')
      await assert.rejects(service.get('defaults'), /Could not read default settings/)
      await assert.rejects(service.updateUi('defaults', { thinkingLevel: 'high' }), /Could not read default settings/, 'writes stay strict')
      assert.deepEqual(defaultsCalls, [])
      defaultsFail = false
      assert.equal((await service.getUi()).defaultSettingsError, null)
      const saved = await service.updateUi('defaults', { thinkingLevel: 'high' })
      assert.equal(saved.defaultSettingsError, null, 'a successful save clears the error in every window')
      return
    }

    if (name === 'corrupt') {
      await mkdir(process.env.PIG_DIR, { recursive: true })
      await writeFile(settingsFile, '{"version":1,')
      await assert.rejects(service.get('theme'))
      await assert.rejects(service.updateUi('notifications', { completionNotifications: false }))
      await assert.rejects(service.setBeamBorder(false))
      assert.equal(await readFile(settingsFile, 'utf8'), '{"version":1,', 'unreadable settings are never replaced with defaults')
      await writeFile(settingsFile, '[]')
      await assert.rejects(service.get('theme'), /Invalid Pig settings object/)
      await rm(settingsFile)
      const saved = await service.setBeamBorder(false)
      assert.deepEqual(saved, { beamBorderEnabled: false, settingsRevision: 1 })
      return
    }

    throw new Error(`Unknown fixture: ${name}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--settings-service-fixture') {
  await fixture(process.argv[3]!)
} else {
  for (const [name, title] of Object.entries({
    validation: 'invalid fields, values, revisions, sessions and cancellations never touch disk',
    updates: 'agent and UI writes share revisions, shortcut patches and model defaults',
    'surface-order': 'solid and glass hand off around the native material, and apply failures are reported',
    corrupt: 'unreadable settings fail instead of being overwritten',
    'pi-corrupt': "a broken Pi settings file is reported beside the default model without hiding Pig's preferences",
    surface: 'the paint barrier waits for loaded UIs only and restores the old surface on cancel'
  })) {
    test(`settings service: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--settings-service-fixture', name], { stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

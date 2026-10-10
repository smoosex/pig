/** Settings navigation is global-only and must not depend on the project catalog. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const panes = [
    ['GeneralPane', 'settings.sectionGeneral'],
    ['ThemePane', 'settings.sectionTheme'],
    ['ProvidersPane', 'settings.sectionProviders'],
    ['McpPane', 'mcp.title'],
    ['PluginsPane', 'settings.sectionPlugins']
  ] as const
  for (const [name] of panes) {
    mock.module(`../src/renderer/src/components/settings/${name}`, () => ({
      [name]: () => h('span', { 'data-settings-pane': name }, name)
    }))
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: () => {
      throw new Error('Settings navigation must not read projects')
    }
  }))
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({
    localeSetting: 'en',
    locale: 'en',
    error: null,
    load: async () => {}
  })
  const { SettingsPage } = await import('../src/renderer/src/components/settings/SettingsPage')
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(h(SettingsPage, { onClose: () => {} }))
    })
    const navigation = host.querySelector('nav')!
    const buttons = [...navigation.querySelectorAll<HTMLButtonElement>('button')]
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      [...panes.map(([, key]) => translate('en', key)), translate('en', 'settings.back')]
    )
    assert.equal(navigation.querySelector('[data-slot="collapsible"]'), null)
    for (const [name, key] of panes) {
      await act(async () => {
        buttons.find((button) => button.textContent === translate('en', key))!.click()
      })
      assert.equal(host.querySelector('h1')!.textContent, translate('en', key))
      assert.equal(
        host.querySelector(`[data-settings-pane="${name}"]`)!.parentElement!.className,
        'contents'
      )
      for (const [other] of panes) {
        if (other !== name)
          assert.equal(
            host.querySelector(`[data-settings-pane="${other}"]`)!.parentElement!.className,
            'hidden'
          )
      }
    }
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else
  test('settings navigation only exposes global sections, without a project catalog dependency', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const timer = setTimeout(() => child.kill(), 6000)
    try {
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, errors || output)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 8000)

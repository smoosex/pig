/** Settings navigation is global-only and must not depend on the project catalog. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { supportsGlass: false } })
  const { act, createElement: h } = await import('react')
  const panes = [
    ['GeneralPane', 'settings.sectionGeneral', 'settings.sectionGeneralDescription'],
    ['ShortcutsPane', 'shortcuts.title', 'shortcuts.description'],
    ['ThemePane', 'settings.sectionTheme', 'settings.sectionThemeDescription'],
    ['ProvidersPane', 'settings.sectionProviders', 'settings.sectionProvidersDescription'],
    ['McpPane', 'mcp.title', 'mcp.description'],
    ['SkillsPane', 'skills.title', 'skills.description'],
    ['PluginsPane', 'settings.sectionPlugins', 'settings.sectionPluginsDescription']
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
    const surface = host.querySelector<HTMLElement>('[data-settings-surface]')!
    assert.ok(surface.hasAttribute('data-app-surface'), 'settings participate in the surface transition handoff')
    for (const token of ['bg-glass-background', 'shadow-glass-panel', 'ring-glass-border', 'solid:bg-card', 'solid:shadow-none', 'solid:ring-0', 'duration-200', 'motion-reduce:transition-none']) {
      assert.ok(surface.classList.contains(token), token)
    }
    assert.ok(!surface.classList.contains('bg-card') && !surface.className.includes('backdrop-'))
    const navigation = host.querySelector('nav')!
    assert.equal(navigation.firstElementChild?.textContent?.trim(), translate('en', 'sidebar.settings'))
    const buttons = [...navigation.querySelectorAll<HTMLButtonElement>('button')]
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      [
        ...panes.map(([, key, desc]) => `${translate('en', key)}${translate('en', desc)}`),
        translate('en', 'settings.back')
      ]
    )
    assert.equal(navigation.querySelector('[data-slot="collapsible"]'), null)
    const paneNodes = new Map(panes.map(([name]) => [name, host.querySelector(`[data-settings-pane="${name}"]`)!]))
    for (const [name, key, desc] of [...panes, panes[0]]) {
      await act(async () => {
        const text = `${translate('en', key)}${translate('en', desc)}`
        buttons.find((button) => button.textContent === text)!.click()
      })
      assert.equal(host.querySelector('h1')!.textContent, translate('en', key))
      assert.equal(host.querySelector('[data-settings-surface]'), surface, 'navigation retains the shared glass backplate')
      for (const button of navigation.querySelectorAll('[data-sidebar-hover-row]')) {
        const selected = button.textContent === `${translate('en', key)}${translate('en', desc)}`
        assert.equal(button.hasAttribute('data-sidebar-selected'), selected)
      }
      for (const [pane] of panes) {
        const node = host.querySelector(`[data-settings-pane="${pane}"]`)!
        assert.equal(node, paneNodes.get(pane), 'navigation retains mounted panes')
        assert.equal(node.parentElement!.classList.contains('hidden'), pane !== name)
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

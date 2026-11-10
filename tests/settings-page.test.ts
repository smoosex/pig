/** Settings navigation is global-only and must not depend on the project catalog. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { translate } from '../src/shared/i18n'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { supportsGlass: false } })
  const { act, createElement: h } = await import('react')
  let featureCallbacks: { onDirtyChange?(value: boolean): void; onBusyChange?(value: boolean): void } = {}
  const panes = [
    ['GeneralPane', 'settings.sectionGeneral', 'settings.sectionGeneralDescription'],
    ['PersonaMemoryPane', 'features.title', 'features.description'],
    ['ShortcutsPane', 'shortcuts.title', 'shortcuts.description'],
    ['ThemePane', 'settings.sectionTheme', 'settings.sectionThemeDescription'],
    ['ProvidersPane', 'settings.sectionProviders', 'settings.sectionProvidersDescription'],
    ['McpPane', 'mcp.title', 'mcp.description'],
    ['SkillsPane', 'skills.title', 'skills.description'],
    ['PluginsPane', 'settings.sectionPlugins', 'settings.sectionPluginsDescription'],
    ['PermissionsPane', 'permissions.title', 'permissions.description']
  ] as const
  for (const [name] of panes) {
    mock.module(`../src/renderer/src/components/settings/${name}`, () => ({
      [name]: (props: typeof featureCallbacks) => {
        if (name === 'PersonaMemoryPane') featureCallbacks = props
        return h('span', { 'data-settings-pane': name }, name)
      },
      ...(name === 'ShortcutsPane' ? { ShortcutsResetAll: () => null } : {})
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
  let closes = 0
  try {
    await act(async () => {
      root.render(h(SettingsPage, { onClose: () => { closes++ } }))
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
    const back = buttons.at(-1)!
    await act(async () => { featureCallbacks.onBusyChange?.(true) })
    assert.equal(back.disabled, true, 'in-flight saves cannot be interrupted by closing settings')
    await act(async () => { back.click() })
    assert.equal(closes, 0)
    await act(async () => { featureCallbacks.onBusyChange?.(false); featureCallbacks.onDirtyChange?.(true) })
    await act(async () => { back.click() })
    assert.equal(closes, 0)
    assert.ok(document.querySelector('[role="alertdialog"]'))
    const action = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
    await act(async () => { action(translate('en', 'persona.keepEditing')).click() })
    assert.equal(closes, 0)
    await act(async () => { back.click() })
    await act(async () => { action(translate('en', 'persona.discard')).click() })
    assert.equal(closes, 1)
    const navigationTarget = document.createElement('div')
    host.append(navigationTarget)
    await act(async () => root.render(h(SettingsPage, {
      onClose: () => { closes++ }, navigationTarget, active: false
    })))
    assert.ok(navigationTarget.querySelector('nav'), 'navigation can share the workspace rail through a portal')
    assert.equal(host.querySelector('[data-settings-surface] nav'), null)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(closes, 1, 'an exiting settings page must no longer handle Escape')
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
    const { exitCode: code, stdout: output, stderr: errors } = await runSelf(import.meta.path, ['--fixture'], { timeoutMs: 6000 })
    assert.equal(code, 0, errors || output)
  }, 8000)

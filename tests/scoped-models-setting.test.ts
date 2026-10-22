/** Multi-select stays open, saves immediately, preserves order and only cleans missing providers. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const models = ['alpha', 'beta', 'gamma'].map((id) => ({
    provider: 'test', providerName: 'Test', id, name: id, contextWindow: 100, reasoning: false, thinkingLevels: []
  }))
  let patterns = ['test/beta', 'gone/old', 'test/unavailable']
  const writes: string[][] = []
  const settings = () => ({
    patterns,
    models: models.filter((m) => patterns.includes(`test/${m.id}`)),
    selections: patterns.map((pattern) => ({ pattern, models: models.filter((m) => `test/${m.id}` === pattern) })),
    warnings: patterns.includes('gone/old') ? ['Missing gone/old'] : [],
    missingProviderPatterns: patterns.filter((pattern) => pattern === 'gone/old')
  })
  Object.assign(window, { api: {
    getScopedModels: async () => settings(),
    setScopedModels: async (next: string[]) => { patterns = next; writes.push(next) },
    onScopedModelsChanged: () => () => {}
  } })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useModelCatalogStore } = await import('../src/renderer/src/stores/model-catalog')
  const { ScopedModelsSetting } = await import('../src/renderer/src/components/settings/ScopedModelsSetting')
  useModelCatalogStore.setState({ models })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const click = async (element: Element | null) => {
    assert.ok(element)
    await act(async () => { (element as HTMLElement).click() })
  }
  try {
    await act(async () => { root.render(createElement(ScopedModelsSetting)) })
    assert.equal(container.querySelector('textarea'), null)
    assert.equal(document.body.textContent?.includes('Missing gone/old'), false, 'warning details start collapsed')
    const triggers = container.querySelectorAll('[data-slot="popover-trigger"]')
    assert.equal(triggers.length, 2, 'warning button appears before the selection button')
    await click(triggers[1])
    const selected = () => Array.from(document.querySelectorAll('[data-scope-pattern]')).map((row) => row.getAttribute('data-scope-pattern'))
    assert.deepEqual(selected(), ['test/beta', 'gone/old', 'test/unavailable'])
    const checkboxes = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'))
    assert.deepEqual(checkboxes().map((c) => c.getAttribute('aria-checked')), ['true', 'true', 'true', 'false', 'false'])
    await click(checkboxes()[3])
    assert.deepEqual(writes.at(-1), ['test/beta', 'gone/old', 'test/unavailable', 'test/alpha'])
    assert.deepEqual(selected(), patterns, 'new selection joins the pinned selection group')
    assert.ok(document.querySelector('[data-slot="popover-content"]'), 'checking does not close the menu')
    await click(document.querySelector('[data-scope-pattern="test/beta"] [role="checkbox"]'))
    assert.deepEqual(patterns, ['gone/old', 'test/unavailable', 'test/alpha'])

    const input = document.querySelector<HTMLInputElement>('[data-slot="popover-content"] input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'gamma')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(document.querySelectorAll('[role="checkbox"]').length, 1, 'search filters both selected and unselected models')
    await click(container.querySelector('[data-slot="popover-trigger"]'))
    assert.ok(document.body.textContent?.includes('Missing gone/old'), 'warning button opens details')
    const cleanup = Array.from(document.querySelectorAll('button')).find((button) => /清除|Clear models/.test(button.textContent ?? ''))!
    await click(cleanup)
    assert.deepEqual(patterns, ['test/unavailable', 'test/alpha'], 'cleanup preserves unavailable models from existing providers')
    assert.equal(container.querySelectorAll('[data-slot="popover-trigger"]').length, 1, 'warning button disappears after cleanup')
    assert.equal(document.body.textContent?.includes('Missing gone/old'), false)
  } finally {
    await act(async () => { root.unmount() })
    GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--scoped-models-setting-fixture') {
  await fixture()
} else {
  test('scoped model multi-select pins selections and cleans only missing providers', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--scoped-models-setting-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally { clearTimeout(timeout) }
  })
}

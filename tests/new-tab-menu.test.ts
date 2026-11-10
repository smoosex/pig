/** Sidebar layout changes dismiss the real new-tab menu without changing its normal actions. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess.ts'

async function fixture() {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => (key: string) => key }))
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { NewTabButton } = await import('../src/renderer/src/components/TabBar')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (sidebarLayout: string) => {
    await act(async () => { root.render(h(NewTabButton, { sidebarTab: 'projects', sidebarLayout })) })
  }
  const open = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-new-tab]')!
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    })
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.ok(document.querySelector('[role="menu"][data-state="open"]'))
  }
  try {
    let layout = 'false:false:null:false'
    await render(layout)
    await open()
    await render(layout)
    assert.ok(document.querySelector('[role="menu"][data-state="open"]'), 'unrelated renders do not dismiss the menu')
    for (layout of ['true:false:null:false', 'false:false:null:false', 'false:true:null:false', 'false:false:null:false', 'false:true:right:false']) {
      await render(layout)
      assert.equal(container.querySelector('[data-new-tab]')?.getAttribute('aria-expanded'), 'false', 'either sidebar opening, closing or floating dismisses the menu')
      assert.equal(document.querySelector('[role="menu"][data-state="open"]'), null)
      await open()
      assert.equal(document.querySelectorAll('[role="menuitem"]').length, 3, 'the menu can reopen with all creation actions')
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--menu-fixture') {
  await fixture()
} else {
  test('new-tab menu closes on sidebar layout changes and remains reopenable', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--menu-fixture'])
    assert.equal(exitCode, 0, stdout + stderr)
  })
}

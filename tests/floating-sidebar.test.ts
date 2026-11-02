/** Floating sidebar intent and dismissal without mounting the workspace. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { floatingSidebarReducer as reduce } from '../src/renderer/src/hooks/useFloatingSidebar'

test('hover dismisses on leave, explicit opening stays and toggles closed on both sides', () => {
  for (const side of ['left', 'right'] as const) {
    const preview = reduce(null, { type: 'hover', side })
    assert.deepEqual(preview, { side, pinned: false })
    assert.equal(reduce(preview, { type: 'leave', side }), null)
    const pinned = reduce(preview, { type: 'toggle', side })
    assert.deepEqual(pinned, { side, pinned: true }, 'explicit opening pins an existing hover preview')
    assert.equal(reduce(pinned, { type: 'leave', side }), pinned)
    assert.equal(reduce(pinned, { type: 'hover', side: side === 'left' ? 'right' : 'left' }), pinned)
    assert.equal(reduce(pinned, { type: 'toggle', side }), null)
    assert.equal(reduce(pinned, { type: 'close' }), null)
  }
})

test('pinned sidebar ignores outside clicks and Escape until explicitly toggled closed', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useFloatingSidebar } = await import('../src/renderer/src/hooks/useFloatingSidebar')
  let floating!: ReturnType<typeof useFloatingSidebar>
  function Probe() {
    floating = useFloatingSidebar()
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const click = async (selector: string) => {
    const element = document.createElement('div')
    if (selector.startsWith('role=')) element.setAttribute('role', selector.slice(5))
    else if (selector) element.setAttribute(selector, '')
    document.body.append(element)
    await act(async () => element.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    element.remove()
  }
  try {
    await act(async () => root.render(createElement(Probe)))
    await act(async () => floating.toggle('right'))
    await act(async () => floating.leave('right'))
    assert.equal(floating.side, 'right')
    for (const selector of ['data-sidebar-overlay', 'data-sidebar-toggle', 'role=menu', 'role=dialog']) {
      await click(selector)
      assert.equal(floating.side, 'right')
    }
    await click('')
    assert.equal(floating.side, 'right')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(floating.side, 'right')
    await act(async () => floating.toggle('right'))
    assert.equal(floating.side, null)
    await act(async () => floating.toggle('left'))
    await click('')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(floating.side, 'left')
    await act(async () => floating.toggle('left'))
    assert.equal(floating.side, null)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    GlobalRegistrator.unregister()
  }
})

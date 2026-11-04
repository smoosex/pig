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

test('hover previews recover from window transitions while pinned sidebars stay open', async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement, useState } = await import('react')
  const { createPortal } = await import('react-dom')
  const { createRoot } = await import('react-dom/client')
  const { useFloatingSidebar } = await import('../src/renderer/src/hooks/useFloatingSidebar')
  const { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } =
    await import('../src/renderer/src/components/ui/context-menu')
  let floating!: ReturnType<typeof useFloatingSidebar>
  function Probe() {
    floating = useFloatingSidebar()
    const [renaming, setRenaming] = useState(false)
    return createElement('div', null, ...(['left', 'right'] as const).map(side =>
      createElement('div', {
        key: side,
        'data-testid': side,
        inert: floating.side !== side,
        onMouseMoveCapture: (event) => floating.trackPointer(side, event),
      },
      createElement(ContextMenu, null,
        createElement(ContextMenuTrigger, { id: `${side}-context-trigger` }, 'Sidebar content'),
        createElement(ContextMenuContent, null,
          createElement(ContextMenuItem, { onSelect: () => setRenaming(true) }, 'Rename session'),
        ),
      ),
      renaming ? createElement('input', { 'aria-label': 'Rename' }) : null,
      ...['project-dropdown', 'session-context-menu', 'history-popover'].map(kind =>
        createPortal(createElement('div', { 'data-testid': `${side}-${kind}` },
          createElement('button', { onClick: () => setRenaming(true) }, 'Rename'),
        ), document.body, `${side}-${kind}`),
      )),
    ))
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
    for (const side of ['left', 'right'] as const) {
      const sidebar = host.querySelector<HTMLElement>(`[data-testid="${side}"]`)!
      const child = sidebar.querySelector<HTMLElement>(`#${side}-context-trigger`)!
      await act(async () => floating.hover(side))
      await act(async () => child.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
      })))
      const menu = document.querySelector<HTMLElement>('[data-slot="context-menu-content"]')!
      assert.ok(menu, 'real Radix context menu opens')
      assert.equal(document.body.style.pointerEvents, 'none', 'modal menu disables background hit testing')
      // Chromium retargets the pointer away from the now-disabled sidebar on opening.
      await act(async () => child.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true, relatedTarget: document.documentElement,
      })))
      assert.equal(floating.side, side, 'opening a modal context menu must not collapse its sidebar')
      await act(async () => document.documentElement.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
      assert.equal(floating.side, side, 'disabled background hit testing is not a sidebar exit')
      await act(async () => menu.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
      assert.equal(floating.side, side, 'real context menu remains owned by the sidebar')
      await act(async () => menu.querySelector<HTMLElement>('[data-slot="context-menu-item"]')!.click())
      assert.equal(sidebar.inert, false, 'real menu rename action leaves sidebar accessible')
      const renameInput = sidebar.querySelector<HTMLInputElement>('input')!
      renameInput.focus()
      assert.equal(document.activeElement, renameInput)
      await act(async () => host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
      assert.equal(floating.side, null, 'normal dismissal resumes after the menu closes')
      const transitions = [
        () => document.dispatchEvent(new MouseEvent('mouseleave')),
        () => window.dispatchEvent(new Event('blur')),
        // Re-enter directly over content, without another sidebar leave event.
        () => host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })),
      ]
      for (const kind of ['project-dropdown', 'session-context-menu', 'history-popover']) {
        await act(async () => floating.hover(side))
        const overlay = document.querySelector(`[data-testid="${side}-${kind}"]`)!
        assert.equal(sidebar.contains(overlay), false, 'overlay is portaled outside the sidebar DOM')
        await act(async () => child.dispatchEvent(new MouseEvent('mouseout', {
          bubbles: true, relatedTarget: overlay,
        })))
        assert.equal(floating.side, side, 'entering an owned Portal is not leaving the React sidebar')
        await act(async () => overlay.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
        assert.equal(floating.side, side, `${kind} belongs to the sidebar`)
        await act(async () => overlay.querySelector('button')!.click())
        const input = sidebar.querySelector<HTMLInputElement>('input')!
        assert.equal(sidebar.inert, false, 'rename input remains accessible')
        input.focus()
        assert.equal(document.activeElement, input)
        await act(async () => input.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
        assert.equal(floating.side, side)
        await act(async () => host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
        assert.equal(floating.side, null, 'unrelated content still dismisses the preview')
      }
      for (const transition of transitions) {
        await act(async () => floating.hover(side))
        await act(async () => child.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
        assert.equal(floating.side, side, 'moving inside the preview keeps it open')
        await act(async () => transition())
        assert.equal(floating.side, null, 'window transitions dismiss hover previews')

        await act(async () => floating.toggle(side))
        await act(async () => transition())
        assert.equal(floating.side, side, 'window transitions preserve pinned sidebars')
        await act(async () => floating.toggle(side))
      }
    }
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

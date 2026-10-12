/**
 * Branch rows draw their own connector, so the sidebar reads as a tree. Each row is
 * its own containing block (the line is absolutely positioned inside it), and rows
 * past the accent only draw the muted spine.
 */
import { afterEach, describe, mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import { createElement as h } from 'react'

mock.module('../src/renderer/src/ipc/api', () => ({ api: {} }))

let domReady = false
let domOurs = false
async function ensureDom(): Promise<void> {
  if (domReady) return
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  try {
    GlobalRegistrator.register({ url: 'http://localhost' })
    domOurs = true
  } catch {
    domOurs = false
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  domReady = true
}

afterEach(async () => {
  if (!domReady || !domOurs) return
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  await GlobalRegistrator.unregister()
  domReady = false
  domOurs = false
})

const labelledRow = (item: unknown, index: number) =>
  h('span', null, `${String(item)}${index}`)

async function renderHookSidebar(props: {
  items: string[]
  value: number
  renderItem?: ((item: unknown, index: number) => ReactNode) | null
}) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { HookSidebar } = await import('../src/renderer/src/components/ui/hook-sidebar')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      h(HookSidebar, {
        items: props.items,
        value: props.value,
        railLeft: '1.5rem',
        renderItem: props.renderItem === undefined ? labelledRow : (props.renderItem ?? undefined)
      })
    )
  })
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
}

const linesOf = (root: Element) =>
  [...root.querySelectorAll('[data-slot="hook-sidebar-item"]')].map(
    (row) => row.querySelector('svg path')
  )

describe('hook sidebar tree lines', () => {
  test('every row is its own containing block for its line', async () => {
    await ensureDom()
    const { container, unmount } = await renderHookSidebar({ items: ['a', 'b'], value: 1 })
    try {
      const rows = [...container.querySelectorAll('[data-slot="hook-sidebar-item"]')]
      assert.equal(rows.length, 2)
      for (const row of rows) {
        assert.ok(
          row.classList.contains('relative'),
          'the absolutely positioned line must resolve against the row, not the list'
        )
      }
    } finally {
      await unmount()
    }
  })

  test('every row draws a line, accented down to the current one', async () => {
    await ensureDom()
    const { container, unmount } = await renderHookSidebar({
      items: ['a', 'b', 'c'],
      value: 1
    })
    try {
      const lines = linesOf(container)
      assert.equal(lines.length, 3, 'a row is never left without its connector')
      const accented = lines.map((path) => path?.parentElement?.getAttribute('style') ?? '')
      assert.ok(accented[0]?.includes('--primary'), 'rows above the active one are accented')
      assert.ok(accented[1]?.includes('--primary'), 'the active row is accented')
      assert.ok(!accented[2]?.includes('--primary'), 'rows below stay muted')
    } finally {
      await unmount()
    }
  })

  test('each row starts its run where the previous row stopped bending', async () => {
    await ensureDom()
    const { container, unmount } = await renderHookSidebar({
      items: ['a', 'b', 'c'],
      value: 0
    })
    try {
      const d = linesOf(container).map((path) => path?.getAttribute('d') ?? '')
      assert.ok(d[0]?.startsWith('M0.5 0V'), `first run reaches the list top: ${d[0]}`)
      // happy-dom reports zero heights, so later runs collapse to a bare bend
      assert.ok(d[1]?.includes('a6 6 0 0 0 6 6H12'), 'the bend is path-drawn')
    } finally {
      await unmount()
    }
  })

  test('the built-in rows get the same line as custom ones', async () => {
    await ensureDom()
    const { container, unmount } = await renderHookSidebar({
      items: ['a', 'b'],
      value: 0,
      renderItem: null
    })
    try {
      const rows = [...container.querySelectorAll('button[data-slot="hook-sidebar-item"]')]
      assert.equal(rows.length, 2, 'plain string items render the built-in buttons')
      for (const row of rows) {
        assert.ok(row.querySelector('svg path'), 'the built-in row draws its own connector')
      }
    } finally {
      await unmount()
    }
  })
})

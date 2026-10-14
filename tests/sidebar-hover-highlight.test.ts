/** The glass hover layer slides independently without tinting selection or transparent sticky gaps. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  highlightClipPath,
  subtractHighlightRect,
  type HighlightRect
} from '../src/renderer/src/components/ui/hover-highlight-clip'

const rect = (left: number, top: number, right: number, bottom: number): HighlightRect =>
  ({ left, top, right, bottom })

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { SidebarHoverHighlight } = await import('../src/renderer/src/components/sidebar/SidebarHoverHighlight')
  const { sidebarRowSurface } = await import('../src/renderer/src/components/sidebar/sidebar-surface')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let pointer: HTMLElement | null = null
  document.elementFromPoint = () => pointer
  const hover = async (row: HTMLElement) => {
    pointer = row
    await act(async () => {
      row.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, clientX: 30, clientY: 30 }))
    })
  }
  const row = (id: string, selected: boolean) => h('button', {
    key: id,
    'data-id': id,
    'data-sidebar-hover-row': '',
    'data-sidebar-selected': selected || undefined,
    className: sidebarRowSurface(selected)
  }, id)
  try {
    const renderRows = async (selected: string) => {
      await act(async () => {
        root.render(h(SidebarHoverHighlight, null, row('first', selected === 'first'), row('second', selected === 'second')))
      })
    }
    await renderRows('first')
    const first = host.querySelector<HTMLElement>('[data-id=first]')!
    const second = host.querySelector<HTMLElement>('[data-id=second]')!
    const layer = host.querySelector<HTMLElement>('[data-hover-highlight-clip]')!
    const area = layer.parentElement!
    area.getBoundingClientRect = () => new window.DOMRect(10, 20, 100, 50)
    first.getBoundingClientRect = () => new window.DOMRect(10, 20, 100, 24)
    second.getBoundingClientRect = () => new window.DOMRect(10, 46, 100, 24)
    const tint = layer.querySelector('span')!
    assert.ok(tint.classList.contains('bg-sidebar-foreground/6'))
    assert.ok(!tint.className.includes('backdrop-blur'))
    assert.ok(layer.classList.contains('pointer-events-none'))
    assert.ok(second.classList.contains('hover:bg-transparent!'))

    await hover(second)
    assert.ok(second.hasAttribute('data-sidebar-hover-target'))
    const firstCutout = highlightClipPath(area.getBoundingClientRect(), [first.getBoundingClientRect()])
    assert.equal(layer.style.clipPath, firstCutout)
    await hover(first)
    assert.ok(first.hasAttribute('data-sidebar-hover-target'))
    assert.ok(!second.hasAttribute('data-sidebar-hover-target'))
    assert.ok(first.classList.contains('bg-sidebar-foreground/12'), 'hover never clears selection')
    assert.equal(layer.style.clipPath, firstCutout, 'selection stays excluded even while the hover layer moves')

    await renderRows('second')
    assert.equal(layer.style.clipPath,
      highlightClipPath(area.getBoundingClientRect(), [second.getBoundingClientRect()]),
      'selection changes refresh cutouts without needing another pointer event')
    assert.ok(second.classList.contains('bg-sidebar-foreground/12'))
    assert.ok(!first.classList.contains('bg-sidebar-foreground/12'))

    await act(async () => {
      root.render(h('div', { 'data-scroll': '' }, h(SidebarHoverHighlight, null,
        h('div', { 'data-section': '' },
          h('div', { 'data-sidebar-hover-occlusion': '' }, row('header', false)),
          h('div', null, row('selected', true), row('file', false))
        )
      )))
    })
    const header = host.querySelector<HTMLElement>('[data-sidebar-hover-occlusion]')!
    const title = host.querySelector<HTMLElement>('[data-id=header]')!
    const selected = host.querySelector<HTMLElement>('[data-id=selected]')!
    const file = host.querySelector<HTMLElement>('[data-id=file]')!
    const clipped = host.querySelector<HTMLElement>('[data-hover-highlight-clip]')!
    const content = clipped.parentElement!
    let scroll = 0
    content.getBoundingClientRect = () => new window.DOMRect(10, 20 - scroll, 100, 100)
    header.getBoundingClientRect = () => new window.DOMRect(10, 20, 100, 30)
    title.getBoundingClientRect = () => new window.DOMRect(14, 20, 92, 28)
    selected.getBoundingClientRect = () => new window.DOMRect(10, 50 - scroll, 100, 24)
    file.getBoundingClientRect = () => new window.DOMRect(10, 76 - scroll, 100, 24)

    await hover(file)
    assert.equal(clipped.style.clipPath, highlightClipPath(content.getBoundingClientRect(), [
      selected.getBoundingClientRect(), header.getBoundingClientRect()
    ]), 'file hover is clipped out of the title and its 2px gap')
    scroll = 12
    await act(async () => {
      host.querySelector('[data-scroll]')!.dispatchEvent(new window.Event('scroll'))
    })
    const visibleSelection = rect(10, 50, 110, 62)
    assert.equal(clipped.style.clipPath, highlightClipPath(content.getBoundingClientRect(), [
      visibleSelection, header.getBoundingClientRect()
    ]), 'scroll refreshes the pinned title and the visible part of selection')

    await hover(title)
    assert.equal(clipped.style.clipPath, highlightClipPath(content.getBoundingClientRect(), [
      visibleSelection,
      ...subtractHighlightRect(header.getBoundingClientRect(), title.getBoundingClientRect())
    ]), 'the title can hover without hidden selection cutting into it; its gap remains excluded')
    assert.ok(title.hasAttribute('data-sidebar-hover-target'))
    assert.ok(!title.hasAttribute('data-sidebar-selected'), 'expanded titles are not selections')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else {
  test('highlight exclusions form a union instead of revealing overlapping cutouts', () => {
    assert.equal(highlightClipPath(rect(0, 0, 100, 100), [
      rect(10, 10, 70, 70), rect(40, 40, 90, 90)
    ]), 'path(evenodd, "M0 0H100V100H0Z M10 10H70V70H10Z M40 70H90V90H40Z M70 40H90V70H70Z")')
  })

  test('highlight cutouts are bounded and relative to the scrolling container', () => {
    const area = rect(100, 200, 200, 300)
    assert.equal(highlightClipPath(area, [rect(80, 220, 150, 260), rect(180, 190, 220, 210)]),
      'path(evenodd, "M0 0H100V100H0Z M0 20H50V60H0Z M80 0H100V10H80Z")')
    assert.equal(highlightClipPath(area, []), '')
    assert.equal(highlightClipPath(area, [rect(0, 0, 50, 50)]), '')
  })

  test('revealing the title keeps the 2px sticky gap excluded', () => {
    assert.deepEqual(subtractHighlightRect(rect(0, 0, 100, 30), rect(4, 0, 96, 28)), [
      rect(0, 28, 100, 30), rect(0, 0, 4, 28), rect(96, 0, 100, 28)
    ])
  })

  test('glass hover keeps selection at 12% and respects transparent sticky titles', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 6000)
    try {
      const [code, output, errors] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, `${output}\n${errors}`)
    } finally {
      clearTimeout(timer)
    }
  })
}

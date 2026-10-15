/**
 * A row that appears while the dialog hosting it is still zooming in is measured through the
 * scale transform, so the layer comes out 5% short. Transforms never reach a ResizeObserver, so
 * the layer has to re-measure when its region or an ancestor stops animating. Unrelated overlays
 * and descendants must not interrupt an in-flight glide.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let clock = 1000
  let frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  }
  const cancelFrame = (id: number) => { frames.delete(id) }
  Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
  Object.assign(window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
  Object.defineProperty(performance, 'now', { value: () => clock })
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
  Object.assign(window, { ResizeObserver: NoopResizeObserver })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { SmoothHoverHighlight } = await import('../src/renderer/src/components/ui/smooth-hover-highlight')
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
  const advance = async (milliseconds: number) => {
    await act(async () => {
      clock += milliseconds
      const batch = [...frames.values()]
      frames.clear()
      for (const callback of batch) callback(clock)
    })
  }
  const endAnimation = async (element: Element) => {
    await act(async () => {
      clock += 1
      element.dispatchEvent(new window.Event('animationend', { bubbles: true }))
    })
    await advance(0)
  }
  const widthOf = (element: HTMLElement): number => Number.parseFloat(element.style.width)
  const row = (id: string) => h('button', {
    key: id,
    'data-id': id,
    'data-hover-highlight-row': ''
  }, id)
  try {
    await act(async () => {
      root.render(h('div', { 'data-dialog': '' },
        h(SmoothHoverHighlight, null, row('first'), row('second')),
        h('div', { 'data-overlay': 'tooltip' }),
        h('div', { 'data-overlay': 'popover' })
      ))
    })
    const first = host.querySelector<HTMLElement>('[data-id=first]')!
    const second = host.querySelector<HTMLElement>('[data-id=second]')!
    const tint = host.querySelector<HTMLElement>('span')!
    const area = tint.parentElement!
    const dialog = host.querySelector<HTMLElement>('[data-dialog]')!
    assert.ok(!first.hasAttribute('data-hover-highlight-target'), 'nothing is hovered before the pointer arrives')

    // Every rect is 95% of its final size while the dialog zooms in from zoom-in-95.
    let scale = 0.95
    first.getBoundingClientRect = () => new window.DOMRect(10 * scale, 20, 100 * scale, 24 * scale)
    await hover(first)
    await advance(16)
    assert.equal(widthOf(tint), 95, 'the first measure runs through the transform')
    scale = 1
    await endAnimation(dialog)
    assert.equal(widthOf(tint), 100, 'the layer re-measures the row once its ancestor stops animating')

    await advance(200)
    assert.equal(Number.parseFloat(tint.style.opacity), 1, 'the next hover should glide, not jump from invisible')
    second.getBoundingClientRect = () => new window.DOMRect(10, 80, 200, 24)
    await hover(second)
    await advance(16)
    await advance(32)
    const midGlide = widthOf(tint)
    assert.ok(midGlide > 100 && midGlide < 200, 'the layer is still moving toward the second row')

    for (const overlay of host.querySelectorAll<HTMLElement>('[data-overlay]')) {
      await endAnimation(overlay)
      assert.ok(widthOf(tint) >= midGlide && widthOf(tint) < 200, `${overlay.dataset.overlay} animation must not snap the glide`)
    }
    await endAnimation(second)
    assert.ok(widthOf(tint) >= midGlide && widthOf(tint) < 200, 'a descendant animation must not snap the glide either')
    await advance(16)
    assert.ok(widthOf(tint) > midGlide && widthOf(tint) < 200, 'the glide keeps running after unrelated events')

    await endAnimation(dialog)
    assert.equal(widthOf(tint), 200, 'an ancestor animation still re-measures the current target immediately')
    second.getBoundingClientRect = () => new window.DOMRect(10, 80, 220, 24)
    await endAnimation(area)
    assert.equal(widthOf(tint), 220, 'an animation on the highlight region itself also re-measures')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--fixture')) await fixture()
else {
  test('the hover layer only re-measures when its region or an ancestor stops animating', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 8000)
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

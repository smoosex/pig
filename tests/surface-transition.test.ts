/** The opacity barrier waits for real background transitions and paint, not a hard-coded delay. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  const { waitForSurfacePaint } = await import('../src/renderer/src/lib/surface-transition')
  let visibility: DocumentVisibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const surface = document.createElement('div')
  surface.setAttribute('data-app-surface', '')
  document.body.append(surface)
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  globalThis.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  const tick = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(0)
  }
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  const transition = () => {
    let resolve!: () => void
    const animation = {
      transitionProperty: 'background-color',
      playState: 'running',
      finished: new Promise<void>((done) => { resolve = done }),
      finish: () => { animation.playState = 'finished'; resolve() }
    }
    return animation
  }
  const first = transition()
  let animations = [first]
  surface.getAnimations = () => animations as unknown as Animation[]
  const controller = new AbortController()
  try {
    if (name === 'paint') {
      const second = transition()
      let completed = false
      const waiting = waitForSurfacePaint(controller.signal)!.then(() => { completed = true })
      assert.equal(frames.size, 0, 'native removal cannot start while background is translucent')
      // A palette change can replace a transition while a surface switch is in progress.
      animations = [second]
      first.finish()
      await flush()
      assert.equal(frames.size, 0, 'replaced background transitions must also finish')
      second.finish()
      await flush()
      assert.equal(frames.size, 1)
      tick()
      await flush()
      assert.equal(completed, false, 'animation completion alone does not mean its final frame painted')
      tick()
      await waiting
      assert.equal(completed, true)
    } else if (name === 'cancel') {
      const waiting = waitForSurfacePaint(controller.signal)!
      controller.abort()
      await waiting
      assert.equal(frames.size, 0)
      animations = []
      const next = new AbortController()
      const paint = waitForSurfacePaint(next.signal)!
      assert.equal(frames.size, 1)
      next.abort()
      await paint
      assert.equal(frames.size, 0, 'reversal also cancels pending paint frames')
    } else if (name === 'reduced') {
      animations = []
      const waiting = waitForSurfacePaint(controller.signal)!
      assert.equal(frames.size, 1, 'immediate/reduced-motion changes still need a paint barrier')
      tick()
      assert.equal(frames.size, 1)
      tick()
      await waiting
    } else if (name === 'hidden') {
      const waiting = waitForSurfacePaint(controller.signal)!
      visibility = 'hidden'
      document.dispatchEvent(new window.Event('visibilitychange'))
      await waiting
      assert.equal(first.playState, 'finished', 'hidden windows snap the opaque background instead of blocking writes')
      assert.equal(frames.size, 0)
    }
  } finally {
    surface.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--fixture') await fixture(process.argv[3])
else {
  for (const [name, title] of Object.entries({
    paint: 'waits for current background transitions and their painted final frame',
    cancel: 'rapid reversals release animation and RAF barriers',
    reduced: 'reduced motion paints immediately without an animation delay',
    hidden: 'hidden windows do not strand preference writes behind suspended RAF'
  })) {
    test(`surface transition: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--fixture', name], { stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill(), 6000)
      try {
        const [code, output, errors] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(code, 0, `${output}\n${errors}`)
      } finally {
        clearTimeout(timeout)
      }
    })
  }
}

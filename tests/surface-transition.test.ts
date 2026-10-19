/** The opacity barrier waits for real background transitions and paint, not a hard-coded delay. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  const { applySurfaceStyle, setSurfaceRevealOrigin, waitForSurfacePaint } = await import('../src/renderer/src/lib/surface-transition')
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
    } else if (name === 'directions') {
      const root = document.documentElement
      root.dataset.surfaceStyle = 'glass'
      const control = document.createElement('button')
      control.getBoundingClientRect = () => new DOMRect(10, 20, 24, 24)
      const motions: { frames: PropertyIndexedKeyframes; options: KeyframeAnimationOptions }[] = []
      root.animate = ((frames: PropertyIndexedKeyframes, options: KeyframeAnimationOptions) => {
        motions.push({ frames, options })
        return {} as Animation
      }) as typeof root.animate
      let finish!: () => void
      Object.assign(document, {
        startViewTransition: (update: () => void) => {
          update()
          return {
            ready: Promise.resolve(),
            finished: new Promise<void>((done) => { finish = done }),
            skipTransition: () => finish()
          }
        }
      })
      for (const style of ['solid', 'glass'] as const) {
        motions.length = 0
        setSurfaceRevealOrigin(control)
        applySurfaceStyle(root, style)
        await flush()
        assert.equal(root.dataset.surfaceReveal, style, 'the clip and inverse mask follow the target material')
        assert.equal(root.style.getPropertyValue('--surface-reveal-x'), '22px')
        assert.equal(root.style.getPropertyValue('--surface-reveal-y'), '32px')
        assert.deepEqual(motions.map(({ options }) => options.pseudoElement), ['::view-transition-old(root)', '::view-transition-new(root)'])
        for (const { frames, options } of motions) {
          const radii = frames['--surface-reveal-radius'] as string[]
          const [start, end] = radii.map(parseFloat)
          if (style === 'solid') {
            assert.equal(start, 0)
            assert.ok(end > 0, 'solid expands from the toggle')
          } else {
            assert.ok(start > 0, 'glass begins with the old solid covering the window')
            assert.equal(end, 0, 'solid contracts to the toggle when switching to glass')
          }
          assert.equal(options.duration, 500)
        }
        finish()
        await flush()
        assert.equal(root.dataset.surfaceReveal, undefined)
      }
    } else if (name === 'reveal') {
      animations = []
      const root = document.documentElement
      root.dataset.surfaceStyle = 'glass'
      const reveals: { update: () => void; finish: () => void }[] = []
      Object.assign(document, {
        startViewTransition: (update: () => void) => {
          let finish!: () => void
          reveals.push({ update, finish: () => finish() })
          return { ready: new Promise(() => {}), finished: new Promise<void>((done) => { finish = done }), skipTransition: () => {} }
        }
      })
      applySurfaceStyle(root, 'solid')
      applySurfaceStyle(root, 'solid')
      assert.equal(reveals.length, 1, 'a repeated request joins the pending reveal')
      assert.equal(root.dataset.surfaceStyle, 'glass', 'the old snapshot is taken before the style changes')
      let completed = false
      const waiting = waitForSurfacePaint(controller.signal)!.then(() => { completed = true })
      applySurfaceStyle(root, 'glass')
      applySurfaceStyle(root, 'solid')
      reveals[0].update()
      assert.equal(root.dataset.surfaceStyle, 'solid', 'a superseded reveal applies the latest choice')
      reveals[0].finish()
      await flush()
      assert.equal(frames.size, 0, 'native removal waits for the reveal that is still running')
      reveals.at(-1)!.update()
      reveals.at(-1)!.finish()
      await flush()
      assert.equal(root.dataset.surfaceReveal, undefined)
      tick()
      await flush()
      tick()
      await waiting
      assert.equal(completed, true)
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
    reveal: 'the circular reveal changes style inside its snapshot and holds the native material until it ends',
    directions: 'solid expands and glass contracts around the toggle with complementary snapshots',
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

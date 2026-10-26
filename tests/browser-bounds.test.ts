/** Isolated Happy DOM + real React hook; native IPC and the paint clock are the only stand-ins. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { BrowserBounds } from '../src/shared/browser'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(scenario: string) {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  const request = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }
  const cancel = (id: number) => { frames.delete(id) }
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, 'requestAnimationFrame', { configurable: true, value: request })
    Object.defineProperty(target, 'cancelAnimationFrame', { configurable: true, value: cancel })
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    observe() {} unobserve() {} disconnect() {}
  } })

  const image = 'data:image/jpeg;base64,YWJj'
  const calls: (BrowserBounds | null)[] = []
  const freezes: { frame: string | null; signal: AbortSignal }[] = []
  const errors: unknown[] = []
  let native: BrowserBounds | null = null
  let still: string | null = null
  let snapshots = 0
  let snapshot: () => Promise<string> = async () => image
  let write: (bounds: BrowserBounds | null) => Promise<void> = async () => {}
  let freeze: (frame: string | null, signal: AbortSignal) => Promise<void> = async () => {}
  Object.defineProperty(window, 'api', { configurable: true, value: { browser: {
    snapshot: async () => { snapshots++; return snapshot() },
    setBounds: async (_id: string, bounds: BrowserBounds | null) => {
      calls.push(bounds)
      await write(bounds)
      native = bounds
    }
  } } })
  const { act, createElement, useRef } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useBrowserBounds } = await import('../src/renderer/src/components/browser/useBrowserBounds')
  const report = (error: unknown) => { errors.push(error) }
  const onFreeze = async (frame: string | null, signal: AbortSignal) => {
    freezes.push({ frame, signal })
    await freeze(frame, signal)
    if (!signal.aborted) still = frame
  }
  function Probe() {
    const viewport = useRef<HTMLDivElement>(null)
    useBrowserBounds('bounds-probe', true, viewport, report, onFreeze)
    const content = createElement('div', { ref: (node: HTMLDivElement | null) => {
      viewport.current = node
      if (node) node.getBoundingClientRect = () => new DOMRect(100, 100, 400, 300)
    } })
    return scenario === 'split-corners' ? createElement('div', {
      'data-split-pane': 'true',
      style: { border: '1px solid', borderRadius: '8px' },
      ref: (node: HTMLDivElement | null) => {
        if (node) node.getBoundingClientRect = () => new DOMRect(99, 70, 402, 331)
      }
    }, content) : content
  }
  const container = document.createElement('div')
  let surfaceLeft = 100
  if (scenario === 'corners' || scenario === 'split-corners') {
    container.setAttribute('data-content-surface', '')
    container.style.borderRadius = '12px'
    container.getBoundingClientRect = () => new DOMRect(surfaceLeft, 50, 500 - surfaceLeft, 350)
  }
  document.body.append(container)
  const root = createRoot(container)
  const drain = async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  const paint = async () => {
    await drain()
    const pending = [...frames.values()]
    frames.clear()
    await act(async () => { for (const callback of pending) callback(performance.now()) })
    await drain()
  }
  const settle = async () => { for (let i = 0; i < 6; i++) await paint() }
  const hideCount = () => calls.filter(bounds => bounds === null).length
  const clearCount = () => freezes.filter(entry => entry.frame === null).length
  const overlay = () => {
    const element = document.createElement('div')
    element.setAttribute('data-slot', 'popover-content')
    element.setAttribute('data-state', 'open')
    element.getBoundingClientRect = () => new DOMRect(150, 150, 100, 80)
    document.body.append(element)
    return element
  }

  try {
    await act(async () => { root.render(createElement(Probe)) })
    await settle()
    assert.equal(calls.at(-1)?.width, 400, 'the real hook initially shows the native viewport')
    calls.length = 0
    freezes.length = 0

    if (scenario === 'split-corners') {
      assert.equal((native as BrowserBounds | null)?.bottomLeftRadius, 7, 'the pane border reduces the inner corner radius')
      assert.equal((native as BrowserBounds | null)?.bottomRightRadius, 7)
      const viewport = container.querySelector('[data-split-pane]')!.firstElementChild as HTMLElement
      assert.equal(viewport.style.borderBottomLeftRadius, '7px', 'the frozen frame uses the same pane corners')
      assert.equal(viewport.style.borderBottomRightRadius, '7px')
    } else if (scenario === 'corners') {
      assert.equal((native as BrowserBounds | null)?.bottomLeftRadius, 12)
      assert.equal((native as BrowserBounds | null)?.bottomRightRadius, 12)
      assert.equal(container.firstElementChild?.getAttribute('style')?.includes('12px'), true)
      surfaceLeft = 50
      window.dispatchEvent(new Event('resize'))
      await settle()
      assert.equal((native as BrowserBounds | null)?.bottomLeftRadius, 0, 'an internal split edge stays square')
      assert.equal((native as BrowserBounds | null)?.bottomRightRadius, 12)
      assert.equal((container.firstElementChild as HTMLElement).style.borderBottomLeftRadius, '0px')
      assert.equal((container.firstElementChild as HTMLElement).style.borderBottomRightRadius, '12px')
    } else if (scenario === 'wrapper') {
      const wrapper = document.createElement('div')
      wrapper.setAttribute('data-radix-popper-content-wrapper', '')
      wrapper.getBoundingClientRect = () => new DOMRect(100, 100, 400, 300)
      document.body.append(wrapper)
      await settle()
      assert.equal(hideCount(), 0, 'a positioning wrapper is not itself an occluder')
      assert.equal(snapshots, 0)
      const content = overlay()
      wrapper.append(content)
      let overlaps = false
      content.getBoundingClientRect = () => new DOMRect(overlaps ? 150 : 700, 150, 100, 80)
      await settle()
      assert.equal(hideCount(), 0, 'actual content outside the viewport does not hide it')
      overlaps = true
      wrapper.style.transform = 'translate(10px, 0)'
      await settle()
      assert.equal(hideCount(), 1, 'wrapper style mutations must remeasure actual content')
      assert.equal(still, image)
      assert.equal(native, null)
      wrapper.remove()
    } else if (scenario === 'animated-menu') {
      const content = overlay()
      content.setAttribute('role', 'menu')
      let overlaps = false
      let running = true
      content.getBoundingClientRect = () => new DOMRect(150, overlaps ? 30 : 15, 100, 80)
      content.getAnimations = () => running ? [{ playState: 'running' } as Animation] : []
      await settle()
      assert.equal(hideCount(), 0, 'the entering menu initially ends above the split page')
      overlaps = true
      await settle()
      assert.equal(hideCount(), 1, 'animation movement alone must trigger a fresh intersection check')
      assert.equal(still, image)
      assert.equal(native, null)
      running = false
      await settle()
      assert.equal(frames.size, 0, 'no polling remains once the overlay animation stops')
      content.remove()
      await settle()
      assert.ok(native)
    } else if (scenario === 'split-preview') {
      // The pane drop preview is DOM; a native page above it would hide where the tab lands.
      const preview = document.createElement('div')
      preview.setAttribute('data-split-drop-preview', '')
      preview.getBoundingClientRect = () => new DOMRect(300, 100, 200, 300)
      document.body.append(preview)
      await settle()
      assert.equal(hideCount(), 1)
      assert.equal(still, image)
      preview.remove()
      await settle()
      assert.equal((native as BrowserBounds | null)?.width, 400)
    } else if (scenario === 'devtools') {
      // A zero-height marker inside the viewport: the native DevTools take what lies below it.
      const viewport = container.firstElementChild as HTMLElement
      const divider = document.createElement('div')
      divider.setAttribute('data-devtools-divider', '')
      let top = 250
      divider.getBoundingClientRect = () => new DOMRect(100, top, 400, 0)
      viewport.append(divider)
      await settle()
      assert.deepEqual((native as BrowserBounds | null)?.devtools, { height: 150 })
      top = 200
      divider.style.setProperty('--devtools-ratio', '0.66')
      await settle()
      assert.deepEqual((native as BrowserBounds | null)?.devtools, { height: 200 }, 'a new ratio on the marker remeasures')
      divider.remove()
      await settle()
      assert.equal((native as BrowserBounds | null)?.devtools, undefined)
    } else if (scenario === 'invisible') {
      const content = overlay()
      content.style.opacity = '0'
      await settle()
      assert.equal(hideCount(), 0, 'opacity-zero content must not hide the native view')
      content.hidden = true
      content.style.opacity = '1'
      await settle()
      assert.equal(hideCount(), 0, 'hidden content is not an occluder')
      content.hidden = false
      content.setAttribute('data-state', 'closed')
      await settle()
      assert.equal(hideCount(), 0, 'closed content is not an occluder')
      content.setAttribute('data-state', 'open')
      content.style.visibility = 'hidden'
      await settle()
      assert.equal(hideCount(), 0, 'visibility-hidden content is not an occluder')
      content.style.visibility = 'visible'
      await settle()
      assert.equal(hideCount(), 1, 'visible overlapping content does hide the native view')
    } else if (scenario === 'freeze-barrier') {
      const ready = deferred<void>()
      freeze = async frame => { if (frame !== null) await ready.promise }
      overlay()
      await settle()
      assert.equal(snapshots, 1)
      assert.equal(freezes.length, 1)
      assert.equal(freezes[0]!.frame, image)
      assert.ok(freezes[0]!.signal instanceof AbortSignal)
      assert.equal(hideCount(), 0, 'native view stays visible while decoding/mounting/painting the still')
      assert.ok(native)
      ready.resolve()
      await settle()
      assert.equal(still, image)
      assert.equal(hideCount(), 1, 'hide follows the fulfilled onFreeze paint barrier')
      assert.equal(native, null)
    } else if (scenario === 'stale-snapshot') {
      const capture = deferred<string>()
      snapshot = () => capture.promise
      const content = overlay()
      await settle()
      assert.equal(snapshots, 1)
      assert.equal(hideCount(), 0)
      content.remove()
      await paint()
      capture.resolve(image)
      await settle()
      assert.equal(hideCount(), 0, 'a completed obsolete snapshot must never hide the restored viewport')
      assert.equal(freezes.filter(entry => entry.frame !== null).length, 0, 'obsolete captures must not mount a still')
      assert.ok(native)
      assert.equal(still, null)
    } else if (scenario === 'restore-paint') {
      const content = overlay()
      await settle()
      assert.equal(still, image)
      assert.equal(native, null)
      const clears = clearCount()
      content.remove()
      await paint() // Layout update + successful native restore, but no subsequent paint yet.
      assert.ok(native, 'native bounds are restored before clearing the placeholder')
      assert.equal(still, image)
      assert.equal(clearCount(), clears, 'setBounds success alone must not clear the still')
      const again = overlay()
      await paint()
      await settle()
      assert.equal(clearCount(), clears, 'a reblocked obsolete restore must not clear the still')
      assert.equal(native, null)
      assert.equal(still, image)
      again.remove()
      await paint()
      assert.equal(still, image)
      await paint()
      assert.equal(still, image, 'one RAF is not the two-frame paint barrier')
      await paint()
      await settle()
      assert.ok(native)
      assert.equal(still, null, 'a current restore clears the still after painting')
      assert.equal(clearCount(), clears + 1)
    } else if (scenario === 'frame-readiness') {
      const { decodeBrowserFrame, waitForBrowserPaint } = await import('../src/renderer/src/components/browser/browser-frame')
      const originalImage = globalThis.Image
      let decoded = deferred<void>()
      Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
        src = ''
        decode() { return decoded.promise }
      } })
      try {
        let ready = false
        const decoding = decodeBrowserFrame(image, new AbortController().signal).then(() => { ready = true })
        await drain()
        assert.equal(ready, false, 'a frame cannot be committed before image decoding finishes')
        decoded.resolve()
        await decoding
        assert.equal(ready, true)
        decoded = deferred<void>()
        const cancelled = new AbortController()
        const pending = decodeBrowserFrame(image, cancelled.signal)
        cancelled.abort()
        await pending
        decoded.reject(new Error('late discarded decode failure'))
        await drain()
        decoded = deferred<void>()
        const decodeError = new Error('invalid snapshot image')
        const invalid = decodeBrowserFrame(image, new AbortController().signal)
        const rejection = assert.rejects(invalid, error => error === decodeError)
        decoded.reject(decodeError)
        await rejection
      } finally {
        Object.defineProperty(globalThis, 'Image', { configurable: true, value: originalImage })
      }
      const controller = new AbortController()
      let painted = false
      const pendingPaint = waitForBrowserPaint(controller.signal).then(() => { painted = true })
      await paint()
      assert.equal(painted, false)
      controller.abort()
      await pendingPaint
      assert.equal(frames.size, 0, 'cancellation releases suspended RAF callbacks')
      let hidden = false
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
      painted = false
      const backgroundPaint = waitForBrowserPaint(new AbortController().signal).then(() => { painted = true })
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      await backgroundPaint
      assert.equal(painted, true, 'a hidden window cannot strand the native bounds queue')
      assert.equal(frames.size, 0)
      await waitForBrowserPaint(new AbortController().signal)
      assert.equal(frames.size, 0, 'an already-hidden window does not schedule RAF')
    } else if (scenario === 'failures-retry') {
      const captureError = new Error('snapshot unavailable')
      const boundsError = new Error('native bounds rejected')
      snapshot = async () => { throw captureError }
      let rejectHide = true
      write = async bounds => {
        if (bounds === null && rejectHide) { rejectHide = false; throw boundsError }
      }
      const content = overlay()
      await settle()
      assert.equal(hideCount(), 1, 'snapshot failure must still attempt mandatory hiding')
      assert.ok(native, 'a rejected bounds write did not hide the native view')
      assert.ok(errors.includes(captureError), 'snapshot failure is reported even if hiding also fails')
      assert.ok(errors.includes(boundsError), 'bounds failure is reported')
      window.dispatchEvent(new Event('resize'))
      await settle()
      assert.equal(hideCount(), 2, 'failed native bounds must not cache the target as applied')
      assert.equal(native, null, 'same-layout resize retries and successfully hides despite snapshot failure')
      snapshot = async () => image
      let rejectShow = true
      write = async bounds => {
        if (bounds && rejectShow) { rejectShow = false; throw boundsError }
      }
      content.remove()
      await settle()
      assert.equal(native, null)
      const shows = calls.filter(Boolean).length
      window.dispatchEvent(new Event('resize'))
      await settle()
      assert.equal(calls.filter(Boolean).length, shows + 1, 'failed restores also permit same-layout retries')
      assert.ok(native)
    } else {
      throw new Error(`Unknown scenario: ${scenario}`)
    }
  } finally {
    await act(async () => { root.unmount() })
    await drain()
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

const scenarios = {
  corners: 'native bounds and frozen frame inherit only the outer panel bottom corners',
  'split-corners': 'native bounds and frozen frame use the split pane inner bottom corners',
  wrapper: 'positioning wrapper is ignored but its style remeasures real overlapping content',
  'animated-menu': 'an entering menu crossing into a split page is remeasured without DOM mutations',
  'split-preview': 'the split drop preview over a page swaps it for its still until the drag leaves',
  devtools: 'docked DevTools take the viewport below their marker and follow it when it moves',
  invisible: 'transparent, hidden and closed overlays do not occlude the viewport',
  'freeze-barrier': 'hide awaits the asynchronous still-frame paint barrier',
  'stale-snapshot': 'an obsolete snapshot cannot hide the viewport',
  'restore-paint': 'restore retains the still until two paints and never clears it after reblocking',
  'failures-retry': 'snapshot failure still hides/reports and rejected bounds can retry unchanged layout',
  'frame-readiness': 'frame decoding, cancellation and hidden windows release paint barriers without swallowing failures'
}

if (process.argv[2] === '--browser-bounds-fixture') {
  await fixture(process.argv[3]!)
} else {
  for (const [scenario, description] of Object.entries(scenarios)) {
    test(`browser bounds: ${description}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--browser-bounds-fixture', scenario], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 8_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 10_000)
  }
}

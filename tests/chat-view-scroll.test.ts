import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DisplayTurn } from '../src/renderer/src/ipc/api'

const VIEWPORT_HEIGHT = 240
const VIEWPORT_TOP = 37
const TURN_ALIGN = 12

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { mock } = await import('bun:test')

  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, { due: number; callback: () => void }>()
  const scrollEvents = new Set<HTMLElement>()
  const positions = new WeakMap<HTMLElement, number>()
  const writes: Array<{ element: HTMLElement; top: number }> = []
  let nextId = 1
  let clock = 0
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = nextId++
    frames.set(id, callback)
    return id
  }
  const cancelFrame = (id: number) => { frames.delete(id) }
  Object.assign(window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
  Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
  window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = nextId++
    timers.set(id, { due: clock + delay, callback })
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = (id) => { timers.delete(Number(id)) }

  const isViewport = (element: HTMLElement) =>
    element.dataset.slot === 'message-scroller-viewport'
  const hidden = (element: HTMLElement) => element.hidden || element.style.display === 'none'
  const absolute = (element: HTMLElement) =>
    ['absolute', 'fixed'].includes(element.style.position) ||
    element.classList.contains('absolute') || element.classList.contains('fixed')
  const pixels = (value: string) => Number.parseFloat(value) || 0
  const spacing = (element: HTMLElement, prefix: string) => {
    const token = [...element.classList].findLast((value) => new RegExp(`^${prefix}-[\\d.]+$`).test(value))
    return token ? pixels(token.slice(prefix.length + 1)) * 4 : 0
  }
  const paddingTop = (element: HTMLElement) =>
    pixels(element.style.paddingTop) || spacing(element, 'pt') || spacing(element, 'py')
  const paddingBottom = (element: HTMLElement) =>
    pixels(element.style.paddingBottom) || spacing(element, 'pb') || spacing(element, 'py')
  const children = (element: HTMLElement) => [...element.children] as HTMLElement[]
  const flowChildren = (element: HTMLElement) => children(element).filter((child) => !hidden(child) && !absolute(child))
  const heightOf = (element: HTMLElement): number => {
    if (hidden(element)) return 0
    if (isViewport(element)) return VIEWPORT_HEIGHT
    if (/^\d+(?:\.\d+)?px$/.test(element.style.height)) return pixels(element.style.height)
    if (element.dataset.height !== undefined) return Number(element.dataset.height)
    const fixedHeight = spacing(element, 'h')
    if (fixedHeight) return fixedHeight
    const flow = flowChildren(element)
    const height = flow.reduce((sum, child) => sum + heightOf(child), 0) +
      Math.max(0, flow.length - 1) * spacing(element, 'gap') + paddingTop(element) + paddingBottom(element)
    return element.dataset.slot === 'message-scroller-content' ? Math.max(VIEWPORT_HEIGHT, height) : height
  }
  const translateY = (element: HTMLElement) => {
    const transform = element.style.transform
    const match = transform.match(/translateY\(([-\d.]+)px\)/) ??
      transform.match(/translate(?:3d)?\([^,]+,\s*([-\d.]+)px/)
    return match ? Number(match[1]) : 0
  }
  const offsetOf = (element: HTMLElement): number => {
    if (absolute(element)) return pixels(element.style.top) + translateY(element)
    const parent = element.parentElement
    if (!parent) return 0
    let offset = paddingTop(parent)
    for (const child of flowChildren(parent)) {
      if (child === element) break
      offset += heightOf(child) + spacing(parent, 'gap')
    }
    return offset + translateY(element)
  }
  const topOf = (element: HTMLElement): number => {
    if (isViewport(element)) return VIEWPORT_TOP
    const parent = element.parentElement
    return parent ? topOf(parent) + offsetOf(element) - (isViewport(parent) ? parent.scrollTop : 0) : 0
  }
  // Absolute virtual rows occupy their container's explicit height, not an
  // additional stack of row heights. Native anchor spacers remain in flow.
  const extentOf = (element: HTMLElement): number => {
    let extent = heightOf(element)
    let flowTop = paddingTop(element)
    for (const child of children(element)) {
      if (hidden(child)) continue
      const top = absolute(child) ? offsetOf(child) : flowTop + translateY(child)
      extent = Math.max(extent, top + extentOf(child))
      if (!absolute(child)) flowTop += heightOf(child) + spacing(element, 'gap')
    }
    return extent
  }
  const contentOf = (viewport: HTMLElement) => viewport.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
  const maxScroll = (viewport: HTMLElement) => Math.max(0, viewport.scrollHeight - VIEWPORT_HEIGHT)
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get() { return heightOf(this) } },
    clientWidth: { configurable: true, get() { return 600 } },
    offsetHeight: { configurable: true, get() { return heightOf(this) } },
    offsetWidth: { configurable: true, get() { return 600 } },
    offsetTop: { configurable: true, get() { return offsetOf(this) } },
    scrollHeight: {
      configurable: true,
      get() {
        const content = isViewport(this) ? contentOf(this) : null
        return content ? Math.max(VIEWPORT_HEIGHT, extentOf(content)) : extentOf(this)
      }
    },
    scrollTop: {
      configurable: true,
      get() { return isViewport(this) ? Math.max(0, Math.min(positions.get(this) ?? 0, maxScroll(this))) : 0 },
      set(value: number) {
        if (!isViewport(this)) return
        const top = Math.max(0, Math.min(value, maxScroll(this)))
        writes.push({ element: this, top })
        if (top !== this.scrollTop) scrollEvents.add(this)
        positions.set(this, top)
      }
    }
  })
  HTMLElement.prototype.scrollTo = function (options: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === 'number' ? y ?? 0 : options.top ?? 0
  }
  HTMLElement.prototype.getBoundingClientRect = function () {
    return new DOMRect(0, topOf(this), 600, heightOf(this))
  }

  class GeometryResizeObserver {
    static instances = new Set<GeometryResizeObserver>()
    targets = new Map<Element, string | null>()
    constructor(private callback: ResizeObserverCallback) { GeometryResizeObserver.instances.add(this) }
    observe(target: Element) { if (!this.targets.has(target)) this.targets.set(target, null) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear(); GeometryResizeObserver.instances.delete(this) }
    static deliverChanged() {
      let delivered = false
      for (const observer of [...this.instances]) {
        const entries: ResizeObserverEntry[] = []
        for (const [target, previous] of observer.targets) {
          const rect = target.getBoundingClientRect()
          const signature = `${rect.width}:${rect.height}`
          if (signature === previous) continue
          observer.targets.set(target, signature)
          const size = [{ inlineSize: rect.width, blockSize: rect.height }]
          entries.push({ target, contentRect: rect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size })
        }
        if (entries.length) { delivered = true; observer.callback(entries, observer as unknown as ResizeObserver) }
      }
      return delivered
    }
  }
  Object.assign(globalThis, { ResizeObserver: GeometryResizeObserver, IntersectionObserver: undefined })
  Object.assign(window, { ResizeObserver: GeometryResizeObserver, IntersectionObserver: undefined })

  const turns = (count = 24): DisplayTurn[] => Array.from({ length: count }, (_, index) => ({
    id: `t${index}`, startedAt: index, endedAt: index + 1, hasProcess: true,
    user: { text: `user ${index}`, images: [], textAttachments: [] },
    answer: [{ type: 'text' as const, text: `answer ${index}` }]
  }))
  type Runtime = {
    branchViewId: string
    turns: DisplayTurn[]
    liveMessages: Array<{ role: string; content: unknown; timestamp: number }>
    processByTurnId: Record<string, never>
    thinkingDurations: Record<string, never>
    elapsedByTurnId: Record<string, never>
    streamElapsedMs: null
    isStreaming: boolean
  }
  const runtime = (branchViewId: string, count: number): Runtime => ({
    branchViewId, turns: turns(count), liveMessages: [], processByTurnId: {}, thinkingDurations: {},
    elapsedByTurnId: {}, streamElapsedMs: null, isStreaming: false
  })
  let store = { activeSessionId: 's1', runtime: { s1: runtime('v1', 24), s2: runtime('v2', 12) }, loadTurnProcess: async () => {} }
  const change = (patch: Partial<Runtime>, session: 's1' | 's2' = 's1') => {
    store = { ...store, runtime: { ...store.runtime, [session]: { ...store.runtime[session], ...patch } } }
  }
  const heights = new Map<string, number>()
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: (select: (state: typeof store) => unknown) => select(store)
  }))
  mock.module('../src/renderer/src/components/TurnView', () => ({
    TurnView: ({ turn, onNeedProcess }: {
      turn: { id: string; user?: { content: unknown } }
      onNeedProcess?: (id: string) => Promise<void>
    }) => {
      const height = heights.get(turn.id) ?? 80
      return h('div', { 'data-turn': turn.id, 'data-height': height, style: { height } },
        h('div', { 'data-turn-user': '', 'data-height': 24 }, 'user'),
        h('button', { type: 'button', 'data-slot': 'collapsible-trigger', 'data-height': 20,
          onClick: () => { void onNeedProcess?.(turn.id) } }, 'fold'))
    }
  }))
  const { ChatView } = await import('../src/renderer/src/components/ChatView')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let mounted = true
  const settle = async () => {
    let quietRounds = 0
    for (let round = 0; round < 100; round++) {
      let resized = false
      await act(async () => {
        clock += 16
        resized = GeometryResizeObserver.deliverChanged()
        for (const [id, callback] of [...frames]) {
          if (!frames.delete(id)) continue
          callback(clock)
        }
        for (const element of [...scrollEvents]) {
          scrollEvents.delete(element)
          if (!element.isConnected) continue
          element.dispatchEvent(new Event('scroll'))
          element.dispatchEvent(new Event('scrollend'))
        }
        for (const [id, timer] of [...timers]) {
          if (timer.due > clock || !timers.delete(id)) continue
          timer.callback()
        }
        await Bun.sleep(0)
      })
      if (!resized && !frames.size && !scrollEvents.size && !timers.size) {
        if (++quietRounds === 2) return
      } else quietRounds = 0
    }
    assert.fail(`scroll did not settle: frames=${frames.size}, timers=${timers.size}, events=${scrollEvents.size}`)
  }
  const render = async (flush = true) => {
    await act(async () => { root.render(h(ChatView, null)) })
    if (flush) await settle()
  }
  const viewport = () => {
    const element = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    assert.ok(element, 'missing viewport')
    return element
  }
  const bottomButton = () => {
    const button = container.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]')
    assert.ok(button, 'the bottom control must remain mounted, including while generating')
    return button
  }
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(Math.abs(actual - expected) <= 2, `${message}: actual=${actual}, expected=${expected}`)
  const atEnd = () => near(viewport().scrollTop, maxScroll(viewport()), 'viewport should follow the actual content end')
  const liveAligned = () => {
    const user = container.querySelector<HTMLElement>('[data-live-turn]:last-of-type [data-turn-user]') ??
      [...container.querySelectorAll<HTMLElement>('[data-live-turn] [data-turn-user]')].at(-1)
    assert.ok(user, 'missing live turn')
    near(user.getBoundingClientRect().top, VIEWPORT_TOP + TURN_ALIGN, 'new live user should align below the viewport top')
  }
  const input = (kind: string, scroller: HTMLElement) => {
    if (kind === 'wheel') scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 }))
    else if (kind === 'touch') scroller.dispatchEvent(new Event('touchmove', { bubbles: true }))
    else scroller.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }))
  }
  const leaveEnd = async (top = 320, kind = 'wheel') => {
    await act(async () => { input(kind, viewport()); viewport().scrollTop = top })
    await settle()
    return viewport().scrollTop
  }
  const startLive = async () => {
    change({ isStreaming: true, liveMessages: [{ role: 'user', content: 'hello', timestamp: 10_000 }] })
    await render()
  }
  const growLive = async (height: number) => {
    const live = [...container.querySelectorAll<HTMLElement>('[data-live-turn]')].at(-1)
    assert.ok(live?.dataset.messageId)
    heights.set(live.dataset.messageId, height)
    change({ liveMessages: [...store.runtime.s1.liveMessages] })
    await render()
  }
  const switchTo = async (session: 's1' | 's2', flush = true) => {
    store = { ...store, activeSessionId: session }
    await render(flush)
  }
  const mountedHistory = () => [...container.querySelectorAll<HTMLElement>('[data-historical-turn]')]
  const row = (index: number) => container.querySelector<HTMLElement>(`[data-historical-turn][data-index="${index}"]`)

  try {
    if (name === 'follow-and-pause') {
      await render()
      atEnd()
      const trigger = mountedHistory().find((element) => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > VIEWPORT_TOP && rect.top < VIEWPORT_TOP + VIEWPORT_HEIGHT
      })?.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')
      assert.ok(trigger, 'a visible history fold must be mounted')
      await act(async () => { trigger.click() })
      await settle()
      const paused = viewport().scrollTop
      change({ turns: turns(32) })
      await render()
      near(viewport().scrollTop, paused, 'folding pauses later history growth')
      assert.equal(bottomButton().dataset.active, 'true')
    } else if (name === 'restore-session-branch') {
      change({ turns: turns(80) })
      await render()
      const first = await leaveEnd(640)
      await switchTo('s2')
      atEnd()
      const second = await leaveEnd(160)
      await switchTo('s1')
      near(viewport().scrollTop, first, 'first session restores its own paused offset')
      change({ branchViewId: 'v3', turns: turns(32) })
      await render()
      const branch = await leaveEnd(240)
      change({ branchViewId: 'v1', turns: turns(80) })
      await render()
      near(viewport().scrollTop, first, 'returning to a branch restores its own snapshot')
      change({ branchViewId: 'v3', turns: turns(32) })
      await render()
      near(viewport().scrollTop, branch, 'branch snapshots remain separate')
      await switchTo('s2')
      near(viewport().scrollTop, second, 'second session was not overwritten by the first')
    } else if (name === 'stream-resumes') {
      await render()
      const paused = await leaveEnd()
      change({ isStreaming: true })
      await render()
      near(viewport().scrollTop, paused, 'stream status alone must not resume scrolling')
      bottomButton()
      await startLive()
      liveAligned()
      await growLive(130)
      liveAligned()
      await growLive(400)
      atEnd()
      const previous = viewport().scrollTop
      await growLive(560)
      atEnd()
      near(viewport().scrollTop - previous, 160, 'growth follows continuously after consuming the anchor spacer')
      bottomButton()
    } else if (name.startsWith('release-')) {
      const kind = name.slice('release-'.length)
      await render()
      await startLive()
      await growLive(400)
      atEnd()
      const paused = await leaveEnd(viewport().scrollTop - 80, kind)
      await growLive(560)
      near(viewport().scrollTop, paused, `${kind} releases native following`)
      assert.equal(bottomButton().dataset.active, 'true')
      await act(async () => { bottomButton().click() })
      await settle()
      atEnd()
      await growLive(640)
      atEnd()
    } else if (name === 'restore-live-anchor') {
      await render()
      await startLive()
      liveAligned()
      await switchTo('s2')
      await switchTo('s1')
      liveAligned()
      await growLive(400)
      atEnd()
      const paused = await leaveEnd(viewport().scrollTop - 80)
      await switchTo('s2')
      await switchTo('s1')
      near(viewport().scrollTop, paused, 'a user-paused live turn remains paused after switching back')
      await growLive(560)
      near(viewport().scrollTop, paused, 'restoring a paused live turn must not restore its former anchor')
    } else if (name === 'restore-paused-short-live') {
      await render()
      await startLive()
      liveAligned()
      const trigger = container.querySelector<HTMLButtonElement>('[data-live-turn] [data-slot="collapsible-trigger"]')!
      await act(async () => { trigger.click() })
      await settle()
      const paused = viewport().scrollTop
      await switchTo('s2')
      await switchTo('s1')
      near(viewport().scrollTop, paused, 'paused short live turns retain the spacer needed for the same reading position')
      liveAligned()
      await growLive(400)
      near(viewport().scrollTop, paused, 'restoration must not resume following after an explicit fold pause')
      assert.equal(bottomButton().dataset.active, 'true')
    } else if (name === 'next-live-after-hydration') {
      await render()
      await startLive()
      liveAligned()
      change({ isStreaming: false, liveMessages: [], turns: turns(25) })
      await render()
      await leaveEnd()
      await startLive()
      liveAligned()
      await growLive(400)
      atEnd()
    } else if (name === 'all-live-natural-flow') {
      change({ turns: turns(1000), isStreaming: true, liveMessages: [
        { role: 'user', content: 'first', timestamp: 10_000 },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 10_001 },
        { role: 'user', content: 'second', timestamp: 20_000 }
      ] })
      await render()
      const live = [...container.querySelectorAll<HTMLElement>('[data-live-turn]')]
      assert.equal(live.length, 2, 'all unhydrated live turns remain visible')
      const history = container.querySelector<HTMLElement>('[data-history-turns]')!
      const content = contentOf(viewport())
      assert.equal(history.parentElement, content)
      assert.deepEqual(live.map((element) => Number(element.dataset.index)), [1000, 1001])
      for (const element of live) assert.equal(element.parentElement, content)
      near(live[0].getBoundingClientRect().top, history.getBoundingClientRect().bottom, 'first live row follows virtual history in normal flow')
      near(live[1].getBoundingClientRect().top, live[0].getBoundingClientRect().bottom, 'second live row follows the first')
      assert.equal(container.querySelector('[data-pinned-turns]'), null)
      assert.ok(mountedHistory().length <= 32, 'live turns do not disable history virtualization')
      liveAligned()
    } else if (name === 'idle-virtualization') {
      change({ turns: turns(2000) })
      await render()
      atEnd()
      assert.ok(row(1999), 'the final historical turn should mount at the end')
      assert.ok(mountedHistory().length > 0 && mountedHistory().length <= 32, 'long idle history stays bounded')
      await leaveEnd(0)
      assert.ok(row(0), 'scrolling to the beginning mounts the first historical turn')
      assert.equal(row(1999), null)
      assert.ok(mountedHistory().length <= 32)
      assert.equal(container.querySelector('[data-pinned-turns]'), null)
    } else if (name === 'minimap-unmounted') {
      change({ turns: turns(240) })
      await render()
      assert.equal(row(50), null, 'the jump target starts outside the rendered range')
      const button = container.querySelector<HTMLButtonElement>('[data-turn-index="50"]')
      assert.ok(button)
      assert.match(button.getAttribute('aria-label') ?? '', /51/)
      await act(async () => { button.click() })
      await settle()
      assert.ok(row(50), 'an unmounted minimap target becomes available without polling')
      near(row(50)!.getBoundingClientRect().top, VIEWPORT_TOP + TURN_ALIGN, 'minimap target aligns at the top')
      assert.ok(mountedHistory().length <= 33, 'navigation forces at most one extra row')
    } else if (name === 'resize-history') {
      change({ turns: turns(80) })
      await render()
      await leaveEnd(1200)
      // Finish the backward-scroll debounce before measuring a stationary row.
      await settle()
      const above = mountedHistory().findLast((element) => element.getBoundingClientRect().bottom < VIEWPORT_TOP)
      assert.ok(above, 'overscan should retain a measured row above the viewport')
      const index = Number(above.dataset.index)
      const before = viewport().scrollTop
      heights.set(`t${index}`, 120)
      change({ turns: [...store.runtime.s1.turns] })
      await render()
      near(viewport().scrollTop, before + 40, 'resizing a row above a stationary reader compensates its height delta')
      await act(async () => { bottomButton().click() })
      await settle()
      atEnd()
      const last = 79
      heights.set(`t${last}`, 140)
      change({ turns: [...store.runtime.s1.turns] })
      await render()
      atEnd()
      change({ turns: turns(81) })
      await render()
      atEnd()
    } else if (name === 'switch-unmount-cleanup') {
      await render()
      const oldViewport = viewport()
      change({ turns: turns(80) })
      await render(false)
      await switchTo('s2', false)
      const afterSwitch = writes.length
      await settle()
      assert.ok(writes.slice(afterSwitch).every((write) => write.element !== oldViewport), 'queued work never writes to a detached session viewport')
      change({ turns: turns(80) }, 's2')
      await render(false)
      await act(async () => { root.unmount() })
      mounted = false
      const afterUnmount = writes.length
      assert.equal(frames.size, 0, 'unmount cancels pending animation frames')
      assert.equal(timers.size, 0, 'unmount cancels pending scroll timers')
      assert.equal([...GeometryResizeObserver.instances].reduce((sum, observer) => sum + observer.targets.size, 0), 0, 'unmount releases resize targets')
      await settle()
      assert.equal(writes.length, afterUnmount, 'no delayed callback writes after unmount')
    } else assert.fail(`Unknown fixture: ${name}`)
  } finally {
    if (mounted) await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--chat-view-scroll-fixture') {
  await runFixture(process.argv[3])
} else {
  const fixtures = {
    'follow-and-pause': 'folding pauses following before later history growth',
    'restore-session-branch': 'paused offsets remain isolated by session and branch',
    'stream-resumes': 'a new live turn anchors, then naturally follows growing output',
    'release-wheel': 'wheel input releases following until the bottom control resumes it',
    'release-touch': 'touch input releases following until the bottom control resumes it',
    'release-key': 'keyboard input releases following until the bottom control resumes it',
    'restore-live-anchor': 'switching sessions preserves live anchors without reviving user-paused anchors',
    'restore-paused-short-live': 'paused short live turns retain their reading position and pause across tabs',
    'next-live-after-hydration': 'a new prompt anchors again after the previous live turn is hydrated',
    'all-live-natural-flow': 'all live turns stay outside virtual history in natural document flow',
    'idle-virtualization': 'long idle histories render a bounded number of rows',
    'minimap-unmounted': 'minimap navigation mounts and aligns an offscreen historical turn',
    'resize-history': 'history resize compensates paused readers without disabling following',
    'switch-unmount-cleanup': 'session switches and unmount cancel detached scrolling work'
  }
  for (const [name, title] of Object.entries(fixtures)) {
    test(`chat view scroll: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--chat-view-scroll-fixture', name], {
        cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 12_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(exitCode, 0, stderr || stdout)
      } finally { clearTimeout(timeout); child.kill() }
    }, 15_000)
  }
}

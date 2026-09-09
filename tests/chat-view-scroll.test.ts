import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DisplayTurn } from '../src/renderer/src/ipc/api'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { mock } = await import('bun:test')

  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 1
  window.requestAnimationFrame = (callback) => {
    const id = nextId++
    frames.set(id, callback)
    return id
  }
  window.cancelAnimationFrame = (id) => { frames.delete(id) }

  class GeometryResizeObserver {
    static instances = new Set<GeometryResizeObserver>()
    targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {
      GeometryResizeObserver.instances.add(this)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() {
      this.targets.clear()
      GeometryResizeObserver.instances.delete(this)
    }
    static notify(target: Element) {
      for (const observer of this.instances) {
        if (observer.targets.has(target)) observer.callback([], observer as unknown as ResizeObserver)
      }
    }
  }
  Object.assign(globalThis, { ResizeObserver: GeometryResizeObserver, IntersectionObserver: undefined })
  Object.assign(window, { ResizeObserver: GeometryResizeObserver, IntersectionObserver: undefined })

  const positions = new WeakMap<HTMLElement, number>()
  const writes: number[] = []
  const viewportOf = (element: HTMLElement) =>
    element.closest<HTMLElement>('[data-slot="message-scroller-viewport"]')
  const heightOf = (element: HTMLElement) => Number(element.dataset.height) || element.getBoundingClientRect().height
  const contentHeight = (viewport: HTMLElement) => {
    const content = viewport.querySelector('[data-slot="message-scroller-content"]')
    if (!content) return 0
    return [...content.children].reduce((sum, child) => {
      if ((child as HTMLElement).hasAttribute('data-message-scroller-spacer')) {
        const spacer = child as HTMLElement
        return sum + (spacer.hidden ? 0 : Number.parseFloat(spacer.style.height) || 0)
      }
      return sum + Math.max(heightOf(child as HTMLElement), child.scrollHeight, 160)
    }, 0)
  }
  const maxScroll = (viewport: HTMLElement) => Math.max(0, Math.max(contentHeight(viewport), viewport.scrollHeight) - 100)
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() { return this.hasAttribute('data-slot') && this.getAttribute('data-slot') === 'message-scroller-viewport' ? 100 : Number(this.dataset.height) || 0 }
    },
    clientWidth: { configurable: true, get() { return 300 } },
    offsetHeight: { configurable: true, get() { return this.clientHeight } },
    offsetWidth: { configurable: true, get() { return this.clientWidth } },
    scrollHeight: {
      configurable: true,
      get() {
        return this.getAttribute('data-slot') === 'message-scroller-viewport'
          ? Math.max(100, contentHeight(this))
          : Number(this.dataset.height) || 0
      }
    },
    scrollTop: {
      configurable: true,
      get() {
        if (this.getAttribute('data-slot') !== 'message-scroller-viewport') return 0
        const value = Math.max(0, Math.min(positions.get(this) ?? 0, maxScroll(this)))
        positions.set(this, value)
        return value
      },
      set(value: number) {
        if (this.getAttribute('data-slot') !== 'message-scroller-viewport') return
        writes.push(value)
        positions.set(this, Math.max(0, value))
      }
    }
  })
  HTMLElement.prototype.scrollTo = function (options: ScrollToOptions | number, y?: number) {
    const top = typeof options === 'number' ? y ?? 0 : options.top ?? 0
    this.scrollTop = top
  }
  HTMLElement.prototype.getBoundingClientRect = function () {
    const viewport = viewportOf(this)
    if (!viewport) return new DOMRect(0, 0, 300, Number(this.dataset.height) || 0)
    if (this === viewport) return new DOMRect(0, 0, 300, 100)
    return new DOMRect(0, 0, 300, Number(this.dataset.height) || 80)
  }

  const turns = (count = 8): DisplayTurn[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `t${index}`,
      startedAt: index,
      endedAt: index + 1,
      hasProcess: true,
      user: { text: `user ${index}`, images: [], textAttachments: [] },
      answer: [{ type: 'text' as const, text: `answer ${index}` }]
    }))

  type Runtime = {
    branchViewId: string
    turns: DisplayTurn[]
    liveMessages: []
    processByTurnId: Record<string, never>
    thinkingDurations: Record<string, never>
    elapsedByTurnId: Record<string, never>
    streamElapsedMs: null
    isStreaming: boolean
  }
  let store = {
    activeSessionId: 's1',
    runtime: {
      s1: {
        branchViewId: 'v1',
        turns: turns(),
        liveMessages: [],
        processByTurnId: {},
        thinkingDurations: {},
        elapsedByTurnId: {},
        streamElapsedMs: null,
        isStreaming: false
      } satisfies Runtime,
      s2: {
        branchViewId: 'v2',
        turns: turns(3),
        liveMessages: [],
        processByTurnId: {},
        thinkingDurations: {},
        elapsedByTurnId: {},
        streamElapsedMs: null,
        isStreaming: false
      } satisfies Runtime
    },
    loadTurnProcess: async () => {}
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: (select: (state: typeof store) => unknown) => select(store)
  }))
  mock.module('../src/renderer/src/components/TurnView', () => ({
    TurnView: ({
      turn,
      onNeedProcess
    }: {
      turn: { id: string }
      onNeedProcess?: (id: string) => Promise<void>
    }) =>
      h('div', { 'data-turn': turn.id, 'data-height': 80, style: { height: 80 } },
        h('div', { 'data-turn-user': '' }, 'user'),
        h('button', {
          type: 'button',
          'data-slot': 'collapsible-trigger',
          onClick: () => { void onNeedProcess?.(turn.id) }
        }, 'fold')
      )
  }))
  const { ChatView } = await import('../src/renderer/src/components/ChatView')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(0)
      for (let round = 0; round < 12; round++) {
        const queued = [...frames]
        frames.clear()
        for (const [, callback] of queued) callback(round * 16)
        await Bun.sleep(0)
        if (!frames.size) return
      }
    })
  }
  const notify = () => {
    for (const observer of GeometryResizeObserver.instances) {
      for (const target of observer.targets) GeometryResizeObserver.notify(target)
    }
  }
  const render = async () => {
    await act(async () => { root.render(h(ChatView, null)) })
    await act(async () => { notify() })
    await settle()
    await act(async () => { notify() })
    await settle()
  }
  const viewport = () => container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
  const clickFold = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')
    assert.ok(
      trigger,
      `missing fold trigger: indexes=${container.querySelectorAll('[data-index]').length}`
    )
    await act(async () => { trigger.click() })
    await settle()
  }
  const leaveEnd = async (top = 40) => {
    const scroller = viewport()
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -10 }))
      scroller.scrollTop = top
      scroller.dispatchEvent(new Event('scroll'))
    })
    await settle()
  }

  try {
    if (name === 'follow-and-pause') {
      await render()
      const scroller = viewport()
      assert.ok(scroller)
      const followed = scroller.scrollTop
      assert.ok(followed > 0)
      await clickFold()
      store = {
        ...store,
        runtime: {
          ...store.runtime,
          s1: { ...store.runtime.s1, turns: turns(12) }
        }
      }
      await render()
      assert.equal(scroller.scrollTop, followed)
    } else if (name === 'restore-branch') {
      await render()
      await leaveEnd(48)
      assert.equal(viewport().scrollTop, 48)
      store = { ...store, activeSessionId: 's2' }
      await render()
      store = { ...store, activeSessionId: 's1' }
      await render()
      const restored = viewport().scrollTop
      assert.ok(restored < 200, `restored ${restored} snapped too far toward the end`)
      assert.ok(Math.abs(restored - 48) <= 80)
    } else if (name === 'stream-resumes') {
      await render()
      await leaveEnd(48)
      assert.equal(viewport().scrollTop, 48)
      store = {
        ...store,
        runtime: { ...store.runtime, s1: { ...store.runtime.s1, isStreaming: true } }
      }
      await render()
      assert.ok(viewport().scrollTop > 48)
      assert.equal(container.querySelector('[data-slot="message-scroller-button"]'), null)
    } else {
      assert.fail(`Unknown fixture: ${name}`)
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--chat-view-scroll-fixture') {
  await runFixture(process.argv[3])
} else {
  const fixtures = {
    'follow-and-pause': 'fold clicks pause follow so later growth does not jump to the end',
    'restore-branch': 'session remount restores the paused offset instead of snapping to the end',
    'stream-resumes': 'starting a stream resumes follow and hides the jump button'
  }
  for (const [name, title] of Object.entries(fixtures)) {
    test(`chat view scroll: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--chat-view-scroll-fixture', name], {
        cwd: new URL('..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 12_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(exitCode, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

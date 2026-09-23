import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DisplayTurn } from '../src/renderer/src/ipc/api'

const VIEWPORT_HEIGHT = 240
const VIEWPORT_TOP = 37
const VIEWPORT_WIDTH = 600
const TURN_ALIGN = 12
const ROW_HEIGHT = 80

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h, useSyncExternalStore } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
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

  const isViewport = (element: HTMLElement) => element.dataset.slot === 'message-scroller-viewport'
  const isContent = (element: HTMLElement) => element.dataset.slot === 'message-scroller-content'
  const hidden = (element: HTMLElement) => element.hidden || element.style.display === 'none'
  // Inactive panes stay mounted behind `display: none`; their geometry is not part of a test.
  const detached = (element: HTMLElement) => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) if (hidden(node)) return true
    return false
  }
  const spacing = (element: HTMLElement, prefix: string) => {
    const token = [...element.classList].findLast((value) => new RegExp(`^${prefix}-[\\d.]+$`).test(value))
    return token ? Number.parseFloat(token.slice(prefix.length + 1)) * 4 : 0
  }
  const paddingTop = (element: HTMLElement) =>
    Number.parseFloat(element.style.paddingTop) || spacing(element, 'pt') || spacing(element, 'py')
  const paddingBottom = (element: HTMLElement) =>
    Number.parseFloat(element.style.paddingBottom) || spacing(element, 'pb') || spacing(element, 'py')
  const children = (element: HTMLElement) => [...element.children] as HTMLElement[]
  const flowChildren = (element: HTMLElement) => children(element).filter((child) => !hidden(child))
  const heightOf = (element: HTMLElement): number => {
    if (hidden(element)) return 0
    if (isViewport(element)) return VIEWPORT_HEIGHT
    if (/^\d+(?:\.\d+)?px$/.test(element.style.height)) return Number.parseFloat(element.style.height)
    if (element.dataset.height !== undefined) return Number(element.dataset.height)
    const fixedHeight = spacing(element, 'h')
    if (fixedHeight) return fixedHeight
    const flow = flowChildren(element)
    const height = flow.reduce((sum, child) => sum + heightOf(child), 0) +
      Math.max(0, flow.length - 1) * spacing(element, 'gap') + paddingTop(element) + paddingBottom(element)
    return isContent(element) ? Math.max(VIEWPORT_HEIGHT, height) : height
  }
  const translateY = (element: HTMLElement) => {
    const match = element.style.transform.match(/translateY\(([-\d.]+)px\)/) ??
      element.style.transform.match(/translate(?:3d)?\([^,]+,\s*([-\d.]+)px/)
    return match ? Number(match[1]) : 0
  }
  const offsetOf = (element: HTMLElement): number => {
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
  const extentOf = (element: HTMLElement): number => {
    let extent = heightOf(element)
    let flowTop = paddingTop(element)
    for (const child of flowChildren(element)) {
      extent = Math.max(extent, flowTop + translateY(child) + extentOf(child))
      flowTop += heightOf(child) + spacing(element, 'gap')
    }
    return extent
  }
  const contentOf = (viewport: HTMLElement) => viewport.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
  const maxScroll = (viewport: HTMLElement) => Math.max(0, viewport.scrollHeight - VIEWPORT_HEIGHT)
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get() { return heightOf(this) } },
    clientWidth: { configurable: true, get() { return VIEWPORT_WIDTH } },
    offsetHeight: { configurable: true, get() { return heightOf(this) } },
    offsetWidth: { configurable: true, get() { return VIEWPORT_WIDTH } },
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
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? 0
  }
  HTMLElement.prototype.getBoundingClientRect = function () {
    return new DOMRect(0, topOf(this), VIEWPORT_WIDTH, heightOf(this))
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
      for (const observer of [...GeometryResizeObserver.instances]) {
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
  // The archived twin of a live prompt: same timestamp and text, so both project to one render key.
  const archivedTurn = (index: number, text: string, timestamp: number): DisplayTurn => ({
    id: `t${index}`, startedAt: timestamp, endedAt: timestamp + 1, hasProcess: true,
    user: { text, images: [], textAttachments: [] }, userTimestamp: timestamp,
    answer: [{ type: 'text' as const, text: 'answer' }]
  })
  type Runtime = {
    branchViewId: string
    turns: DisplayTurn[]
    turnStart: number
    turnPending: boolean
    turnIndexTrusted: boolean
    turnError: string | null
    turnSummary: never[]
    liveMessages: Array<{ role: string; content: unknown; timestamp: number }>
    processByTurnId: Record<string, never>
    thinkingDurations: Record<string, never>
    elapsedByTurnId: Record<string, never>
    streamElapsedMs: null
    isStreaming: boolean
  }
  const runtime = (branchViewId: string, count: number): Runtime => ({
    branchViewId, turns: turns(count), turnStart: 0, turnPending: false, turnIndexTrusted: true,
    turnError: null, turnSummary: [],
    liveMessages: [], processByTurnId: {}, thinkingDurations: {},
    elapsedByTurnId: {}, streamElapsedMs: null, isStreaming: false
  })
  let store = {
    activeTabId: 's1',
    openTabs: [{ id: 's1', kind: 'project' }, { id: 's2', kind: 'project' }],
    runtime: { s1: runtime('v1', 24), s2: runtime('v2', 12) },
    loadTurnProcess: async () => {},
    loadOlderTurns: async (_sessionId: string, target?: number) => {
      olderCalls.push(target)
      const runtime = store.runtime.s1
      if (runtime.turnStart === 0) return
      // Bounded the way the store pages: a far target is fetched in steps, not in one read.
      const wanted = Math.min(target ?? runtime.turnStart - 40, runtime.turnStart - 1)
      const from = Math.max(0, wanted, runtime.turnStart - 200)
      preloaded.push(from)
      change({ turns: [...turns(runtime.turnStart).slice(from, runtime.turnStart), ...runtime.turns], turnStart: from })
    }
  }
  const preloaded: number[] = []
  const olderCalls: Array<number | undefined> = []
  // Zustand-like subscriptions: memoized panes only re-render when their selectors change.
  const listeners = new Set<() => void>()
  const notify = () => act(() => { for (const listener of [...listeners]) listener() })
  const change = (patch: Partial<Runtime>, session: 's1' | 's2' = 's1') => {
    store = { ...store, runtime: { ...store.runtime, [session]: { ...store.runtime[session], ...patch } } }
    notify()
  }
  const heights = new Map<string, number>()
  mock.module('../src/renderer/src/stores/sessions', () => ({
    selectActiveSessionId: (state: typeof store) => state.activeTabId,
    useSessionsStore: Object.assign(
      (select: (state: typeof store) => unknown) =>
        useSyncExternalStore(
          (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
          () => select(store),
          () => select(store)
        ),
      { getState: () => store }
    )
  }))
  mock.module('../src/renderer/src/components/TurnView', () => ({
    TurnView: ({ turn, onNeedProcess }: {
      turn: { id?: string; renderKey?: string; user?: { content: unknown } }
      onNeedProcess?: (id: string) => Promise<void>
    }) => {
      const live = turn.id?.startsWith('live:') ?? false
      const key = turn.renderKey ?? turn.id ?? ''
      const height = heights.get(key) ?? ROW_HEIGHT
      return h('div', {
        'data-turn': turn.id,
        'data-turn-key': key,
        [live ? 'data-live-turn' : 'data-historical-turn']: '',
        'data-height': height,
        style: { height }
      },
      h('div', { 'data-turn-user': '', 'data-height': 24 }, 'user'),
      h('button', {
        type: 'button', 'data-slot': 'collapsible-trigger', 'data-height': 20,
        onClick: () => { void onNeedProcess?.(turn.id ?? '') }
      }, 'fold'))
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
        for (const [id, callback] of [...frames]) {
          if (!frames.delete(id)) continue
          callback(clock)
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
    const element = [...container.querySelectorAll<HTMLElement>('[data-slot="message-scroller-viewport"]')]
      .find((candidate) => !detached(candidate))
    assert.ok(element, 'missing active viewport')
    return element
  }
  const bottomButton = () => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="message-scroller-button"]')]
      .find((candidate) => !detached(candidate))
    assert.ok(button, 'the bottom control must remain mounted, including while generating')
    return button
  }
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(Math.abs(actual - expected) <= 2, `${message}: actual=${actual}, expected=${expected}`)
  const atEnd = () => near(viewport().scrollTop, maxScroll(viewport()), 'viewport should follow the actual content end')
  const rowOffset = (index: number) => {
    const item = row(index)
    assert.ok(item, `missing row ${index}`)
    return item.getBoundingClientRect().top - VIEWPORT_TOP
  }
  const rows = () => [...container.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]')]
    .filter((item) => !detached(item))
  const row = (index: number) => rows().find((item) => item.dataset.turnIndex === String(index)) ?? null
  const liveRows = () => rows().filter((item) => item.querySelector('[data-live-turn]'))
  // The pair a snapshot has to restore: which turn sits at the top and how far it is pushed down.
  const topRow = () => {
    const bounds = VIEWPORT_TOP + TURN_ALIGN
    const hit = rows().find((item) => item.getBoundingClientRect().bottom > bounds)
    assert.ok(hit, 'missing a row below the viewport top')
    const rect = hit.getBoundingClientRect()
    return { index: Number(hit.dataset.turnIndex), offset: rect.top - VIEWPORT_TOP }
  }
  const pendingButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === '加载更早消息')
  const foldFirstVisibleHistory = async () => {
    const trigger = rows().find((item) => {
      const rect = item.getBoundingClientRect()
      return rect.bottom > VIEWPORT_TOP && rect.top < VIEWPORT_TOP + VIEWPORT_HEIGHT && !item.querySelector('[data-live-turn]')
    })?.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')
    assert.ok(trigger, 'a visible history fold must be mounted')
    await act(async () => { trigger.click() })
    await settle()
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
  const startLive = async (text = 'hello', timestamp = 10_000) => {
    change({ isStreaming: true, liveMessages: [{ role: 'user', content: text, timestamp }] })
    await render()
  }
  const growLive = async (height: number) => {
    const live = liveRows().at(-1)
    assert.ok(live?.dataset.turnKey, 'missing the live row')
    heights.set(live.dataset.turnKey, height)
    change({ liveMessages: [...store.runtime.s1.liveMessages] })
    await render()
  }
  const switchTo = async (session: 's1' | 's2', flush = true) => {
    store = { ...store, activeTabId: session }
    notify()
    await render(flush)
  }

  try {
    if (name === 'fold-pauses') {
      await render()
      atEnd()
      await foldFirstVisibleHistory()
      const paused = viewport().scrollTop
      change({ turns: turns(32) })
      await render()
      near(viewport().scrollTop, paused, 'folding pauses later history growth')
      assert.equal(bottomButton().dataset.active, 'true')
    } else if (name === 'restore-branch') {
      change({ turns: turns(80) })
      await render()
      const paused = await leaveEnd(1000)
      const anchored = topRow()
      change({ branchViewId: 'v3', turns: turns(32) })
      await render()
      atEnd()
      change({ branchViewId: 'v1', turns: turns(80) })
      await render()
      near(viewport().scrollTop, paused, 'returning to a branch restores its own snapshot')
      assert.deepEqual(topRow(), anchored, 'the same turn stays at the same offset')
    } else if (name === 'restore-missing-anchor') {
      change({ turns: turns(80) })
      await render()
      const paused = await leaveEnd(1000)
      const anchored = topRow()
      const rewritten = turns(80).map((turn, index) =>
        index === anchored.index ? { ...turn, user: { ...turn.user!, text: 'rewritten' } } : turn)
      change({ branchViewId: 'v3' })
      await render()
      change({ branchViewId: 'v1', turns: rewritten })
      await render()
      near(viewport().scrollTop, paused, 'a vanished anchor falls back to the saved offset')
    } else if (name === 'prompt-follows') {
      await render()
      atEnd()
      await startLive()
      atEnd()
      await growLive(400)
      atEnd()
      const previous = viewport().scrollTop
      await growLive(560)
      atEnd()
      near(viewport().scrollTop - previous, 160, 'growth keeps following the answer')
      assert.equal(bottomButton().dataset.active, 'false')
    } else if (name.startsWith('release-')) {
      const kind = name.slice('release-'.length)
      await render()
      await startLive()
      await growLive(400)
      atEnd()
      const paused = await leaveEnd(viewport().scrollTop - 80, kind)
      await growLive(560)
      near(viewport().scrollTop, paused, `${kind} releases following`)
      assert.equal(bottomButton().dataset.active, 'true')
      await act(async () => { bottomButton().click() })
      await settle()
      atEnd()
      await growLive(640)
      atEnd()
    } else if (name === 'paused-live-across-tabs') {
      await render()
      await startLive()
      await growLive(400)
      atEnd()
      const paused = await leaveEnd(viewport().scrollTop - 80)
      await switchTo('s2')
      atEnd()
      await switchTo('s1')
      near(viewport().scrollTop, paused, 'a user-paused live turn keeps its reading position')
      await growLive(560)
      near(viewport().scrollTop, paused, 'returning to a paused tab must not resume following')
      assert.equal(bottomButton().dataset.active, 'true')
    } else if (name === 'archive-identity') {
      await render()
      await startLive()
      await growLive(400)
      atEnd()
      const before = liveRows().at(-1)!
      const key = before.dataset.turnKey
      change({
        isStreaming: false,
        liveMessages: [],
        turns: [...turns(24), archivedTurn(24, 'hello', 10_000)]
      })
      await render()
      assert.equal(liveRows().length, 0, 'the archived turn leaves the live projection')
      assert.equal(row(24)?.dataset.turnKey, key, 'history keeps the live render key')
      assert.equal(row(24)?.querySelector('[data-turn]'), before.querySelector('[data-turn]'),
        'the archive reuses the same row element')
      atEnd()
      await startLive('hello again', 20_000)
      atEnd()
      await growLive(400)
      atEnd()
    } else if (name === 'paging') {
      change({ turns: turns(2000) })
      await render()
      atEnd()
      assert.equal(rows().length, 20, 'only the tail of a long history mounts')
      assert.ok(row(1999), 'the newest turn mounts')
      assert.equal(row(1979), null, 'older turns stay unmounted')
      await act(async () => { input('wheel', viewport()); viewport().scrollTop = 0 })
      const anchored = topRow()
      await settle()
      assert.equal(rows().length, 40, 'scrolling to the top loads one page')
      assert.ok(row(1960), 'the older page is mounted')
      assert.ok(row(1999), 'the newest tail stays inside the window')
      near(viewport().scrollTop, 20 * ROW_HEIGHT, 'paging inserts exactly one page above')
      assert.equal(rowOffset(anchored.index), anchored.offset, 'paging keeps the same turn under the reader')
      await act(async () => { input('wheel', viewport()); viewport().scrollTop = 0 })
      const secondAnchor = topRow()
      await settle()
      assert.equal(rows().length, 40, 'later pages keep the mounted window bounded')
      assert.ok(row(1940), 'the next older page is mounted')
      assert.equal(row(1999), null, 'the newest tail leaves the window once it is out of range')
      assert.equal(rowOffset(secondAnchor.index), secondAnchor.offset, 'later pages keep the reader anchored')
      const windowBottom = viewport().scrollHeight - viewport().clientHeight - 80
      await act(async () => { input('wheel', viewport()); viewport().scrollTop = windowBottom })
      await settle()
      assert.equal(rows().length, 40, 'scrolling back down pages the window forward')
      assert.ok(row(1999), 'paging down returns the newest tail')
      await switchTo('s2')
      await switchTo('s1')
      assert.equal(rows().length, 40, 'the reader keeps the loaded page after switching back')
    } else if (name === 'minimap-jump') {
      change({ turns: turns(80) })
      await render()
      assert.equal(row(30), null, 'the jump target starts outside the rendered window')
      const button = container.querySelector<HTMLButtonElement>('[data-turn-index="30"]')
      assert.ok(button, 'the minimap renders one control per turn')
      assert.match(button.getAttribute('aria-label') ?? '', /31/)
      await act(async () => { button.click() })
      await settle()
      assert.ok(row(30), 'navigation mounts the older page')
      assert.equal(row(79), null, 'the jump does not mount the newest tail')
      near(row(30)!.getBoundingClientRect().top, VIEWPORT_TOP + TURN_ALIGN, 'the target aligns at the top')
      assert.equal(bottomButton().dataset.active, 'true')
      await act(async () => { bottomButton().click() })
      await settle()
      assert.ok(row(79), 'the bottom control returns to the newest tail')
      atEnd()
    } else if (name === 'far-jump') {
      // A live session keeps the whole minimap, but its window only holds the newest turns.
      const total = 2000
      const start = total - 60
      change({
        turns: turns(total).slice(start),
        turnStart: start,
        turnSummary: turns(total).map((turn) => ({ id: turn.id, bytes: 12, hasImages: false })) as never
      })
      await render()
      atEnd()
      const target = container.querySelector<HTMLButtonElement>('[role="navigation"] [data-turn-index="100"]')
      assert.ok(target, 'a turn far above the window still has a minimap bar')
      await act(async () => { target.click() })
      for (let round = 0; round < 6 && !row(100); round += 1) await settle()
      assert.ok(preloaded.length > 1, `a far jump pages instead of pulling the whole gap: ${preloaded.join(', ')}`)
      assert.ok(
        preloaded.every((value, index) => index === 0 || preloaded[index - 1]! - value <= 200),
        `every page stays bounded: ${preloaded.join(', ')}`
      )
      assert.ok(row(100), 'the wanted turn is mounted once its page arrived')
      near(row(100)!.getBoundingClientRect().top, VIEWPORT_TOP + TURN_ALIGN, 'the target aligns at the top')
    } else if (name === 'empty-window-error') {
      // An empty window with a failure behind it must not fall back to the chat's empty state: the
      // reader would have no hint that older turns exist and nothing to click.
      change({ turns: [], turnStart: 0, turnPending: false, turnIndexTrusted: false, turnError: 'index died' })
      await render()
      const alert = container.querySelector('[role="alert"]')
      assert.ok(alert, 'the failure is visible instead of an empty chat')
      assert.match(alert.textContent ?? '', /更早的消息加载失败/)
      const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '重试')
      assert.ok(retry, 'the failure offers a retry')
      await act(async () => { retry.click() })
      assert.deepEqual(olderCalls, [undefined], 'the retry asks the store for the window again')
    } else if (name === 'pending-window-status') {
      // The first paint of a long session is a provisional tail: its offset is unknown, so there is
      // nothing to page — but the reader still needs a way to ask for the authoritative window.
      change({ turnPending: true, turnIndexTrusted: false, turnStart: 0, turns: turns(60) })
      await render()
      assert.equal(pendingButton(), undefined, 'a provisional window cannot page the branch')
      const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('正在统计更早轮次'))
      assert.ok(retry, 'the reader is told why nothing can be paged, and can ask again')
      assert.equal(olderCalls.length, 0, 'nothing is requested before the reader asks')
      await act(async () => { retry.click() })
      assert.deepEqual(olderCalls, [undefined], 'the retry asks for a window, not for a page')
      change({ turnPending: false, turnIndexTrusted: true, turnStart: 140, turns: turns(60) })
      await render()
      assert.ok(pendingButton(), 'once the window knows its offset the control is back')
    } else if (name === 'return-to-branch-window') {
      // The reader walks up an old branch, leaves it, and comes back: the branch returns its tail
      // only, so the saved reading row has to page the window that holds it back in.
      change({
        turns: turns(200),
        turnStart: 0,
        turnSummary: turns(200).map((turn) => ({ id: turn.id, bytes: 12, hasImages: false })) as never
      })
      await render()
      atEnd()
      const bar = container.querySelector<HTMLButtonElement>('[role="navigation"] [data-turn-index="40"]')
      assert.ok(bar, 'the minimap knows every turn of the branch')
      await act(async () => { bar.click() })
      await settle()
      assert.ok(row(40), 'the jump mounts the older row')
      const anchored = topRow()
      assert.ok(anchored.index < 60, `the reader must sit in the older part: index=${anchored.index}`)
      change({ branchViewId: 'v3', turns: turns(32), turnStart: 0 })
      await render()
      atEnd()
      const before = preloaded.length
      // Coming back hands over the branch's tail, which does not hold the saved row.
      change({ branchViewId: 'v1', turns: turns(200).slice(140), turnStart: 140 })
      await render()
      const asked = preloaded.slice(before)
      assert.ok(asked.length > 0, 'the saved position must ask for the turns that hold it')
      assert.ok(Math.min(...asked) <= anchored.index, `paging starts where the row is: ${asked}`)
      assert.ok(store.runtime.s1.turnStart <= anchored.index, 'the loaded window reaches the saved row')
      const restored = topRow()
      assert.equal(restored.index, anchored.index, 'the saved row is the reading row again')
      near(restored.offset, anchored.offset, 'at its saved offset')
    } else if (name === 'window-without-summary') {
      // A live session over the window size: the minimap holds only the loaded turns, at their own index.
      const total = 2000
      const start = total - 60
      change({ turns: turns(total).slice(start), turnStart: start, turnSummary: [] })
      await render()
      atEnd()
      const first = container.querySelectorAll<HTMLButtonElement>('[role="navigation"] button')[0]
      assert.ok(first, 'the loaded window still gets bars')
      assert.match(first.getAttribute('aria-label') ?? '', /第 1941 轮/)
      await act(async () => { first.click() })
      await settle()
      assert.ok(!preloaded.includes(0), 'the bar must not ask for the branch start: ' + preloaded.join(', '))
      assert.ok(row(1940), 'the first bar jumps to its own turn, not to the first turn')
      assert.equal(topRow().index, 1940)
    } else if (name === 'remote-history') {
      // A tail window of a 2000-turn history: everything above it is still on disk.
      const total = 2000
      const start = total - 60
      change({
        turns: turns(total).slice(start),
        turnStart: start,
        turnSummary: turns(total).map((turn) => ({ id: turn.id, bytes: 12, hasImages: false })) as never
      })
      await render()
      atEnd()
      assert.equal(rows().length, 20, 'only the tail of the loaded window mounts')
      const older = container.querySelector<HTMLButtonElement>('[data-turn-index="1930"]')
      assert.ok(older, 'a turn that was never loaded still gets a minimap bar')
      assert.match(older.getAttribute('aria-label') ?? '', /第 1931 轮/, 'the bar is labelled from the summary')
      await act(async () => { older.click() })
      await settle()
      assert.equal(preloaded[0], 1930, 'the jump fetches the missing range it needs')
      assert.ok(row(1930), 'the fetched page mounts')
      assert.equal(rows()[0]?.dataset.turnIndex, '1930', 'the fetched turn is the top row')
      assert.ok(rowOffset(1930) <= ROW_HEIGHT, `the fetched turn sits at the fold: ${rowOffset(1930)}`)
      const beforePrepend = preloaded.length
      let anchored = topRow()
      for (let round = 0; round < 5 && preloaded.length === beforePrepend; round += 1) {
        await act(async () => { input('wheel', viewport()); viewport().scrollTop = 0 })
        anchored = topRow()
        await settle()
      }
      assert.ok(preloaded.length > beforePrepend, 'reaching the top of the window loads the page above it')
      assert.ok(
        preloaded.slice(1).every((value, index) => value === preloaded[index]! - 40),
        `older pages walk upwards: ${preloaded.join(', ')}`
      )
      assert.equal(rows().length, 40, 'the mounted window stays bounded')
      assert.ok(store.runtime.s1.turnStart < 1930, 'the window grew above the turn the reader is on')
      assert.equal(rowOffset(anchored.index), anchored.offset, 'loading above keeps the reading row and its offset')
      const settled = preloaded.length
      const scrolled = viewport().scrollTop
      await act(async () => { input('wheel', viewport()); viewport().scrollTop = scrolled + 30 })
      await settle()
      assert.equal(preloaded.length, settled, 'reading downwards does not fetch older turns')
    } else if (name === 'page-above-reachable') {
      const total = 2000
      const start = 1850
      change({
        turns: turns(total).slice(start),
        turnStart: start,
        turnSummary: turns(total).map((turn) => ({ id: turn.id, bytes: 12, hasImages: false })) as never
      })
      await render()
      atEnd()
      // The reader pages up locally until the window cannot move any further, and ends at the very
      // top of the scroll range.
      for (let round = 0; round < 6; round += 1) {
        await act(async () => { input('wheel', viewport()); viewport().scrollTop = 0 })
        await settle()
      }
      await act(async () => { viewport().scrollTop = 0 })
      const parked = store.runtime.s1.turnStart
      const anchored = topRow()
      assert.equal(viewport().scrollTop, 0, 'the reader sits at the very top')
      // A page lands while they are still there: there is no scroll event left to page it in, so
      // the hint is what mounts it.
      await act(async () => { await store.loadOlderTurns('s1') })
      await settle()
      assert.ok(store.runtime.s1.turnStart < parked, 'a page landed above the loaded window')
      assert.deepEqual(topRow(), anchored, 'the landing itself keeps the reading row in place')
      const hint = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '加载更早消息')
      assert.ok(hint, 'the hint is a control, not just a promise')
      await act(async () => { hint.click() })
      await settle()
      const first = Number(rows()[0]?.dataset.turnIndex)
      assert.ok(
        Number.isFinite(first) && first <= anchored.index - 20,
        `the hint mounts the page that landed: first=${first}, before=${anchored.index}`
      )
      assert.deepEqual(topRow(), anchored, 'mounting it above keeps the reading row in place')
      assert.ok(viewport().scrollTop > 0, 'the page above leaves room to keep scrolling')
      const reached = Number(rows()[0]?.dataset.turnIndex)
      for (let round = 0; round < 4; round += 1) {
        await act(async () => {
          input('wheel', viewport())
          viewport().scrollTop = Math.max(0, viewport().scrollTop - 400)
        })
        await settle()
      }
      assert.ok(Number(rows()[0]?.dataset.turnIndex) < reached, 'scrolling up keeps mounting older turns')
    } else if (name === 'resize-history') {
      change({ turns: turns(80) })
      await render()
      const paused = await leaveEnd(1000)
      const anchored = topRow()
      const above = row(anchored.index - 2)
      assert.ok(above?.dataset.turnKey, 'an above-viewport history row must be mounted')
      heights.set(above.dataset.turnKey, ROW_HEIGHT + 120)
      change({ turns: [...store.runtime.s1.turns] })
      await render()
      near(viewport().scrollTop, paused + 120, 'an above-viewport growth pushes the viewport down')
      assert.deepEqual(topRow(), anchored, 'the reading row keeps its offset')
    } else if (name === 'switch-unmount-cleanup') {
      await render()
      const idle = viewport()
      await leaveEnd(2000)
      await switchTo('s2', false)
      const afterSwitch = writes.length
      await settle()
      assert.ok(writes.slice(afterSwitch).every((write) => write.element !== idle),
        'a hidden pane is never scrolled by its own timers or observers')
      await act(async () => { root.unmount() })
      mounted = false
      const afterUnmount = writes.length
      assert.equal(frames.size, 0, 'unmount cancels pending animation frames')
      assert.equal(timers.size, 0, 'unmount cancels pending scroll timers')
      assert.equal(
        [...GeometryResizeObserver.instances].reduce((sum, observer) => sum + observer.targets.size, 0), 0,
        'unmount releases resize targets')
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
    'fold-pauses': 'folding pauses following before later history growth',
    'restore-branch': 'paused offsets are restored when a branch view returns',
    'restore-missing-anchor': 'a snapshot whose turn vanished falls back to its saved offset',
    'prompt-follows': 'a new live turn follows the answer as it grows',
    'release-wheel': 'wheel input releases following until the bottom control resumes it',
    'release-touch': 'touch input releases following until the bottom control resumes it',
    'release-key': 'keyboard input releases following until the bottom control resumes it',
    'paused-live-across-tabs': 'a paused live turn keeps its position across tabs',
    'archive-identity': 'archiving reuses the live row and a later prompt follows again',
    'resize-history': 'an above-viewport size change keeps a paused reader in place',
    paging: 'long histories mount one page and paging keeps the reading position',
    'minimap-jump': 'minimap navigation mounts and aligns an older turn',
    'far-jump': 'a far minimap jump pages the window instead of reading the whole gap',
    'window-without-summary': 'a windowed minimap jumps by the branch turn behind each bar',
    'return-to-branch-window': 'returning to a branch pages back to the saved reading row',
    'pending-window-status': 'a provisional window asks for its window instead of pretending to page',
    'empty-window-error': 'an empty window with a failed read still shows the failure',
    'remote-history': 'a windowed history loads older turns on demand and keeps the reading position',
    'switch-unmount-cleanup': 'hidden panes stay quiet and unmount cancels detached work'
  }
  for (const [name, title] of Object.entries(fixtures)) {
    test(`chat view scroll: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--chat-view-scroll-fixture', name], {
        cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 25_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(exitCode, 0, stderr || stdout)
      } finally { clearTimeout(timeout); child.kill() }
    }, 30_000)
  }
}

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { useMessageScroller } from '@shadcn/react/message-scroller'

type Scroller = ReturnType<typeof useMessageScroller>
type Row = { id: string; height: number; anchor?: boolean }
type Session = {
  id: string
  rows: Row[]
  autoScroll?: boolean
  defaultScrollPosition?: 'start' | 'end' | 'last-anchor'
  viewport?: boolean
  onLayout?: (api: Scroller) => void
}

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h, useLayoutEffect } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const {
    MessageScroller: Primitive,
    useMessageScroller,
    useMessageScrollerScrollable,
    useMessageScrollerVisibility
  } = await import('@shadcn/react/message-scroller')

  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Map<number, () => void>()
  const scrollEvents = new Set<HTMLElement>()
  let nextId = 1
  window.requestAnimationFrame = (callback) => {
    const id = nextId++
    frames.set(id, callback)
    return id
  }
  window.cancelAnimationFrame = (id) => { frames.delete(id) }
  window.setTimeout = ((callback: () => void) => {
    const id = nextId++
    timers.set(id, callback)
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = (id) => { timers.delete(id!) }

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

  // Synthetic geometry and a deterministic frame queue test behavior, not browser layout or performance.
  const positions = new WeakMap<HTMLElement, number>()
  const writes: { viewport: HTMLElement; top: number; behavior?: ScrollBehavior; native: boolean }[] = []
  const viewportOf = (element: HTMLElement) => element.closest<HTMLElement>('[data-viewport]')
  const contentOf = (viewport: HTMLElement) => viewport.querySelector<HTMLElement>('[data-content]')!
  const heightOf = (element: HTMLElement): number => element.hasAttribute('data-message-scroller-spacer')
    ? element.hidden ? 0 : Number.parseFloat(element.style.height) || 0
    : Number(element.dataset.height) || 0
  const contentHeight = (viewport: HTMLElement) => [...(contentOf(viewport)?.children ?? [])]
    .reduce((sum, child) => sum + heightOf(child as HTMLElement), 0)
  const maxScroll = (viewport: HTMLElement) => Math.max(0, contentHeight(viewport) - 100)
  const currentTop = (viewport: HTMLElement) => {
    const value = Math.max(0, Math.min(positions.get(viewport) ?? 0, maxScroll(viewport)))
    positions.set(viewport, value)
    return value
  }
  const applyScroll = (viewport: HTMLElement, top: number, native: boolean, behavior?: ScrollBehavior) => {
    writes.push({ viewport, top, native, behavior })
    positions.set(viewport, Math.max(0, Math.min(top, maxScroll(viewport))))
    scrollEvents.add(viewport)
  }
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get() { return this.hasAttribute('data-viewport') ? 100 : 0 } },
    scrollHeight: { configurable: true, get() { return this.hasAttribute('data-viewport') ? Math.max(100, contentHeight(this)) : 0 } },
    scrollTop: {
      configurable: true,
      get() { return currentTop(this) },
      set(value: number) { applyScroll(this, value, false) }
    }
  })
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    applyScroll(this, typeof options === 'number' ? y ?? 0 : options?.top ?? currentTop(this), true,
      typeof options === 'number' ? undefined : options?.behavior)
  }
  HTMLElement.prototype.getBoundingClientRect = function () {
    const viewport = viewportOf(this)
    if (!viewport) return new DOMRect(0, 0, 300, 0)
    if (this === viewport) return new DOMRect(0, 0, 300, 100)
    if (this.hasAttribute('data-content')) return new DOMRect(0, -currentTop(viewport), 300, contentHeight(viewport))
    let top = -currentTop(viewport)
    for (const sibling of this.parentElement?.children ?? []) {
      if (sibling === this) break
      top += heightOf(sibling as HTMLElement)
    }
    return new DOMRect(0, top, 300, heightOf(this))
  }

  const apis = new Map<string, Scroller>()
  function Probe({ session }: { session: Session }) {
    const api = useMessageScroller()
    useMessageScrollerScrollable()
    useMessageScrollerVisibility()
    apis.set(session.id, api)
    useLayoutEffect(() => { session.onLayout?.(api) }, [api, session.onLayout])
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let mounted = true
  const api = (id = 'a') => apis.get(id)!
  const viewport = (id = 'a') => container.querySelector<HTMLElement>(`[data-viewport="${id}"]`)!
  const spacer = (id = 'a') => viewport(id).querySelector<HTMLElement>('[data-message-scroller-spacer]')!
  const rows = (heights = [100, 100, 100]): Row[] => heights.map((height, index) => ({ id: `m${index}`, height }))
  const makeSession = (patch: Partial<Session> = {}): Session => ({ id: 'a', rows: rows(), autoScroll: true, ...patch })
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(0)
      for (let round = 0; round < 20; round++) {
        const callbacks = [...frames]
        frames.clear()
        for (const [, callback] of callbacks) callback(round * 16)
        const events = [...scrollEvents]
        scrollEvents.clear()
        for (const element of events) {
          if (element.isConnected) element.dispatchEvent(new Event('scroll'))
        }
        await Bun.sleep(0)
        if (!frames.size && !scrollEvents.size) return
      }
      assert.fail('Scroller did not settle: unexpected persistent frame loop')
    })
  }
  // createElement, unlike JSX, has no allowance for unknown data-* props on a typed component.
  const withData = (props: Record<string, unknown>) => props as never
  const render = async (sessions: Session[], flush = true) => {
    await act(async () => {
      root.render(sessions.map((session) => h(Primitive.Provider, {
        key: session.id,
        autoScroll: session.autoScroll,
        defaultScrollPosition: session.defaultScrollPosition ?? 'end',
        scrollPreviousItemPeek: 0
      }, h(Probe, { session }), session.viewport === false ? null : h(Primitive.Root, withData({ 'data-session': session.id }),
        h(Primitive.Viewport, withData({ 'data-viewport': session.id }),
          h(Primitive.Content, withData({ 'data-content': session.id }), session.rows.map((row) => h(Primitive.Item, withData({
            key: row.id,
            messageId: row.id,
            scrollAnchor: row.anchor,
            'data-height': row.height
          }), row.id)))
        ), h(Primitive.Button, withData({ 'data-end-button': session.id, behavior: 'auto' }))
      ))))
    })
    if (flush) await settle()
  }
  const resize = async (id = 'a') => {
    GeometryResizeObserver.notify(viewport(id))
    GeometryResizeObserver.notify(contentOf(viewport(id)))
    await settle()
  }
  const command = async (callback: () => void) => {
    await act(async () => { callback() })
    await settle()
  }
  const userScroll = async (top: number, id = 'a') => {
    positions.set(viewport(id), top)
    await command(() => { viewport(id).dispatchEvent(new Event('scroll')) })
  }
  const state = (top: number, following: boolean, id = 'a') => {
    const actual = api(id).getScrollState()
    assert.deepEqual({ scrollTop: actual.scrollTop, following: actual.following }, { scrollTop: top, following })
  }
  const noWrites = async (callback: () => Promise<void>) => {
    const count = writes.length
    await callback()
    assert.equal(writes.length, count, 'Paused updates must not write scrollTop or call scrollTo')
  }

  try {
    if (name === 'follow') {
      let session = makeSession()
      await render([session])
      state(200, true)
      for (const height of [120, 180, 260, 320]) {
        session = { ...session, rows: rows([100, 100, height]) }
        await render([session])
        await resize()
        state(100 + height, true)
      }
      session = { ...session, rows: [...session.rows, { id: 'new', height: 80 }] }
      await render([session])
      state(500, true)
      assert.equal(viewport().getAttribute('data-scrollable'), 'start')
      assert.equal(container.querySelector('[data-end-button]')?.getAttribute('data-active'), 'false')
    } else if (name === 'pause') {
      let session = makeSession()
      await render([session])
      assert.ok(timers.size > 0)
      assert.ok(viewport().hasAttribute('data-autoscrolling'))
      await noWrites(async () => { await command(() => { api().pauseAutoScroll() }) })
      state(200, false)
      assert.equal(timers.size, 0)
      assert.equal(viewport().hasAttribute('data-autoscrolling'), false)
      assert.equal(container.querySelector('[data-session]')?.hasAttribute('data-autoscrolling'), false)
      await noWrites(async () => {
        await userScroll(196)
        await resize()
        state(196, false)
        session = { ...session, rows: rows([100, 100, 96]) }
        await render([session])
        await userScroll(196)
        await resize()
        state(196, false)
        session = { ...session, rows: rows([100, 100, 140]) }
        await render([session])
        await resize()
        state(196, false)
        session = { ...session, rows: [...session.rows, { id: 'anchor', height: 30, anchor: true }] }
        await render([session])
        await resize()
        state(196, false)
        assert.equal(spacer().hidden, true)
        session = { ...session, rows: [{ id: 'older', height: 70, anchor: true }, ...session.rows] }
        await render([session])
        state(196, false)
        session = { ...session, defaultScrollPosition: 'last-anchor' }
        await render([session])
        await render([{ ...session, autoScroll: false }])
        await render([session])
        state(196, false)
      })
      assert.equal(container.querySelector('[data-end-button]')?.getAttribute('data-active'), 'true')
    } else if (name === 'offset') {
      let session = makeSession()
      await render([session])
      await command(() => {
        assert.equal(api().scrollToOffset(75.25), true)
        state(75.25, false)
      })
      assert.deepEqual(writes.at(-1), { viewport: viewport(), top: 75.25, native: true, behavior: 'auto' })
      await noWrites(async () => {
        session = { ...session, rows: [...rows([100, 100, 160]), { id: 'anchor', height: 50, anchor: true }] }
        await render([session])
        await resize()
        state(75.25, false)
      })
      await command(() => { assert.equal(api().scrollToOffset(75.25, { behavior: 'smooth' }), true) })
      assert.deepEqual(writes.at(-1), { viewport: viewport(), top: 75.25, native: true, behavior: 'smooth' })
      await command(() => { assert.equal(api().scrollToOffset(-20), true) })
      state(0, false)
      await command(() => { assert.equal(api().scrollToOffset(10_000), true) })
      state(310, false)
      await noWrites(async () => { await resize(); state(310, false) })
      await command(() => { assert.equal(api().scrollToEnd({ behavior: 'auto' }), true) })
      state(310, true)
      session = { ...session, rows: [...session.rows.slice(0, -1), { id: 'anchor', height: 120, anchor: true }] }
      await render([session])
      await resize()
      state(380, true)
      await command(() => { api().scrollToOffset(20) })
      await command(() => { container.querySelector<HTMLButtonElement>('[data-end-button]')!.click() })
      state(380, true)
    } else if (name === 'intent') {
      await render([makeSession()])
      for (const event of [
        new WheelEvent('wheel', { bubbles: true, deltaY: 10 }),
        new Event('touchmove', { bubbles: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' })
      ]) {
        await command(() => { api().scrollToOffset(100) })
        await userScroll(200)
        state(200, false)
        await command(() => { viewport().dispatchEvent(event) })
        state(200, false)
        await userScroll(200)
        state(200, true)
        await resize()
        state(200, true)
      }
      await command(() => { api().scrollToOffset(100) })
      await command(() => { viewport().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' })) })
      await userScroll(200)
      state(200, false)
      await command(() => { viewport().dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -10 })) })
      await userScroll(80)
      state(80, false)
      await resize()
      state(80, false)
      await userScroll(200)
      state(200, true)
    } else if (name === 'default') {
      const session = makeSession({ rows: [], autoScroll: false })
      await render([session])
      state(0, false)
      assert.equal(container.querySelector('[data-pending-scroll]'), null)
      await render([{ ...session, rows: rows() }])
      state(200, false)
      await render([{ ...session, rows: rows([100, 100, 180]) }])
      await resize()
      state(200, false)
    } else if (name === 'empty-paused') {
      const session = makeSession({ rows: [] })
      await render([session])
      await command(() => { assert.equal(api().scrollToMessage('future'), true) })
      await noWrites(async () => {
        await command(() => { api().pauseAutoScroll() })
        await render([{ ...session, rows: [...rows(), { id: 'future', height: 20, anchor: true }] }])
        await resize()
        state(0, false)
        assert.equal(spacer().hidden, true)
        assert.equal(container.querySelector('[data-pending-scroll]'), null)
      })
    } else if (name === 'pending-frame') {
      const session = makeSession({ rows: [] })
      await render([session])
      await command(() => { assert.equal(api().scrollToMessage('future'), true) })
      await render([{ ...session, rows: [...rows(), { id: 'future', height: 30, anchor: true }] }], false)
      await command(() => { api().pauseAutoScroll() })
      const top = api().getScrollState().scrollTop
      await noWrites(async () => { await settle() })
      state(top, false)
    } else if (name === 'anchor') {
      let session = makeSession()
      await render([session])
      session = { ...session, rows: [...session.rows, { id: 'anchor', height: 20, anchor: true }] }
      await render([session])
      state(300, false)
      assert.equal(spacer().hidden, false)
      assert.equal(spacer().style.height, '80px')
      await noWrites(async () => { await command(() => { api().pauseAutoScroll() }) })
      state(300, false)
      assert.equal(spacer().style.height, '80px')
      await noWrites(async () => {
        session = { ...session, rows: [...session.rows.slice(0, -1), { id: 'anchor', height: 200, anchor: true }] }
        await render([session])
        await resize()
        state(300, false)
        assert.equal(spacer().style.height, '80px')
      })
      await command(() => { assert.equal(api().scrollToOffset(30), true) })
      state(30, false)
      assert.equal(spacer().hidden, true)
      assert.equal(spacer().style.height, '0px')
      await command(() => { assert.equal(api().scrollToMessage('m1', { behavior: 'auto' }), true) })
      state(100, false)
      await command(() => { assert.equal(api().scrollToStart({ behavior: 'auto' }), true) })
      state(0, false)
      await command(() => { assert.equal(api().scrollToEnd({ behavior: 'auto' }), true) })
      state(400, true)
    } else if (name === 'explicit-anchor') {
      let session = makeSession()
      await render([session])
      await command(() => { api().scrollToOffset(50) })
      session = { ...session, rows: [...session.rows, { id: 'live', height: 20 }] }
      await render([session])
      state(50, false)
      await command(() => {
        assert.equal(api().scrollToMessage('live', { anchor: true, behavior: 'auto' }), true)
      })
      state(300, false)
      assert.equal(spacer().style.height, '80px')
      for (const height of [40, 80]) {
        session = { ...session, rows: [...rows(), { id: 'live', height }] }
        await render([session])
        await resize()
        state(300, false)
        assert.equal(spacer().style.height, `${100 - height}px`)
      }
      for (const height of [120, 200]) {
        session = { ...session, rows: [...rows(), { id: 'live', height }] }
        await render([session])
        await resize()
        state(200 + height, true)
        assert.equal(spacer().hidden, true)
      }
      await command(() => { api().scrollToMessage('m1', { behavior: 'auto' }) })
      state(100, false)
      await noWrites(async () => {
        session = { ...session, rows: [...rows(), { id: 'live', height: 260 }] }
        await render([session])
        await resize()
        state(100, false)
      })
    } else if (name === 'anchor-state') {
      let session = makeSession({ rows: [...rows(), { id: 'live', height: 20 }] })
      await render([session])
      assert.equal(api().getScrollState().anchoredMessageId, null)
      await command(() => { api().scrollToMessage('live', { anchor: true }) })
      assert.equal(api().getScrollState().anchoredMessageId, 'live')
      await command(() => { api().pauseAutoScroll() })
      assert.equal(api().getScrollState().anchoredMessageId, null)
      await command(() => { api().scrollToMessage('live', { anchor: true }) })
      session = { ...session, rows: [...rows(), { id: 'live', height: 60 }] }
      await render([session])
      await resize()
      assert.equal(api().getScrollState().anchoredMessageId, 'live')
      session = { ...session, rows: [...rows(), { id: 'live', height: 160 }] }
      await render([session])
      await resize()
      assert.equal(api().getScrollState().anchoredMessageId, null)
      state(360, true)
      await command(() => { api().scrollToMessage('live', { anchor: true }) })
      assert.equal(api().getScrollState().anchoredMessageId, 'live')
      await render([{ ...session, rows: rows() }])
      assert.equal(api().getScrollState().anchoredMessageId, null)
    } else if (name === 'anchored-intent') {
      for (const event of [
        new WheelEvent('wheel', { bubbles: true, deltaY: -10 }),
        new Event('touchmove', { bubbles: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' })
      ]) {
        let session = makeSession({ rows: [...rows(), { id: 'live', height: 20 }] })
        await render([session])
        await command(() => { api().scrollToOffset(0) })
        await command(() => { api().scrollToMessage('live', { anchor: true }) })
        state(300, false)
        assert.equal(api().getScrollState().anchoredMessageId, 'live')
        await command(() => { viewport().dispatchEvent(event) })
        assert.equal(api().getScrollState().anchoredMessageId, null)
        await userScroll(200)
        await noWrites(async () => {
          session = { ...session, rows: [...rows(), { id: 'live', height: 60 }] }
          await render([session])
          await resize()
          state(200, false)
        })
        await command(() => { container.querySelector<HTMLButtonElement>('[data-end-button]')!.click() })
        state(260, true)
        assert.equal(spacer().hidden, true)
        session = { ...session, rows: [...rows(), { id: 'live', height: 140 }] }
        await render([session])
        await resize()
        state(340, true)
      }
    } else if (name === 'pending-anchor') {
      let session = makeSession({ rows: [] })
      await render([session])
      await command(() => {
        api().pauseAutoScroll()
        assert.equal(api().scrollToMessage('future', { anchor: true }), true)
      })
      session = { ...session, rows: [...rows(), { id: 'future', height: 20 }] }
      await render([session])
      state(300, false)
      assert.equal(spacer().style.height, '80px')
      session = { ...session, rows: [...rows(), { id: 'future', height: 200 }] }
      await render([session])
      await resize()
      state(400, true)
      assert.equal(spacer().hidden, true)
    } else if (name === 'pending-intent') {
      for (const [index, event] of [
        new WheelEvent('wheel', { bubbles: true, deltaY: -10 }),
        new Event('touchmove', { bubbles: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 'Home' })
      ].entries()) {
        const id = `pending-${index}`
        let session = makeSession({ id, rows: [] })
        await render([session])
        await command(() => {
          assert.equal(api(id).scrollToMessage('future', { anchor: true }), true)
        })
        session = { ...session, rows: rows() }
        await render([session])
        await command(() => { viewport(id).dispatchEvent(event) })
        await userScroll(100, id)
        await noWrites(async () => {
          session = { ...session, rows: [...rows(), { id: 'future', height: 20 }] }
          await render([session])
          await resize(id)
          state(100, false, id)
        })
      }
    } else if (name === 'pending-frame-intent') {
      for (const [index, event] of [
        new WheelEvent('wheel', { bubbles: true, deltaY: -10 }),
        new Event('touchmove', { bubbles: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' })
      ].entries()) {
        const id = `pending-frame-${index}`
        const session = makeSession({ id, rows: [], autoScroll: false })
        await render([session])
        await command(() => {
          assert.equal(api(id).scrollToMessage('future', { anchor: true }), true)
        })
        await noWrites(async () => {
          await render([{
            ...session,
            rows: [...rows(), { id: 'future', height: 20 }],
            // Refs have registered the target, but its queued jump has not run yet.
            onLayout: () => { viewport(id).dispatchEvent(event) }
          }], false)
          await settle()
          await resize(id)
          state(0, false, id)
        })
      }
    } else if (name === 'invalid') {
      const session = makeSession()
      await render([session])
      const timerIds = [...timers.keys()]
      await noWrites(async () => {
        await command(() => {
          for (const value of [NaN, Infinity, -Infinity, undefined, null, '25']) {
            assert.equal(api().scrollToOffset(value as number), false)
            state(200, true)
          }
        })
      })
      assert.deepEqual([...timers.keys()], timerIds)
      await command(() => { api().scrollToOffset(60) })
      await noWrites(async () => {
        await command(() => { assert.equal(api().scrollToOffset(NaN), false) })
        state(60, false)
      })
      await render([{ ...session, id: 'unmounted', viewport: false }])
      const before = api('unmounted').getScrollState()
      assert.equal(before.scrollTop, 0)
      assert.equal(api('unmounted').scrollToOffset(20), false)
      assert.deepEqual(api('unmounted').getScrollState(), before)
      await command(() => { api('unmounted').pauseAutoScroll() })
      state(0, false, 'unmounted')
      await noWrites(async () => { await render([{ ...session, id: 'unmounted' }]); state(0, false, 'unmounted') })
    } else if (name === 'cleanup-isolation') {
      const first = makeSession()
      const second = makeSession({ id: 'b' })
      await render([first, second])
      state(200, true)
      state(200, true, 'b')
      await command(() => { api().scrollToOffset(80) })
      await render([{ ...first, rows: rows([100, 100, 150]) }, { ...second, rows: rows([100, 100, 150]) }])
      await resize('a')
      await resize('b')
      state(80, false)
      state(250, true, 'b')
      const stale = api()
      await render([{ ...second, rows: rows([100, 100, 150]) }])
      assert.equal(stale.getScrollState().scrollTop, 0)
      assert.equal(stale.scrollToOffset(120), false)
      state(250, true, 'b')
      await render([second, makeSession({ id: 'pending', rows: [] })])
      await command(() => { assert.equal(api('pending').scrollToMessage('future'), true) })
      await render([second, makeSession({ id: 'pending', rows: [{ id: 'future', height: 500 }] })], false)
      const oldViewport = viewport('b')
      GeometryResizeObserver.notify(oldViewport)
      GeometryResizeObserver.notify(contentOf(oldViewport))
      assert.ok(frames.size > 0)
      assert.ok(timers.size > 0)
      await act(async () => { root.unmount() })
      mounted = false
      assert.equal(GeometryResizeObserver.instances.size, 0)
      assert.equal(frames.size, 0)
      assert.equal(timers.size, 0)
      const count = writes.length
      GeometryResizeObserver.notify(oldViewport)
      await settle()
      assert.equal(writes.length, count)
      assert.equal(stale.scrollToOffset(5), false)
    } else {
      assert.fail(`Unknown fixture: ${name}`)
    }
  } finally {
    if (mounted) await act(async () => { root.unmount() })
    assert.equal(GeometryResizeObserver.instances.size, 0)
    assert.equal(frames.size, 0)
    assert.equal(timers.size, 0)
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--message-scroller-fixture') {
  await runFixture(process.argv[3])
} else {
  const fixtures = {
    follow: 'auto-follow tracks continuous growth and appended rows',
    pause: 'pause does not write at the bottom or near it, and ignores resize, rows, anchors and prepend',
    offset: 'offset uses native scrollTo, survives growth, and scrollToEnd/button resume following',
    intent: 'only wheel, touchmove and scrolling keys release pause; ordinary scroll does not',
    default: 'the first nonempty content still applies the default position with autoScroll disabled',
    'empty-paused': 'pause cancels a pending message and suppresses the first-nonempty fallback',
    'pending-frame': 'pause cancels an already scheduled message-jump animation frame',
    anchor: 'pause leaves anchor spacer untouched, offset clears it, and existing commands still work',
    'explicit-anchor': 'explicit anchoring overrides pause and hands growing content back to native bottom-follow',
    'anchor-state': 'scroll snapshots expose only a connected native anchor until pause, bottom-follow or removal',
    'anchored-intent': 'wheel, touch and scrolling keys release explicit anchoring; the button restores following',
    'pending-anchor': 'an explicit pending anchor keeps its growth behavior when the message mounts',
    'pending-intent': 'user scroll intent cancels a pending anchored message jump before its target mounts',
    'pending-frame-intent': 'user scroll intent also cancels an already registered target and its queued jump',
    invalid: 'invalid offsets and absent viewports reject without changing scroll state',
    'cleanup-isolation': 'providers isolate session state and unmount cancels observers, frames and timers'
  }
  for (const [name, title] of Object.entries(fixtures)) {
    test(`message-scroller DOM unit: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--message-scroller-fixture', name], {
        cwd: new URL('..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 10_000)
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

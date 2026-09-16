import { test } from 'bun:test'
import assert from 'node:assert/strict'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function fixture(scenario: string): Promise<void> {
  const { mock } = await import('bun:test')
  if (scenario === 'highlight') {
    const language = deferred<void>()
    let creations = 0
    let loads = 0
    let renders = 0
    const engines: unknown[] = []
    const loaded = new Set<string>()
    mock.module('shiki', () => ({
      bundledLanguages: { python: {}, typescript: {} },
      createOnigurumaEngine: (wasm: unknown) => {
        engines.push(wasm)
        return {}
      },
      createHighlighter: async () => {
        creations++
        if (creations === 1) throw new Error('Highlighter initialization failed')
        return {
          getLoadedLanguages: () => [...loaded],
          loadLanguage: async (lang: string) => { loads++; await language.promise; loaded.add(lang) },
          codeToHtml: (code: string, options: { theme: string; lang: string }) => {
            renders++
            return `${options.theme}:${options.lang}:${code}`
          }
        }
      }
    }))
    const { highlightHtml } = await import('../src/renderer/src/lib/highlight')
    await assert.rejects(highlightHtml('retry', 'plaintext'), /initialization failed/)
    const one = highlightHtml('first', 'python')
    const duplicate = highlightHtml('first', 'python')
    const two = highlightHtml('second', 'python')
    assert.equal(one, duplicate)
    await Promise.resolve()
    await Promise.resolve()
    language.resolve()
    assert.deepEqual(await Promise.all([one, two]), ['github-dark:python:first', 'github-dark:python:second'])
    assert.equal(creations, 2)
    assert.equal(loads, 1)
    assert.equal(renders, 2)
    assert.equal(await highlightHtml('first', 'python'), 'github-dark:python:first')
    assert.equal(renders, 2)
    assert.equal(await highlightHtml('first', 'python', 'github-light'), 'github-light:python:first')
    assert.equal(await highlightHtml('unknown', 'not-a-language'), 'github-dark:plaintext:unknown')
    assert.equal(engines.length, 2, 'the retry rebuilds the engine')
    assert.equal(typeof engines[0], 'function', 'highlighting runs on the WASM engine, not the JS one')
    for (let i = 0; i < 205; i++) await highlightHtml(String(i), 'plaintext')
    const before = renders
    await highlightHtml('first', 'python')
    assert.equal(renders, before + 1, 'the cache evicts entries past its cap')
    return
  }

  if (scenario === 'mermaid') {
    const first = deferred<{ svg: string }>()
    const themes: string[] = []
    const ids: string[] = []
    mock.module('mermaid', () => ({ default: {
      initialize: (options: { theme: string; suppressErrorRendering: boolean }) => {
        themes.push(options.theme)
        assert.equal(options.suppressErrorRendering, true)
      },
      render: async (id: string, code: string) => {
        ids.push(id)
        if (code === 'first') return first.promise
        if (code === 'invalid') throw new Error('Invalid diagram')
        return { svg: code }
      }
    } }))
    const { renderMermaid } = await import('../src/renderer/src/lib/mermaid-renderer')
    const one = renderMermaid('first', false, new AbortController().signal)
    const controller = new AbortController()
    const cancelled = renderMermaid('cancelled', true, controller.signal).catch((error) => error)
    const two = renderMermaid('second', true, new AbortController().signal)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(themes, ['default'])
    controller.abort()
    first.resolve({ svg: 'first' })
    assert.equal(await one, 'first')
    assert.equal((await cancelled).name, 'AbortError')
    assert.equal(await two, 'second')
    assert.deepEqual(themes, ['default', 'dark'])
    assert.equal(new Set(ids).size, 2)
    await assert.rejects(renderMermaid('invalid', false, new AbortController().signal), /Invalid diagram/)
    assert.equal(await renderMermaid('after-error', false, new AbortController().signal), 'after-error')
    return
  }

  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement, useRef } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    if (scenario === 'model-controls') {
      const { create } = await import('zustand')
      let applied = 0
      let calls = 0
      const store = create(() => ({
        runtime: { one: { instanceId: 1, controlsPending: false, controlsError: null as string | null } },
        applyControls: () => { applied++ },
        setControlsStatus: (id: string, status: Record<string, unknown>) => store.setState((state) => ({
          runtime: { ...state.runtime, [id]: { ...state.runtime[id], ...status } }
        }))
      }))
      mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: store }))
      const { useModelControls } = await import('../src/renderer/src/components/composer/useModelControls')
      let state!: ReturnType<typeof useModelControls>
      function Probe() { state = useModelControls('one'); return null }
      await act(async () => { root.render(createElement(Probe)) })
      const pending = deferred<any>()
      let running!: Promise<boolean>
      await act(async () => {
        running = state.run(() => { calls++; return pending.promise })
        assert.equal(await state.run(() => { calls++; return Promise.resolve({} as any) }), false)
      })
      assert.equal(calls, 1)
      assert.equal(state.pending, true)
      await act(async () => { pending.reject(new Error('Model failed')); await running })
      assert.equal(state.pending, false)
      assert.equal(state.error, 'Model failed')
      const replaced = deferred<any>()
      await act(async () => { running = state.run(() => replaced.promise) })
      // A closed and reopened session is a new instance with fresh flags of its own.
      store.setState({ runtime: { one: { instanceId: 2, controlsPending: false, controlsError: null } } })
      await act(async () => { replaced.resolve({}); await running })
      assert.equal(applied, 0)
      assert.equal(state.pending, false)
      await act(async () => { assert.equal(await state.run(async () => ({} as any)), true) })
      assert.equal(applied, 1)
      assert.equal(state.pending, false)
      assert.equal(state.error, null)
    } else if (scenario === 'worked-label') {
      const { create } = await import('zustand')
      const store = create(() => ({ activeSessionId: 'one', runtime: { one: { streamStartedAt: 100, streamElapsedMs: 500 } } }))
      mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: store }))
      const { useWorkedMs } = await import('../src/renderer/src/components/turn/useWorkedMs')
      let renders = 0
      function Probe() {
        renders++
        const elapsed = useWorkedMs({ id: 'history', streaming: false, workedMs: 1200 } as any)
        return createElement('span', null, elapsed)
      }
      await act(async () => { root.render(createElement(Probe)) })
      const before = renders
      await act(async () => { store.setState({ runtime: { one: { streamStartedAt: 1000, streamElapsedMs: 3000 } } }) })
      assert.equal(renders, before)
      assert.equal(container.textContent, '1200')
    } else if (scenario === 'turn-timer' || scenario === 'turn-process') {
      const { create } = await import('zustand')
      let now = 1000
      const originalNow = Date.now
      Date.now = () => now
      const store = create(() => ({ activeSessionId: 'one', runtime: { one: { streamStartedAt: 0, streamElapsedMs: null } } }))
      mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: store }))
      let processRenders = 0
      mock.module('../src/renderer/src/components/turn/TurnProcess', () => ({
        ProcessOutline: () => { processRenders++; return createElement('div', { 'data-process': '' }) },
        ProcessList: () => { processRenders++; return createElement('div', { 'data-process': '' }) }
      }))
      mock.module('../src/renderer/src/components/turn/TurnMessages', () => ({ UserBubble: () => null, Answer: () => null }))
      const ticks: Array<() => void> = []
      window.setInterval = ((callback: () => void) => { ticks.push(callback); return ticks.length }) as typeof window.setInterval
      window.clearInterval = () => {}
      const { TurnView } = await import('../src/renderer/src/components/TurnView')
      const turn = { id: 'history', streaming: scenario === 'turn-timer', hasProcess: true, process: [], answer: [], startedAt: 0, endedAt: 1000 }
      let requested = deferred<void>()
      const load = () => requested.promise
      try {
        await act(async () => { root.render(createElement(TurnView, { turn, onNeedProcess: load })) })
        if (scenario === 'turn-timer') {
          const before = processRenders
          now = 5000
          await act(async () => { for (const tick of ticks) tick() })
          assert.equal(processRenders, before)
          assert.match(container.textContent ?? '', /5/)
        } else {
          const button = () => container.querySelector<HTMLButtonElement>('button')!
          await act(async () => { button().click() })
          await act(async () => { requested.reject(new Error('Process load failed')); await Promise.resolve() })
          assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Process load failed/)
          assert.equal(button().getAttribute('aria-expanded'), 'false')
          requested = deferred<void>()
          await act(async () => { button().click() })
          await act(async () => {
            root.render(createElement(TurnView, { turn: { ...turn, id: 'another-turn' }, onNeedProcess: load }))
          })
          await act(async () => { requested.resolve(); await Promise.resolve() })
          assert.equal(button().getAttribute('aria-expanded'), 'false')
          assert.equal(container.querySelector('[role="alert"]'), null)
        }
      } finally {
        Date.now = originalNow
      }
    } else if (scenario === 'highlight-fallback') {
      mock.module('shiki', () => ({
        bundledLanguages: {},
        createOnigurumaEngine: () => ({}),
        createHighlighter: async () => { throw new Error('Unavailable grammar engine') }
      }))
      const { useHighlightHtml } = await import('../src/renderer/src/lib/highlight')
      const frames: FrameRequestCallback[] = []
      globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
      globalThis.cancelAnimationFrame = () => {}
      function Probe() {
        const html = useHighlightHtml('fallback code', 'plaintext')
        return createElement('pre', null, html ?? 'fallback code')
      }
      await act(async () => { root.render(createElement(Probe)) })
      await act(async () => {
        for (const frame of frames) frame(0)
        await new Promise<void>((resolve) => setImmediate(resolve))
      })
      assert.equal(container.textContent, 'fallback code')
    } else if (scenario === 'highlight-viewport') {
      const rendered: string[] = []
      mock.module('shiki', () => ({
        bundledLanguages: { typescript: {} },
        createOnigurumaEngine: () => ({}),
        createHighlighter: async () => ({
          getLoadedLanguages: () => ['plaintext'],
          loadLanguage: async () => {},
          codeToHtml: (code: string) => { rendered.push(code); return `hl-${code}` }
        })
      }))
      mock.module('shiki/wasm', () => ({ default: () => ({}) }))
      const frames: FrameRequestCallback[] = []
      globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
      globalThis.cancelAnimationFrame = () => {}
      async function flush() {
        for (let pass = 0; pass < 4; pass++) {
          for (const frame of frames.splice(0)) frame(0)
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
      const observers: FakeObserver[] = []
      class FakeObserver {
        targets = new Set<Element>()
        callback: IntersectionObserverCallback
        options?: IntersectionObserverInit
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.callback = callback
          this.options = options
          observers.push(this)
        }
        observe(target: Element) { this.targets.add(target) }
        unobserve(target: Element) { this.targets.delete(target) }
        disconnect() { this.targets.clear() }
        takeRecords(): IntersectionObserverEntry[] { return [] }
        enter(...elements: Element[]) {
          this.callback(elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
        }
      }
      globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver
      const { useHighlightHtml } = await import('../src/renderer/src/lib/highlight')
      function Block({ n }: { n: number }) {
        const ref = useRef<HTMLDivElement>(null)
        const html = useHighlightHtml(`block-${n}`, 'plaintext', ref)
        return createElement('pre', { ref }, html ?? `plain-${n}`)
      }
      function Probe() {
        return createElement('div', null, [0, 1, 2, 3].map((n) => createElement(Block, { key: n, n })))
      }
      await act(async () => { root.render(createElement(Probe)) })
      await act(flush)
      const blocks = [...container.querySelectorAll('pre')]
      assert.equal(rendered.length, 0, 'nothing highlights before the observer reports visibility')
      assert.deepEqual(blocks.map((el) => el.textContent), ['plain-0', 'plain-1', 'plain-2', 'plain-3'])
      assert.equal(observers.length, 1, 'one observer serves every block')
      assert.equal(observers[0]!.options?.rootMargin, '600px 0px')
      // The blocks sit in a nested scroller, so the margin that matters is the scroll margin: a
      // rootMargin alone is clipped by the scrollport before it can prefetch anything.
      assert.equal(observers[0]!.options?.scrollMargin, '600px 0px')
      const observer = observers[0]!
      assert.equal(observer.targets.size, 4)
      await act(async () => { observer.enter(blocks[1]!, blocks[3]!) })
      await act(flush)
      assert.deepEqual(blocks.map((el) => el.textContent), ['plain-0', 'hl-block-1', 'plain-2', 'hl-block-3'])
      assert.equal(rendered.length, 2)
      assert.equal(observer.targets.size, 2, 'highlighted blocks stop being observed')
      await act(async () => { observer.enter(blocks[0]!) })
      await act(flush)
      assert.equal(blocks[0]!.textContent, 'hl-block-0')
      assert.equal(rendered.length, 3)
    } else if (scenario === 'highlight-no-observer') {
      const rendered: string[] = []
      mock.module('shiki', () => ({
        bundledLanguages: { typescript: {} },
        createOnigurumaEngine: () => ({}),
        createHighlighter: async () => ({
          getLoadedLanguages: () => ['plaintext'],
          loadLanguage: async () => {},
          codeToHtml: (code: string) => { rendered.push(code); return `hl-${code}` }
        })
      }))
      globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver
      mock.module('shiki/wasm', () => ({ default: () => ({}) }))
      const frames: FrameRequestCallback[] = []
      globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
      globalThis.cancelAnimationFrame = () => {}
      const { useHighlightHtml } = await import('../src/renderer/src/lib/highlight')
      function Block() {
        const ref = useRef<HTMLDivElement>(null)
        const html = useHighlightHtml('block-0', 'plaintext', ref)
        return createElement('pre', { ref }, html ?? 'plain-0')
      }
      await act(async () => { root.render(createElement(Block)) })
      for (let pass = 0; pass < 4; pass++) {
        await act(async () => { for (const frame of frames.splice(0)) frame(0); await new Promise<void>((resolve) => setImmediate(resolve)) })
      }
      assert.equal(container.textContent, 'hl-block-0', 'without an observer every block still highlights')
      assert.deepEqual(rendered, ['block-0'])
    } else {
      assert.fail(`Unknown scenario: ${scenario}`)
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--rendering-fixture') {
  await fixture(process.argv[3])
} else {
  for (const scenario of ['highlight', 'mermaid', 'model-controls', 'worked-label', 'turn-timer', 'turn-process', 'highlight-fallback', 'highlight-viewport', 'highlight-no-observer']) {
    test(`rendering lifecycle: ${scenario}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--rendering-fixture', scenario], { stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

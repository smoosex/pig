/**
 * The model toolbar awaits an IPC reply. A reply belongs to the session instance that asked: switching
 * tabs while one is in flight must not throw it away, or the toolbar keeps showing the old model until
 * the next turn refreshes the controls. The pending/error state must stay per session too, so a hidden
 * session's completion cannot clear the visible session's spinner.
 *
 * Only React is real here: the store, the hook and the tab switch are the ones the app runs. There is
 * no module mock, but the fixture still runs in a child process like the other renderer fixtures.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function model(id: string) {
  return { provider: id, id: `${id}-model`, name: id, providerName: id, contextWindow: 1000, reasoning: true }
}

async function fixture(scenario: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: {} })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { useModelControls } = await import('../src/renderer/src/components/composer/useModelControls')

  const controls = (id: string, thinkingLevel = 'off') => ({
    model: model(id), models: [model(id)], thinkingLevel, thinkingLevels: ['low', 'high'],
    contextUsage: null, followUpMessages: []
  })

  useSessionsStore.setState({
    openTabs: [
      { sessionId: 'a', cwd: '/project', title: 'A' },
      { sessionId: 'b', cwd: '/project', title: 'B' }
    ] as never,
    runtime: {
      a: { ...emptyRuntime(), model: model('old') },
      b: { ...emptyRuntime(), model: model('other') }
    },
    activeSessionId: 'a'
  })

  let actions!: ReturnType<typeof useModelControls>
  const shown: Array<{ sessionId: string | null; model: string | null }> = []
  function Probe() {
    const sessionId = useSessionsStore((s) => s.activeSessionId)
    const current = useSessionsStore((s) => (sessionId ? s.runtime[sessionId]?.model ?? null : null))
    actions = useModelControls(sessionId)
    shown.push({ sessionId, model: current?.id ?? null })
    return null
  }

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const runtime = () => useSessionsStore.getState().runtime

  try {
    await act(async () => { root.render(createElement(Probe)) })

    if (scenario === 'mounted-twice') {
      // Two toolbar mounts share one in-flight mutation through the runtime flag.
      let first!: ReturnType<typeof useModelControls>
      let second!: ReturnType<typeof useModelControls>
      function Pair() { first = useModelControls('a'); second = useModelControls('a'); return null }
      await act(async () => { root.render(createElement(Pair)) })
      const slow = deferred<never>()
      let acceptedFirst!: Promise<boolean>
      await act(async () => { acceptedFirst = first.run(() => slow.promise) })
      assert.equal(second.pending, true, 'the second mount sees the mutation in flight')
      await act(async () => {
        assert.equal(
          await second.run(() => Promise.resolve(controls('other') as never)),
          false,
          'the second mount cannot start a mutation of its own'
        )
      })
      await act(async () => {
        slow.resolve(controls('new') as never)
        assert.equal(await acceptedFirst, true)
      })
      assert.equal(runtime().a?.model?.id, 'new-model')
      assert.equal(second.pending, false)
      return
    }

    if (scenario === 'replaced') {
      const stale = deferred<never>()
      let acceptedStale!: Promise<boolean>
      await act(async () => { acceptedStale = actions.run(() => stale.promise) })
      // Closing and reopening the same session id builds a new runtime instance.
      await act(async () => {
        useSessionsStore.setState((state) => ({
          runtime: { ...state.runtime, a: { ...emptyRuntime(), model: model('reopened') } }
        }))
      })
      assert.equal(actions.pending, false, 'the reopened instance starts without the old flags')

      // The reopened instance takes a mutation of its own, which the old reply must not release.
      const fresh = deferred<never>()
      let acceptedFresh!: Promise<boolean>
      await act(async () => { acceptedFresh = actions.run(() => fresh.promise) })
      assert.equal(actions.pending, true)
      await act(async () => {
        stale.resolve(controls('stale') as never)
        assert.equal(await acceptedStale, false, 'the reply of the replaced instance is dropped')
      })
      assert.equal(actions.pending, true, 'a dropped reply cannot release the new instance')
      await act(async () => {
        fresh.resolve(controls('new') as never)
        assert.equal(await acceptedFresh, true)
      })
      assert.equal(runtime().a?.model?.id, 'new-model', 'the new instance lands its own controls')
      assert.equal(actions.pending, false, 'the new instance releases itself')
      return
    }

    const first = deferred<never>()
    let acceptedFirst!: Promise<boolean>
    await act(async () => { acceptedFirst = actions.run(() => first.promise) })
    assert.equal(actions.pending, true)

    await act(async () => { useSessionsStore.getState().setActive('b') })
    assert.equal(shown.at(-1)?.sessionId, 'b')
    assert.equal(actions.pending, false, 'the other session starts without the first session’s spinner')

    const second = deferred<never>()
    let acceptedSecond!: Promise<boolean>
    await act(async () => { acceptedSecond = actions.run(() => second.promise) })

    // The first session's reply lands while the second one is visible.
    await act(async () => {
      first.resolve(controls('new', 'high') as never)
      assert.equal(await acceptedFirst, true)
    })
    assert.equal(runtime().a?.model?.id, 'new-model', 'the reply reaches the session that asked')
    assert.equal(runtime().a?.thinkingLevel, 'high')
    assert.equal(actions.pending, true, 'a hidden session’s completion cannot clear the visible spinner')

    await act(async () => {
      second.resolve(controls('other2') as never)
      assert.equal(await acceptedSecond, true)
    })
    assert.equal(runtime().b?.model?.id, 'other2-model')
    assert.equal(actions.pending, false)

    await act(async () => { useSessionsStore.getState().setActive('a') })
    assert.equal(shown.at(-1)?.model, 'new-model', 'the toolbar shows the model the session switched to')
    assert.equal(actions.error, null)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--model-controls-fixture') {
  await fixture(process.argv[3] ?? 'switched')
} else {
  for (const scenario of ['switched', 'replaced', 'mounted-twice']) {
    test(`model controls survive a ${scenario} session`, async () => {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, '--model-controls-fixture', scenario],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

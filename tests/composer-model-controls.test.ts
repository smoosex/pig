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
  // The store persists tab selection through the bridge, so the stub has to answer that call.
  Object.assign(window, { api: { selectOpenProjectWorkspace: async () => {} } })
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
      { id: 'a', cwd: '/project', title: 'A', kind: 'project', loadState: 'ready' },
      { id: 'b', cwd: '/project', title: 'B', kind: 'project', loadState: 'ready' }
    ] as never,
    runtime: {
      a: { ...emptyRuntime(), model: model('old') },
      b: { ...emptyRuntime(), model: model('other') }
    },
    activeTabId: 'a'
  })

  let actions!: ReturnType<typeof useModelControls>
  const shown: Array<{ sessionId: string | null; model: string | null }> = []
  function Probe() {
    const sessionId = useSessionsStore((s) => s.activeTabId)
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

    if (scenario === 'shared-save' || scenario === 'shared-clear') {
      const { api } = await import('../src/renderer/src/ipc/api')
      const saving = scenario === 'shared-save'
      const before = saving ? null : 'high'
      const after = saving ? 'high' : null
      await act(async () => {
        useSessionsStore.setState((state) => ({
          openTabs: [...state.openTabs,
            { id: 'c', cwd: '/project', title: 'C', kind: 'project', loadState: 'ready' },
            { id: 'd', cwd: '/project', title: 'D', kind: 'project', loadState: 'ready' }
          ],
          runtime: {
            ...state.runtime,
            a: { ...state.runtime.a!, thinkingLevel: 'high', modelThinkingLevel: before },
            b: { ...state.runtime.b!, model: model('old'), thinkingLevel: 'low',
              modelThinkingLevel: before, followUpMessages: ['queued'], steeringMessages: ['steer'] },
            c: { ...emptyRuntime(), model: { ...model('old'), id: 'different' }, modelThinkingLevel: 'off' },
            d: { ...emptyRuntime(), model: { ...model('old'), provider: 'different' }, modelThinkingLevel: 'off' }
          }
        }))
      })
      const b = runtime().b!
      const c = runtime().c!
      const d = runtime().d!
      const late = deferred<never>()
      api.getControls = () => late.promise
      const reading = useSessionsStore.getState().loadControls('b')
      api.setModelThinkingPreference = async () => ({
        ...controls('old', 'high'), modelThinkingLevel: after
      } as never)
      await act(async () => {
        assert.equal(await actions.run(() => api.setModelThinkingPreference('a', saving)), true)
        await useSessionsStore.getState().activateTab('b')
      })
      assert.equal(runtime().a?.modelThinkingLevel, after)
      assert.equal(runtime().b?.modelThinkingLevel, after, 'ready tab immediately shares the saved marker')
      assert.equal(runtime().a?.thinkingLevel, 'high')
      assert.equal(runtime().b?.thinkingLevel, 'low', 'other sessions keep their current effort')
      assert.equal(runtime().b?.model, b.model)
      assert.equal(runtime().b?.followUpMessages, b.followUpMessages)
      assert.equal(runtime().b?.steeringMessages, b.steeringMessages)
      assert.equal(runtime().c, c, 'same provider with a different model is unaffected')
      assert.equal(runtime().d, d, 'same model id with a different provider is unaffected')
      assert.ok(runtime().b!.controlsRevision > b.controlsRevision)
      await act(async () => {
        late.resolve({ ...controls('old', 'off'), modelThinkingLevel: before } as never)
        await reading
        await useSessionsStore.getState().activateTab('a')
        await useSessionsStore.getState().activateTab('b')
      })
      assert.equal(runtime().b?.modelThinkingLevel, after, 'late controls cannot undo the preference')
      assert.equal(runtime().b?.thinkingLevel, 'low')
      assert.equal(runtime().b?.followUpMessages, b.followUpMessages)

      // Changing effort also returns the freshly saved model preference.
      api.setThinking = async () => ({ ...controls('old', 'low'), modelThinkingLevel: 'low' } as never)
      await act(async () => { assert.equal(await actions.run(() => api.setThinking('b', 'low')), true) })
      assert.equal(runtime().a?.modelThinkingLevel, 'low')
      assert.equal(runtime().a?.thinkingLevel, 'high')
      await act(async () => { await actions.run(async () => controls('old', 'low') as never) })
      assert.equal(runtime().a?.modelThinkingLevel, 'low', 'legacy replies do not clear shared preferences')
      assert.equal(runtime().b?.modelThinkingLevel, 'low')
      return
    }

    if (scenario === 'replaced-preference') {
      const oldActions = actions
      const reply = deferred<never>()
      let accepted!: Promise<boolean>
      await act(async () => {
        useSessionsStore.setState((state) => ({ runtime: {
          ...state.runtime, b: { ...state.runtime.b!, model: model('old'), thinkingLevel: 'low' }
        } }))
        accepted = actions.run(() => reply.promise)
      })
      await act(async () => {
        useSessionsStore.setState((state) => ({ runtime: {
          ...state.runtime, a: { ...emptyRuntime(), model: model('old'), thinkingLevel: 'off',
            followUpMessages: ['new queue'] }
        } }))
      })
      let called = false
      await act(async () => {
        assert.equal(await oldActions.run(async () => {
          called = true
          return controls('stale') as never
        }), false, 'an old hook callback cannot start work for the replacement')
        useSessionsStore.getState().setControlsStatus('a', { controlsPending: true })
        reply.resolve({ ...controls('old', 'high'), modelThinkingLevel: 'high' } as never)
        assert.equal(await accepted, false)
      })
      assert.equal(called, false)
      assert.equal(runtime().a?.modelThinkingLevel, 'high', 'the saved preference also belongs to the replacement model')
      assert.equal(runtime().b?.modelThinkingLevel, 'high')
      assert.equal(runtime().b?.thinkingLevel, 'low')
      assert.equal(runtime().a?.thinkingLevel, 'off', 'old session controls cannot overwrite the replacement')
      assert.deepEqual(runtime().a?.followUpMessages, ['new queue'])
      assert.equal(runtime().a?.controlsPending, true, 'old completion cannot release new flags')
      return
    }

    if (scenario === 'thinking-preference') {
      class NoopResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
      Object.assign(window, { ResizeObserver: NoopResizeObserver })
      HTMLElement.prototype.scrollIntoView = () => {}
      const { ThinkingPicker } = await import('../src/renderer/src/components/composer/ModelControls')
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      const { api } = await import('../src/renderer/src/ipc/api')
      const calls: Array<[string, boolean]> = []
      let reply = deferred<never>()
      api.setModelThinkingPreference = (id, remember) => {
        calls.push([id, remember])
        return reply.promise
      }
      api.setThinking = async () => { throw new Error('preference toggle must not change session effort') }
      function Picker() {
        const current = useSessionsStore((s) => s.runtime.a!)
        const pickerActions = useModelControls('a')
        return createElement(ThinkingPicker, {
          sessionId: 'a', thinkingLevel: current.thinkingLevel,
          thinkingLevels: current.thinkingLevels, actions: pickerActions
        })
      }
      await act(async () => {
        useSessionsStore.getState().applyControls('a', controls('old', 'high') as never)
        root.render(createElement(TooltipProvider, null, createElement(Picker)))
      })
      await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click() })
      const toggle = () => {
        const element = document.querySelector<HTMLButtonElement>('button[aria-pressed]')
        assert.ok(element, 'the thinking menu contains a preference icon button')
        return element
      }
      assert.equal(toggle().getAttribute('aria-pressed'), 'false', 'undefined preference is not pressed')
      assert.ok(toggle().getAttribute('aria-label'), 'the icon button has an accessible label')
      const firstOption = document.querySelector<HTMLButtonElement>('[data-hover-highlight-row]')!
      const levels = runtime().a!.thinkingLevels
      await act(async () => { firstOption.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })) })
      assert.ok(firstOption.hasAttribute('data-hover-highlight-active'))
      await act(async () => { toggle().click() })
      assert.deepEqual(calls, [['a', true]])
      assert.equal(toggle().disabled, false, 'saving does not invoke the visually dimmed native disabled state')
      assert.equal(toggle().getAttribute('aria-disabled'), 'true')
      assert.equal(firstOption.disabled, false, 'the strength options retain their normal visual state')
      assert.equal(firstOption.getAttribute('aria-disabled'), 'true')
      await act(async () => { toggle().click(); firstOption.click() })
      assert.deepEqual(calls, [['a', true]], 'busy controls still reject repeated operations')
      assert.ok(document.querySelector('[data-slot="popover-content"]'), 'a busy selection must not close the picker')
      await act(async () => {
        reply.resolve({ ...controls('old', 'high'), modelThinkingLevel: 'high' } as never)
      })
      assert.equal(toggle().getAttribute('aria-pressed'), 'true', 'the returned controls activate the button')
      assert.equal(toggle().disabled, false)
      assert.equal(runtime().a?.thinkingLevel, 'high')
      assert.equal(runtime().a!.thinkingLevels, levels, 'identical levels retain their reference across preference saves')
      assert.ok(firstOption.hasAttribute('data-hover-highlight-active'), 'saving keeps the picker navigation highlight')

      // Focused preference button keys must not select the hovered thinking option.
      await act(async () => {
        firstOption.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
        toggle().focus()
        toggle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      assert.ok(document.querySelector('button[aria-pressed]'), 'button keyboard input leaves the menu open')
      assert.deepEqual(calls, [['a', true]])

      reply = deferred<never>()
      await act(async () => { toggle().click() })
      assert.deepEqual(calls, [['a', true], ['a', false]])
      await act(async () => { reply.reject(new Error('save failed')) })
      assert.equal(toggle().getAttribute('aria-pressed'), 'true', 'failed changes keep the stored state')
      assert.equal(document.querySelector('[role="alert"]')?.textContent, 'save failed')
      assert.equal(toggle().disabled, false)

      reply = deferred<never>()
      await act(async () => { toggle().click() })
      await act(async () => {
        reply.resolve({ ...controls('old', 'high'), modelThinkingLevel: null } as never)
      })
      assert.equal(toggle().getAttribute('aria-pressed'), 'false', 'null preference is not pressed')
      assert.equal(runtime().a?.thinkingLevel, 'high', 'forgetting does not change current effort')
      assert.equal(runtime().a?.controlsError, null)

      await act(async () => {
        useSessionsStore.getState().applyControls('a', {
          ...controls('other', 'high'), modelThinkingLevel: 'off'
        } as never)
      })
      assert.equal(toggle().getAttribute('aria-pressed'), 'true', 'off is a saved preference too')
      return
    }

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
  for (const scenario of ['switched', 'replaced', 'mounted-twice', 'thinking-preference', 'shared-save', 'shared-clear', 'replaced-preference']) {
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

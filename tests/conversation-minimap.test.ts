import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { DisplayTurn, TurnSummary } from '../src/renderer/src/ipc/api'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement: h, memo } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { mock } = await import('bun:test')

  // The minimap only cares about the props it is handed, so the scroller and the scroll hook are
  // replaced by stable stubs: this keeps the case about the props, not about geometry.
  const scroller = {
    pauseAutoScroll() {},
    getScrollState: () => ({ following: true }),
    scrollToOffset() {},
    scrollToEnd() {},
    scrollToMessage: () => false
  }
  const noop = () => {}
  mock.module('../src/renderer/src/components/ui/message-scroller', () => {
    const Box = ({ children, ...rest }: { children?: unknown }) => h('div', rest, children as never)
    return {
      MessageScroller: Box,
      MessageScrollerViewport: ({ preserveScrollOnPrepend: _drop, ...rest }: { preserveScrollOnPrepend?: boolean }) =>
        h('div', rest),
      MessageScrollerContent: Box,
      MessageScrollerItem: ({ messageId, children, ...rest }: { messageId?: string; children?: unknown }) =>
        h('div', rest, children as never),
      MessageScrollerButton: () => null,
      useMessageScroller: () => scroller
    }
  })
  const scrollHook = {
    viewportRef: { current: null },
    contentRef: { current: null },
    loadEarlier: noop,
    hasMoreAbove: true,
    hasMoreBelow: false,
    onScroll: noop,
    registerTurn: noop,
    jumpToTurn: noop
  }
  mock.module('../src/renderer/src/components/chat/useConversationScroll', () => ({
    useConversationScroll: ({ historical }: { historical: Array<{ id?: string }> }) => ({
      ...scrollHook,
      visibleTurns: historical.map((turn, index) => ({ turn, index, key: turn.id ?? String(index) }))
    })
  }))
  const storeState: { runtime: Record<string, { turnStart: number; instanceId: number }> } = { runtime: {} }
  const store = {
    loadTurnProcess: async () => {},
    loadOlderTurns: async (_sessionId: string, _target?: number) => {}
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: Object.assign(
      (select: (state: typeof store) => unknown) => select(store),
      { getState: () => storeState }
    )
  }))

  mock.module('../src/renderer/src/components/TurnView', () => ({
    TurnView: ({ turn }: { turn: { id?: string } }) => h('div', { 'data-turn': turn.id })
  }))

  const minimapRenders: Array<Array<{ id: string; length: number; turn: number; label: string }>> = []
  // The real minimap is `memo(...)`: the stand-in has to keep that contract, because the case is
  // about which props change, not about what the minimap draws.
  mock.module('../src/renderer/src/components/chat/TurnMinimap', () => ({
    TurnMinimap: memo((props: {
      items: Array<{ id: string; length: number; turn: number; label: string }>
      onJump: (index: number) => void
    }) => {
      minimapRenders.push(props.items)
      return h('div', { role: 'navigation' }, h('button', {
        type: 'button', 'data-jump': String(props.items[0]?.turn ?? 0), onClick: () => props.onJump(props.items[0]?.turn ?? 0)
      }, 'jump'))
    })
  }))

  const turns = (count: number): DisplayTurn[] => Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    startedAt: index,
    endedAt: index + 1,
    hasProcess: true,
    user: { text: `user ${index}`, images: [], textAttachments: [] },
    answer: [{ type: 'text' as const, text: `answer ${index}` }]
  }))
  const summary = (count: number, bytes: number): TurnSummary[] =>
    Array.from({ length: count }, (_, index) => ({ id: `t${index}`, bytes, hasImages: false }))
  const { ConversationViewport } = await import('../src/renderer/src/components/chat/ConversationViewport')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const historicalFor = (list: DisplayTurn[]) => list.map((turn, index) => ({
    id: turn.id,
    user: { role: 'user', content: `user ${index}`, timestamp: 0 },
    answer: turn.answer,
    process: [],
    streaming: false,
    startedAt: 0,
    endedAt: 1,
    renderKey: turn.id
  }))
  const historical = new WeakMap<DisplayTurn[], ReturnType<typeof historicalFor>>()
  const stableHistorical = (list: DisplayTurn[]) => {
    const cached = historical.get(list)
    if (cached) return cached
    const mapped = historicalFor(list)
    historical.set(list, mapped)
    return mapped
  }
  const paint = async (props: {
    turns: DisplayTurn[]
    windowStart: number
    summary: TurnSummary[]
    loadError?: string | null
  }) => {
    await act(async () => {
      root.render(h(ConversationViewport, {
        active: true,
        historical: stableHistorical(props.turns),
        live: [],
        sessionId: 's1',
        windowStart: props.windowStart,
        loadError: props.loadError ?? null,
        summary: props.summary,
        onSave: noop
      } as never))
    })
  }

  try {
    if (name === 'memo') {
      const list = turns(80)
      const weights = summary(80, 40)
      await paint({ turns: list, windowStart: 0, summary: weights })
      const baseline = minimapRenders.length
      assert.ok(baseline > 0, 'the minimap renders with the conversation')
      // A re-render of the pane that changes neither the branch, its weights, nor history.
      await paint({ turns: list, windowStart: 0, summary: weights, loadError: 'boom' })
      assert.equal(minimapRenders.length, baseline, 'an unrelated pane render must not rebuild the minimap')
      assert.ok(container.querySelector('[role="navigation"]'), 'the minimap stays mounted')
    } else if (name === 'jump-cap') {
      // A jump far above the window pages in steps; the click is bounded even when the target is a
      // thousand pages away, and the reader can simply click again from the window it reached.
      const total = 20000
      const start = total - 60
      const asked: Array<number | undefined> = []
      storeState.runtime = { s1: { turnStart: start, instanceId: 1 } }
      Object.assign(store, {
        loadOlderTurns: async (_sessionId: string, target?: number) => {
          asked.push(target)
          const current = storeState.runtime.s1!
          storeState.runtime = { ...storeState.runtime, s1: { ...current, turnStart: Math.max(0, current.turnStart - 200) } }
        }
      })
      await paint({ turns: turns(total).slice(start), windowStart: start, summary: summary(total, 40) })
      const bar = container.querySelector<HTMLButtonElement>('[data-jump]')
      assert.ok(bar, 'the minimap offers the jump')
      await act(async () => { bar.click() })
      assert.ok(asked.length > 1, `a far jump pages instead of reading the gap: ${asked.length}`)
      assert.ok(asked.length <= 32, `a far jump stays bounded: ${asked.length} pages`)
      assert.ok(storeState.runtime.s1!.turnStart < start, 'the window did move towards the target')
    } else if (name === 'weight') {
      const total = 2000
      const start = total - 60
      const whole = turns(total)
      const weights = summary(total, 40)
      await paint({ turns: whole.slice(start), windowStart: start, summary: weights })
      const loaded = minimapRenders.at(-1)
      assert.ok(loaded, 'the minimap rendered with the window')
      const bar = (turn: number) => loaded.find((item) => item.turn === turn)
      assert.equal(bar(1999)?.length, 40, 'a loaded turn is measured like the branch, not by its own text')
      assert.equal(bar(0)?.length, 40, 'a turn above the window keeps the same metric')
      // The same turn, this time inside the window: its weight must not change with its state.
      await paint({ turns: whole.slice(0, start), windowStart: 0, summary: weights })
      const paged = minimapRenders.at(-1)
      assert.equal(paged?.find((item) => item.turn === 1930)?.length, 40, 'paging a turn in keeps its weight')
      assert.ok(container.querySelectorAll('[data-turn-key]').length > 0, 'the window still renders its rows')
    } else {
      assert.fail(`Unknown fixture: ${name}`)
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--conversation-minimap-fixture') {
  await runFixture(process.argv[3])
} else {
  for (const [name, title] of Object.entries({
    'jump-cap': 'a jump into the far past pages a bounded number of steps',
    memo: 'an unrelated pane render does not rebuild the minimap',
    weight: 'the minimap measures loaded and unloaded turns on one scale'
  })) {
    test(`conversation minimap: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--conversation-minimap-fixture', name], {
        cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 15_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(exitCode, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 20_000)
  }
}

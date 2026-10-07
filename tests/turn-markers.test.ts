import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { buildTurn, groupTurns } from '../src/renderer/src/chat/turns'
import type { ProcessItem, ToolStep, Turn } from '../src/renderer/src/chat/turns'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  // Renderer modules must evaluate after DOM/IPC installation and the ThinkingOrb mock.
  const { act, createElement } = await import('react')
  mock.module('thinking-orbs', () => ({
    ThinkingOrb: ({ size, state, theme, className }: Record<string, unknown>) =>
      createElement('span', {
        'data-testid': 'thinking-orb',
        'data-size': size,
        'data-state': state,
        'data-theme': theme,
        className
      })
  }))
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { TurnView } = await import('../src/renderer/src/components/TurnView')
  type Message = Parameters<typeof groupTurns>[0][number]
  const sourceUser: Message = { role: 'user', content: 'run tools', timestamp: 1_000 }
  const sourceRequest: Extract<Message, { role: 'assistant' }> = {
    role: 'assistant', timestamp: 1_500, api: 'openai-completions', provider: 'synthetic', model: 'synthetic',
    stopReason: 'toolUse',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [
      { type: 'toolCall', id: 'completed', name: 'read', arguments: { path: '/project/completed.ts' } },
      { type: 'text', text: 'pre-tool text' }
    ]
  }
  const sourceResult: Extract<Message, { role: 'toolResult' }> = {
    role: 'toolResult', timestamp: 2_000, toolCallId: 'completed', toolName: 'read',
    content: [{ type: 'text', text: 'file contents' }], isError: false
  }
  const style = document.createElement('style')
  style.textContent = `
    [data-slot="collapsible-content"] { animation-duration: 0.3s; }
    [data-slot="collapsible-content"][data-state="open"] { animation-name: collapsible-down; }
    [data-slot="collapsible-content"][data-state="closed"] { animation-name: collapsible-up; }
  `
  document.head.append(style)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const makeTurn = (patch: Partial<Turn> = {}): Turn => ({
    id: 'marker-test',
    process: [],
    answer: [],
    startedAt: 1_000,
    endedAt: 4_000,
    streaming: true,
    waitingForModel: false,
    ...patch
  })
  const render = async (turn: Turn, onNeedProcess?: (id: string) => Promise<void>) => {
    await act(async () => { root.render(createElement(TurnView, { turn, onNeedProcess })) })
  }
  const separator = () => {
    const button = container.querySelector<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')
    assert.ok(button)
    return button
  }
  const shimmerText = () => [...container.querySelectorAll('.shimmer')].map((el) => el.textContent)
  const readTool = (id: string, done = false): ToolStep => ({
    id,
    name: 'read',
    args: { path: `/project/${id}.ts` },
    ...(done ? {
      result: {
        role: 'toolResult' as const,
        toolCallId: id,
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'file contents' }],
        isError: false,
        timestamp: 2_000
      }
    } : {})
  })

  try {
    if (name === 'wait') {
      await render(makeTurn({ waitingForModel: true }))
      assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-state'), 'working')
      // Pig themes with the root `dark` class alone; an orb resolved from prefers-color-scheme
      // would paint dark ink on a light palette when the appearance is forced to light.
      assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-theme'), 'light')
      document.documentElement.classList.add('dark')
      await act(async () => {})
      assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-theme'), 'dark')
      document.documentElement.classList.remove('dark')
      await render(makeTurn({ errorMessage: 'aborted' }))
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
      await render(makeTurn({ streaming: false }))
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
    } else if (name === 'thinking') {
      const process: ProcessItem[] = [{ kind: 'thinking', text: '完整思考正文', durationMs: 0, live: true }]
      await render(makeTurn({ process }))
      assert.deepEqual(shimmerText(), ['思考中...'])
      assert.equal(container.querySelector('.shimmer')!.classList.contains('shimmer-once'), false)
      assert.equal(container.querySelector('.shimmer')!.children.length, 0)
      assert.equal(container.querySelector('.shimmer svg'), null)
      assert.equal(container.querySelector('pre'), null)
      const live = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('思考中'))!
      assert.ok(live)
      assert.equal(live.getAttribute('aria-expanded'), 'false')
      await act(async () => { live.click() })
      assert.equal(live.getAttribute('aria-expanded'), 'true')
      const liveBody = container.querySelector('pre')!
      assert.equal(liveBody.textContent, '完整思考正文')
      assert.equal(liveBody.closest('.shimmer'), null)
      assert.ok(liveBody.className.includes('max-h-60'))
      Object.defineProperty(liveBody, 'scrollHeight', { value: 1_000, configurable: true })
      Object.defineProperty(liveBody, 'clientHeight', { value: 0, configurable: true })
      await act(async () => {
        liveBody.scrollTop = 0
        liveBody.dispatchEvent(new Event('scroll'))
      })
      await render(makeTurn({ process: [{ ...process[0], text: '完整思考正文，继续推理' } as ProcessItem] }))
      const scrolled = container.querySelector('pre')!
      assert.equal(scrolled.scrollTop, 0)
      Object.defineProperty(scrolled, 'scrollHeight', { value: 2_000, configurable: true })
      await act(async () => {
        scrolled.scrollTop = 2_000
        scrolled.dispatchEvent(new Event('scroll'))
      })
      await render(makeTurn({ process: [{ ...process[0], text: '完整思考正文，继续推理。' } as ProcessItem] }))
      assert.equal(container.querySelector('pre')!.scrollTop, 2_000)
      await render(makeTurn({ process: [{ ...process[0], durationMs: 1_000, live: false } as ProcessItem] }))
      assert.deepEqual(shimmerText(), [])
      const thinking = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('已思考'))!
      assert.ok(thinking)
      // Expanding a live thought keeps it open once it settles.
      assert.equal(thinking.getAttribute('aria-expanded'), 'true')
      assert.equal(container.querySelector('pre')?.textContent, '完整思考正文')
      await act(async () => { thinking.click() })
      assert.equal(thinking.getAttribute('aria-expanded'), 'false')
      assert.equal(
        thinking
          .closest('[data-slot="collapsible"]')
          ?.querySelector('[data-slot="collapsible-content"]')
          ?.getAttribute('data-state'),
        'closed'
      )
      await act(async () => { thinking.click() })
      assert.equal(container.querySelector('pre')?.textContent, '完整思考正文')
    } else if (name === 'thinking-segments') {
      const first = { type: 'thinking' as const, thinking: '第一段思考' }
      const second = { type: 'thinking' as const, thinking: '第二段思考' }
      const thoughts = () => [...container.querySelectorAll<HTMLButtonElement>('button')]
        .filter((button) => /^(思考中|已思考)/.test(button.textContent ?? ''))
      for (const withTools of [false, true]) {
        const prefix: Message[] = withTools
          ? [sourceUser, { ...sourceRequest, content: sourceRequest.content.slice(0, 1) }, sourceResult]
          : [sourceUser]
        const show = async (
          content: typeof sourceRequest.content,
          type: string,
          contentIndex: number,
          durations: Record<string, number>
        ) => {
          await render(groupTurns([...prefix, {
            ...sourceRequest, timestamp: 4_000, stopReason: 'stop', content,
            streamEvent: { type, contentIndex }
          }], true, durations)[0])
          assert.equal(thoughts().length, 1)
        }
        await show([first], 'thinking_delta', 0, {})
        assert.deepEqual(shimmerText(), ['思考中...'])
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
        await show([first], 'thinking_end', 0, { '4000:0': 15_000 })
        assert.equal(thoughts()[0].textContent, '已思考 15 秒')
        assert.deepEqual(shimmerText(), [])
        assert.ok(container.querySelector('[data-testid="thinking-orb"]'))
        await show([first, { type: 'thinking', thinking: '' }], 'thinking_start', 1, { '4000:0': 15_000 })
        assert.ok(container.querySelector('[data-testid="thinking-orb"]'))
        await show([first, second], 'thinking_delta', 1, { '4000:0': 15_000 })
        assert.deepEqual(shimmerText(), ['思考中...'], 'elapsed time from the first piece cannot settle the second')
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
        if (thoughts()[0].getAttribute('aria-expanded') === 'false') {
          await act(async () => { thoughts()[0].click() })
        }
        assert.equal(container.querySelector('pre')?.textContent, '第一段思考\n\n第二段思考')
        const durations = { '4000:0': 15_000, '4000:1': 13_000 }
        await show([first, second], 'thinking_end', 1, durations)
        assert.equal(thoughts()[0].textContent, '已思考 28 秒')
        assert.deepEqual(shimmerText(), [])
        assert.ok(container.querySelector('[data-testid="thinking-orb"]'))
        await show([first, second], 'thinking_end', 1, { '4000:0': 100, '4000:1': 100 })
        assert.equal(thoughts()[0].textContent, '已思考 1 秒', 'the duration floor applies once to the merged row')
        const invisible = { type: 'thinking' as const, thinking: '' }
        await show([first, second, invisible], 'thinking_start', 2, durations)
        assert.ok(container.querySelector('[data-testid="thinking-orb"]'), 'invisible thoughts still need a waiting indicator')
        await show([first, second, invisible], 'thinking_end', 2, durations)
        assert.ok(container.querySelector('[data-testid="thinking-orb"]'))
        const reasoning = [first, second, invisible, invisible]
        await show(reasoning, 'thinking_start', 3, durations)
        assert.ok(container.querySelector('[data-testid="thinking-orb"]'))
        await show([...reasoning, { type: 'text', text: '' }], 'text_start', 4, durations)
        assert.ok(container.querySelector('[data-testid="thinking-orb"]'))
        const content: typeof sourceRequest.content = [...reasoning, { type: 'text', text: '最终回答' }]
        await show(content, 'text_delta', 4, durations)
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
        await render(groupTurns([...prefix, { ...sourceRequest, timestamp: 4_000, content }], false, durations)[0])
        await act(async () => { await Bun.sleep(350); separator().click() })
        if (withTools) {
          const group = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent?.startsWith('使用了'))
          assert.ok(group)
          await act(async () => { group.click() })
        }
        assert.equal(thoughts().length, 1, 'the historical process keeps the same merged row')
        assert.equal(thoughts()[0].textContent, '已思考 28 秒')
        assert.deepEqual(shimmerText(), [])
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
      }
    } else if (name === 'tools') {
      const process: ProcessItem[] = [
        { kind: 'tools', tools: [readTool('previous', true)] },
        { kind: 'text', text: '继续检查' },
        { kind: 'tools', tools: [readTool('done', true), readTool('pending'), readTool('current')] }
      ]
      await render(makeTurn({ process }))
      assert.equal(shimmerText().length, 1)
      assert.ok(shimmerText()[0]?.includes('current.ts'))
      const shimmer = container.querySelector('.shimmer')!
      assert.equal(shimmer.classList.contains('shimmer-once'), false)
      assert.equal(shimmer.previousElementSibling?.textContent, '读取')
      assert.equal(shimmer.previousElementSibling?.classList.contains('shimmer'), false)
      assert.ok(shimmer.parentElement?.classList.contains('truncate'))
      assert.equal(shimmer.closest('button')?.getAttribute('aria-expanded'), 'false')
      for (const header of container.querySelectorAll('[data-slot="marker-content"]')) {
        if (header.textContent === '正在使用工具') assert.equal(header.querySelector('.shimmer'), null)
      }
      await render(makeTurn({ process, errorMessage: 'request failed' }))
      assert.deepEqual(shimmerText(), [])
      assert.ok(container.textContent?.includes('current.ts'))
    } else if (name === 'tool-wait') {
      const messages: Message[] = [sourceUser, sourceRequest]
      await render(groupTurns(messages, true)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
      messages.push(sourceResult)
      await render(groupTurns(messages, true)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-state'), 'working')
      assert.deepEqual(shimmerText(), [], 'completed tools and their old trailing text stay settled')
      assert.ok(container.textContent?.includes('pre-tool text'))

      const nextAssistant = { ...sourceRequest, timestamp: 4_000, content: [] }
      await render(groupTurns([...messages, nextAssistant], true)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-state'), 'working')
      const newOutputs: typeof sourceRequest.content = [
        { type: 'thinking', thinking: 'new reasoning' },
        { type: 'text', text: 'new assistant output' },
        { type: 'toolCall', id: 'next', name: 'read', arguments: { path: '/project/next.ts' } }
      ]
      for (const output of newOutputs) {
        await render(groupTurns([...messages, { ...nextAssistant, content: [output] }], true)[0])
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null, `new ${output.type} replaces waiting`)
      }
      const parallel: typeof sourceRequest = {
        ...sourceRequest,
        content: [
          { type: 'toolCall', id: 'slow', name: 'bash', arguments: { command: 'slow' } },
          { type: 'toolCall', id: 'fast', name: 'read', arguments: { path: '/project/fast.ts' } }
        ]
      }
      await render(groupTurns([sourceUser, parallel, { ...sourceResult, toolCallId: 'fast' }], true)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null, 'another pending tool is not a model wait')
      await render(groupTurns([...messages, { ...nextAssistant, errorMessage: 'aborted' }], true)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
      await render(groupTurns(messages, false)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
    } else if (name === 'retry-tool-wait') {
      const failed: typeof sourceRequest = {
        ...sourceRequest, stopReason: 'error', errorMessage: 'context length exceeded',
        content: [{ type: 'toolCall', id: 'reused', name: 'read', arguments: { path: '/project/failed.ts' } }]
      }
      const retried: typeof sourceRequest = {
        ...sourceRequest, timestamp: 4_000,
        content: [
          { type: 'toolCall', id: 'reused', name: 'read', arguments: { path: '/project/retry-slow.ts' } },
          { type: 'toolCall', id: 'fast', name: 'read', arguments: { path: '/project/retry-fast.ts' } },
          { type: 'text', text: 'retry trailing text' }
        ]
      }
      const compactions: Parameters<typeof groupTurns>[4] = [{
        id: 'k1', reason: 'threshold', startedAt: 2_500, endedAt: 3_500, afterMessageCount: 2,
        workMsBefore: 1_500, status: 'done', summary: 'preserved context', tokensBefore: 42
      }]
      const fast = { ...sourceResult, timestamp: 4_500, toolCallId: 'fast' }
      const messages: Message[] = [sourceUser, failed, retried, fast]
      await render(groupTurns(messages, true, {}, {}, compactions)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null, 'the reused ID still belongs to a pending retry tool')

      messages.push({ ...sourceResult, timestamp: 5_000, toolCallId: 'reused' })
      await render(groupTurns(messages, true, {}, {}, compactions)[0])
      const orb = container.querySelector('[data-testid="thinking-orb"]')
      assert.equal(orb?.getAttribute('data-state'), 'working')
      assert.deepEqual(shimmerText(), [])
      const headers = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
      assert.equal(headers[0].parentElement?.contains(orb), false, 'the failed attempt is not active')
      assert.ok(headers.at(-1)?.parentElement?.contains(orb), 'waiting belongs to the retry interval')
      if (headers[0].getAttribute('aria-expanded') === 'false') await act(async () => { headers[0].click() })
      assert.ok(container.textContent?.includes('failed.ts'), 'the unexecuted call remains visible as history')
      assert.deepEqual(shimmerText(), [], 'opening the failed attempt does not reactivate its calls')

      await render(groupTurns([...messages, { ...sourceRequest, timestamp: 6_000, content: [] }], true, {}, {}, compactions)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-state'), 'working')
      for (const stopReason of ['error', 'aborted'] as const) {
        await render(groupTurns([
          sourceUser, { ...failed, errorMessage: undefined, stopReason }, ...messages.slice(2)
        ], true, {}, {}, compactions)[0])
        assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-state'), 'working', `${stopReason} calls are unexecuted even without an error message`)
      }
      const healthy: typeof sourceRequest = {
        ...failed, errorMessage: undefined, stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'prior-healthy', name: 'read', arguments: { path: '/project/prior-healthy.ts' } }]
      }
      await render(groupTurns([sourceUser, healthy, ...messages.slice(2)], true, {}, {}, compactions)[0])
      assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null, 'compaction does not abandon unfinished healthy calls')
    } else if (name === 'compaction-wait') {
      const originalNow = Date.now
      const originalInterval = window.setInterval.bind(window)
      const originalClear = window.clearInterval.bind(window)
      const ticks = new Map<number, () => void>()
      let now = 10_000
      let timerId = 100_000
      Date.now = () => now
      window.setInterval = ((callback: () => void, delay: number) => {
        if (delay !== 200) return originalInterval(callback, delay)
        const id = ++timerId
        ticks.set(id, callback)
        return id
      }) as typeof window.setInterval
      window.clearInterval = ((id: number) => {
        if (!ticks.delete(id)) originalClear(id)
      }) as typeof window.clearInterval
      try {
        const messages = [sourceUser, sourceRequest, sourceResult]
        const running = {
          id: 'k1', reason: 'threshold' as const, startedAt: 5_000, afterMessageCount: messages.length,
          workMsBefore: 2_000, endedAt: null, status: 'running' as const
        }
        await render(groupTurns(messages, true, {}, {}, [running])[0])
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
        const done = { ...running, endedAt: 7_000, status: 'done' as const, summary: 'preserved context', tokensBefore: 42 }
        await render(groupTurns(messages, true, {}, {}, [done])[0])
        const orb = container.querySelector('[data-testid="thinking-orb"]')
        assert.equal(orb?.getAttribute('data-state'), 'working')
        const headers = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
        assert.equal(headers.length, 3, 'old work, compaction, and the empty current interval')
        assert.ok(orb && headers[1].compareDocumentPosition(orb) & Node.DOCUMENT_POSITION_FOLLOWING)
        assert.ok(headers[2].parentElement?.contains(orb), 'waiting belongs to the interval after compaction')
        const frozenTitle = headers[0].textContent
        const liveTitle = headers[2].textContent
        now += 3_000
        await act(async () => { for (const tick of ticks.values()) tick() })
        assert.equal(headers[0].textContent, frozenTitle)
        assert.notEqual(headers[2].textContent, liveTitle, 'only the current interval clock advances')

        const next = { ...sourceRequest, timestamp: 8_000, content: [{ type: 'text' as const, text: 'new assistant output' }] }
        await render(groupTurns([...messages, next], true, {}, {}, [done])[0])
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
        assert.ok(headers[2].parentElement?.textContent?.includes('new assistant output'))
        assert.equal(headers[0].textContent, frozenTitle)
        await render(groupTurns([...messages, next], false, {}, {}, [done])[0])
        assert.equal(container.querySelector('[data-testid="thinking-orb"]'), null)
      } finally {
        Date.now = originalNow
        window.setInterval = originalInterval
        window.clearInterval = originalClear
      }
    } else if (name === 'tool-live') {
      let steps: ToolStep[] = [
        { id: 'first', name: 'task', args: { command: 'echo first' } },
        { id: 'second', name: 'task', args: { command: 'echo second' } }
      ]
      const buttons = () => [...container.querySelectorAll('button')].filter((button) => button.textContent?.includes('task'))
      const update = (step: ToolStep, text: string): ToolStep => ({
        ...step, partialResult: { content: [{ type: 'text', text }] }
      })
      const finish = (step: ToolStep, text: string, isError = false): ToolStep => ({
        ...step,
        result: {
          role: 'toolResult', toolCallId: step.id, toolName: step.name,
          content: text ? [{ type: 'text', text }] : [], isError, timestamp: 3_000
        }
      })
      await render(makeTurn({ process: [{ kind: 'tools', tools: steps }] }))
      const [first, second] = buttons()
      assert.equal(first.getAttribute('aria-expanded'), 'false')
      assert.equal(second.getAttribute('aria-expanded'), 'false')
      await act(async () => { first.click(); second.click() })
      assert.equal(first.getAttribute('aria-expanded'), 'true')
      assert.equal(second.getAttribute('aria-expanded'), 'true')
      assert.ok(container.textContent?.includes('$ echo first'))
      assert.ok(container.textContent?.includes('$ echo second'))

      steps = [update(steps[0], 'first output'), update(steps[1], 'second output')]
      await render(makeTurn({ process: [{ kind: 'tools', tools: steps }] }))
      steps = [update(steps[0], 'first output\nnext line'), steps[1]]
      await render(makeTurn({ process: [{ kind: 'tools', tools: steps }] }))
      assert.equal(buttons()[0], first)
      assert.equal(first.getAttribute('aria-expanded'), 'true')
      assert.equal(second.getAttribute('aria-expanded'), 'true')
      assert.equal([...container.querySelectorAll('pre')].filter((element) => element.textContent === 'first output').length, 0)
      assert.ok(container.textContent?.includes('first output\nnext line'))
      assert.ok(container.textContent?.includes('second output'))

      steps = [finish(steps[0], 'Command aborted', true), steps[1]]
      await render(makeTurn({ process: [{ kind: 'tools', tools: steps }] }))
      assert.equal(buttons()[0], first)
      assert.equal(first.getAttribute('aria-expanded'), 'true')
      assert.ok(first.querySelector('.text-destructive'))
      assert.equal(first.querySelector('.shimmer'), null)
      assert.ok(container.textContent?.includes('Command aborted'))
      assert.equal(container.textContent?.includes('first output'), false)
      steps = [steps[0], finish(steps[1], '')]
      await render(makeTurn({ process: [{ kind: 'tools', tools: steps }, { kind: 'text', text: '继续回答' }] }))
      assert.equal(buttons()[0], first)
      assert.equal(buttons()[1], second)
      assert.equal(first.getAttribute('aria-expanded'), 'true')
      assert.equal(second.getAttribute('aria-expanded'), 'true')
      assert.equal(container.textContent?.includes('second output'), false)
      assert.deepEqual(shimmerText(), [])
    } else if (name === 'failure') {
      const running: ProcessItem = {
        kind: 'bash',
        message: {
          role: 'bashExecution',
          command: 'echo done',
          output: '',
          exitCode: undefined,
          cancelled: false,
          truncated: false,
          timestamp: 2_000
        }
      }
      await render(makeTurn({ process: [running] }))
      assert.equal(shimmerText().length, 1)
      await render(makeTurn({ process: [{ ...running, message: { ...running.message, exitCode: 0 } }] }))
      assert.deepEqual(shimmerText(), [])
      for (const cancelled of [false, true]) {
        const process: ProcessItem[] = [{
          kind: 'bash',
          message: {
            role: 'bashExecution',
            command: 'exit 1',
            output: 'failed',
            exitCode: cancelled ? undefined : 1,
            cancelled,
            truncated: false,
            timestamp: 2_000
          }
        }]
        await render(makeTurn({ process }))
        assert.deepEqual(shimmerText(), [])
        assert.ok(container.querySelector('[data-slot="marker"] .text-destructive'))
      }
    } else if (name === 'finish') {
      const turn = makeTurn({ process: [{ kind: 'tools', tools: [readTool('current')] }] })
      await render(turn)
      const liveRow = container.querySelector('.shimmer')!.closest('button')
      const content = container.querySelector<HTMLElement>('[data-slot="collapsible-content"]')!
      await act(async () => { await Bun.sleep(30) })
      await render({ ...turn, streaming: false })
      assert.equal(separator().getAttribute('aria-expanded'), 'false')
      assert.ok(separator().textContent?.startsWith('工作耗时'))
      assert.equal(content.getAttribute('data-state'), 'closed')
      assert.ok(content.classList.contains('duration-300'))
      assert.equal(liveRow?.isConnected, true)
      assert.deepEqual(shimmerText(), [])
      await render(turn)
      await act(async () => { await Bun.sleep(350) })
      assert.equal(separator().getAttribute('aria-expanded'), 'true')
      assert.equal(shimmerText().length, 1)
      await render({ ...turn, streaming: false })
      await act(async () => { await Bun.sleep(350) })
      assert.deepEqual(shimmerText(), [])
      assert.equal(container.textContent?.includes('正在使用工具'), false)
      await act(async () => { separator().click() })
      assert.equal(separator().getAttribute('aria-expanded'), 'true')
      assert.deepEqual(shimmerText(), [])
    } else if (name === 'command-continuation') {
      const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
      const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
      useSessionsStore.setState({
        activeTabId: 'repair',
        openTabs: [{ id: 'repair', cwd: '/project', title: 'repair', kind: 'project', loadState: 'ready' }],
        runtime: { repair: emptyRuntime() }
      })
      const actions = useSessionsStore.getState()
      const ticks = new Map<number, () => void>()
      const originalNow = Date.now
      const originalInterval = window.setInterval.bind(window)
      const originalClear = window.clearInterval.bind(window)
      let now = 10_000
      let timerId = 100_000
      Date.now = () => now
      window.setInterval = ((callback: () => void, delay: number) => {
        if (delay !== 200) return originalInterval(callback, delay)
        const id = ++timerId
        ticks.set(id, callback)
        return id
      }) as typeof window.setInterval
      window.clearInterval = ((id: number) => {
        if (!ticks.delete(id)) originalClear(id)
      }) as typeof window.clearInterval
      try {
        const command = { role: 'user' as const, content: '/end-review', timestamp: now }
        const revision = useSessionsStore.getState().runtime.repair.agentRunRevision
        actions.beginPrompt('repair', command)
        actions.setStreaming('repair', true)
        function LiveTurn() {
          const state = useSessionsStore((s) => s.runtime.repair)
          const [turn] = groupTurns(state.liveMessages, state.isStreaming, state.thinkingDurations, state.toolUpdates)
          return turn ? createElement(TurnView, { turn: { ...turn, id: 'live:repair', workedMs: state.streamElapsedMs ?? undefined } }) : null
        }
        await act(async () => { root.render(createElement(LiveTurn)) })
        await act(async () => {
          actions.rollbackPrompt('repair', command, revision)
          actions.appendLiveMessage('repair', { role: 'user', content: 'Implement findings', timestamp: now })
          actions.appendLiveMessage('repair', { role: 'assistant', timestamp: now, content: [{ type: 'thinking', thinking: 'Planning the repair' }] } as Parameters<typeof actions.appendLiveMessage>[1])
        })
        assert.equal(ticks.size, 1)
        assert.equal(separator().getAttribute('aria-expanded'), 'true')
        assert.ok(separator().classList.contains('pointer-events-none'))
        assert.deepEqual(shimmerText(), ['思考中...'])
        await act(async () => { separator().click() })
        assert.equal(separator().getAttribute('aria-expanded'), 'true')
        now += 1_400
        await act(async () => { for (const tick of ticks.values()) tick() })
        assert.equal(separator().textContent, '已工作 1 秒')
        now += 3_000
        await act(async () => { for (const tick of ticks.values()) tick() })
        assert.equal(separator().textContent, '已工作 4 秒')
        await act(async () => { actions.setStreaming('repair', false) })
        assert.equal(ticks.size, 0)
        assert.deepEqual(shimmerText(), [])
        assert.equal(separator().getAttribute('aria-expanded'), 'false')
        now += 5_000
        await act(async () => { await Bun.sleep(0) })
        assert.equal(separator().textContent, '工作耗时 4 秒')
      } finally {
        Date.now = originalNow
        window.setInterval = originalInterval
        window.clearInterval = originalClear
      }
    } else if (name === 'compaction') {
      const process: ProcessItem[] = [
        { kind: 'tools', tools: [readTool('done', true)] },
        { kind: 'compaction', text: '- 保留这条记忆', tokensBefore: 523_400, afterAnswer: false, workMsBefore: 0, durationMs: 0 }
      ]
      await render(makeTurn({ process, streaming: false }))
      const markers = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
      assert.equal(markers.length, 2)
      const compaction = markers[1]
      assert.equal(compaction.getAttribute('aria-expanded'), 'false')
      assert.ok(compaction.textContent?.includes('上下文已压缩'))
      assert.ok(compaction.textContent?.includes('压缩前 523.4k tokens'))
      assert.equal(container.textContent?.includes('保留这条记忆'), false)
      await act(async () => { compaction.click(); await Bun.sleep(0) })
      assert.equal(compaction.getAttribute('aria-expanded'), 'true')
      assert.ok(container.textContent?.includes('保留这条记忆'))
      assert.equal(compaction.classList.contains('aria-expanded:bg-transparent'), true)
      const box = [...container.querySelectorAll('li')]
        .find((element) => element.textContent === '保留这条记忆')
        ?.closest('[data-slot="collapsible-content"]')?.firstElementChild
      assert.ok(box)
      assert.deepEqual([...box.classList].filter((name) => name.startsWith('bg-')), [])
      // A turn that carries nothing but a compaction has no work block to head.
      await render(makeTurn({
        process: [{ kind: 'compaction', text: '只有压缩', tokensBefore: 1, afterAnswer: false, workMsBefore: 0, durationMs: 0 }],
        streaming: false,
        hasProcess: false
      }))
      assert.equal(container.textContent?.includes('工作耗时'), false)
      assert.ok(container.textContent?.includes('上下文已压缩'))
      // A completed compaction does not settle the run: an otherwise empty turn still waits for model output.
      await render(makeTurn({
        process: [{ kind: 'compaction', text: '已整理上下文', tokensBefore: 1, afterAnswer: false, workMsBefore: 0, durationMs: 0 }],
        streaming: true,
        waitingForModel: true
      }))
      assert.equal(container.querySelector('[data-testid="thinking-orb"]')?.getAttribute('data-state'), 'working')
      // A compaction that arrived after the answer reads below it, not above the work.
      await render(makeTurn({
        process: [
          { kind: 'tools', tools: [readTool('before', true)] },
          { kind: 'compaction', text: '尾压缩', tokensBefore: 999, afterAnswer: true, workMsBefore: 0, durationMs: 0 }
        ],
        answer: [{ type: 'text', text: '回答正文' }],
        streaming: false
      }))
      const text = container.textContent ?? ''
      assert.ok(text.indexOf('回答正文') < text.indexOf('上下文已压缩'), text)
      assert.equal(container.textContent?.includes('尾压缩'), false)
      const trailing = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')].pop()
      assert.ok(trailing)
      assert.equal(trailing.closest('[data-slot="collapsible-content"]'), null)
      await act(async () => { trailing.click(); await Bun.sleep(0) })
      assert.ok(container.textContent?.includes('尾压缩'))
      // A loaded process carries the landmarks in position, so the projection's copies are dropped
      // instead of rendering every compaction twice.
      await render(makeTurn({
        process: [
          { kind: 'tools', tools: [readTool('loaded', true)] },
          { kind: 'compaction', text: '流内压缩', tokensBefore: 42, afterAnswer: false, workMsBefore: 0, durationMs: 0 }
        ],
        compactions: [
          { kind: 'compaction', text: '投影压缩', tokensBefore: 42, afterAnswer: false, workMsBefore: 0, durationMs: 0 }
        ],
        streaming: false
      }))
      const notices = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
      assert.equal(notices.length, 2, 'the work header and one landmark, not the projection copy too')
      await act(async () => { notices[1].click(); await Bun.sleep(0) })
      assert.ok(container.textContent?.includes('流内压缩'))
      assert.equal(container.textContent?.includes('投影压缩'), false)
      // A process that carries no landmark of its own is a partial one: it must not swallow the
      // projection's copy, or a turn whose work was read from a stream without the compaction loses
      // the marker entirely.
      await render(makeTurn({
        process: [{ kind: 'text', text: '读到的过程' }],
        compactions: [
          { kind: 'compaction', text: '投影压缩', tokensBefore: 42, afterAnswer: false, workMsBefore: 0, durationMs: 0 }
        ],
        streaming: false
      }))
      const partial = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
      assert.equal(partial.length, 2, 'the work header and the projection landmark')
      await act(async () => { partial[1].click(); await Bun.sleep(0) })
      assert.ok(container.textContent?.includes('投影压缩'))
    } else if (name === 'compaction-unloaded' || name === 'compaction-retry-text') {
      const retryText = name === 'compaction-retry-text'
      const { displayTurnsFromEntries, turnMessagesFromEntries } = await import('../src/main/pi/session-display-model')
      const { toTurn } = await import('../src/renderer/src/chat/display-turns')
      const message = (id: string, time: number, value: Record<string, unknown>) => ({
        type: 'message', id, parentId: null, timestamp: new Date(time).toISOString(), message: { timestamp: time, ...value }
      })
      const call = (id: string) => ({ type: 'toolCall', id, name: 'read', arguments: { path: `/project/${id}.ts` } })
      const result = (id: string) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'file contents' }], isError: false })
      const entries = [
        message('user', 1_000, { role: 'user', content: 'question' }),
        message('a1', 2_000, { role: 'assistant', content: [call('before')] }),
        message('r1', 2_000, result('before')),
        { type: 'compaction', id: 'k1', parentId: null, timestamp: new Date(3_000).toISOString(), summary: '已落盘的压缩', tokensBefore: 42 },
        ...(retryText ? [
          message('a2', 4_000, { role: 'assistant', content: [{ type: 'text', text: '不完整的回答' }], errorMessage: 'overloaded' }),
          message('a3', 6_000, { role: 'assistant', content: [{ type: 'text', text: '最后回答' }] })
        ] : [
          message('a2', 4_000, { role: 'assistant', content: [call('after')] }),
          message('r2', 4_500, result('after')),
          message('a3', 6_000, { role: 'assistant', content: [{ type: 'text', text: '最后回答' }] })
        ])
      ] as unknown as Parameters<typeof displayTurnsFromEntries>[1]
      const [display] = displayTurnsFromEntries('session', entries)
      const process = buildTurn(turnMessagesFromEntries(entries, display.id) as Parameters<typeof buildTurn>[0], false).process
      const unloaded = () => toTurn(display, [])
      const requested: string[] = []
      const load = async (id: string) => {
        requested.push(id)
        root.render(createElement(TurnView, { turn: toTurn(display, process), onNeedProcess: load }))
      }
      const headers = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
        .filter((button) => button.textContent?.includes('工作耗时'))
      const assertUnloaded = () => {
        assert.deepEqual(headers().map((button) => button.textContent), retryText ? ['工作耗时 1 秒'] : ['工作耗时 1 秒', '工作耗时 3 秒'])
        assert.ok(headers().every((button) => button.getAttribute('aria-expanded') === 'false'))
        assert.ok(container.textContent?.includes('上下文已压缩'))
        assert.ok(container.textContent?.includes('最后回答'))
      }
      await render({ ...toTurn(display, process), streaming: true })
      await render(unloaded(), load)
      assertUnloaded()
      assert.deepEqual(requested, [])
      // Opening the last work block first must keep its header and reveal a nonempty body.
      const original = headers()
      const target = original.length - 1
      await act(async () => { original[target].click(); await Bun.sleep(0) })
      assert.deepEqual(requested, [display.id])
      assert.equal(headers().length, original.length)
      assert.ok(headers().every((button, index) => button === original[index]))
      assert.deepEqual(headers().map((button) => button.getAttribute('aria-expanded')), original.map((_, index) => index === target ? 'true' : 'false'))
      const body = document.getElementById(original[target].getAttribute('aria-controls')!)
      assert.ok(body?.textContent?.trim())
      if (original.length > 1) {
        await act(async () => { original[0].click(); await Bun.sleep(0) })
        assert.deepEqual(headers().map((button) => button.getAttribute('aria-expanded')), ['true', 'true'])
        await act(async () => { original[0].click(); await Bun.sleep(0) })
        assert.deepEqual(headers().map((button) => button.getAttribute('aria-expanded')), ['false', 'true'])
      }
      assert.equal(requested.length, 1)
      // Reopening starts with no cached process, but the summary still has the complete layout.
      await act(async () => { root.render(null) })
      await render(unloaded(), load)
      assertUnloaded()
      assert.equal(requested.length, 1)
    } else if (name === 'compaction-empty-blocks') {
      const compaction = (workMsBefore: number) => ({ kind: 'compaction' as const, text: '压缩', tokensBefore: 42, afterAnswer: false, workMsBefore, durationMs: 1_000 })
      const markers = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
      await render(makeTurn({ streaming: false, hasProcess: true, workBlocks: [true, false], compactions: [compaction(1_000)] }))
      assert.deepEqual(markers().map((button) => button.textContent?.startsWith('工作耗时')), [true, false])
      const landmarks = [compaction(0), compaction(1_000)]
      const turn = makeTurn({ streaming: false, hasProcess: true, workBlocks: [false, false, true], compactions: landmarks, endedAt: 9_000 })
      await render(turn)
      assert.deepEqual(markers().map((button) => button.textContent?.startsWith('工作耗时')), [false, false, true])
      assert.equal(markers()[2].textContent, '工作耗时 6 秒')
      await render({ ...turn, process: [...landmarks, { kind: 'tools', tools: [readTool('after', true)] }] })
      assert.equal(markers()[2].textContent, '工作耗时 6 秒')
      await render(makeTurn({ streaming: false, hasProcess: false, workBlocks: [false], compactions: [{ ...compaction(0), afterAnswer: true }] }))
      assert.equal(markers().length, 1)
      assert.equal(container.textContent?.includes('工作耗时'), false)
    } else if (name === 'compaction-ids') {
      await render(makeTurn({
        streaming: true,
        process: [
          { kind: 'tools', tools: [readTool('first', true)] },
          { kind: 'compaction', text: '中间压缩', tokensBefore: 42, afterAnswer: false, workMsBefore: 0, durationMs: 0 },
          { kind: 'tools', tools: [readTool('second', true)] }
        ]
      }))
      const ids = [...container.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id)
      assert.equal(new Set(ids).size, ids.length, ids.join(','))
      const controls = separator().getAttribute('aria-controls')
      assert.ok(controls)
      assert.equal(document.querySelectorAll(`[id="${controls}"]`).length, 1)
    } else if (name === 'compaction-live') {
      const running = {
        kind: 'compaction' as const,
        text: '',
        tokensBefore: 0,
        afterAnswer: false,
        workMsBefore: 2_000,
        durationMs: 0,
        live: {
          id: 'k1', reason: 'threshold' as const, startedAt: Date.now() - 3_000, afterMessageCount: 0, workMsBefore: 2_000,
          endedAt: null, status: 'running' as const
        }
      }
      await render(makeTurn({
        process: [{ kind: 'tools', tools: [readTool('before', true)] }, running]
      }))
      // While the summary is being written the work before it keeps the total it froze at, and the
      // compaction itself is the one thing still counting.
      const headers = () => [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
        .filter((button) => button.textContent?.includes('工作'))
      assert.equal(headers().length, 1, 'the work before the summary has a header of its own')
      assert.ok(headers()[0].textContent?.startsWith('已工作 2 秒'), headers()[0].textContent ?? '')
      assert.deepEqual(shimmerText(), ['上下文接近上限，正在压缩'])
      assert.equal(container.querySelectorAll('button[data-slot="marker"]').length, 1, 'a summary in progress has nothing to open')
      const row = container.querySelector<HTMLElement>('[data-slot="marker"][data-variant="separator"]:not(button)')
      assert.ok(row?.textContent?.includes('上下文接近上限，正在压缩'), row?.textContent ?? '')
      assert.ok(row?.textContent?.includes('3 秒'), `the summary counts its own time: ${row?.textContent}`)

      const done = {
        ...running,
        text: '- 保留这条记忆',
        tokensBefore: 523_400,
        durationMs: 1_000,
        live: {
          ...running.live, endedAt: 3_000, status: 'done' as const,
          summary: '- 保留这条记忆', tokensBefore: 523_400
        }
      }
      await render(makeTurn({
        process: [
          { kind: 'tools', tools: [readTool('before', true)] },
          done,
          { kind: 'tools', tools: [readTool('after', true)] }
        ],
        workedMs: 5_000,
        streaming: false
      }))
      // Two blocks of work, each with a header of its own: the first keeps the time it ended at,
      // the second carries on from it with the summary's own time left out.
      assert.deepEqual(shimmerText(), [])
      const [first, second] = headers()
      assert.ok(first.textContent?.startsWith('工作耗时 2 秒'), first.textContent ?? '')
      assert.ok(second.textContent?.startsWith('工作耗时 4 秒'), second.textContent ?? '')
      assert.equal(first.getAttribute('aria-expanded'), 'false')
      assert.equal(second.getAttribute('aria-expanded'), 'false')
      await act(async () => { second.click(); await Bun.sleep(0) })
      assert.equal(second.getAttribute('aria-expanded'), 'true')
      assert.equal(first.getAttribute('aria-expanded'), 'false', 'each block opens on its own')
      await act(async () => { first.click(); await Bun.sleep(0) })
      assert.equal(first.getAttribute('aria-expanded'), 'true')
      assert.equal(second.getAttribute('aria-expanded'), 'true')
      // The landmark between them stays a landmark: it opens the summary, not the work.
      const notice = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"]')]
        .find((button) => button.textContent?.includes('上下文已压缩'))
      assert.ok(notice)
      assert.equal(container.textContent?.includes('保留这条记忆'), false)
      await act(async () => { notice!.click(); await Bun.sleep(0) })
      assert.ok(container.textContent?.includes('保留这条记忆'))
    } else if (name === 'disclosure') {
      let requested: string | undefined
      let release!: () => void
      const pending = new Promise<void>((resolve) => { release = resolve })
      await render(makeTurn({ streaming: false, hasProcess: true }), async (id) => {
        requested = id
        await pending
      })
      const button = separator()
      assert.equal(button.type, 'button')
      assert.equal(button.tabIndex, 0)
      assert.equal(button.children.length, 1)
      assert.equal(container.querySelector('button button'), null)
      assert.equal(button.getAttribute('aria-expanded'), 'false')
      assert.equal(button.getAttribute('aria-controls'), null)
      for (const name of ['text-xs', 'hover:bg-transparent', 'aria-expanded:bg-transparent']) {
        assert.ok(button.classList.contains(name))
      }
      assert.equal(button.classList.contains('hover:bg-muted'), false)
      assert.equal(button.classList.contains('aria-expanded:bg-muted'), false)
      button.focus()
      assert.equal(document.activeElement, button)
      await act(async () => { button.click() })
      assert.equal(requested, 'marker-test')
      assert.equal(button.disabled, true)
      assert.equal(button.getAttribute('aria-expanded'), 'false')
      await act(async () => { release() })
      assert.equal(button.disabled, false)
      assert.equal(button.getAttribute('aria-expanded'), 'true')
      const contentId = button.getAttribute('aria-controls')
      assert.ok(contentId && document.getElementById(contentId))
      await act(async () => { button.click() })
      assert.equal(button.getAttribute('aria-expanded'), 'false')
      assert.deepEqual(shimmerText(), [])
    } else {
      assert.fail(`Unknown fixture: ${name}`)
    }
  } finally {
    await act(async () => { root.unmount() })
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--marker-fixture') {
  await runFixture(process.argv[3])
} else {
  const fixtures = {
    wait: 'initial model waiting shows a working orb and clears on failure or settlement',
    thinking: 'thinking marker preserves the body and completed thinking remains expandable',
    'thinking-segments': 'adjacent thoughts merge while stream gaps and invisible reasoning keep a waiting orb',
    tools: 'only the current tool text shimmers while its action prefix stays static',
    'tool-wait': 'completed tools show model waiting until visible work resumes, without overlapping execution or old blocks',
    'retry-tool-wait': 'failed unexecuted calls remain history without blocking retries or hiding genuinely pending tools',
    'compaction-wait': 'waiting and resumed output belong after compaction while the old work clock stays frozen',
    'tool-live': 'running tools stay expandable through snapshots, final results and later assistant text',
    failure: 'completed, failed and cancelled commands stop shimmering',
    finish: 'shimmer stops during the 300ms collapse and restart cancels stale cleanup',
    'command-continuation': 'a command continuation keeps live thinking, locked work headers and a ticking clock until settlement',
    compaction: 'a compaction renders as its own landmark outside the collapsed work block',
    'compaction-live': 'a live compaction splits the turn into two blocks that time themselves alone',
    'compaction-unloaded': 'all persisted work headers survive settlement, lazy loading and reopening',
    'compaction-retry-text': 'partial-text retries after compaction create no empty or disappearing work header',
    'compaction-empty-blocks': 'empty compaction intervals create no work header or timing offset',
    'compaction-ids': 'each work block split by a compaction owns a unique content id',
    disclosure: 'separator stays one focusable button with lazy loading and no hover highlight'
  }
  for (const [name, title] of Object.entries(fixtures)) {
    test(title, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--marker-fixture', name], {
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

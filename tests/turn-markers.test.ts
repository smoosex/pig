import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { ProcessItem, ToolStep, Turn } from '../src/renderer/src/chat/turns'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
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
      let rotate: (() => void) | undefined
      const setInterval = window.setInterval.bind(window)
      window.setInterval = ((callback: () => void, delay: number) => {
        if (delay === 2_800) rotate = callback
        return setInterval(callback, delay)
      }) as typeof window.setInterval
      await render(makeTurn())
      const [text] = shimmerText()
      assert.equal(text, '正在加班加点理解你的问题...')
      const label = container.querySelector('.shimmer')!
      assert.ok(label.classList.contains('shimmer-once'))
      assert.equal(label.children.length, 0)
      assert.equal(label.getAttribute('style'), null)
      assert.ok(label.closest('[data-slot="marker-content"]'))
      assert.ok(label.closest('[data-slot="marker"]')?.classList.contains('text-xs'))
      const orb = container.querySelector('[data-testid="thinking-orb"]')!
      assert.equal(orb.closest('.shimmer'), null)
      assert.equal(orb.getAttribute('data-size'), '20')
      assert.equal(orb.getAttribute('data-state'), 'shaping')
      assert.equal(orb.getAttribute('data-theme'), 'auto')
      assert.equal(separator().querySelector('.shimmer'), null)
      assert.ok(rotate)
      await act(async () => { rotate!() })
      assert.notEqual(shimmerText()[0], text)
      assert.equal(container.querySelector('.shimmer'), label, 'rotating copy does not restart the sweep')
      await render(makeTurn({ errorMessage: 'aborted' }))
      assert.deepEqual(shimmerText(), [])
    } else if (name === 'thinking') {
      const process: ProcessItem[] = [{ kind: 'thinking', text: '完整思考正文', durationMs: 0 }]
      await render(makeTurn({ process }))
      assert.deepEqual(shimmerText(), ['思考中...'])
      assert.ok(container.querySelector('.shimmer')!.classList.contains('shimmer-once'))
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
      await render(makeTurn({ process: [{ ...process[0], durationMs: 1_000 } as ProcessItem] }))
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
      assert.ok(shimmer.classList.contains('shimmer-once'))
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
    } else if (name === 'compaction') {
      const process: ProcessItem[] = [
        { kind: 'tools', tools: [readTool('done', true)] },
        { kind: 'compaction', text: '- 保留这条记忆', tokensBefore: 523_400, afterAnswer: false }
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
        process: [{ kind: 'compaction', text: '只有压缩', tokensBefore: 1, afterAnswer: false }],
        streaming: false,
        hasProcess: false
      }))
      assert.equal(container.textContent?.includes('工作耗时'), false)
      assert.ok(container.textContent?.includes('上下文已压缩'))
      // While the run is live the landmark is not a substitute for the work block: the waiting line
      // lives in the work block the compaction would otherwise be the only segment of.
      await render(makeTurn({
        process: [{ kind: 'compaction', text: '运行中压缩', tokensBefore: 1, afterAnswer: false }],
        streaming: true
      }))
      assert.deepEqual(shimmerText(), ['正在加班加点理解你的问题...'])
      assert.ok(container.textContent?.includes('上下文已压缩'))
      // A compaction that arrived after the answer reads below it, not above the work.
      await render(makeTurn({
        process: [
          { kind: 'tools', tools: [readTool('before', true)] },
          { kind: 'compaction', text: '尾压缩', tokensBefore: 999, afterAnswer: true }
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
          { kind: 'compaction', text: '流内压缩', tokensBefore: 42, afterAnswer: false }
        ],
        compactions: [
          { kind: 'compaction', text: '投影压缩', tokensBefore: 42, afterAnswer: false }
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
          { kind: 'compaction', text: '投影压缩', tokensBefore: 42, afterAnswer: false }
        ],
        streaming: false
      }))
      const partial = [...container.querySelectorAll<HTMLButtonElement>('button[data-slot="marker"][data-variant="separator"]')]
      assert.equal(partial.length, 2, 'the work header and the projection landmark')
      await act(async () => { partial[1].click(); await Bun.sleep(0) })
      assert.ok(container.textContent?.includes('投影压缩'))
    } else if (name === 'compaction-unloaded') {
      // The projection ships the landmark with the turn, so a turn whose work is still on disk shows
      // its compaction without the reader having to open the block that would have revealed it.
      let requested: string | undefined
      await render(makeTurn({
        process: [],
        compactions: [
          { kind: 'compaction', text: '已落盘的压缩', tokensBefore: 42, afterAnswer: false }
        ],
        hasProcess: true,
        streaming: false
      }), async (id) => { requested = id })
      assert.ok(container.textContent?.includes('上下文已压缩'))
      assert.ok(container.textContent?.includes('工作耗时'))
      assert.equal(container.querySelector('[data-slot="collapsible-content"]')?.getAttribute('data-state'), 'closed')
      assert.equal(requested, undefined)
      // The work is behind the header, and opening it is what asks for it.
      await act(async () => { separator().click(); await Bun.sleep(0) })
      assert.equal(requested, 'marker-test')
    } else if (name === 'compaction-ids') {
      await render(makeTurn({
        streaming: true,
        process: [
          { kind: 'tools', tools: [readTool('first', true)] },
          { kind: 'compaction', text: '中间压缩', tokensBefore: 42, afterAnswer: false },
          { kind: 'tools', tools: [readTool('second', true)] }
        ]
      }))
      const ids = [...container.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id)
      assert.equal(new Set(ids).size, ids.length, ids.join(','))
      const controls = separator().getAttribute('aria-controls')
      assert.ok(controls)
      assert.equal(document.querySelectorAll(`[id="${controls}"]`).length, 1)
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
    wait: 'wait marker uses native shimmer without animating the orb or splitting characters',
    thinking: 'thinking marker preserves the body and completed thinking remains expandable',
    tools: 'only the current tool text shimmers while its action prefix stays static',
    'tool-live': 'running tools stay expandable through snapshots, final results and later assistant text',
    failure: 'completed, failed and cancelled commands stop shimmering',
    finish: 'shimmer stops during the 300ms collapse and restart cancels stale cleanup',
    compaction: 'a compaction renders as its own landmark outside the collapsed work block',
    'compaction-unloaded': 'a persisted compaction shows before its work is read',
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

  test('uses the installed shimmer defaults and removes custom animation definitions', async () => {
    const [native, styles, view] = await Promise.all([
      Bun.file(new URL('../node_modules/shadcn/dist/tailwind.css', import.meta.url)).text(),
      Bun.file(new URL('../src/renderer/src/styles.css', import.meta.url)).text(),
      Bun.file(new URL('../src/renderer/src/components/TurnView.tsx', import.meta.url)).text()
    ])
    assert.match(native, /animation: tw-shimmer var\(--shimmer-duration, 2s\) linear infinite/)
    assert.match(native, /@utility shimmer-once\s*\{\s*animation-iteration-count: 1/)
    assert.match(native, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.shimmer\s*\{\s*animation: none/)
    assert.doesNotMatch(styles + view, /think-wave|tool-wave|WaveText|ThinkLabel/)
    assert.doesNotMatch(view, /--shimmer-|shimmer-(?:duration|color|angle|spread)-|animationDelay/)
  })
}

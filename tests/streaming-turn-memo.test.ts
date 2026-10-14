/** Renderer fixtures isolate module mocks while exercising turn and tool-row memo boundaries. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { Translate } from '../src/shared/i18n'
import type { Turn } from '../src/renderer/src/chat/turns'
import type { AssistantMessage, PigUserMessage, ToolResultMessage } from '../src/renderer/src/pi/types'

async function runFixture(scenario: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  document.write('<!doctype html><html><head></head><body></body></html>')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { supportsGlass: false } })
  const { mock } = await import('bun:test')
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { create } = await import('zustand')
  const store = create(() => ({ activeTabId: null, runtime: {} }))
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: store,
    selectActiveSessionId: () => null
  }))
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    if (scenario === 'settled-turn') {
      const userRenders: string[] = []
      // Non-memoized probe: it runs whenever its owning AgentTurnView renders, even while the
      // completed process is collapsed. Count the two turns independently.
      mock.module('../src/renderer/src/components/turn/TurnMessages', () => ({
        UserBubble: ({ turnId }: { turnId: string }) => {
          userRenders.push(turnId)
          return createElement('span', null, turnId)
        },
        Answer: () => null
      }))
      mock.module('../src/renderer/src/components/turn/TurnProcess', () => ({
        ProcessOutline: () => null,
        ProcessList: () => null
      }))
      const { TurnView } = await import('../src/renderer/src/components/TurnView')
      const settled: Turn = {
        id: 'settled', user: { role: 'user', content: 'old request', timestamp: 0 },
        streaming: false, waitingForModel: false, hasProcess: true,
        process: [{ kind: 'text', text: 'completed work' }], answer: [], startedAt: 0, endedAt: 1000
      }
      const streaming: Turn = {
        id: 'live', user: { role: 'user', content: 'new request', timestamp: 2000 },
        streaming: true, waitingForModel: false, hasProcess: true,
        process: [{ kind: 'text', text: 'answer' }], answer: [], startedAt: 2000, endedAt: 2000
      }
      const render = async (past: Turn, live: Turn) => {
        await act(async () => {
          root.render(createElement('div', null,
            createElement(TurnView, { key: 'past', turn: past }),
            createElement(TurnView, { key: 'live', turn: live })
          ))
        })
      }
      await render(settled, streaming)
      const settledRenders = userRenders.filter((id) => id === 'settled').length
      const liveRenders = userRenders.filter((id) => id === 'live').length
      assert.ok(settledRenders > 0)
      assert.ok(liveRenders > 0)

      const growing: Turn = { ...streaming, process: [{ kind: 'text', text: 'answer grows' }] }
      await render(settled, growing)
      assert.equal(userRenders.filter((id) => id === 'settled').length, settledRenders,
        'unrelated streaming updates must not render the completed turn')
      assert.equal(userRenders.filter((id) => id === 'live').length, liveRenders + 1)

      await render({ ...settled, id: 'another-turn' }, growing)
      assert.ok(userRenders.includes('another-turn'), 'changed turn identity must render')
      assert.equal(userRenders.filter((id) => id === 'settled').length, settledRenders)
      assert.equal(userRenders.filter((id) => id === 'live').length, liveRenders + 1)
    } else if (scenario === 'tool-row') {
      const { translate } = await import('../src/shared/i18n')
      const reads = new Map<string, number>()
      // toolStepLabel invokes this once per real ToolRow render. Keep the process/row components
      // intact; only replace translation to observe them and Markdown to isolate unrelated work.
      const t: Translate = (key, params) => {
        if (key === 'tool.read') {
          const path = String(params!.path)
          reads.set(path, (reads.get(path) ?? 0) + 1)
        }
        return translate('en', key, params)
      }
      mock.module('../src/renderer/src/hooks/useT', () => ({ useT: () => t }))
      mock.module('../src/renderer/src/components/MarkdownText', () => ({
        MarkdownText: ({ text }: { text: string }) => createElement('p', null, text)
      }))
      mock.module('thinking-orbs', () => ({ ThinkingOrb: () => null }))
      const { groupTurns } = await import('../src/renderer/src/chat/turns')
      const { ProcessOutline } = await import('../src/renderer/src/components/turn/TurnProcess')
      const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
      const user: PigUserMessage = { role: 'user', content: 'read files', timestamp: 1000 }
      const request: AssistantMessage = {
        role: 'assistant', timestamp: 1500, api: 'openai-completions', provider: 'synthetic', model: 'synthetic',
        stopReason: 'toolUse',
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        content: [
          { type: 'toolCall', id: 'completed', name: 'read', arguments: { path: 'completed.ts' } },
          { type: 'toolCall', id: 'pending', name: 'read', arguments: { path: 'pending.ts' } }
        ]
      }
      const completed: ToolResultMessage = {
        role: 'toolResult', timestamp: 2000, toolCallId: 'completed', toolName: 'read',
        content: [{ type: 'text', text: 'completed output' }], isError: false
      }
      const partial = { content: [{ type: 'text' as const, text: 'partial output' }] }
      const first = groupTurns([user, request, completed], true, {}, { pending: partial })[0]
      const render = async (turn: Turn) => {
        await act(async () => {
          root.render(createElement(TooltipProvider, null, createElement(ProcessOutline, {
            items: turn.process, streaming: turn.streaming, waitingForModel: turn.waitingForModel
          })))
        })
      }
      const trigger = (path: string) => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find((item) => item.textContent === `Read ${path}`)
        assert.ok(button, `missing tool row: ${path}`)
        return button
      }
      await render(first)
      await act(async () => {
        trigger('completed.ts').click()
        trigger('pending.ts').click()
      })
      assert.match(container.textContent ?? '', /completed output.*partial output/)
      const completedRenders = reads.get('completed.ts')!
      const pendingRenders = reads.get('pending.ts')!
      assert.ok(completedRenders > 0)
      assert.ok(pendingRenders > 0)

      await render(groupTurns([user, request, completed], true, {}, {
        pending: { content: [{ type: 'text', text: 'partial output grows' }] }
      })[0])
      assert.equal(reads.get('completed.ts'), completedRenders,
        'partial output must not render other completed tools')
      assert.equal(reads.get('pending.ts'), pendingRenders + 1)
      assert.match(container.textContent ?? '', /partial output grows/)

      const changedRequest: AssistantMessage = {
        ...request,
        content: [request.content[0], {
          type: 'toolCall', id: 'pending', name: 'read', arguments: { path: 'renamed.ts' }
        }]
      }
      await render(groupTurns([user, changedRequest, completed], true, {}, { pending: partial })[0])
      assert.ok(trigger('renamed.ts').querySelector('.shimmer'))
      assert.equal(reads.get('completed.ts'), completedRenders)
      assert.equal(reads.get('renamed.ts'), 1)

      const finished: ToolResultMessage = {
        role: 'toolResult', timestamp: 2500, toolCallId: 'pending', toolName: 'read',
        content: [{ type: 'text', text: 'final output' }], isError: false
      }
      await render(groupTurns([user, changedRequest, completed, finished], true)[0])
      assert.equal(reads.get('completed.ts'), completedRenders)
      assert.equal(trigger('renamed.ts').querySelector('.shimmer'), null)
      assert.match(container.textContent ?? '', /final output/)
      const finishedRenders = reads.get('renamed.ts')!

      const text = { type: 'text' as const, text: 'answer' }
      const answer: AssistantMessage = { ...request, timestamp: 3000, stopReason: 'stop', content: [text] }
      const messages = [user, changedRequest, completed, finished, answer]
      await render(groupTurns(messages, true)[0])
      text.text += ' grows'
      const growing = groupTurns(messages, true)[0]
      assert.ok(first.process[0].kind === 'tools')
      assert.ok(growing.process[0].kind === 'tools')
      assert.notStrictEqual(first.process[0].tools[0], growing.process[0].tools[0],
        'groupTurns recreates ToolStep wrappers')
      await render(growing)
      assert.match(container.textContent ?? '', /answer grows/)
      assert.equal(reads.get('completed.ts'), completedRenders,
        'subsequent answer text must not render completed tool rows')
      assert.equal(reads.get('renamed.ts'), finishedRenders)

      const failed: ToolResultMessage = {
        ...completed, content: [{ type: 'text', text: 'replacement error' }], isError: true
      }
      await render(groupTurns([user, changedRequest, failed, finished, answer], true)[0])
      assert.equal(reads.get('completed.ts'), completedRenders + 1, 'changed results must render')
      assert.equal(reads.get('renamed.ts'), finishedRenders)
      assert.ok(trigger('completed.ts').querySelector('.text-destructive'))
      assert.match(container.textContent ?? '', /replacement error/)
    } else {
      throw new Error(`unknown fixture: ${scenario}`)
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--fixture') {
  await runFixture(process.argv[3])
} else {
  for (const [scenario, name] of [
    ['settled-turn', 'a completed turn skips unrelated streaming updates but renders a changed identity'],
    ['tool-row', 'real tool rows skip unrelated groupTurns updates without dropping args, output or status changes']
  ]) {
    test(name, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--fixture', scenario], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

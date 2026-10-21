/** Isolate module mocks from the runtime and store tests in the shared Bun registry. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

if (process.argv.includes('--terminal-agent-renderer-fixture')) {
  const { mock } = await import('bun:test')
  type Answer = import('../src/shared/terminal-agent').TerminalAgentOpenAnswer
  const tabs = [{ id: 'project', kind: 'project', cwd: '/worktree' }, { id: 'chat', kind: 'chat', cwd: '' }]
  const opened: { cwd: string | null; background: boolean | undefined }[] = []
  const closed: string[] = []
  const activated: string[] = []
  const answers: Answer[] = []
  let finish!: () => void
  let readiness: Promise<void> = Promise.resolve()
  let rejectAnswer = false
  const store = {
    openTabs: tabs,
    openTerminalTab(cwd: string | null, options?: { background?: boolean }) {
      opened.push({ cwd, background: options?.background })
      tabs.push({ id: 'terminal:new', kind: 'terminal', cwd: cwd ?? '' })
      return 'terminal:new'
    },
    async activateTab(id: string) { activated.push(id) },
    closeTab(id: string) {
      closed.push(id)
      const index = tabs.findIndex((tab) => tab.id === id)
      if (index >= 0) tabs.splice(index, 1)
    }
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: { getState: () => store } }))
  mock.module('../src/renderer/src/terminal/runtime', () => ({ ensureTerminal: () => readiness }))
  mock.module('../src/renderer/src/ipc/api', () => ({ api: { terminal: {
    answerAgentOpen: async (_id: string, answer: Answer) => {
      answers.push(answer)
      if (rejectAnswer) throw new Error('request cancelled')
    }
  } } }))
  const { answerTerminalAgentOpen } = await import('../src/renderer/src/hooks/useTerminalAgentRequests')
  readiness = new Promise((resolve) => { finish = resolve })
  const opening = answerTerminalAgentOpen({ requestId: 'request', sessionId: 'project' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(opened, [{ cwd: '/worktree', background: true }])
  assert.equal(answers.length, 0, 'main must not receive an answer until the shell is ready')
  finish()
  await opening
  assert.deepEqual(answers.at(-1), { terminalId: 'terminal:new' })
  store.closeTab('terminal:new')

  readiness = Promise.resolve()
  await answerTerminalAgentOpen({ requestId: 'chat-request', sessionId: 'chat' })
  assert.deepEqual(opened.at(-1), { cwd: null, background: true }, 'Chat terminals start at home')
  await answerTerminalAgentOpen({ requestId: 'activate', sessionId: 'chat', action: 'activate', terminalId: 'terminal:new' })
  assert.deepEqual(activated, ['terminal:new'])
  assert.deepEqual(answers.at(-1), { terminalId: 'terminal:new' })
  rejectAnswer = true
  await assert.rejects(answerTerminalAgentOpen({ requestId: 'late-activation', sessionId: 'chat', action: 'activate', terminalId: 'terminal:new' }), /cancelled/)
  assert.ok(tabs.some(tab => tab.id === 'terminal:new'), 'late activation answers must not close existing tabs')
  rejectAnswer = false
  await answerTerminalAgentOpen({ requestId: 'close', sessionId: 'absent', action: 'close', terminalId: 'terminal:new' })
  assert.equal(closed.at(-1), 'terminal:new', 'an authorized close finishes even after the session closes')
  await answerTerminalAgentOpen({ requestId: 'close-again', sessionId: 'absent', action: 'close', terminalId: 'terminal:new' })
  assert.deepEqual(answers.at(-1), { terminalId: 'terminal:new' }, 'close is idempotent')
  await answerTerminalAgentOpen({ requestId: 'missing-activation', sessionId: 'chat', action: 'activate', terminalId: 'terminal:new' })
  assert.ok('error' in answers.at(-1)!)
  const beforeInvalid = opened.length
  await answerTerminalAgentOpen({ requestId: 'wrong-window', sessionId: 'absent' })
  assert.equal(opened.length, beforeInvalid, 'requests for another window cannot open a tab')
  assert.ok('error' in answers.at(-1)!)

  readiness = Promise.reject(new Error('shell failed'))
  await answerTerminalAgentOpen({ requestId: 'failed', sessionId: 'project' })
  assert.deepEqual(answers.at(-1), { error: 'shell failed' })
  assert.equal(closed.at(-1), 'terminal:new', 'failed startup cleans up its tab and runtime')
  readiness = Promise.resolve()
  rejectAnswer = true
  await assert.rejects(answerTerminalAgentOpen({ requestId: 'late', sessionId: 'project' }), /request cancelled/)
  assert.ok(!tabs.some((tab) => tab.id === 'terminal:new'), 'a rejected late answer closes the orphan')
} else {
  test('terminal agent opens background worktree/home tabs, awaits readiness and cleans rejected requests', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--terminal-agent-renderer-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stdout + stderr)
  })
}

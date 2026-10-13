import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, PromptStreamingBehavior } from '../src/shared/api'
import type { PiMessage } from '../src/renderer/src/pi/types'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function fixture(scenario: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: {} })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { mock } = await import('bun:test')
  const prepared = deferred()
  let promptCalls = 0
  let abortCalls = 0
  let rollbackCalls = 0
  let hydrationCalls = 0
  let promoteCalls = 0
  let bashCalls = 0
  let bashEnds = 0
  let compactCalls = 0
  let compactInstructions: string | undefined
  let sentPrompt = ''
  const isCompact = scenario.startsWith('compact')
  const compactText = scenario === 'compact-streaming' ? '/compact  Preserve decisions' : '/compact '
  const { useSessionsStore: sessions } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  sessions.setState({
    activeTabId: scenario === 'draft-create' ? null : 'one',
    runtime: { one: emptyRuntime(), two: emptyRuntime() }
  })
  const store = {
    get activeTabId() { return sessions.getState().activeTabId },
    set activeTabId(id: string | null) { sessions.setState({ activeTabId: id }) },
    get runtime() { return sessions.getState().runtime },
    beginPrompt: sessions.getState().beginPrompt,
    rollbackPrompt(...args: Parameters<ReturnType<typeof sessions.getState>['rollbackPrompt']>) {
      rollbackCalls++
      sessions.getState().rollbackPrompt(...args)
    },
    previewSessionTitle() {},
    beginBash: sessions.getState().beginBash,
    endBash(...args: Parameters<ReturnType<typeof sessions.getState>['endBash']>) {
      if (this.runtime[args[0]].bashExecution?.id === args[1]) bashEnds++
      sessions.getState().endBash(...args)
    },
    promoteDraft: async () => {
      promoteCalls++
      store.activeTabId = 'one'
      return true
    },
    refreshCwd: async () => { if (scenario === 'refresh') throw new Error('Refresh failed') },
    hydrateTurns: async () => {
      hydrationCalls++
      if (scenario.startsWith('bash')) store.runtime.one.turns = [{
        id: 'bash-row', bash: { command: 'echo done', cancelled: false }, answer: [], branchSummaries: [], compactions: [], workBlocks: [false],
        hasProcess: true, startedAt: 1, endedAt: 2
      }]
      return true
    },
    loadControls: async () => {}
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: { getState: () => store },
    selectActiveSessionId: () => store.activeTabId
  }))
  const continuation = scenario.startsWith('command-') && scenario !== 'command-only'
  const behaviors: Array<PromptStreamingBehavior | undefined> = []
  const status: PiMessage = { role: 'custom', customType: 'repair', content: 'Repair started', display: true, timestamp: 100 }
  const startRepair = () => {
    sessions.getState().setStreaming('one', true)
    sessions.getState().appendLiveMessage('one', status)
  }
  Object.assign(window.api, {
    prepareSession: async () => {
      await prepared.promise
      return { sessionId: 'one', cwd: '/project', created: true }
    },
    prompt: async (...args: Parameters<SessionApi['prompt']>) => {
      const [target, text, , , behavior] = args
      promptCalls++
      sentPrompt = text
      behaviors.push(behavior)
      if (continuation && promptCalls === 1) {
        if (scenario !== 'command-delayed') startRepair()
        if (scenario === 'command-error') throw new Error('Command failed after starting repair')
      } else {
        if (scenario !== 'command-only') store.runtime[target].pendingUserMessage = false
        if (continuation && !behavior) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")
        if (scenario === 'accepted-error') throw new Error('Run failed after acknowledgement')
      }
    },
    compactSession: async (id: string, instructions?: string) => {
      assert.equal(id, 'one')
      compactCalls++
      compactInstructions = instructions
      await prepared.promise
    },
    executeBash: async (_id: string, command: string) => {
      bashCalls++
      assert.equal(command, 'echo done')
      if (scenario === 'bash-error') throw new Error('Shell failed')
      return { output: 'done', exitCode: 0, cancelled: false, truncated: false }
    },
    abortBash: async () => {},
    abort: async () => {
      abortCalls++
      if (scenario !== 'stopped') throw new Error('Abort failed')
    }
  })
  const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
  const { useComposerImages } = await import('../src/renderer/src/components/composer/useComposerImages')
  const { useComposerSubmission } = await import('../src/renderer/src/components/composer/useComposerSubmission')
  let state!: ReturnType<typeof useComposerSubmission>
  let editor!: ReturnType<typeof useComposerEditor>
  let images!: ReturnType<typeof useComposerImages>
  function Probe({ sessionId, draft = false }: { sessionId: string | null; draft?: boolean }) {
    const draftKey = draft ? 'draft:/project' : sessionId
    images = useComposerImages(draftKey)
    editor = useComposerEditor({ sessionId: draftKey, onKeyDown: () => false, onPasteImages: images.add })
    state = useComposerSubmission({
      sessionId,
      draftCwd: draft ? '/project' : undefined,
      isDraftSession: draft,
      document: editor,
      attachments: images,
      bashMode: scenario.startsWith('bash')
    })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (sessionId: 'one' | 'two' | null, draft = false) => {
    store.activeTabId = draft ? null : sessionId
    await act(async () => { root.render(createElement(Probe, { sessionId, draft })) })
  }

  try {
    await render('one', scenario.startsWith('draft-') || scenario === 'bash-draft' || scenario === 'compact-draft')
    if (scenario === 'compact-streaming') store.runtime.one.isStreaming = true
    await act(async () => {
      if (scenario !== 'duplicate-images') {
        editor.restore({ type: 'doc', content: [{ type: 'paragraph', content: [
          { type: 'text', text: continuation ? '/end-review' : isCompact ? compactText : scenario === 'escaped-bash' ? '!echo done' : scenario.startsWith('bash') ? 'echo done' : '原文' },
          ...(scenario.startsWith('bash') || isCompact || scenario === 'escaped-bash' || continuation ? [] : [{ type: 'pastedText', attrs: { id: 'paste', text: '附件', byteSize: 6 } }])
        ] }] })
      }
      if (scenario === 'bash-attachments' || scenario === 'compact-attachments' || (!scenario.startsWith('bash') && !isCompact && scenario !== 'escaped-bash' && !continuation)) {
        images.restore([{ id: 'image', mimeType: 'image/png', data: 'AA==', url: 'blob:original' }])
      }
    })
    if (scenario === 'review-returning') {
      const { useSystemUIStore } = await import('../src/renderer/src/stores/system-ui')
      useSystemUIStore.getState().setReviewReturning('one', true)
      for (const mode of ['followUp', 'steer'] as const) await act(async () => { await state.send(mode) })
      assert.equal(promptCalls, 0)
      assert.equal(store.runtime.one.isStreaming, false)
      assert.equal(editor.getDraft().text, '原文附件')
      assert.equal(editor.getDraft().attachments.length, 1)
      assert.equal(images.images.length, 1)
      await render('two')
      await act(async () => { editor.replaceText('另一会话'); prepared.resolve(); await state.send() })
      assert.equal(promptCalls, 1)
      assert.equal(sentPrompt, '另一会话')
      await render('one')
      await act(async () => { await state.send() })
      assert.equal(promptCalls, 1)
      assert.equal(editor.getDraft().text, '原文附件')
      useSystemUIStore.getState().setReviewReturning('one', false)
      await act(async () => { await state.send() })
      assert.equal(promptCalls, 2)
      assert.equal(editor.getDraft().text, '')
      assert.equal(images.images.length, 0)
      assert.equal(state.error, undefined)
      return
    }
    let sending!: Promise<void>
    let duplicate!: Promise<void>
    await act(async () => {
      sending = state.send()
      if (scenario === 'duplicate-images' || scenario === 'bash') duplicate = state.send()
    })
    if (scenario === 'newer-draft') await act(async () => { editor.replaceText('新输入') })
    if (scenario === 'bash-busy') store.runtime.one.isStreaming = true
    if (scenario === 'draft-failure') await render('one')
    if (scenario === 'stopped') await act(async () => { await state.abort() })
    if (scenario === 'switch') await render('two')
    if (scenario === 'remount') {
      await act(async () => { root.render(null) })
      await render('one')
    }
    if (scenario === 'reopened') store.runtime.one.instanceId++
    await act(async () => {
      if (['newer-draft', 'switch', 'remount', 'reopened', 'draft-failure', 'compact-error'].includes(scenario)) prepared.reject(new Error('Prepare failed'))
      else prepared.resolve()
      await sending
      await duplicate
    })

    if (promptCalls > 0) assert.equal(behaviors[0], 'followUp')
    if (continuation) {
      assert.equal(rollbackCalls, 1)
      assert.equal(store.runtime.one.pendingUserMessage, false)
      if (scenario === 'command-delayed') {
        assert.equal(store.runtime.one.isStreaming, false)
        assert.deepEqual(store.runtime.one.liveMessages, [])
        startRepair()
      }
      assert.equal(store.runtime.one.isStreaming, true)
      assert.notEqual(store.runtime.one.streamStartedAt, null)
      assert.deepEqual(store.runtime.one.liveMessages, [status])
      if (scenario === 'command-error') {
        assert.match(state.error ?? '', /Command failed after starting repair/)
        assert.equal(editor.getDraft().text, '/end-review')
      } else {
        sessions.getState().appendLiveMessage('one', { role: 'user', content: 'Implement findings', timestamp: 200 })
        for (const mode of ['followUp', 'steer'] as const) {
          await act(async () => { editor.replaceText(`Additional instructions: ${mode}`) })
          await act(async () => { await state.send(mode) })
          assert.equal(behaviors.at(-1), mode)
          assert.equal(store.runtime.one.isStreaming, true)
          assert.equal(state.error, undefined)
        }
        assert.equal(promptCalls, 3)
      }
      sessions.getState().setStreaming('one', false)
      assert.equal(store.runtime.one.isStreaming, false)
    } else if (isCompact) {
      assert.equal(promptCalls, 0)
      assert.equal(bashCalls, 0)
      assert.equal(rollbackCalls, 0)
      assert.equal(hydrationCalls, 0)
      assert.equal(store.runtime.one.pendingUserMessage, false)
      if (scenario === 'compact-attachments') {
        assert.equal(compactCalls, 0)
        assert.equal(editor.getDraft().text, compactText)
        assert.equal(images.images.length, 1)
        assert.match(state.error ?? '', /Remove images and attachments/)
      } else {
        assert.equal(compactCalls, 1)
        assert.equal(compactInstructions, scenario === 'compact-streaming' ? 'Preserve decisions' : undefined)
        if (scenario === 'compact-error') {
          assert.match(state.error ?? '', /Prepare failed/)
          assert.equal(editor.getDraft().text, compactText)
        } else {
          assert.equal(editor.getDraft().text, '')
          assert.equal(state.error, undefined)
          if (scenario === 'compact-draft') assert.equal(promoteCalls, 1)
          if (scenario === 'compact-streaming') assert.equal(store.runtime.one.isStreaming, true)
        }
      }
    } else if (scenario === 'newer-draft') {
      assert.equal(editor.getDraft().text, '新输入')
      assert.equal(state.canRestore, true)
      assert.equal(rollbackCalls, 1)
      await act(async () => { state.restore() })
      assert.equal(editor.getDraft().text, '原文附件\n新输入')
      assert.equal(editor.getDraft().attachments.length, 1)
      assert.equal(images.images.length, 1)
      assert.equal(images.images[0].url, 'data:image/png;base64,AA==')
    } else if (scenario === 'switch') {
      assert.equal(editor.getDraft().text, '')
      assert.equal(state.error, undefined)
      await render('one')
      assert.equal(editor.getDraft().text, '原文附件')
      assert.equal(editor.getDraft().attachments.length, 1)
      assert.equal(images.images.length, 1)
      assert.equal(state.canRestore, false)
    } else if (scenario === 'remount') {
      assert.equal(rollbackCalls, 1)
      assert.equal(editor.getDraft().text, '原文附件')
      assert.equal(editor.getDraft().attachments.length, 1)
      assert.equal(images.images.length, 1)
      assert.match(state.error ?? '', /Prepare failed/)
      assert.equal(state.canRestore, false)
    } else if (scenario === 'reopened') {
      assert.equal(rollbackCalls, 0)
      assert.equal(editor.getDraft().text, '')
      assert.equal(state.canRestore, false)
    } else if (scenario === 'stopped') {
      assert.equal(abortCalls, 1)
      assert.equal(promptCalls, 0)
      assert.equal(rollbackCalls, 1)
      assert.equal(store.runtime.one.isStreaming, false)
      assert.equal(store.runtime.one.liveMessages.length, 0)
      assert.equal(state.error, undefined)
      assert.equal(state.canRestore, false)
      assert.equal(editor.getDraft().text, '原文附件')
      assert.equal(editor.getDraft().attachments.length, 1)
      assert.equal(images.images.length, 1)
    } else if (scenario === 'draft-create') {
      assert.equal(promoteCalls, 1)
      assert.equal(promptCalls, 1)
      assert.equal(editor.getDraft().text, '')
      assert.equal(state.error, undefined)
    } else if (scenario === 'draft-failure') {
      assert.equal(promoteCalls, 1)
      assert.equal(promptCalls, 0)
      assert.equal(editor.getDraft().text, '原文附件')
      assert.equal(editor.getDraft().attachments.length, 1)
      assert.equal(images.images.length, 1)
      assert.match(state.error ?? '', /Prepare failed/)
    } else if (scenario === 'bash-attachments') {
      assert.equal(promptCalls, 0)
      assert.equal(bashCalls, 0)
      assert.equal(editor.getDraft().text, 'echo done')
      assert.equal(images.images.length, 1)
      assert.match(state.error ?? '', /Remove images and attachments/)
    } else if (scenario === 'escaped-bash') {
      assert.equal(promptCalls, 1)
      assert.equal(sentPrompt, '!echo done')
      assert.equal(bashCalls, 0)
    } else if (scenario === 'bash-busy') {
      assert.equal(promptCalls, 0)
      assert.equal(bashCalls, 0)
      assert.equal(bashEnds, 0)
      assert.equal(editor.getDraft().text, 'echo done')
      assert.match(state.error ?? '', /started working|已经开始工作/)
    } else if (scenario === 'bash' || scenario === 'bash-error' || scenario === 'bash-draft') {
      assert.equal(promptCalls, 0)
      assert.equal(bashCalls, 1)
      assert.equal(bashEnds, 1)
      assert.equal(store.runtime.one.bashExecution, null)
      if (scenario === 'bash' || scenario === 'bash-draft') {
        if (scenario === 'bash-draft') assert.equal(promoteCalls, 1)
        assert.equal(hydrationCalls, 1)
        assert.equal(editor.getDraft().text, '')
        assert.equal(state.error, undefined)
      } else {
        assert.match(state.error ?? '', /Shell failed/)
        assert.equal(editor.getDraft().text, '!echo done')
      }
    } else if (scenario === 'command-only') {
      assert.equal(promptCalls, 1)
      assert.equal(rollbackCalls, 1)
      assert.equal(hydrationCalls, 1)
      assert.equal(store.runtime.one.isStreaming, false)
      assert.equal(state.canRestore, false)
    } else {
      assert.equal(promptCalls, 1)
      assert.equal(rollbackCalls, 0)
      assert.equal(editor.getDraft().text, '')
      assert.equal(state.canRestore, false)
      if (scenario !== 'duplicate-images') assert.ok(state.error)
    }
  } finally {
    prepared.resolve()
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--submission-fixture') {
  await fixture(process.argv[3])
} else {
  for (const scenario of ['newer-draft', 'switch', 'remount', 'refresh', 'accepted-error', 'reopened', 'duplicate-images', 'command-only', 'command-started', 'command-delayed', 'command-error', 'stopped', 'draft-create', 'draft-failure', 'bash', 'bash-error', 'bash-draft', 'bash-busy', 'bash-attachments', 'escaped-bash', 'compact', 'compact-streaming', 'compact-error', 'compact-draft', 'compact-attachments', 'review-returning']) {
    test(`composer submission recovery: ${scenario}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--submission-fixture', scenario], { stdout: 'pipe', stderr: 'pipe' })
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

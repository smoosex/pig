import { test } from 'bun:test'
import assert from 'node:assert/strict'

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
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { mock } = await import('bun:test')
  const prepared = deferred()
  let promptCalls = 0
  let abortCalls = 0
  let rollbackCalls = 0
  let exportCalls = 0
  let hydrationCalls = 0
  let promoteCalls = 0
  let bashCalls = 0
  let bashEnds = 0
  let sentPrompt = ''
  const runtime = () => ({
    instanceId: 1, pendingUserMessage: false, isStreaming: false, liveMessages: [] as unknown[],
    bashExecution: null as { id: string; command: string } | null,
    turns: [] as Array<{ id: string; bash: { command: string } }>
  })
  const store = {
    activeTabId: scenario === 'draft-create' ? null as string | null : 'one' as string | null,
    runtime: { one: runtime(), two: runtime() },
    beginPrompt(id: 'one' | 'two', message: unknown) {
      Object.assign(this.runtime[id], { isStreaming: true, pendingUserMessage: true, liveMessages: [message] })
    },
    rollbackPrompt(id: 'one' | 'two') {
      rollbackCalls++
      Object.assign(this.runtime[id], { isStreaming: false, pendingUserMessage: false, liveMessages: [] })
    },
    previewSessionTitle() {},
    beginBash(id: 'one' | 'two', executionId: string, command: string) {
      this.runtime[id].bashExecution = { id: executionId, command }
    },
    endBash(id: 'one' | 'two', executionId: string) {
      if (this.runtime[id].bashExecution?.id === executionId) {
        bashEnds++
        this.runtime[id].bashExecution = null
      }
    },
    promoteDraft: async () => {
      promoteCalls++
      store.activeTabId = 'one'
      return true
    },
    refreshCwd: async () => { if (scenario === 'refresh') throw new Error('Refresh failed') },
    hydrateTurns: async () => {
      hydrationCalls++
      if (scenario.startsWith('bash')) store.runtime.one.turns = [{ id: 'bash-row', bash: { command: 'echo done' } }]
      return true
    },
    loadControls: async () => {}
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: { getState: () => store },
    selectActiveSessionId: () => store.activeTabId
  }))
  Object.assign(window, { api: {
    prepareSession: async () => {
      await prepared.promise
      return { sessionId: 'one', cwd: '/project', created: true }
    },
    prompt: async (_id: string, text: string) => {
      promptCalls++
      sentPrompt = text
      if (scenario !== 'command-only') store.runtime.one.pendingUserMessage = false
      if (scenario === 'accepted-error') throw new Error('Run failed after acknowledgement')
    },
    exportSession: async () => { exportCalls++; await prepared.promise; throw new Error('Export failed') },
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
  } })
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
    await render('one', scenario.startsWith('draft-') || scenario === 'bash-draft')
    await act(async () => {
      if (scenario !== 'duplicate-images') {
        editor.restore({ type: 'doc', content: [{ type: 'paragraph', content: [
          { type: 'text', text: scenario === 'export' ? '/export' : scenario === 'escaped-bash' ? '!echo done' : scenario.startsWith('bash') ? 'echo done' : '原文' },
          ...(scenario === 'export' || scenario.startsWith('bash') || scenario === 'escaped-bash' ? [] : [{ type: 'pastedText', attrs: { id: 'paste', text: '附件', byteSize: 6 } }])
        ] }] })
      }
      if (scenario !== 'export' && (scenario === 'bash-attachments' || (!scenario.startsWith('bash') && scenario !== 'escaped-bash'))) {
        images.restore([{ id: 'image', mimeType: 'image/png', data: 'AA==', url: 'blob:original' }])
      }
    })
    let sending!: Promise<void>
    let duplicate!: Promise<void>
    await act(async () => {
      sending = state.send()
      if (scenario === 'duplicate-images' || scenario === 'export' || scenario === 'bash') duplicate = state.send()
    })
    if (scenario === 'newer-draft') await act(async () => { editor.replaceText('新输入') })
    if (scenario === 'bash-busy') store.runtime.one.isStreaming = true
    if (scenario === 'draft-failure') await render('one')
    if (scenario === 'stopped') await act(async () => { await state.abort() })
    if (scenario === 'switch') await render('two')
    if (scenario === 'reopened') store.runtime.one.instanceId++
    await act(async () => {
      if (['newer-draft', 'switch', 'reopened', 'draft-failure'].includes(scenario)) prepared.reject(new Error('Prepare failed'))
      else prepared.resolve()
      await sending
      await duplicate
    })

    if (scenario === 'newer-draft') {
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
    } else if (scenario === 'export') {
      assert.equal(exportCalls, 1)
      assert.equal(editor.getDraft().text, '/export')
      assert.match(state.error ?? '', /Export failed/)
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
  for (const scenario of ['newer-draft', 'switch', 'refresh', 'accepted-error', 'reopened', 'duplicate-images', 'export', 'command-only', 'stopped', 'draft-create', 'draft-failure', 'bash', 'bash-error', 'bash-draft', 'bash-busy', 'bash-attachments', 'escaped-bash']) {
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

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
  const runtime = () => ({ instanceId: 1, pendingUserMessage: false, isStreaming: false, liveMessages: [] as unknown[] })
  const store = {
    activeSessionId: 'one',
    runtime: { one: runtime(), two: runtime() },
    beginPrompt(id: 'one' | 'two', message: unknown) {
      Object.assign(this.runtime[id], { isStreaming: true, pendingUserMessage: true, liveMessages: [message] })
    },
    rollbackPrompt(id: 'one' | 'two') {
      rollbackCalls++
      Object.assign(this.runtime[id], { isStreaming: false, pendingUserMessage: false, liveMessages: [] })
    },
    previewSessionTitle() {},
    refreshCwd: async () => { if (scenario === 'refresh') throw new Error('Refresh failed') },
    hydrateTurns: async () => { hydrationCalls++; return true },
    loadControls: async () => {}
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: { getState: () => store } }))
  Object.assign(window, { api: {
    prepareSession: async () => {
      await prepared.promise
      return { sessionId: 'one', cwd: '/project', created: true }
    },
    prompt: async () => {
      promptCalls++
      if (scenario !== 'command-only') store.runtime.one.pendingUserMessage = false
      if (scenario === 'accepted-error') throw new Error('Run failed after acknowledgement')
    },
    exportSession: async () => { exportCalls++; await prepared.promise; throw new Error('Export failed') },
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
  function Probe({ sessionId }: { sessionId: string }) {
    images = useComposerImages(sessionId)
    editor = useComposerEditor({ sessionId, onKeyDown: () => false, onPasteImages: images.add })
    state = useComposerSubmission({ sessionId, document: editor, attachments: images })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (sessionId: 'one' | 'two') => {
    store.activeSessionId = sessionId
    await act(async () => { root.render(createElement(Probe, { sessionId })) })
  }

  try {
    await render('one')
    await act(async () => {
      if (scenario !== 'duplicate-images') {
        editor.restore({ type: 'doc', content: [{ type: 'paragraph', content: [
          { type: 'text', text: scenario === 'export' ? '/export' : '原文' },
          ...(scenario === 'export' ? [] : [{ type: 'pastedText', attrs: { id: 'paste', text: '附件', byteSize: 6 } }])
        ] }] })
      }
      if (scenario !== 'export') images.restore([{ id: 'image', mimeType: 'image/png', data: 'AA==', url: 'blob:original' }])
    })
    let sending!: Promise<void>
    let duplicate!: Promise<void>
    await act(async () => {
      sending = state.send()
      if (scenario === 'duplicate-images' || scenario === 'export') duplicate = state.send()
    })
    if (scenario === 'newer-draft') await act(async () => { editor.replaceText('新输入') })
    if (scenario === 'stopped') await act(async () => { await state.abort() })
    if (scenario === 'switch') await render('two')
    if (scenario === 'reopened') store.runtime.one.instanceId++
    await act(async () => {
      if (['newer-draft', 'switch', 'reopened'].includes(scenario)) prepared.reject(new Error('Prepare failed'))
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
  for (const scenario of ['newer-draft', 'switch', 'refresh', 'accepted-error', 'reopened', 'duplicate-images', 'export', 'command-only', 'stopped']) {
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

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, PromptStreamingBehavior } from '../src/shared/api'
import type { PiMessage } from '../src/renderer/src/pi/types'
import { runSelf } from './helpers/subprocess.ts'

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
  const { EditorContent } = await import('@tiptap/react')
  const { mock } = await import('bun:test')
  const prepared = deferred()
  const promoted = deferred()
  const leaveBeforeMount = scenario === 'draft-leave-before-mount'
  const leaveBeforeFrame = scenario === 'draft-leave-before-frame'
  const newerBash = scenario === 'bash-draft-newer'
  const handoff = ['draft-create', 'draft-newer', 'draft-late-mount', 'bash-draft'].includes(scenario) || leaveBeforeMount || leaveBeforeFrame || newerBash
  let finishImage!: () => void
  let readingImage: Promise<void> | undefined
  let promptCalls = 0
  let abortCalls = 0
  let rollbackCalls = 0
  let hydrationCalls = 0
  let promoteCalls = 0
  let bashCalls = 0
  let bashEnds = 0
  let sentPrompt = ''
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
      if (handoff) await promoted.promise
      store.activeTabId = 'one'
      return true
    },
    refreshCwd: async () => { if (scenario === 'refresh') throw new Error('Refresh failed') },
    hydrateTurns: async () => {
      hydrationCalls++
      if (scenario.startsWith('bash')) store.runtime.one.turns = [{
        id: 'bash-row', bash: { command: 'echo done', cancelled: false }, answer: [], branchSummaries: [], compactions: [], workBlocks: [false],
        hasProcess: true, lastEntryId: 'last', startedAt: 1, endedAt: 2
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
    const draftKey = sessionId
    images = useComposerImages(draftKey)
    editor = useComposerEditor({ sessionId: draftKey, receivePromotionFocus: !draft, onKeyDown: () => false, onPasteImages: images.add })
    state = useComposerSubmission({
      sessionId,
      draftCwd: draft ? '/project' : undefined,
      isDraftSession: draft,
      document: editor,
      attachments: images,
      bashMode: scenario.startsWith('bash')
    })
    return handoff ? createElement(EditorContent, { editor: editor.editor }) : null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (sessionId: 'one' | 'two' | null, draft = false) => {
    store.activeTabId = draft ? null : sessionId
    await act(async () => { root.render(createElement(Probe, { sessionId, draft })) })
  }

  try {
    await render('one', scenario.startsWith('draft-') || scenario.startsWith('bash-draft'))
    await act(async () => {
      if (scenario !== 'duplicate-images') {
        editor.restore({ type: 'doc', content: [{ type: 'paragraph', content: [
          { type: 'text', text: continuation ? '/end-review' : scenario === 'escaped-bash' ? '!echo done' : scenario.startsWith('bash') ? 'echo done' : '原文' },
          ...(scenario.startsWith('bash') || scenario === 'escaped-bash' || continuation ? [] : [{ type: 'pastedText', attrs: { id: 'paste', text: '附件', byteSize: 6 } }])
        ] }] })
      }
      if (scenario === 'bash-attachments' || (!scenario.startsWith('bash') && scenario !== 'escaped-bash' && !continuation)) {
        images.restore([{ id: 'image', mimeType: 'image/png', data: 'AA==', url: 'blob:original' }])
      }
    })
    if (scenario === 'branch-navigating') {
      sessions.setState((current) => ({ runtime: { ...current.runtime, one: { ...current.runtime.one, isNavigatingBranch: true } } }))
      for (const mode of ['followUp', 'steer'] as const) await act(async () => { await state.send(mode) })
      assert.equal(promptCalls, 0, 'nothing is sent while the tree is summarizing or switching')
      assert.equal(editor.getDraft().text, '原文附件', 'the draft is kept for after navigation')
      sessions.setState((current) => ({ runtime: { ...current.runtime, one: { ...current.runtime.one, isNavigatingBranch: false } } }))
      await act(async () => { prepared.resolve(); await state.send() })
      assert.equal(promptCalls, 1)
      return
    }
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
      if (handoff) editor.editor!.view.focus()
      sending = state.send()
      if (scenario === 'duplicate-images' || scenario === 'bash') duplicate = state.send()
    })
    if (scenario === 'newer-draft') await act(async () => { editor.replaceText('新输入') })
    if (scenario === 'bash-busy') store.runtime.one.isStreaming = true
    if (scenario === 'draft-late-mount' || leaveBeforeMount) {
      // Promotion publishes the selection before React replaces the home editor.
      await act(async () => { promoted.resolve() })
      const { useComposerDraftsStore } = await import('../src/renderer/src/stores/composer-drafts')
      assert.ok(useComposerDraftsStore.getState().drafts.one?.focusAfterPromotion, 'the outgoing editor cannot take the request')
      if (leaveBeforeMount) {
        await render('two')
        assert.equal(useComposerDraftsStore.getState().drafts.one?.focusAfterPromotion, false)
      }
      await act(async () => { root.render(null) })
      await render('one')
    } else if (handoff) {
      const oldEditor = editor.editor
      await act(async () => { root.render(null) })
      await render('one')
      assert.notEqual(editor.editor, oldEditor)
      assert.equal(editor.getDraft().text, scenario.startsWith('bash-draft') ? 'echo done' : '原文附件')
      if (scenario === 'draft-newer') await act(async () => {
        const otherControl = document.createElement('button')
        container.after(otherControl)
        otherControl.id = 'other-control'
        otherControl.focus()
        editor.replaceText('交接期间的新输入')
        images.restore([{ id: 'new-image', mimeType: 'image/png', data: 'AQ==' }])
      })
      if (scenario === 'draft-create' || leaveBeforeFrame) {
        const outgoingControl = document.createElement('button')
        container.after(outgoingControl)
        outgoingControl.focus()
        const frames = new Map<number, FrameRequestCallback>()
        const request = globalThis.requestAnimationFrame
        const cancel = globalThis.cancelAnimationFrame
        let frameId = 0
        globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
        globalThis.cancelAnimationFrame = id => { frames.delete(id) }
        try {
          await act(async () => { promoted.resolve() })
          assert.ok(document.activeElement === outgoingControl, 'focus is not moved during the commit')
          outgoingControl.remove()
          if (leaveBeforeFrame) {
            await render('two')
            await render('one')
          }
          await act(async () => { for (const callback of frames.values()) callback(performance.now()) })
          assert.equal(document.activeElement === editor.editor!.view.dom, !leaveBeforeFrame, 'focus is handed off only if the user did not leave the tab')
        } finally {
          globalThis.requestAnimationFrame = request
          globalThis.cancelAnimationFrame = cancel
        }
      } else {
        await act(async () => { promoted.resolve() })
      }
    }
    if (newerBash) {
      const Reader = globalThis.FileReader
      try {
        globalThis.FileReader = class extends Reader {
          override readAsDataURL() {
            finishImage = () => {
              Object.defineProperty(this, 'result', { value: 'data:image/png;base64,AQ==' })
              this.dispatchEvent(new Event('load'))
            }
          }
        }
        await act(async () => {
          editor.replaceText('next draft')
          editor.editor!.commands.setTextSelection({ from: 2, to: 5 })
          readingImage = images.add([new File(['x'], 'next.png', { type: 'image/png' })])
        })
      } finally {
        globalThis.FileReader = Reader
      }
    }
    if (scenario === 'draft-failure') await render('one')
    if (scenario === 'stopped') await act(async () => { await state.abort() })
    if (scenario === 'switch') await render('two')
    if (scenario === 'remount') {
      await act(async () => { root.render(null) })
      await render('one')
    }
    if (scenario === 'reopened') store.runtime.one.instanceId++
    await act(async () => {
      if (['newer-draft', 'switch', 'remount', 'reopened', 'draft-failure'].includes(scenario)) prepared.reject(new Error('Prepare failed'))
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
    } else if (newerBash) {
      assert.equal(bashCalls, 1)
      assert.equal(editor.getDraft().text, 'next draft')
      const { from, to } = editor.editor!.state.selection
      assert.deepEqual([from, to], [2, 5])
      await act(async () => { finishImage(); await readingImage })
      assert.deepEqual(images.images.map(image => image.data), ['AQ=='])
    } else if (leaveBeforeMount || leaveBeforeFrame) {
      await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
      assert.equal(promptCalls, 1)
      assert.notEqual(document.activeElement, editor.editor!.view.dom)
    } else if (scenario === 'draft-create' || scenario === 'draft-newer' || scenario === 'draft-late-mount') {
      if (scenario === 'draft-late-mount') await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
      assert.equal(promoteCalls, 1)
      assert.equal(promptCalls, 1)
      assert.equal(sentPrompt, '原文附件')
      assert.equal(editor.getDraft().text, scenario === 'draft-newer' ? '交接期间的新输入' : '')
      assert.deepEqual(images.images.map(image => image.id), scenario === 'draft-newer' ? ['new-image'] : [])
      const expectedFocus = scenario === 'draft-newer' ? document.getElementById('other-control') : editor.editor!.view.dom
      assert.ok(document.activeElement === expectedFocus, 'promotion restores lost focus but does not steal focus from another control')
      await act(async () => { root.render(null) })
      await render('one')
      assert.ok(document.activeElement !== editor.editor!.view.dom, 'the focus handoff is not replayed on another mount')
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
  for (const scenario of ['newer-draft', 'switch', 'remount', 'refresh', 'accepted-error', 'reopened', 'duplicate-images', 'command-only', 'command-started', 'command-delayed', 'command-error', 'stopped', 'draft-create', 'draft-newer', 'draft-late-mount', 'draft-leave-before-mount', 'draft-leave-before-frame', 'draft-failure', 'bash', 'bash-error', 'bash-draft', 'bash-draft-newer', 'bash-busy', 'bash-attachments', 'escaped-bash', 'review-returning', 'branch-navigating']) {
    test(`composer submission recovery: ${scenario}`, async () => {
      const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--submission-fixture', scenario], { timeoutMs: 10_000 })
      assert.equal(code, 0, stderr || stdout)
    }, 15_000)
  }
}

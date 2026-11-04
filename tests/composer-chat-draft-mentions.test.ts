import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const requestedStates: string[] = []
  const fileDirectories: string[] = []
  Object.assign(window, { api: {
    supportsGlass: false,
    getCommands: async () => [],
    onPluginsChanged: () => () => {},
    suggestFiles: async (cwd: string) => { fileDirectories.push(cwd); return [] },
    browser: {
      onState: () => () => {},
      getState: async (browserId: string) => {
        requestedStates.push(browserId)
        return { browserId, url: 'https://example.test/' }
      }
    }
  } })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { useComposer } = await import('../src/renderer/src/components/composer/useComposer')
  const { TAB_REFERENCE_DROP } = await import('../src/renderer/src/components/composer/tab-reference')
  const { tabMentions } = await import('../src/renderer/src/components/composer/tab-mentions')
  const { textToComposerDocument } = await import('../src/renderer/src/components/composer/document')
  const cwd = '/pig/chats/private'
  useSessionsStore.setState({
    activeTabId: null,
    chatDraft: { sessionId: 'chat-draft', cwd },
    openTabs: [
      { id: 'browser:chat', kind: 'browser', title: 'Chat browser', cwd: '', loadState: 'ready' },
      { id: 'browser:project', kind: 'browser', title: 'Project browser', cwd: '/project', loadState: 'ready' }
    ]
  })
  let state!: ReturnType<typeof useComposer>
  mock.module('../src/renderer/src/components/composer/useComposer', () => ({
    useComposer: (...args: Parameters<typeof useComposer>) => { state = useComposer(...args); return state }
  }))
  for (const [path, name] of [
    ['../src/renderer/src/components/FollowUpQueue', 'FollowUpQueue'],
    ['../src/renderer/src/components/ImagePreview', 'ImagePreview'],
    ['../src/renderer/src/components/composer/CompactionStatus', 'CompactionStatus'],
    ['../src/renderer/src/components/composer/RetryNotice', 'RetryNotice'],
    ['../src/renderer/src/components/composer/ReviewFeedback', 'ReviewFeedback'],
    ['../src/renderer/src/components/composer/ComposerToolbar', 'ComposerToolbar'],
    ['../src/renderer/src/components/composer/MentionSuggestions', 'MentionSuggestions']
  ] as const) mock.module(path, () => ({ [name]: () => null }))
  mock.module('../src/renderer/src/components/composer/ApprovalPrompt', () => ({
    ApprovalPrompt: () => null, useApprovalPrompt: () => undefined
  }))
  mock.module('../src/renderer/src/components/composer/useComposerAppearance', () => ({ useComposerAppearance: () => ({}) }))
  const { Composer } = await import('../src/renderer/src/components/Composer')
  type ComposerProps = NonNullable<Parameters<typeof Composer>[0]>
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const replace = (text: string) => state.editor!.commands.setContent(textToComposerDocument(text))
  try {
    await act(async () => { root.render(createElement<ComposerProps>(Composer, { draftCwd: cwd, draftSessionId: 'chat-draft' })) })
    assert.equal(useSessionsStore.getState().openTabs.some((tab) => tab.id === 'chat-draft'), false)
    await act(async () => { replace('@browser'); await Bun.sleep(0) })
    await act(async () => { await Bun.sleep(200) })
    assert.equal(state.mentions.open, true)
    assert.deepEqual(state.mentions.items.filter((item) => item.kind === 'tab').map((item) => item.tab.id), ['browser:chat'])
    assert.deepEqual(requestedStates, ['browser:chat'])
    assert.deepEqual(fileDirectories, [cwd], 'file completion still uses the private scratch directory')
    await act(async () => {
      assert.equal(state.mentions.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })), true)
    })
    assert.equal(state.editor!.getText(), '@[browser:chat] ')

    state.editor!.view.posAtCoords = () => null
    const target = container.querySelector('[data-tab-reference-target]')!
    const drop = (id: string) => {
      const reference = tabMentions(useSessionsStore.getState().openTabs).find((item) => item.id === id)!
      target.dispatchEvent(new CustomEvent(TAB_REFERENCE_DROP, { detail: { reference, x: 0, y: 0 } }))
    }
    await act(async () => { replace(''); drop('browser:project') })
    assert.equal(state.editor!.getText(), '', 'Chat drafts cannot reference project browsers')
    await act(async () => { drop('browser:chat') })
    assert.equal(state.editor!.getText(), '@[browser:chat] ')

    await act(async () => {
      root.render(createElement<ComposerProps>(Composer, { draftCwd: '/project', draftSessionId: 'project-draft' }))
    })
    await act(async () => { replace(''); drop('browser:chat') })
    assert.equal(state.editor!.getText(), '', 'project drafts cannot borrow the unrelated Chat draft scope')
    await act(async () => { drop('browser:project') })
    assert.equal(state.editor!.getText(), '@[browser:project] ')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--chat-draft-mentions-fixture') {
  await fixture()
} else {
  test('Chat home drafts select and receive Chat browser references without leaking project browsers', async () => {
    const result = await runSelf(import.meta.path, ['--chat-draft-mentions-fixture'])
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
  })
}

import { describe, expect, mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { atMentionToken, mentionValue } from '../src/renderer/src/components/composer/mentions'

mock.module('../src/renderer/src/ipc/api', () => ({
  api: {
    suggestFiles: async (_cwd: string, query: string) =>
      query === 'd'
        ? [{ path: 'dir space/', isDirectory: true }]
        : [{ path: 'src/a.ts', isDirectory: false }]
  }
}))

describe('at-mention token', () => {
  test('takes the token behind the caret, not the start of the text', () => {
    expect(atMentionToken('看下 @src/ma')).toEqual({ start: 3, raw: '@src/ma', query: 'src/ma', quoted: false })
  })

  test('opens on a bare @', () => {
    expect(atMentionToken('@')).toEqual({ start: 0, raw: '@', query: '', quoted: false })
  })

  test('leaves emails and mid-word @ alone', () => {
    expect(atMentionToken('mail@example.com')).toBeNull()
    expect(atMentionToken('foo@bar')).toBeNull()
  })

  test('closes on a trailing space', () => {
    expect(atMentionToken('@a ')).toBeNull()
    expect(atMentionToken('plain text')).toBeNull()
  })

  test('triggers after prose separators', () => {
    expect(atMentionToken('(see @a/b')?.query).toBe('a/b')
    expect(atMentionToken('see,@x')?.start).toBe(4)
  })

  test('splits on CJK punctuation the way Pi does', () => {
    expect(atMentionToken('看下，@src/ma')).toEqual({ start: 3, raw: '@src/ma', query: 'src/ma', quoted: false })
    expect(atMentionToken('看下。@src')?.query).toBe('src')
    expect(atMentionToken('看下、@src')?.query).toBe('src')
    expect(atMentionToken('（@src')?.query).toBe('src')
    expect(atMentionToken('mail@example.com')).toBeNull()
  })

  test('reads the quoted form until its closing quote', () => {
    expect(atMentionToken('@"my file')).toEqual({ start: 0, raw: '@"my file', query: 'my file', quoted: true })
    expect(atMentionToken('see @"my file')?.start).toBe(4)
    expect(atMentionToken('@"done"')).toBeNull()
    expect(atMentionToken('@"done" @x')?.query).toBe('x')
  })
})

describe('mention value', () => {
  test('quotes only when the token was quoted or the path needs it', () => {
    expect(mentionValue('src/a.ts', false)).toBe('@src/a.ts')
    expect(mentionValue('a b.ts', false)).toBe('@"a b.ts"')
    expect(mentionValue('src/a.ts', true)).toBe('@"src/a.ts"')
  })
})

let domReady = false
async function ensureDom(): Promise<void> {
  if (domReady) return
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  domReady = true
}

describe('file mention dismissal', () => {
  test('the menu reopens after completing once', async () => {
    await ensureDom()
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
    const { useFileMentions } = await import('../src/renderer/src/components/composer/useFileMentions')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    let editorState!: ReturnType<typeof useComposerEditor>
    let mentionState!: ReturnType<typeof useFileMentions>
    function Probe() {
      editorState = useComposerEditor({ sessionId: 'mentions', onKeyDown: () => false, onPasteImages: async () => {} })
      mentionState = useFileMentions({ resetKey: 'mentions', cwd: '/repo', editor: editorState.editor, disabled: false })
      return null
    }
    await act(async () => { root.render(createElement(Probe)) })
    assert.ok(editorState.editor)
    const editor = editorState.editor

    await act(async () => { editor.commands.insertContent('@') })
    await act(async () => { await sleep(250) })
    assert.equal(mentionState.open, true)
    await act(async () => {
      assert.equal(mentionState.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })), true)
    })
    assert.equal(editorState.getDraft().text, '@src/a.ts ')

    await act(async () => { editor.commands.insertContent(' @') })
    await act(async () => { await sleep(250) })
    assert.equal(mentionState.open, true)
    await act(async () => { root.unmount() })
  })

  test('typing narrows without closing while the fresh rows load', async () => {
    await ensureDom()
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
    const { useFileMentions } = await import('../src/renderer/src/components/composer/useFileMentions')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    let editorState!: ReturnType<typeof useComposerEditor>
    let mentionState!: ReturnType<typeof useFileMentions>
    function Probe() {
      editorState = useComposerEditor({ sessionId: 'mentions', onKeyDown: () => false, onPasteImages: async () => {} })
      mentionState = useFileMentions({ resetKey: 'mentions', cwd: '/repo', editor: editorState.editor, disabled: false })
      return null
    }
    await act(async () => { root.render(createElement(Probe)) })
    assert.ok(editorState.editor)
    const editor = editorState.editor

    await act(async () => { editor.commands.insertContent('@') })
    await act(async () => { await sleep(250) })
    assert.equal(mentionState.open, true)
    // No sleep: the narrowed fetch is still debounced, but the stale rows stay up.
    await act(async () => { editor.commands.insertContent('m') })
    assert.equal(mentionState.open, true)
    await act(async () => { await sleep(250) })
    assert.equal(mentionState.open, true)
    await act(async () => { root.unmount() })
  })

  test('a directory with whitespace keeps the caret inside its quotes', async () => {
    await ensureDom()
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
    const { useFileMentions } = await import('../src/renderer/src/components/composer/useFileMentions')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    let editorState!: ReturnType<typeof useComposerEditor>
    let mentionState!: ReturnType<typeof useFileMentions>
    function Probe() {
      editorState = useComposerEditor({ sessionId: 'mentions', onKeyDown: () => false, onPasteImages: async () => {} })
      mentionState = useFileMentions({ resetKey: 'mentions', cwd: '/repo', editor: editorState.editor, disabled: false })
      return null
    }
    await act(async () => { root.render(createElement(Probe)) })
    assert.ok(editorState.editor)
    const editor = editorState.editor

    await act(async () => { editor.commands.insertContent('@d') })
    await act(async () => { await sleep(250) })
    assert.equal(mentionState.open, true)
    await act(async () => {
      assert.equal(mentionState.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })), true)
    })
    assert.equal(editorState.getDraft().text, '@"dir space/"')
    // Before the closing quote, not after it: the token stays open so the menu can descend.
    assert.equal(editor.state.selection.from, 13)
    await act(async () => { await sleep(250) })
    assert.equal(mentionState.open, true)
    // Typing inside the quotes descends instead of closing the token.
    await act(async () => { editor.commands.insertContent('f') })
    assert.equal(mentionState.open, true)
    await act(async () => { root.unmount() })
  })
})

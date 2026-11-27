import { afterEach, describe, expect, mock, test } from 'bun:test'
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
let domOurs = false
async function ensureDom(): Promise<void> {
  if (domReady) return
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  try {
    GlobalRegistrator.register({ url: 'http://localhost' })
    domOurs = true
  } catch {
    // Another fixture in this process holds the document; the containers below keep every
    // assertion scoped, so sharing it is fine.
    domOurs = false
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  domReady = true
}

async function releaseDom(): Promise<void> {
  if (!domReady || !domOurs) return
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  await GlobalRegistrator.unregister()
  domReady = false
  domOurs = false
}
afterEach(async () => {
  const { useComposerDraftsStore } = await import('../src/renderer/src/stores/composer-drafts')
  useComposerDraftsStore.getState().discard('mentions')
  await releaseDom()
})

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

describe('file drag into the composer', () => {
  test('a file from the same worktree lands as a chip; another worktree is refused', async () => {
    await ensureDom()
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
    const { fileDragProps } = await import('../src/renderer/src/components/composer/file-drag')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    let editorState!: ReturnType<typeof useComposerEditor>
    function Probe() {
      editorState = useComposerEditor({ sessionId: 'drag', cwd: '/repo', onKeyDown: () => false, onPasteImages: async () => {} })
      return null
    }
    await act(async () => { root.render(createElement(Probe)) })
    assert.ok(editorState.editor)
    const view = editorState.editor.view
    view.posAtCoords = () => null

    const drop = (cwd: string, path: string, isDirectory: boolean) => {
      const data = new Map<string, string>()
      const dataTransfer = {
        types: [] as string[],
        effectAllowed: 'all',
        dropEffect: 'none',
        files: [],
        setData(type: string, value: string) { data.set(type, value); this.types.push(type) },
        getData: (type: string) => data.get(type) ?? ''
      }
      const props = fileDragProps({ cwd, path, isDirectory })
      props.onDragStart({ dataTransfer } as never)
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.assign(event, { dataTransfer, clientX: 0, clientY: 0 })
      view.dom.dispatchEvent(event)
      props.onDragEnd()
      return event.defaultPrevented
    }

    await act(async () => { assert.equal(drop('/other', 'src/b.ts', false), true) })
    assert.equal(editorState.getDraft().text, '')
    await act(async () => { assert.equal(drop('/repo', 'src/a.ts', false), true) })
    assert.equal(editorState.getDraft().text, '@src/a.ts ')
    assert.equal(editorState.editor.getJSON().content?.[0].content?.[0].type, 'fileMention')
    await act(async () => { drop('/repo', 'my dir', true) })
    assert.equal(editorState.getDraft().text, '@src/a.ts @"my dir/" ')
    await act(async () => { root.unmount() })
    container.remove()
  })

  test('classifies draggable payloads, attaches dropped OS images, and renders top drop hints', async () => {
    await ensureDom()
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
    const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
    const { ComposerDropHint } = await import('../src/renderer/src/components/composer/ComposerDropHint')
    const { classifyComposerDrag, fileDragProps } = await import('../src/renderer/src/components/composer/file-drag')
    const { TAB_REFERENCE_DRAG, dropTabReference, hoverTabReference } = await import(
      '../src/renderer/src/components/composer/tab-reference'
    )

    useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })

    // 1. classifyComposerDrag distinguishes workspace files, OS images, plain text, and rejected drags
    const sameRepoDrag = fileDragProps({ cwd: '/repo', path: 'AGENTS.md', isDirectory: false })
    const wsData = new Map<string, string>()
    const wsTransfer = {
      types: [] as string[],
      files: [] as File[],
      items: [],
      effectAllowed: 'all',
      dropEffect: 'none',
      setData(type: string, value: string) {
        wsData.set(type, value)
        this.types.push(type)
      },
      getData: (type: string) => wsData.get(type) ?? ''
    }
    sameRepoDrag.onDragStart({ dataTransfer: wsTransfer } as never)
    expect(
      classifyComposerDrag({ dataTransfer: wsTransfer as unknown as DataTransfer }, { editable: true, cwd: '/repo' })
    ).toBe('files')
    expect(
      classifyComposerDrag({ dataTransfer: wsTransfer as unknown as DataTransfer }, { editable: true, cwd: '/other' })
    ).toBeNull()
    sameRepoDrag.onDragEnd()

    const imgFile = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    const pdfFile = new File([new Uint8Array([1, 2, 3])], 'doc.pdf', { type: 'application/pdf' })
    expect(
      classifyComposerDrag(
        { dataTransfer: { types: ['Files'], files: [imgFile], items: [] } as unknown as DataTransfer },
        { editable: true, cwd: '/repo', bashMode: false }
      )
    ).toBe('files')
    expect(
      classifyComposerDrag(
        { dataTransfer: { types: ['Files'], files: [imgFile], items: [] } as unknown as DataTransfer },
        { editable: true, cwd: '/repo', bashMode: true }
      )
    ).toBe('files')
    expect(
      classifyComposerDrag(
        { dataTransfer: { types: ['Files'], files: [pdfFile], items: [] } as unknown as DataTransfer },
        { editable: true, cwd: '/repo', bashMode: false }
      )
    ).toBe('files')
    expect(
      classifyComposerDrag(
        { dataTransfer: { types: ['text/plain'], files: [], items: [] } as unknown as DataTransfer },
        { editable: true, cwd: '/repo', internalDragging: false }
      )
    ).toBe('text')
    expect(
      classifyComposerDrag(
        { dataTransfer: { types: ['text/plain'], files: [], items: [] } as unknown as DataTransfer },
        { editable: true, cwd: '/repo', internalDragging: true }
      )
    ).toBeNull()

    // 2. Dropping an OS image file forwards it to onPasteImages and suppresses ProseMirror's inline dropcursor
    const receivedImages: File[][] = []
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let editorState!: ReturnType<typeof useComposerEditor>
    function EditorProbe() {
      editorState = useComposerEditor({
        sessionId: 'drag-image',
        cwd: '/repo',
        onKeyDown: () => false,
        onPasteImages: async (files) => {
          receivedImages.push(files)
        }
      })
      return null
    }
    await act(async () => {
      root.render(createElement(EditorProbe))
    })
    assert.ok(editorState.editor)
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.assign(dropEvent, {
      dataTransfer: { types: ['Files'], files: [imgFile], items: [], getData: () => '' },
      clientX: 0,
      clientY: 0
    })
    await act(async () => {
      editorState.editor!.view.dom.dispatchEvent(dropEvent)
    })
    assert.equal(dropEvent.defaultPrevented, true)
    assert.equal(receivedImages.length, 1)
    assert.equal(receivedImages[0]?.[0]?.name, 'shot.png')

    // 2b. Dragging files never draws a dropcursor line and ignores pointer coordinates, appending at
    // the end when no caret was placed or inserting at the active caret when explicitly positioned.
    await act(async () => {
      editorState.replaceText('已有前缀')
    })
    editorState.editor!.view.posAtCoords = () => ({ pos: 1, inside: 0 })
    const fileDrag = fileDragProps({ cwd: '/repo', path: 'AGENTS.md', isDirectory: false })
    const fileData = new Map<string, string>()
    const fileTransfer = {
      types: [] as string[],
      files: [] as File[],
      items: [],
      effectAllowed: 'all',
      dropEffect: 'none',
      setData(type: string, value: string) {
        fileData.set(type, value)
        this.types.push(type)
      },
      getData: (type: string) => fileData.get(type) ?? ''
    }
    fileDrag.onDragStart({ dataTransfer: fileTransfer } as never)
    const overEvent = new Event('dragover', { bubbles: true, cancelable: true })
    Object.assign(overEvent, { dataTransfer: fileTransfer, clientX: 2, clientY: 2 })
    await act(async () => {
      editorState.editor!.view.dom.dispatchEvent(overEvent)
    })
    assert.equal(
      document.querySelector('.prosemirror-dropcursor-block, .prosemirror-dropcursor-inline'),
      null,
      'dropcursor plugin is disabled so no horizontal or vertical line renders during dragover'
    )
    const fileDropEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.assign(fileDropEvent, { dataTransfer: fileTransfer, clientX: 2, clientY: 2 })
    await act(async () => {
      editorState.editor!.view.dom.dispatchEvent(fileDropEvent)
    })
    fileDrag.onDragEnd()
    assert.equal(
      editorState.getDraft().text,
      '已有前缀 @AGENTS.md ',
      'drops append after existing content instead of jumping to posAtCoords(1)'
    )

    // 2c. External OS filesystem drops convert workspace-internal files to relative chips, external files
    // to absolute chips, directories to `@dir/` text, and bash-mode drops to shell-escaped paths.
    const fakePaths = new Map<File, string>()
    const insideOsFile = new File(['export {}'], 'inside.ts', { type: 'text/typescript' })
    const outsideOsFile = new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' })
    const outsideOsDir = new File([''], 'my docs', { type: '' })
    fakePaths.set(insideOsFile, '/repo/src/inside.ts')
    fakePaths.set(outsideOsFile, '/outside/spec.pdf')
    fakePaths.set(outsideOsDir, '/outside/my docs')
    const prevWinApi = (window as unknown as { api?: Record<string, unknown> }).api
    Object.assign(window, {
      api: {
        ...(prevWinApi ?? {}),
        getPathForFile: (file: File) => fakePaths.get(file) ?? '',
        localFileMentionInfo: async (path: string) =>
          path === '/outside/my docs'
            ? { kind: 'directory' as const, absolutePath: path, modifiedAt: 1 }
            : { kind: 'file' as const, absolutePath: path, modifiedAt: 1, lineCount: 10 }
      }
    })
    await act(async () => {
      editorState.clear()
    })
    const osDropEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.assign(osDropEvent, {
      dataTransfer: {
        types: ['Files'],
        files: [insideOsFile, outsideOsFile, outsideOsDir],
        items: [],
        getData: () => ''
      },
      clientX: 0,
      clientY: 0
    })
    await act(async () => {
      editorState.editor!.view.dom.dispatchEvent(osDropEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(osDropEvent.defaultPrevented, true)
    assert.equal(editorState.getDraft().text, '@src/inside.ts @/outside/spec.pdf @"/outside/my docs/" ')
    assert.deepEqual(
      editorState.getDraft().mentions.map((m) => m.path),
      ['src/inside.ts', '/outside/spec.pdf']
    )
    Object.assign(window, { api: prevWinApi })

    // 3. ComposerDropHint renders localized banner text and hoverTabReference notifies target enter/leave
    await act(async () => {
      root.render(createElement(ComposerDropHint, { kind: 'files' }))
    })
    assert.equal(container.querySelector('[data-composer-drop-hint]')?.textContent, '拖放文件以添加附件')
    await act(async () => {
      root.render(createElement(ComposerDropHint, { kind: 'tab' }))
    })
    assert.equal(container.querySelector('[data-composer-drop-hint]')?.textContent, '拖放标签以添加引用')

    const dragStates: Array<string | null> = []
    const targetEl = document.createElement('div')
    targetEl.addEventListener(TAB_REFERENCE_DRAG, (event) => {
      const detail = (event as CustomEvent<{ reference: { id: string } | null }>).detail
      dragStates.push(detail.reference?.id ?? null)
    })
    const termTab = { id: 'term-1', cwd: '/repo', title: 'zsh', kind: 'terminal' as const, loadState: 'ready' as const }
    hoverTabReference(targetEl, termTab, [termTab])
    dropTabReference(targetEl, termTab, 10, 10, [termTab])
    assert.deepEqual(dragStates, ['term-1', null])

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})

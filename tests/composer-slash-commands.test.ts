import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { SlashCommand } from '../src/shared/api'

const commands = [{ name: 'review', source: 'extension' }, { name: 'export', source: 'prompt' }] as SlashCommand[]
mock.module('../src/renderer/src/ipc/api', () => ({
  api: { getCommands: async () => commands, onPluginsChanged: () => () => {} }
}))

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

async function setup() {
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
  const { useSlashCommands } = await import('../src/renderer/src/components/composer/useSlashCommands')
  const { useComposerDraftsStore } = await import('../src/renderer/src/stores/composer-drafts')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let documentState!: ReturnType<typeof useComposerEditor>
  let slashState!: ReturnType<typeof useSlashCommands>
  function Probe() {
    documentState = useComposerEditor({ sessionId: 'slash', onKeyDown: () => false, onPasteImages: async () => {} })
    slashState = useSlashCommands('slash', documentState.editor)
    return null
  }
  cleanup = async () => {
    await act(async () => { root.unmount() })
    container.remove()
    useComposerDraftsStore.getState().discard('slash')
    await GlobalRegistrator.unregister()
  }
  await act(async () => { root.render(createElement(Probe)) })
  const editor = documentState.editor!
  return { act, editor, slash: () => slashState, draft: () => documentState.getDraft() }
}

test('opens slash completion before existing prose and preserves the document suffix on selection', async () => {
  const { act, editor, slash, draft } = await setup()
  const suffix = [
    { type: 'text', text: '原有 prompt' },
    { type: 'hardBreak' },
    { type: 'text', text: '第二行 ' },
    { type: 'fileMention', attrs: { path: 'src/main.ts' } },
    { type: 'pastedText', attrs: { id: 'paste', text: '附件内容', filename: 'paste.txt', byteSize: 12 } }
  ]
  await act(async () => {
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: suffix }] })
    editor.commands.setTextSelection(1)
    editor.commands.insertContent('/')
  })
  expect(slash().open).toBe(true)
  expect(slash().filtered).toHaveLength(2)
  await act(async () => { editor.commands.insertContent('rev') })
  expect(slash().filtered.map((command) => command.name)).toEqual(['review'])
  const original = draft()
  await act(async () => { slash().select(commands[0]) })
  expect(draft().text).toBe('/review ' + original.text.slice(4))
  expect<unknown>(editor.getJSON().content?.[0].content?.slice(1)).toEqual(suffix.slice(1))
  expect(draft().attachments[0]?.id).toBe('paste')
  expect(draft().mentions[0]?.path).toBe('src/main.ts')
  expect(editor.state.selection.from).toBe(9)
  expect(slash().open).toBe(false)
})

test('refreshes candidates after silent restoration without a selection change', async () => {
  const { act, editor, slash, draft } = await setup()
  await act(async () => {
    editor.commands.setContent('<p>/rev</p>')
    editor.commands.setTextSelection(5)
  })
  expect(slash().filtered.map((command) => command.name)).toEqual(['review'])
  const previousSelection = editor.state.selection
  await act(async () => {
    editor.commands.setContent('<p>/exp</p>', { emitUpdate: false })
  })
  expect(editor.state.selection.eq(previousSelection)).toBe(true)
  expect(slash().open).toBe(true)
  expect(slash().filtered.map((command) => command.name)).toEqual(['export'])
  await act(async () => {
    expect(slash().handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  })
  expect(draft().text).toBe('/export ')
  expect(slash().open).toBe(false)
})

test('tracks caret movement and dismisses outside the initial plain-text command', async () => {
  const { act, editor, slash } = await setup()
  await act(async () => {
    editor.commands.setContent('<p>/rev existing prompt</p>')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  })
  expect(slash().open).toBe(false)
  await act(async () => { editor.commands.setTextSelection(5) })
  expect(slash().open).toBe(true)
  await act(async () => { slash().handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(slash().open).toBe(false)
  await act(async () => { editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
  await act(async () => { editor.commands.setTextSelection(5) })
  expect(slash().open).toBe(true)
  await act(async () => { editor.commands.setTextSelection({ from: 1, to: 5 }) })
  expect(slash().open).toBe(false)
  for (const content of [
    [{ type: 'text', text: 'hello /rev' }],
    [{ type: 'text', text: 'hello' }, { type: 'hardBreak' }, { type: 'text', text: '/rev' }],
    [{ type: 'fileMention', attrs: { path: 'a' } }, { type: 'text', text: '/rev' }],
    [{ type: 'pastedText', attrs: { id: 'p', text: '/rev' } }]
  ]) {
    await act(async () => {
      editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content }] })
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    })
    expect(slash().open).toBe(false)
  }
})

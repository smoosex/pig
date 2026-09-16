import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  try {
    if (name === 'editor') {
      const { useComposerEditor } = await import('../src/renderer/src/components/composer/useComposerEditor')
      let state!: ReturnType<typeof useComposerEditor>
      let forwarded = 0
      const frames = new Map<number, FrameRequestCallback>()
      let nextFrame = 0
      globalThis.requestAnimationFrame = (callback) => {
        frames.set(++nextFrame, callback)
        return nextFrame
      }
      globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
      function Probe({ sessionId }: { sessionId: string }) {
        state = useComposerEditor({ sessionId, onKeyDown: () => { forwarded++; return true }, onPasteImages: async () => {} })
        return null
      }
      await act(async () => { root.render(createElement(Probe, { sessionId: 'one' })) })
      assert.ok(state.editor)
      const editor = state.editor
      const props = editor.options.editorProps!
      const keyDown = (init: KeyboardEventInit) => props.handleKeyDown!.call(undefined, editor.view, new KeyboardEvent('keydown', init))
      assert.equal(keyDown({ key: 'Enter', isComposing: true }), false)
      assert.equal(keyDown({ key: 'Enter', keyCode: 229 }), false)
      props.handleDOMEvents!.compositionstart!.call(undefined, editor.view, new CompositionEvent('compositionstart'))
      assert.equal(keyDown({ key: 'Enter' }), false)
      props.handleDOMEvents!.compositionend!.call(undefined, editor.view, new CompositionEvent('compositionend'))
      assert.equal(keyDown({ key: 'Enter' }), false)
      for (const callback of frames.values()) callback(0)
      frames.clear()
      assert.equal(keyDown({ key: 'Enter' }), true)
      assert.equal(forwarded, 1)

      // Windows clipboards hand over CRLF and some clipboard sources only CR. The paste path is our
      // own, so nothing normalizes it for us: every \r that survives lands in the prompt.
      const paste = async (text: string) => {
        let prevented = false
        const event = {
          clipboardData: {
            getData: (type: string) => (type === 'text/plain' ? text : ''),
            files: [],
            items: []
          },
          preventDefault: () => { prevented = true }
        } as unknown as ClipboardEvent
        let handled = false
        await act(async () => {
          handled = Boolean(props.handlePaste!.call(undefined, editor.view, event))
        })
        assert.equal(handled, true)
        assert.equal(prevented, true)
        return state.getDraft()
      }

      await act(async () => { state.clear() })
      assert.equal((await paste('a\r\nb\r\nc')).text, 'a\nb\nc')
      await act(async () => { state.clear() })
      assert.equal((await paste('a\rb\rc')).text, 'a\nb\nc')

      // Past the line threshold the paste becomes a chip, whose stored text and byte size must be
      // measured on the same LF version the prompt receives.
      await act(async () => { state.clear() })
      const long = Array.from({ length: 22 }, (_, index) => `line${index}`).join('\r\n')
      const chipped = await paste(long)
      assert.equal(chipped.text, long.replace(/\r\n/g, '\n'))
      assert.equal(chipped.attachments.length, 1)
      const attachment = chipped.attachments[0]
      assert.equal(chipped.text.slice(attachment.start, attachment.end), attachment.text)
      assert.equal(attachment.byteSize, new TextEncoder().encode(attachment.text).byteLength)
      await act(async () => { state.clear() })

      // What the editor writes to the clipboard has to read back as the same draft: ProseMirror's
      // default block separator is a blank line, which would add one newline per paragraph.
      await act(async () => { state.replaceText('一\n二\n三') })
      await act(async () => { editor.commands.selectAll() })
      const copied = editor.view.serializeForClipboard(editor.view.state.selection.content()).text
      assert.equal(copied, '一\n二\n三')
      assert.equal((await paste(copied)).text, '一\n二\n三')

      await act(async () => { state.replaceText('编辑\n队列') })
      assert.equal(state.getDraft().text, '编辑\n队列')
      await act(async () => {
        state.clear()
        assert.equal(state.getDraft().text, '')
      })
      await act(async () => { state.replaceText('旧会话') })
      await act(async () => { root.render(createElement(Probe, { sessionId: 'two' })) })
      assert.equal(state.getDraft().text, '')
    } else {
      const { useComposerImages } = await import('../src/renderer/src/components/composer/useComposerImages')
      const reads: FakeFileReader[] = []
      class FakeFileReader {
        result: string | null = null
        error: Error | null = null
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        readAsDataURL() { reads.push(this) }
        finish(result = 'data:image/png;base64,image') { this.result = result; this.onload?.() }
        fail() { this.error = new Error('read failed'); this.onerror?.() }
      }
      Object.assign(globalThis, { FileReader: FakeFileReader })
      let nextUrl = 0
      const revoked: string[] = []
      URL.createObjectURL = () => `blob:test-${++nextUrl}`
      URL.revokeObjectURL = (url) => { revoked.push(url) }
      let state!: ReturnType<typeof useComposerImages>
      function Probe({ sessionId }: { sessionId: string }) {
        state = useComposerImages(sessionId)
        return null
      }
      const file = () => new File(['image'], 'image.png', { type: 'image/png' })
      await act(async () => { root.render(createElement(Probe, { sessionId: 'one' })) })
      const pending = state.add([file()])
      await act(async () => { root.render(createElement(Probe, { sessionId: 'two' })) })
      await act(async () => { reads[0].finish(); await pending })
      assert.equal(state.images.length, 0)
      assert.deepEqual(revoked, ['blob:test-1'])

      const partial = state.add([file(), file()])
      await act(async () => { reads[1].finish(); reads[2].fail(); await partial })
      assert.equal(state.images.length, 1)
      assert.ok(state.error)
      const activeUrl = state.images[0].url
      const duringSend = state.add([file()])
      await act(async () => { state.clear() })
      await act(async () => { reads[3].finish(); await duringSend })
      assert.equal(state.images.length, 0)
      assert.equal(state.error, null)
      assert.ok(revoked.includes(activeUrl))
      assert.equal(revoked.length, 3)

      // A zero-byte file reads as an empty payload; it has to surface as a failure instead of a
      // thumbnail that can never render, and it must not leak a preview URL.
      const empty = state.add([file()])
      await act(async () => { reads[4].finish('data:image/png;base64,'); await empty })
      assert.equal(state.images.length, 0)
      assert.equal(state.error, '有图片读取失败，请重新粘贴。')
      assert.equal(revoked.length, 3)
    }
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--composer-fixture') {
  await runFixture(process.argv[3])
} else {
  for (const [name, title] of Object.entries({
    editor: 'IME confirmation never forwards Enter, and the clipboard round-trips the draft line for line',
    images: 'pending image reads cannot escape their session or cleared draft'
  })) {
    test(`composer lifecycle: ${title}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--composer-fixture', name], {
        cwd: new URL('..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 12_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(exitCode, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

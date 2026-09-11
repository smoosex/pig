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
        finish() { this.result = 'data:image/png;base64,image'; this.onload?.() }
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
    editor: 'IME confirmation never forwards Enter and clearing updates the draft immediately',
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

import { test } from 'bun:test'
import assert from 'node:assert/strict'

/** Isolate Tiptap and its DOM so Esc's mode latch is exercised through the real editor key handler. */
async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, {
    api: { getCommands: async () => [{ name: 'export', description: 'Export the session' }], onPluginsChanged: () => () => {} }
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useComposer } = await import('../src/renderer/src/components/composer/useComposer')
  const { textToComposerDocument } = await import('../src/renderer/src/components/composer/document')
  let state!: ReturnType<typeof useComposer>
  const replace = (text: string) => state.editor?.commands.setContent(textToComposerDocument(text))
  function Probe({ sessionId = 'draft-bash' }: { sessionId?: string }) {
    state = useComposer('/project', sessionId)
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(createElement(Probe)) })
    await act(async () => { replace('not ! first') })
    assert.equal(state.bashMode, false)
    await act(async () => { replace(' !echo later') })
    assert.equal(state.bashMode, false)
    await act(async () => { replace('!echo ready') })
    assert.equal(state.bashMode, true)
    assert.equal(state.editor?.getText(), 'echo ready')
    assert.equal(state.canRunBash, true)
    await act(async () => {
      state.editor?.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(state.bashMode, false)
    assert.equal(state.editor?.getText(), '!echo ready')
    await act(async () => { replace('!pwd') })
    assert.equal(state.bashMode, false)
    await act(async () => { replace('plain text') })
    await act(async () => { replace('!pwd') })
    assert.equal(state.bashMode, true)
    assert.equal(state.editor?.getText(), 'pwd')
    await act(async () => { replace('') })
    assert.equal(state.bashMode, true)
    assert.equal(state.editor?.getText(), '')
    assert.equal(state.canRunBash, false)
    await act(async () => {
      state.editor?.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(state.bashMode, false)
    assert.equal(state.editor?.getText(), '!')
    await act(async () => { replace('plain text') })
    await act(async () => { replace('!') })
    assert.equal(state.bashMode, true)
    assert.equal(state.editor?.getText(), '')
    await act(async () => {
      state.editor?.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await act(async () => { replace('plain text') })
    await act(async () => { replace('') })
    await act(async () => { state.editor?.commands.insertContent('!') })
    assert.equal(state.bashMode, true)
    assert.equal(state.editor?.getText(), '')
    await act(async () => { state.editor?.commands.insertContent('echo typed') })
    assert.equal(state.editor?.getText(), 'echo typed')
    assert.equal(state.canRunBash, true)
    await act(async () => {
      state.editor?.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await act(async () => { state.editor?.commands.insertContent(' again') })
    assert.equal(state.editor?.getText(), '!echo typed again')
    await act(async () => { replace('plain text') })
    const pasted = '!'.padEnd(500, 'x')
    await act(async () => {
      state.editor?.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'pastedText', attrs: { id: 'paste', text: pasted, byteSize: 500 } }
      ] }] })
    })
    assert.equal(state.bashMode, false)
    assert.equal(state.editor?.getJSON().content?.[0]?.content?.[0]?.type, 'pastedText')
    await act(async () => { replace('plain text') })
    await act(async () => { replace('/e') })
    await act(async () => { await Bun.sleep(0) })
    assert.equal(state.bashMode, false)
    assert.equal(state.commands.open, true)
    // Bash commands start with / often enough that the menu must not steal Enter from them.
    await act(async () => { replace('!/e') })
    await act(async () => { await Bun.sleep(0) })
    assert.equal(state.bashMode, true)
    assert.equal(state.editor?.getText(), '/e')
    assert.equal(state.commands.open, false)
    await act(async () => { replace('plain text') })
    await act(async () => { replace('!pwd') })
    assert.equal(state.bashMode, true)
    await act(async () => { root.render(createElement(Probe, { sessionId: 'draft-other' })) })
    assert.equal(state.bashMode, false)
    await act(async () => { root.render(createElement(Probe, { sessionId: 'draft-bash' })) })
    assert.equal(state.bashMode, true, 'returning restores the session-owned Bash draft')
    assert.equal(state.editor?.getText(), '!pwd')
    const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
    useSettingsStore.setState({ shortcuts: { 'composer.focus': 'Mod+Alt+Enter' } })
    await act(async () => { replace('plain text') })
    const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
    // Sending looks up the session's runtime before anything else; nothing else reads it during the key press.
    let sent = 0
    const runtime = useSessionsStore.getState().runtime
    await act(async () => {
      useSessionsStore.setState({ runtime: new Proxy(runtime, { get: (target, key) => { if (key === 'draft-bash') sent++; return Reflect.get(target, key) } }) })
    })
    sent = 0
    const focusKey = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, altKey: true, bubbles: true, cancelable: true })
    state.editor?.view.dom.dispatchEvent(focusKey)
    assert.equal(sent, 0, 'an Enter-based focus shortcut never sends the draft')
    await act(async () => { useSessionsStore.setState({ runtime }) })
    assert.ok(focusKey.defaultPrevented, 'the focus shortcut is consumed in the editor')
    assert.equal(state.editor?.getText(), 'plain text')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--bash-mode-fixture') {
  await fixture()
} else {
  test('only a first-character ! enters Bash mode; Esc preserves ! without immediately re-entering', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--bash-mode-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 12_000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}

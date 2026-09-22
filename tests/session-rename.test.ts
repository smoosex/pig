import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi } from '../src/shared/api'

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: NoopResizeObserver, IntersectionObserver: undefined })
  Object.assign(window, { ResizeObserver: NoopResizeObserver, IntersectionObserver: undefined })

  const renames: { sessionId: string; name: string }[] = []
  Object.assign(window, {
    api: {
      renameSession: async (sessionId: string, name: string) => { renames.push({ sessionId, name }) }
    } as unknown as SessionApi
  })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } =
    await import('../src/renderer/src/components/ui/context-menu')
  const { SessionRenameField, useSessionRename } =
    await import('../src/renderer/src/components/SessionRenameField')

  function Row(): React.ReactElement {
    const rename = useSessionRename('s1', '/tmp/s1.jsonl')
    return h(
      ContextMenu,
      null,
      h(
        ContextMenuTrigger,
        { asChild: true, disabled: rename.editing },
        h(
          'div',
          { className: 'row' },
          rename.editing
            ? h(SessionRenameField, { value: '旧名字', onCommit: rename.commit, onCancel: rename.cancel })
            : h('button', { type: 'button' }, '旧名字')
        )
      ),
      h(ContextMenuContent, null, h(ContextMenuItem, { onSelect: rename.start }, '重命名'))
    )
  }

  function Harness(): React.ReactElement {
    return h('div', null, h('button', { type: 'button', id: 'elsewhere' }, '别处'), h(Row))
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(h(Harness)) })

  const flush = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }

  if (name === 'rename-field-keeps-focus') {
    const elsewhere = host.querySelector<HTMLButtonElement>('#elsewhere')!
    elsewhere.focus()
    assert.equal(document.activeElement, elsewhere, 'the fixture starts with focus outside the row')

    const trigger = host.querySelector<HTMLElement>('.row')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    await flush()
    const item = document.querySelector<HTMLElement>('[data-slot="context-menu-item"]')
    assert.ok(item, 'the context menu opened')

    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const input = host.querySelector<HTMLInputElement>('input')
    assert.ok(input, 'the rename field replaced the title')
    await flush()

    assert.deepEqual(renames, [], 'an untouched field must not commit a name')
    assert.equal(document.activeElement, input, 'the field keeps the focus the menu gave it')
    assert.equal(input.value, '旧名字')

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, '新名字')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await flush()

    assert.deepEqual(renames, [{ sessionId: 's1', name: '新名字' }], 'Enter writes the typed name')
    assert.equal(host.querySelector('input'), null, 'the field closes once it commits')
    assert.equal(host.querySelector('.row button')?.textContent, '旧名字', 'the row returns to its button')
    return
  }

  throw new Error(`unknown fixture: ${name}`)
}

if (process.argv.includes('--session-rename-fixture')) {
  await runFixture(process.argv[process.argv.indexOf('--session-rename-fixture') + 1]!)
} else {
  test('rename: the menu hands focus to the inline field, which keeps it until Enter commits', async () => {
    const child = Bun.spawn(
      [process.execPath, import.meta.path, '--session-rename-fixture', 'rename-field-keeps-focus'],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}

/** Isolates renderer mocks while checking nested calls against the direct tool panels. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { LiveNestedCalls } from '../src/renderer/src/chat/nested-tools'
import type { ToolStep } from '../src/renderer/src/chat/turns'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { supportsGlass: false } })
  const { mock } = await import('bun:test')
  mock.module('../src/renderer/src/lib/highlight', () => ({
    langFromPath: () => 'typescript',
    useHighlightHtml: () => undefined
  }))
  mock.module('../src/renderer/src/components/diff/EditDiffBody', () => ({
    default: ({ path, edits }: { path: string; edits: { oldText: string; newText: string }[] }) =>
      createElement('div', { 'data-edit-path': path }, JSON.stringify(edits))
  }))
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { ToolRow } = await import('../src/renderer/src/components/turn/ToolDetails')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const record: LiveNestedCalls = {
    complete: false,
    calls: [
      { id: 'parent/1', name: 'edit', arguments: { path: 'src/edit.ts', edits: [{ oldText: 'before', newText: 'after' }] }, status: 'ok', durationMs: 12 },
      { id: 'parent/2', name: 'write', arguments: { path: 'src/write.ts', content: 'export const value = 42' }, status: 'ok' },
      { id: 'parent/3', name: 'bash', arguments: { command: 'pwd' }, status: 'running' },
      { id: 'parent/4', name: 'read', arguments: { path: 'src/read.ts' }, status: 'ok' },
      { id: 'parent/5', name: 'write', argumentsBytes: 9000, status: 'unfinished' },
      { id: 'parent/6', name: 'bash', arguments: { command: 'exit 1' }, status: 'error', error: 'command failed' }
    ]
  }
  const parent: ToolStep = { id: 'parent', name: 'codemode', args: { code: 'return tools.read(...)' } }
  const trigger = (prefix: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent?.startsWith(prefix))
    assert.ok(button, `missing disclosure: ${prefix}`)
    return button
  }
  const open = async (prefix: string) => {
    const button = trigger(prefix)
    await act(async () => { button.click() })
    return button.closest<HTMLElement>('[data-slot="collapsible"]')!
  }
  const renderParent = async (final: boolean) => {
    await act(async () => {
      root.render(createElement(ToolRow, {
        step: final ? {
          ...parent,
          result: {
            role: 'toolResult', toolCallId: parent.id, toolName: parent.name,
            content: [], isError: false, timestamp: 1,
            nestedCalls: {
              ...record,
              calls: record.calls.map((call) => ({ ...call, status: call.status === 'running' ? 'unfinished' : call.status }))
            }
          }
        } : { ...parent, partialResult: { content: [], nestedCalls: record } }
      }))
    })
  }

  try {
    const directBodies: string[] = []
    for (const call of record.calls.slice(0, 4)) {
      await act(async () => {
        root.render(createElement(ToolRow, {
          key: call.id,
          step: { id: call.id, name: call.name, args: call.arguments! }
        }))
      })
      await act(async () => { container.querySelector('button')!.click() })
      directBodies.push(container.querySelector('[data-slot="collapsible-content"]')!.innerHTML)
    }

    await renderParent(false)
    await open('Call codemode')
    assert.equal(container.querySelector('[data-edit-path]'), null)
    await open('Nested tool calls (6)')
    assert.match(container.textContent ?? '', /Some calls or arguments were not saved/)
    assert.match(trigger('Edit src/edit.ts').textContent ?? '', /Succeeded.*12 ms/)
    assert.match(trigger('Run pwd').textContent ?? '', /Running/)
    assert.ok(trigger('Run pwd').querySelector('.shimmer'))

    const prefixes = ['Edit src/edit.ts', 'Write src/write.ts', 'Run pwd', 'Read src/read.ts']
    for (const [index, prefix] of prefixes.entries()) {
      const row = await open(prefix)
      assert.equal(row.querySelector('[data-slot="collapsible-content"]')!.innerHTML, directBodies[index])
    }
    assert.equal(container.querySelector('[data-edit-path]')?.getAttribute('data-edit-path'), 'src/edit.ts')
    assert.equal(container.querySelector('[data-edit-path]')?.textContent, JSON.stringify(record.calls[0].arguments!.edits))
    assert.match(container.textContent ?? '', /export const value = 42/)
    const bash = trigger('Run pwd').closest('[data-slot="collapsible"]')!
    assert.equal(bash.querySelectorAll('pre').length, 1)
    assert.equal(bash.querySelector('pre')?.textContent, 'pwd')
    assert.doesNotMatch(bash.textContent ?? '', /output/)
    const read = trigger('Read src/read.ts').closest('[data-slot="collapsible"]')!
    assert.equal(read.querySelector('pre')?.textContent, 'src/read.ts')
    assert.equal(read.querySelector('.solid\\:border-code-border'), null)

    const omitted = await open('Write a file')
    assert.match(omitted.textContent ?? '', /Unfinished.*Arguments omitted \(9000 bytes\)/)
    assert.equal(omitted.querySelector('pre'), null)
    const failed = await open('Run exit 1')
    assert.ok(failed.querySelector('button .text-destructive'))
    assert.match(failed.textContent ?? '', /Failed.*command failed/)

    record.calls[2] = { ...record.calls[2], status: 'ok', durationMs: 23 }
    await renderParent(true)
    assert.equal(trigger('Nested tool calls (6)').getAttribute('aria-expanded'), 'true')
    assert.equal(trigger('Run pwd').getAttribute('aria-expanded'), 'true')
    assert.match(trigger('Run pwd').textContent ?? '', /Succeeded.*23 ms/)
    assert.equal(trigger('Run pwd').querySelector('.shimmer'), null)
    assert.equal(trigger('Run pwd').closest('[data-slot="collapsible"]')?.querySelectorAll('pre').length, 1)
  } finally {
    await act(async () => { root.unmount() })
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--nested-tool-rendering-fixture') {
  await runFixture()
} else {
  test('nested calls reuse direct tool panels without recording results', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--nested-tool-rendering-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}

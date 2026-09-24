/**
 * Tool panels run in a child process so the highlighter mock and fixed locale
 * do not leak into other renderer tests.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  const languages: string[] = []
  mock.module('../src/renderer/src/lib/highlight', () => ({
    langFromPath: () => 'plaintext',
    useHighlightHtml: (code: string, lang: string) => {
      languages.push(lang)
      return `<pre><code><span class="token">${code}</span></code></pre>`
    }
  }))
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { ToolRow, BashRow } = await import('../src/renderer/src/components/turn/ToolDetails')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const step = { id: 'bash-1', name: 'bash', args: { command: 'echo done' } }

  try {
    await act(async () => { root.render(createElement(ToolRow, { step })) })
    await act(async () => { container.querySelector('button')!.click() })
    const panels = () => [...container.querySelectorAll<HTMLElement>('.rounded-lg.border-code-border')]
    assert.deepEqual(languages, ['bash'])
    assert.equal(container.textContent?.includes('command'), true)
    assert.equal(container.textContent?.includes('output'), false)
    assert.equal(panels().length, 1)
    assert.equal(panels()[0].textContent, 'echo done')
    assert.ok(panels()[0].querySelector('.token'))
    assert.equal(panels()[0].classList.contains('bg-secondary'), true)

    await act(async () => {
      root.render(createElement(ToolRow, {
        step: {
          ...step,
          result: {
            role: 'toolResult', toolCallId: step.id, toolName: 'bash',
            content: [{ type: 'text', text: 'first\nsecond' }], isError: false, timestamp: 1
          }
        }
      }))
    })
    assert.equal(container.textContent?.includes('output'), true)
    assert.deepEqual(panels().map((panel) => panel.textContent), ['echo done', 'first\nsecond'])
    assert.ok(panels().every((panel) => panel.classList.contains('bg-secondary')))
    assert.ok(panels().every((panel) => !panel.classList.contains('bg-code-background')))
    assert.equal(panels()[1].querySelector('.token'), null)

    const missingCommand = { id: 'bash-empty', name: 'bash', args: {} }
    await act(async () => { root.render(createElement(ToolRow, { step: missingCommand })) })
    assert.equal(panels().length, 0)
    assert.equal(container.querySelector('pre'), null)
    await act(async () => {
      root.render(createElement(ToolRow, {
        step: {
          ...missingCommand,
          result: {
            role: 'toolResult', toolCallId: missingCommand.id, toolName: 'bash',
            content: [{ type: 'text', text: 'invalid args' }], isError: true, timestamp: 1
          }
        }
      }))
    })
    assert.equal(panels().length, 0)
    assert.equal(container.querySelector('pre')?.textContent, 'invalid args')

    await act(async () => {
      root.render(createElement(BashRow, {
        message: {
          role: 'bashExecution', command: 'echo done', output: 'first\nsecond',
          exitCode: 0, cancelled: false, truncated: false, timestamp: 1
        }
      }))
    })
    await act(async () => { container.querySelector('button')!.click() })
    assert.equal(panels().length, 0)
    assert.equal(container.querySelector('.bg-secondary'), null)
    assert.equal(container.querySelector('pre')?.textContent, '$ echo done')
    assert.equal(container.textContent?.includes('command'), false)

    const readId = 'read-1'
    await act(async () => {
      root.render(createElement(ToolRow, {
        step: {
          id: readId, name: 'read', args: { path: 'src/main.ts' },
          result: {
            role: 'toolResult', toolCallId: readId, toolName: 'read',
            content: [{ type: 'text', text: 'file contents' }], isError: false, timestamp: 1
          }
        }
      }))
    })
    await act(async () => { container.querySelector('button')!.click() })
    assert.equal(panels().length, 1)
    assert.equal(panels()[0].classList.contains('bg-code-background'), true)
    assert.equal(panels()[0].classList.contains('border-code-border'), true)
    assert.equal(panels()[0].querySelector('.max-h-80')?.classList.contains('bg-code-background'), false)
    assert.equal(panels()[0].querySelector('.token')?.textContent, 'file contents')
  } finally {
    await act(async () => { root.unmount() })
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--bash-panel-fixture') {
  await runFixture()
} else {
  test('bash tool panels keep bashExecution unchanged and read panels framed', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--bash-panel-fixture'], {
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

/**
 * The shared code surface keeps each layout's spacing and file-line fallback while
 * using one highlighter; a child process isolates its mocked Shiki hook.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  const calls: string[] = []
  mock.module('../src/renderer/src/lib/highlight', () => ({
    useHighlightHtml: (code: string, lang: string) => {
      calls.push(`${lang}:${code}`)
      return code === 'one\ntwo' ? undefined : `<pre><code><span class="token">${code}</span></code></pre>`
    }
  }))
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { HighlightedCode } = await import('../src/renderer/src/components/HighlightedCode')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const panel = () => container.firstElementChild as HTMLElement

  try {
    await act(async () => { root.render(createElement(HighlightedCode, { code: 'echo ok', lang: 'bash', variant: 'command' })) })
    assert.equal(panel().classList.contains('max-h-60'), true)
    assert.equal(panel().classList.contains('border-code-border'), true)
    assert.equal(panel().querySelector('.token')?.textContent, 'echo ok')
    assert.equal(panel().classList.contains('bg-secondary'), true)

    await act(async () => { root.render(createElement(HighlightedCode, { code: 'pwd', lang: 'bash', variant: 'terminal' })) })
    assert.equal(panel().classList.contains('bg-code-background'), true)
    assert.equal(panel().querySelector('.token')?.textContent, 'pwd')

    await act(async () => {
      root.render(createElement(HighlightedCode, { code: 'one\ntwo', lang: 'text', variant: 'file', fileListing: true, notice: 'truncated' }))
    })
    assert.equal(panel().classList.contains('border-code-border'), false)
    assert.equal(panel().classList.contains('leading-4'), true)
    assert.equal(panel().querySelector('pre')?.textContent, '1one2two')
    assert.ok(panel().textContent?.endsWith('truncated'))

    await act(async () => {
      root.render(createElement(HighlightedCode, { code: 'file body', lang: 'typescript', variant: 'file', fileListing: true }))
    })
    assert.ok(panel().querySelector('.token'))
    assert.ok(panel().querySelector('.token')?.closest('div')?.className.includes('counter-reset:line'))

    await act(async () => { root.render(createElement(HighlightedCode, { code: 'answer', lang: 'text' })) })
    assert.equal(panel().classList.contains('my-2'), true)
    assert.equal(panel().classList.contains('max-h-80'), true)
    assert.equal(panel().querySelector('.token')?.textContent, 'answer')
    assert.deepEqual(calls, ['bash:echo ok', 'bash:pwd', 'text:one\ntwo', 'typescript:file body', 'text:answer'])
  } finally {
    await act(async () => { root.unmount() })
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--highlighted-code-fixture') {
  await runFixture()
} else {
  test('shared highlighted code preserves command, file and markdown layouts', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--highlighted-code-fixture'], {
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

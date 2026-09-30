/**
 * The retry notice is the only part of a retried request the reader sees before it settles, and its
 * copy comes from four different states of two shapes. Rendered in a child process: the locale and
 * the session store are real here.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { RetryNotice } from '../src/renderer/src/stores/sessions/types'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { selectOpenProjectWorkspace: async () => {} } })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { RetryNotice: Notice } = await import('../src/renderer/src/components/composer/RetryNotice')

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const show = async (notice: RetryNotice | null, sessionId = 'session') => {
    useSessionsStore.setState({
      runtime: { session: { ...emptyRuntime(), retryNotice: notice } }
    })
    await act(async () => { root.render(createElement(Notice, { sessionId: sessionId as string | null })) })
    return container.textContent ?? ''
  }

  await show(null)
  assert.equal(container.textContent, '', 'no failure means no notice')
  await show({ kind: 'request', attempt: 1, maxAttempts: 3, errorMessage: '', endsAt: Date.now() }, 'other')
  assert.equal(container.textContent, '', 'a notice belongs to the session that reported it')

  const waiting: RetryNotice = {
    kind: 'request', attempt: 1, maxAttempts: 3, errorMessage: 'socket hang up', endsAt: Date.now() + 5_000
  }
  assert.match(await show(waiting), /Request failed, retrying in [45]s \(attempt 1\/3\)/)
  assert.match(container.textContent ?? '', /socket hang up/)

  assert.match(
    await show({ ...waiting, attempt: 2, endsAt: Date.now() - 1 }),
    /^Request failed, retrying \(attempt 2\/3\)/,
    'a backoff that already elapsed only leaves the attempt count'
  )

  const summary: RetryNotice = {
    kind: 'summary', source: 'summary', attempt: 1, maxAttempts: 3,
    errorMessage: 'summarization failed', endsAt: Date.now() + 5_000
  }
  assert.match(await show(summary), /Summary failed, retrying in [45]s \(attempt 1\/3\)/)
  assert.match(await show({ ...summary, source: 'compaction' }), /Retrying context compaction \(attempt 1\/3\)/)
  assert.match(await show({ ...summary, source: 'branchSummary' }), /Retrying branch summary \(attempt 1\/3\)/)

  // The clock ticks down on its own, and reaches the in-flight copy without another event.
  await show({ ...waiting, endsAt: Date.now() + 1_000 })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)) })
  assert.match(container.textContent ?? '', /^Request failed, retrying \(attempt 1\/3\)/)

  root.unmount()
}

if (process.argv[2] === '--retry-notice-fixture') {
  await runFixture()
} else {
  test('retry notice: one row of copy per retry state, counting down on its own', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--retry-notice-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}

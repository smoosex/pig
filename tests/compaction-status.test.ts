/**
 * A compaction Pi runs between turns belongs to no conversation turn, so it is reported beside the
 * composer instead: it counts its own time, offers to stop, and keeps a failure until dismissed.
 * Rendered in a child process: the locale, the session store and the preload API are real here.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { LiveCompaction } from '../src/renderer/src/chat/compactions'
import type { PiMessage } from '../src/renderer/src/pi/types'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const aborted: string[] = []
  Object.assign(window, {
    api: {
      selectOpenProjectWorkspace: async () => {},
      abortCompaction: async (sessionId: string) => { aborted.push(sessionId) }
    }
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { emptyRuntime } = await import('../src/renderer/src/stores/sessions/runtime')
  const { CompactionStatus } = await import('../src/renderer/src/components/composer/CompactionStatus')

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const running = (patch: Partial<LiveCompaction> = {}): LiveCompaction => ({
    id: 'k1', reason: 'manual', startedAt: Date.now() - 3_000, workMsBefore: 0,
    endedAt: null, status: 'running', ...patch
  })
  const show = async (
    marks: LiveCompaction[],
    options: { liveRuns?: number; sessionId?: string | null } = {}
  ) => {
    const { liveRuns = 0, sessionId = 'session' } = options
    const liveMessages: PiMessage[] = Array.from(
      { length: liveRuns },
      (_, index) => ({ role: 'user', content: 'question', timestamp: index })
    )
    useSessionsStore.setState({
      runtime: { session: { ...emptyRuntime(), liveCompactions: marks, liveMessages } }
    })
    await act(async () => { root.render(createElement(CompactionStatus, { sessionId })) })
    return container.textContent ?? ''
  }

  assert.equal(await show([]), '', 'no compaction means no row')
  assert.equal(await show([running()], { sessionId: null }), '', 'a row belongs to the session that reported it')
  assert.match(await show([running({ reason: 'threshold' })]), /Context is near its limit, compacting/)
  assert.match(await show([running({ reason: 'overflow' })]), /Context overflowed, compacting/)
  assert.equal(await show([running()], { liveRuns: 1 }), '', 'a summary the transcript shows is not repeated')

  // Counting its own time, and stopping it goes through the session API.
  assert.match(await show([running({ startedAt: Date.now() })]), /Compacting the context0s/)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)) })
  assert.match(container.textContent ?? '', /Compacting the context1s/, 'the clock runs while Pi works')
  const cancel = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')
  assert.ok(cancel, 'an unfinished compaction can be stopped')
  await act(async () => { cancel.click() })
  assert.deepEqual(aborted, ['session'])
  assert.equal(cancel.disabled, true, 'stop is not asked for twice')

  // A failure never becomes a landmark: it waits for the reader instead of for history.
  const failed = running({ status: 'failed', endedAt: Date.now(), errorMessage: 'Auto-compaction failed: boom' })
  const failure = await show([failed])
  assert.match(failure, /Compaction failed/)
  assert.match(failure, /Auto-compaction failed: boom/)
  assert.equal(container.textContent?.includes('Cancel'), false, 'nothing is left to stop')
  assert.equal(useSessionsStore.getState().runtime.session.liveCompactions.length, 1)
  const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label]')
  assert.equal(dismiss?.getAttribute('aria-label'), 'Dismiss Compaction failed')
  await act(async () => { dismiss.click() })
  assert.equal(container.textContent, '', 'the row is gone once the reader has seen it')
  assert.equal(useSessionsStore.getState().runtime.session.liveCompactions.length, 0)

  // A dismissed failure stays dismissed while another one still has to be acknowledged.
  const second = running({ id: 'k2', status: 'failed', endedAt: Date.now() })
  assert.match(await show([failed, second]), /Compaction failed/)
  assert.equal(useSessionsStore.getState().runtime.session.liveCompactions.length, 2)

  root.unmount()
}

if (process.argv[2] === '--compaction-status-fixture') {
  await runFixture()
} else {
  test('compaction status: a summary between turns reports itself and can be stopped or dismissed', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--compaction-status-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stdout + stderr)
  })
}

import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import type { SessionApi, WorktreeDeletionJob } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const shown: Array<{ message: string; options: { id?: string; duration?: number; description?: string; action?: { onClick: (event: unknown) => void } } }> = []
  const dismissed: string[] = []
  const applied: string[][] = []
  const retried: string[] = []
  mock.module('sonner', () => ({ toast: {
    error: (message: string, options: typeof shown[number]['options']) => { shown.push({ message, options }) },
    dismiss: (id: string) => { dismissed.push(id) }
  } }))
  const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))
  const translate = (key: string, args?: Record<string, unknown>) => `${key}:${args?.branch ?? args?.seconds ?? ''}`
  mock.module(modulePath('../src/renderer/src/hooks/useT.ts'), () => ({ useT: () => translate }))
  mock.module(modulePath('../src/renderer/src/stores/sessions.ts'), () => ({
    useSessionsStore: { getState: () => ({ applyWorktreeDeletions: (cwds: string[]) => { applied.push(cwds) } }) }
  }))
  let listener: ((jobs: WorktreeDeletionJob[]) => void) | undefined
  let resolveSnapshot!: (jobs: WorktreeDeletionJob[]) => void
  const snapshot = new Promise<WorktreeDeletionJob[]>((resolve) => { resolveSnapshot = resolve })
  let retryFails = false
  const api = {
    onWorktreeDeletionsChanged: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
    listWorktreeDeletions: () => snapshot,
    retryWorktreeDeletion: async (cwd: string) => {
      retried.push(cwd)
      if (retryFails) throw new Error("Error invoking remote method 'project:retry-worktree-deletion': Error: retry failed")
    }
  } satisfies Pick<SessionApi, 'onWorktreeDeletionsChanged' | 'listWorktreeDeletions' | 'retryWorktreeDeletion'>
  window.api = api as unknown as SessionApi
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useWorktreeDeletions } = await import('../src/renderer/src/hooks/useWorktreeDeletions')
  function Probe() { useWorktreeDeletions(); return null }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const job: WorktreeDeletionJob = {
    projectCwd: '/project', cwd: '/worktree', branch: 'feature', attempts: 1,
    status: 'retrying', error: 'permission denied', retryAt: Date.now() + 5_000
  }
  try {
    await act(async () => root.render(React.createElement(Probe)))
    assert.ok(listener)
    await act(async () => listener!([job]))
    assert.deepEqual(applied.at(-1), ['/worktree'])
    assert.equal(shown.length, 1)
    assert.equal(shown[0].options.duration, Infinity)
    assert.ok(shown[0].options.description?.includes('worktree.deleteRetrying'))
    await act(async () => listener!([job]))
    assert.equal(shown.length, 1, 'repeated snapshots do not duplicate the failure toast')

    await act(async () => resolveSnapshot([]))
    assert.deepEqual(dismissed, [], 'a stale initial snapshot cannot dismiss a newer failure')
    let prevented = false
    await act(async () => shown[0].options.action!.onClick({ preventDefault: () => { prevented = true } }))
    assert.equal(prevented, true)
    assert.deepEqual(retried, ['/worktree'])

    await act(async () => listener!([{ ...job, status: 'running', error: undefined, retryAt: undefined }]))
    assert.deepEqual(dismissed, ['worktree-delete:/worktree'])
    const failed: WorktreeDeletionJob = { ...job, status: 'failed', attempts: 4, retryAt: undefined }
    await act(async () => listener!([failed]))
    assert.ok(shown[1].options.description?.includes('worktree.deleteRetryExhausted'))
    retryFails = true
    await act(async () => shown[1].options.action!.onClick({ preventDefault: () => {} }))
    assert.equal(shown.at(-1)?.options.description, 'retry failed')
    await act(async () => listener!([]))
    assert.equal(dismissed.at(-1), 'worktree-delete:/worktree')

    await act(async () => root.render(null))
    api.listWorktreeDeletions = async () => [failed]
    await act(async () => root.render(React.createElement(Probe)))
    assert.ok(shown.at(-1)?.options.description?.includes('permission denied'), 'remount restores saved failures')
  } finally {
    await act(async () => root.unmount())
    assert.equal(listener, undefined)
    host.remove()
    GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--worktree-deletion-notices') {
  await fixture()
} else {
  test('background deletion failures toast, retry and recover after renderer reload', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--worktree-deletion-notices'], { stdout: 'pipe', stderr: 'pipe' })
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

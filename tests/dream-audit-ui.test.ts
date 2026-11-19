import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import type { DreamAuditProject, DreamRecord, DreamRequest, DreamStatus } from '../src/shared/dream'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-audit-ui-fixture')) {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mock.module('../src/renderer/src/components/sidebar/ChatList', () => ({ ChatList: () => null }))
  mock.module('../src/renderer/src/components/sidebar/ProjectList', () => ({ ProjectList: () => null }))

  const projId = '1'.repeat(64)
  const projects: DreamAuditProject[] = [{ id: projId, name: 'AlphaRepo' }]
  let status: DreamStatus = { state: 'idle', changes: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costKnown: true, requests: 0 }
  const starts: DreamRequest[] = []

  Object.assign(window, {
    api: {
      getMemorySettings: async () => ({ fileMemory: { enabled: true } }),
      dream: {
        list: async () => ({
          items: [
            { id: 'rec-audit', audit: true, auditScope: { kind: 'project', projectId: projId }, auditProjectName: 'AlphaRepo', state: 'done', startedAt: 1, endedAt: 2 },
            { id: 'rec-dream', topic: 'Old topic', state: 'done', startedAt: 3, endedAt: 4 },
            { id: 'rec-repair', repair: true, state: 'done', startedAt: 5, endedAt: 6 }
          ]
        }),
        read: async (id: string): Promise<DreamRecord> => ({
          ...status, id, audit: id === 'rec-audit',
          auditScope: id === 'rec-audit' ? { kind: 'project', projectId: projId } : undefined,
          auditProjectName: id === 'rec-audit' ? 'AlphaRepo' : undefined,
          state: 'done', report: 'Audit completed cleanly.', startedAt: 1, endedAt: 2
        }),
        status: async () => status,
        auditProjects: async () => projects,
        start: async (request: DreamRequest) => {
          starts.push(request)
          status = {
            ...status,
            id: 'audit-run-1',
            audit: 'audit' in request,
            auditScope: 'audit' in request ? request.scope : undefined,
            auditProjectName: 'audit' in request && request.scope.kind === 'project' ? 'AlphaRepo' : undefined,
            state: 'running',
            phase: 'searching',
            changes: [], report: undefined, error: undefined
          }
          return status
        },
        stop: async () => {
          status = { ...status, state: 'cancelled', phase: undefined, error: 'DREAM_CANCELLED' }
          return status
        }
      }
    }
  })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useDreamStore } = await import('../src/renderer/src/stores/dream')
  const { DreamAuditSettings, DreamSettings, DreamDialogHost } = await import('../src/renderer/src/components/settings/DreamSettings')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { Sidebar } = await import('../src/renderer/src/components/Sidebar')

  useSettingsStore.setState({ locale: 'zh-CN', localeSetting: 'zh-CN', supportsGlass: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const flush = async () => act(async () => { await new Promise(r => setTimeout(r, 15)) })
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!

  try {
    await act(async () => root.render(h(TooltipProvider, null,
      h(Sidebar, { tab: 'chats', preferencesError: null, onOpenSettings: () => {} }),
      h(DreamSettings, { enabled: true }),
      h(DreamAuditSettings, { enabled: true }),
      h(DreamDialogHost)
    )))
    await flush()

    // 1. Open Dream history and confirm audit entry badge & search work alongside dream and repair.
    await act(async () => button('做梦…').click())
    await flush()
    const auditRow = document.querySelector<HTMLElement>('[data-dream-record="rec-audit"]')!
    assert.ok(auditRow)
    assert.match(auditRow.textContent!, /体检/)
    assert.match(auditRow.textContent!, /AlphaRepo/)

    const search = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, '体检')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    assert.ok(document.querySelector('[data-dream-record="rec-audit"]'))
    assert.equal(document.querySelector('[data-dream-record="rec-dream"]'), null)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click())
    await flush()

    // 2. Open Memory audit compose dialog from settings row and select project scope.
    await act(async () => button('体检…').click())
    await flush()
    assert.match(document.querySelector('[data-slot="dialog-title"]')!.textContent!, /记忆体检/)
    assert.equal(document.querySelector('textarea'), null, 'audit compose has no topic textarea')
    await act(async () => {
      useDreamStore.getState().setAuditScope({ kind: 'project', projectId: projId })
    })
    await flush()
    await act(async () => button('开始体检').click())
    await flush()

    assert.deepEqual(starts, [{ audit: true, scope: { kind: 'project', projectId: projId } }])
    assert.match(document.body.textContent!, /AlphaRepo/)
    assert.ok(document.querySelector('[data-dream-status]'))
    assert.match(document.querySelector('[data-dream-status]')!.getAttribute('aria-label')!, /记忆体检/)

    // 3. Simulate partial result failure (memory published, audit-state save failed): changes & report remain visible.
    status = {
      ...status,
      state: 'error',
      error: 'DREAM_AUDIT_STATE',
      changes: [`projects/${projId}/poison.md`],
      report: 'Updated poison.md before audit-state failure.'
    }
    await act(async () => { await useDreamStore.getState().refresh() })
    await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /DREAM_AUDIT_STATE/)
    assert.match(dialog.textContent!, /已发布的记忆未回滚/)
    assert.match(dialog.textContent!, /poison\.md/)
    assert.match(dialog.textContent!, /Updated poison\.md before audit-state failure/)

    // 4. Published audit cancelled during keep-state commit still reports uncommitted cooldown without claiming rollback.
    status = {
      ...status,
      state: 'cancelled',
      error: 'DREAM_CANCELLED',
      changes: [`projects/${projId}/poison.md`],
      report: 'Updated poison.md before stop during cooldown wait.'
    }
    await act(async () => { await useDreamStore.getState().refresh() })
    await flush()
    assert.doesNotMatch(dialog.textContent!, /DREAM_CANCELLED|备份/)
    assert.match(dialog.textContent!, /复核冷却状态未提交/)
    assert.match(dialog.textContent!, /记忆改动已发布/)
    assert.match(dialog.textContent!, /poison\.md/)
    assert.equal(dialog.querySelector('[data-dream-changes] li')?.getAttribute('title'), `projects/${projId}/poison.md`)

    assert.equal(button('开始体检'), undefined, 'the result action does not say Start audit')
    await act(async () => button('再次体检…').click())
    await flush()
    assert.equal(starts.length, 1, 'opening the scope chooser does not start an audit')
    assert.match(dialog.querySelector('#dream-audit-scope')!.textContent!, /AlphaRepo/)
    await act(async () => button('开始体检').click())
    assert.deepEqual(starts[1], starts[0], 'confirming the chooser reuses the previous project scope')

    await act(async () => button('停止').click())
    assert.match(dialog.textContent!, /已停止，未发布任何记忆改动/)
    assert.doesNotMatch(dialog.textContent!, /DREAM_CANCELLED|备份|复核冷却状态未提交/)
    assert.equal(dialog.querySelector('[data-dream-changes]'), null)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    GlobalRegistrator.unregister()
  }
} else {
  test('Dream audit UI exposes scope chooser, shares single-flight indicator, merges audit receipts, and displays partial failure state', async () => {
    const result = await runSelf(import.meta.path, ['--dream-audit-ui-fixture'], { timeoutMs: 15_000 })
    assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  })
}

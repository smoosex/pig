/** Recent sessions must not lose their newest leaf when a fork chain exceeds the row limit. */
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { SessionMeta } from '../src/shared/api'

async function fixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { value: {}, configurable: true })
  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSessionsStore: store } = await import('../src/renderer/src/stores/sessions')
  const { ProjectSessionHome } = await import('../src/renderer/src/components/ProjectSessionHome')
  const cwd = '/project'
  const sessions: SessionMeta[] = Array.from({ length: 6 }, (_, index) => ({
    id: `s${index}`,
    cwd,
    path: `/sessions/s${index}.jsonl`,
    created: `2026-01-0${index + 1}T00:00:00Z`,
    modified: `2026-01-0${index + 1}T00:00:00Z`,
    size: 1,
    firstMessage: `s${index}`,
    ...(index > 0 ? { parentSession: `/sessions/s${index - 1}.jsonl` } : {})
  })).reverse()
  const opened: string[] = []
  store.setState({
    projects: [{ cwd, name: 'project', sessions }],
    openExisting: async (session) => { opened.push(session.id) }
  })

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(h(ProjectSessionHome, { cwd })) })
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-sidebar-hover-row]')]
    assert.deepEqual(rows.map((row) => row.querySelector('.truncate')?.textContent), ['s1', 's2', 's3', 's4', 's5'])
    assert.equal(rows[0]!.querySelector('.lucide-corner-down-right'), null, 'ancestors outside the candidates do not add rows')
    assert.ok(rows[4]!.querySelector('.lucide-corner-down-right'), 'the newest leaf is still shown as a fork')
    await act(async () => { rows[4]!.click() })
    assert.deepEqual(opened, ['s5'], 'the newest session remains available to open')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--project-home-fixture') {
  await fixture()
} else {
  test('recent sessions retain the newest leaf of a fork chain longer than five rows', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--project-home-fixture'], {
      stdout: 'pipe', stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ])
    assert.equal(code, 0, stderr || stdout)
  })
}

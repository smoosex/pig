import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SubagentInfo } from '../src/shared/api'

async function fixture(): Promise<void> {
  let reduced = false
  Object.assign(globalThis, { window: { api: {}, matchMedia: () => ({ matches: reduced }) } })
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const { useSubagentStore: store } = await import('../src/renderer/src/stores/subagents')
  const done = { id: 'done', status: 'completed' } as SubagentInfo
  const active = { id: 'active', status: 'running' } as SubagentInfo
  const cleared = { ...done, cleared: true }
  const apply = (subagents: SubagentInfo[]) => store.getState().apply({ parentSessionId: 'parent', subagents })
  const reset = (items: SubagentInfo[]) => store.setState({ clearing: null, bySession: { parent: items }, card: { sessionId: 'parent', id: 'done' } })

  reset([done, active])
  apply([cleared, active])
  assert.equal(store.getState().clearing?.phase, 'removing')
  assert.equal(store.getState().card?.id, 'done', 'keep the selected body while finished rows fade out')
  const transition = store.getState().clearing
  apply([cleared, active])
  assert.equal(store.getState().clearing, transition, 'progress pushes must not restart the animation')
  await wait(180)
  assert.deepEqual(store.getState().card, { sessionId: 'parent', id: 'active' }, 'clearing the selected result switches to an active child')
  assert.equal(store.getState().bySession.parent[0].cleared, true)

  reset([done])
  apply([cleared])
  await wait(180)
  assert.equal(store.getState().clearing?.phase, 'empty')
  assert.equal(store.getState().card?.id, 'done', 'leave time for the cleared confirmation before closing')
  await wait(120)
  assert.equal(store.getState().clearing?.phase, 'closing')
  await wait(160)
  assert.equal(store.getState().card, null, 'clearing every result closes the card instead of retaining one cleared result')

  reset([done, active])
  store.getState().openCard('parent', 'active')
  apply([cleared, active])
  await wait(180)
  assert.deepEqual(store.getState().card, { sessionId: 'parent', id: 'active' }, 'an active selection is not changed')

  store.getState().openCard('parent', 'done')
  apply([cleared, active])
  assert.deepEqual(store.getState().card, { sessionId: 'parent', id: 'done' }, 'a cleared historical result can still be explicitly opened')

  store.getState().openCard('other', 'other-child')
  apply([cleared])
  assert.deepEqual(store.getState().card, { sessionId: 'other', id: 'other-child' }, 'another session is unaffected')

  reset([done])
  apply([cleared])
  await wait(180)
  apply([cleared, active])
  await wait(520)
  assert.equal(store.getState().card?.id, 'active', 'a new child cancels a pending empty-state close')

  reset([done])
  apply([cleared])
  store.getState().closeCard()
  store.getState().openCard('other', 'other-child')
  await wait(180)
  assert.equal(store.getState().card?.id, 'other-child', 'a stale transition must not close a newly opened card')

  reduced = true
  reset([done, active])
  apply([cleared, active])
  await wait(5)
  assert.equal(store.getState().card?.id, 'active', 'reduced motion skips the fade delay')
}

if (process.argv.includes('--fixture')) await fixture()
else test('clearing subagents removes a newly cleared selection without hiding historical results', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, err || out)
  } finally {
    clearTimeout(timer)
  }
}, 15_000)

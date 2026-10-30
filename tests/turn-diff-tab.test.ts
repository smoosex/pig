/**
 * The history diff pane opened from a turn's file list: it docks beside the session it came from,
 * one per session, and leaves with that session.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi } from '../src/shared/api'

// Every bridge call settles quietly: only the stores' own state is under test.
const api = new Proxy({}, { get: () => async () => {} }) as SessionApi
Object.defineProperty(globalThis, 'window', { value: { api }, configurable: true })

const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
const { turnDiffTabId } = await import('../src/renderer/src/stores/sessions/tabs-slice')
const { useSplitLayoutStore, paneOfTab, groupOfTab } = await import('../src/renderer/src/stores/split-layout')

test('docks right of its session, retargets on reuse, and closes with the session', async () => {
  const cwd = '/project'
  useSessionsStore.setState({
    openTabs: [
      { id: 'session', cwd, title: 'S', kind: 'project', loadState: 'ready' },
      { id: 'other', cwd, title: 'O', kind: 'project', loadState: 'ready' }
    ],
    activeTabId: 'other',
    activeTabByCwd: { [cwd]: 'other' }
  })
  useSplitLayoutStore.getState().reset()
  const id = turnDiffTabId('session')

  await useSessionsStore.getState().openTurnDiffTab('session', 'turn-1')
  const group = groupOfTab(useSplitLayoutStore.getState().groups, id)
  assert.ok(group && paneOfTab([group], 'session'), 'placed beside the source, not the active tab')
  assert.equal(paneOfTab(useSplitLayoutStore.getState().groups, 'other'), null)
  assert.equal(useSessionsStore.getState().activeTabId, id)

  await useSessionsStore.getState().openTurnDiffTab('session', 'turn-2')
  const tabs = useSessionsStore.getState().openTabs.filter((tab) => tab.kind === 'turn-diff')
  assert.equal(tabs.length, 1)
  assert.deepEqual(tabs[0]!.turnDiff, { sessionId: 'session', turnId: 'turn-2' })
  assert.equal(useSplitLayoutStore.getState().groups.length, 1, 'reuse does not split again')

  useSessionsStore.getState().closeTab('session', { confirmed: true })
  assert.equal(useSessionsStore.getState().openTabs.some((tab) => tab.id === id), false)
  assert.equal(useSplitLayoutStore.getState().groups.length, 0)
})

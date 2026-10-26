/**
 * Following a rename in the file tree into the tab strip.
 *
 * A file tab's identity is its path, so renaming a row means the tab takes a new id: the strip keys on
 * ids, the split layout's panes hold them, and the worktree remembers which one was showing. A folder is
 * the part worth pinning — renaming one moves every file inside it, and the tabs for those files have to
 * follow even though nobody named them. The other half is what a rename must never do: leave two tabs
 * answering to one id.
 *
 * The stores are real and the bridge is stubbed, so this runs in its own process like the other store
 * fixtures.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi } from '../src/shared/api'

async function runFixture(name: string): Promise<void> {
  Object.defineProperty(globalThis, 'window', { value: { api: {} as Partial<SessionApi> }, configurable: true })

  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { fileTabId } = await import('../src/renderer/src/stores/sessions/tabs-slice')
  const { useSplitLayoutStore, paneOfTab } = await import('../src/renderer/src/stores/split-layout')
  const cwd = '/project'

  const fileTab = (path: string, title = path.slice(path.lastIndexOf('/') + 1)) => ({
    id: fileTabId(cwd, path),
    cwd,
    path,
    title,
    kind: 'file' as const,
    loadState: 'ready' as const
  })

  const restore = () => {
    useSessionsStore.setState({
      openTabs: [fileTab('README.md'), fileTab('src/main.ts'), fileTab('src/deep/leaf.ts'), fileTab('src2/other.ts')],
      activeTabId: fileTabId(cwd, 'src/main.ts'),
      activeTabByCwd: { [cwd]: fileTabId(cwd, 'src/main.ts') }
    })
    useSplitLayoutStore.getState().reset()
  }

  const ids = () => useSessionsStore.getState().openTabs.map((tab) => tab.id)
  const paths = () => useSessionsStore.getState().openTabs.map((tab) => tab.path)

  restore()

  if (name === 'file') {
    useSessionsStore.getState().moveFileTab(cwd, 'README.md', 'NOTES.md')
    assert.equal(ids().includes(fileTabId(cwd, 'README.md')), false, 'the old id is gone')
    assert.equal(ids().includes(fileTabId(cwd, 'NOTES.md')), true, 'the tab answers to the new name')
    assert.equal(paths().includes('README.md'), false, 'and its path moved with it')
    assert.ok(ids().includes(fileTabId(cwd, 'NOTES.md')))
    const moved = useSessionsStore.getState().openTabs.find((tab) => tab.path === 'NOTES.md')
    assert.equal(moved?.title, 'NOTES.md', 'the title is the new name')
    return
  }

  if (name === 'folder') {
    useSessionsStore.getState().moveFileTab(cwd, 'src', 'source')
    assert.equal(ids().includes(fileTabId(cwd, 'src/main.ts')), false, 'the tab inside is gone from the old id')
    assert.equal(ids().includes(fileTabId(cwd, 'source/main.ts')), true, 'and answers to the new one')
    assert.equal(ids().includes(fileTabId(cwd, 'source/deep/leaf.ts')), true, 'so does the one deeper down')
    assert.equal(ids().includes(fileTabId(cwd, 'src2/other.ts')), true, 'a prefix sibling is left alone')
    assert.equal(ids().includes(fileTabId(cwd, 'README.md')), true, 'and so is an unrelated file')
    // It was the tab being read, and it is still the tab being read under its new name.
    assert.equal(useSessionsStore.getState().activeTabId, fileTabId(cwd, 'source/main.ts'))
    assert.equal(useSessionsStore.getState().activeTabByCwd[cwd], fileTabId(cwd, 'source/main.ts'))
    return
  }

  if (name === 'pane') {
    // A pane holds a tab id, and a pane pointing at one that is no longer there shows nothing at all.
    useSplitLayoutStore.getState().splitTab(fileTabId(cwd, 'src/main.ts'), fileTabId(cwd, 'README.md'), 'right')
    const before = paneOfTab(useSplitLayoutStore.getState().groups, fileTabId(cwd, 'src/main.ts'))!.id
    useSessionsStore.getState().moveFileTab(cwd, 'src', 'source')
    const pane = paneOfTab(useSplitLayoutStore.getState().groups, fileTabId(cwd, 'source/main.ts'))
    assert.equal(pane?.id, before, 'the pane itself did not change')
    return
  }

  if (name === 'no-duplicate') {
    // The tab at the destination is closed rather than left beside the moved one: one id, one tab.
    useSessionsStore.getState().moveFileTab(cwd, 'README.md', 'src/main.ts')
    const state = useSessionsStore.getState()
    const target = fileTabId(cwd, 'src/main.ts')
    assert.equal(state.openTabs.filter((tab) => tab.id === target).length, 1, 'the id is held by one tab')
    assert.equal(new Set(ids()).size, state.openTabs.length, 'and every id is still distinct')
    return
  }

  if (name === 'absent') {
    // A rename that raced a close must not resurrect the tab.
    restore()
    useSessionsStore.setState({ openTabs: [fileTab('README.md')] })
    useSessionsStore.getState().moveFileTab(cwd, 'src/main.ts', 'src/entry.ts')
    assert.deepEqual(ids(), [fileTabId(cwd, 'README.md')], 'nothing was added and nothing moved')
    return
  }

  throw new Error(`unknown case ${name}`)
}

if (process.argv[2] === '--move-tab-fixture') {
  await runFixture(process.argv[3] ?? 'file')
} else {
  for (const [name, description] of Object.entries({
    file: 'a renamed file takes its tab with it',
    folder: 'a renamed folder carries the tabs inside it',
    pane: 'the pane holding a moved tab follows it',
    'no-duplicate': 'a rename onto an open tab leaves one tab, not two',
    absent: 'a rename for a tab that is not open adds nothing'
  })) {
    test(description, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--move-tab-fixture', name], {
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}

/**
 * Verifies Project Spaces persistence (`ProjectSpaceStore`) and sidebar space switching,
 * creation dialog, and project filtering.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SPACE_ID,
  resolveProjectSpaceId,
  resolveSpaceTargetCwd,
  type ProjectSpacesSnapshot
} from '../src/shared/project-spaces'
import { runSelf } from './helpers/subprocess.ts'

async function runStoreFixture(): Promise<void> {
  const { mock } = await import('bun:test')
  const root = await mkdtemp(join(tmpdir(), 'pig-project-spaces-'))
  const file = join(root, 'project-spaces.json')
  mock.module('../src/main/pig-dir', () => ({
    pigDir: () => root,
    pigPath: (...parts: string[]) => join(root, ...parts)
  }))
  try {
    const { ProjectSpaceStore } = await import('../src/main/project-spaces')
    const store = new ProjectSpaceStore(() => file)

    const initial = await store.getSnapshot()
    assert.equal(initial.revision, 0)
    assert.equal(initial.activeSpaceId, DEFAULT_SPACE_ID)
    assert.deepEqual(initial.spaces, [{ id: DEFAULT_SPACE_ID, name: '' }])

    // Create Space 2 and move /projects/b into it atomically
    const afterCreate = await store.create({
      name: '空间 2',
      icon: 'rocket',
      moveProjectCwd: '/projects/b'
    })
    assert.equal(afterCreate.revision, 1)
    assert.equal(afterCreate.spaces.length, 2)
    const space2 = afterCreate.spaces[1]!
    assert.equal(space2.name, '空间 2')
    assert.equal(space2.icon, 'rocket')
    assert.equal(afterCreate.activeSpaceId, space2.id)
    assert.equal(afterCreate.lastCwds?.[space2.id], '/projects/b')
    assert.equal(resolveProjectSpaceId(afterCreate, '/projects/a'), DEFAULT_SPACE_ID)
    assert.equal(resolveProjectSpaceId(afterCreate, '/projects/b'), space2.id)

    // Remember active worktree per space and verify legacy files without lastCwds still parse cleanly
    const afterRemember = await store.rememberWorktree(DEFAULT_SPACE_ID, '/projects/a/wt-1')
    assert.equal(afterRemember.lastCwds?.[DEFAULT_SPACE_ID], '/projects/a/wt-1')
    assert.equal(afterRemember.lastCwds?.[space2.id], '/projects/b')

    // Rename and clear icon
    const afterUpdate = await store.update({ id: space2.id, name: '后端服务', icon: null })
    assert.equal(afterUpdate.spaces[1]?.name, '后端服务')
    assert.equal(afterUpdate.spaces[1]?.icon, undefined)

    // Assign another project, then delete Space 2 -> projects safely fall back to Default
    await store.assignProject('/projects/c', space2.id)
    const afterRemove = await store.remove(space2.id)
    assert.equal(afterRemove.spaces.length, 1)
    assert.equal(afterRemove.activeSpaceId, DEFAULT_SPACE_ID)
    assert.deepEqual(afterRemove.assignments, {})
    assert.equal(afterRemove.lastCwds?.[space2.id], undefined)
    assert.equal(resolveProjectSpaceId(afterRemove, '/projects/b'), DEFAULT_SPACE_ID)
    assert.equal(resolveProjectSpaceId(afterRemove, '/projects/c'), DEFAULT_SPACE_ID)

    // Legacy JSON without lastCwds loads without error
    await writeFile(
      file,
      JSON.stringify({
        revision: 9,
        activeSpaceId: DEFAULT_SPACE_ID,
        spaces: [{ id: DEFAULT_SPACE_ID, name: '' }],
        assignments: {}
      }),
      'utf8'
    )
    const legacyLoaded = await store.getSnapshot()
    assert.deepEqual(legacyLoaded.lastCwds, {})

    // Cannot delete the last remaining space
    await assert.rejects(() => store.remove(DEFAULT_SPACE_ID), /Cannot delete the last space/)

    // Corrupt JSON must throw rather than silently overwriting with defaults
    await writeFile(file, '{corrupt', 'utf8')
    await assert.rejects(() => store.getSnapshot(), /Invalid project spaces file/)
    await assert.rejects(() => store.create({ name: 'Next' }), /Invalid project spaces file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runUiFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Reflect.deleteProperty(Element.prototype, 'animate')
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: NoopResizeObserver })
  Object.assign(window, { ResizeObserver: NoopResizeObserver })

  let snapshot: ProjectSpacesSnapshot = {
    revision: 0,
    activeSpaceId: DEFAULT_SPACE_ID,
    spaces: [{ id: DEFAULT_SPACE_ID, name: '' }],
    assignments: {}
  }

  Object.assign(window, {
    api: {
      supportsGlass: true,
      onProjectsChanged: () => () => {},
      discoverOpenedWorktrees: async () => [],
      spaces: {
        getSnapshot: async () => snapshot,
        select: async (spaceId: string) => {
          snapshot = { ...snapshot, revision: snapshot.revision + 1, activeSpaceId: spaceId }
          return snapshot
        },
        create: async ({ name, icon, moveProjectCwd }: { name: string; icon?: 'rocket' | 'sparkles' | 'folder' | 'globe'; moveProjectCwd?: string }) => {
          const id = `space-${snapshot.spaces.length + 1}`
          snapshot = {
            revision: snapshot.revision + 1,
            activeSpaceId: id,
            spaces: [...snapshot.spaces, { id, name, ...(icon ? { icon } : {}) }],
            assignments: moveProjectCwd
              ? { ...snapshot.assignments, [moveProjectCwd]: id }
              : snapshot.assignments
          }
          return snapshot
        },
        update: async () => snapshot,
        remove: async () => snapshot,
        assignProject: async (cwd: string, spaceId: string) => {
          snapshot = {
            ...snapshot,
            revision: snapshot.revision + 1,
            assignments: { ...snapshot.assignments, [cwd]: spaceId }
          }
          return snapshot
        },
        forgetProject: async () => snapshot,
        onChanged: () => () => {}
      }
    }
  })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const { useProjectSpacesStore } = await import('../src/renderer/src/stores/project-spaces')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  const { Sidebar } = await import('../src/renderer/src/components/Sidebar')

  useSettingsStore.setState({ locale: 'zh-CN', localeSetting: 'zh-CN', supportsGlass: true })
  useSessionsStore.setState({
    projects: [
      { cwd: '/repo/pig', name: 'pig', sessions: [] },
      { cwd: '/repo/lumina', name: 'lumina', sessions: [] }
    ],
    chats: []
  })

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })

  try {
    await act(async () => {
      root.render(
        h(TooltipProvider, null, h(Sidebar, { tab: 'projects', preferencesError: null, onOpenSettings: () => {} }))
      )
    })
    await flush()

    // Default space shows both projects and header "默认"
    assert.equal(container.querySelector('[data-space-header]')?.textContent, '默认')
    assert.ok(container.querySelector('[title="/repo/pig"]'))
    assert.ok(container.querySelector('[title="/repo/lumina"]'))

    // Click `+` to open Create Space dialog, submit default "空间 2"
    const createBtn = container.querySelector<HTMLButtonElement>('[data-space-create]')!
    assert.ok(createBtn)
    await act(async () => { createBtn.click() })
    await flush()

    const nameInput = document.querySelector<HTMLInputElement>('#space-name-input')!
    assert.ok(nameInput)
    assert.equal(nameInput.value, '空间 2')

    const submitBtn = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0]!
    await act(async () => { submitBtn.click() })
    await flush()

    // Switched into empty "空间 2" (moving right -> slides from right)
    assert.equal(container.querySelector('[data-space-header]')?.textContent, '空间 2')
    assert.equal(container.querySelector('[data-space-slide]')?.getAttribute('data-space-slide'), 'right')
    assert.equal(container.querySelector('[title="/repo/pig"]'), null)
    assert.ok(container.textContent?.includes('添加项目即可开始'))

    // Move /repo/lumina into space-2, verify only lumina renders in space-2 and only pig renders in Default
    await act(async () => {
      await useProjectSpacesStore.getState().assignProject('/repo/lumina', 'space-2')
    })
    await flush()
    assert.equal(container.querySelector('[title="/repo/pig"]'), null)
    assert.ok(container.querySelector('[title="/repo/lumina"]'))

    const defaultTab = container.querySelector<HTMLButtonElement>('button[role="tab"][data-space-id="default"]')!
    await act(async () => { defaultTab.click() })
    await flush()
    assert.equal(container.querySelector('[data-space-header]')?.textContent, '默认')
    assert.equal(container.querySelector('[data-space-slide]')?.getAttribute('data-space-slide'), 'left')
    assert.ok(container.querySelector('[title="/repo/pig"]'))
    assert.equal(container.querySelector('[title="/repo/lumina"]'), null)

    // Horizontal trackpad/mouse wheel swipe steps one space at a time (inertia tail stays locked)
    const scrollArea = container.querySelector<HTMLElement>('[data-slot="scroll-area"]')!
    await act(async () => {
      scrollArea.dispatchEvent(new window.WheelEvent('wheel', { deltaX: 60, deltaY: 0, bubbles: true }))
      scrollArea.dispatchEvent(new window.WheelEvent('wheel', { deltaX: 55, deltaY: 0, bubbles: true }))
    })
    await flush()
    assert.equal(useProjectSpacesStore.getState().activeSpaceId, 'space-2')

    // Opposite horizontal swipe immediately unlocks and returns to Default
    await act(async () => {
      scrollArea.dispatchEvent(new window.WheelEvent('wheel', { deltaX: -60, deltaY: 0, bubbles: true }))
    })
    await flush()
    assert.equal(useProjectSpacesStore.getState().activeSpaceId, 'default')

    // Icon collapse rule: <= 3 spaces show all icons; > 3 spaces show ONLY active space's icon until hovered
    await act(async () => {
      useProjectSpacesStore.getState().applySnapshot({
        revision: 10,
        activeSpaceId: 'space-3',
        spaces: [
          { id: 'default', name: '', icon: 'sparkles' },
          { id: 'space-2', name: '空间 2', icon: 'folder' },
          { id: 'space-3', name: '空间 3', icon: 'rocket' }
        ],
        assignments: snapshot.assignments
      })
    })
    await flush()
    assert.equal(container.querySelectorAll('[role="tablist"] [data-space-icon]').length, 3, '3 spaces keep all custom icons visible')

    await act(async () => {
      useProjectSpacesStore.getState().applySnapshot({
        revision: 11,
        activeSpaceId: 'space-4',
        spaces: [
          { id: 'default', name: '', icon: 'sparkles' },
          { id: 'space-2', name: '空间 2', icon: 'folder' },
          { id: 'space-3', name: '空间 3', icon: 'rocket' },
          { id: 'space-4', name: '空间 4', icon: 'globe' }
        ],
        assignments: snapshot.assignments
      })
    })
    await flush()
    assert.equal(container.querySelectorAll('[role="tablist"] [data-space-icon]').length, 1, '> 3 spaces collapse inactive icons to dots')
    assert.ok(container.querySelector('[data-space-id="space-4"] [data-space-icon="globe"]'))
    assert.ok(container.querySelector('[data-space-id="space-2"][data-space-compact-dot="true"] [data-space-dot]'))

    // Focusing / hovering an inactive space reveals its icon and removes compact-dot collapse
    const space2Btn = container.querySelector<HTMLButtonElement>('[data-space-id="space-2"]')!
    await act(async () => { space2Btn.focus() })
    await flush()
    assert.ok(container.querySelector('[data-space-id="space-2"] [data-space-icon="folder"]'))
    assert.equal(space2Btn.hasAttribute('data-space-compact-dot'), false)

    await act(async () => { space2Btn.blur() })
    await flush()
    assert.equal(container.querySelector('[data-space-id="space-2"] [data-space-icon]'), null)
    assert.ok(container.querySelector('[data-space-id="space-2"] [data-space-dot]'))

    // Verify main-area synchronization via useSpaceWorkspaceSync + resolveSpaceTargetCwd:
    // 1) Pure priority resolution: remembered lastCwd -> open content -> first project -> null for empty space
    const probeSpaces = [
      { id: 'default', name: '' },
      { id: 'space-open', name: '有内容' },
      { id: 'space-new', name: '仅项目' },
      { id: 'space-empty', name: '空空间' }
    ]
    const probeProjects = [
      { cwd: '/repo/p1' },
      { cwd: '/repo/p2' },
      { cwd: '/repo/p3' }
    ]
    const probeAssignments = {
      '/repo/p2': 'space-open',
      '/repo/p3': 'space-open'
    }
    assert.equal(
      resolveSpaceTargetCwd({
        spaceId: 'space-empty',
        spaces: probeSpaces,
        assignments: probeAssignments,
        projects: probeProjects
      }),
      null
    )
    assert.equal(
      resolveSpaceTargetCwd({
        spaceId: 'space-open',
        spaces: probeSpaces,
        assignments: probeAssignments,
        projects: probeProjects,
        hasOpenContent: (cwd) => cwd === '/repo/p3'
      }),
      '/repo/p3',
      'prefers worktree with open content when lastCwds has not recorded a choice yet'
    )
    assert.equal(
      resolveSpaceTargetCwd({
        spaceId: 'space-open',
        spaces: probeSpaces,
        assignments: probeAssignments,
        lastCwds: { 'space-open': '/repo/p2' },
        projects: probeProjects,
        hasOpenContent: (cwd) => cwd === '/repo/p3'
      }),
      '/repo/p2',
      'remembered lastCwds wins over other open tabs in the same space'
    )

    // 2) Live hook synchronization across space switches, empty spaces, new-session homes, and cross-space jumps
    const { useSpaceWorkspaceSync } = await import('../src/renderer/src/components/sidebar/use-space-workspace-sync')
    Object.assign(window.api, {
      selectOpenProjectWorkspace: async () => {},
      listWorktreeSessions: async () => [],
      saveOpenToolTabs: async () => {},
      saveOpenSplitLayouts: async () => {}
    })
    Object.assign(window.api.spaces, {
      rememberCwd: async (spaceId: string, cwd: string) => {
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          lastCwds: { ...(snapshot.lastCwds ?? {}), [spaceId]: cwd }
        }
        return snapshot
      }
    })

    snapshot = {
      revision: 20,
      activeSpaceId: 'default',
      spaces: [
        { id: 'default', name: '' },
        { id: 'space-2', name: '空间 2' },
        { id: 'space-empty', name: '空空间' }
      ],
      assignments: { '/repo/lumina': 'space-2' },
      lastCwds: { default: '/repo/pig' }
    }
    useProjectSpacesStore.getState().applySnapshot(snapshot)
    useSessionsStore.setState({
      workspaceRestoreReady: true,
      workspaceRestoreError: null,
      projects: [
        { cwd: '/repo/pig', name: 'pig', sessions: [] },
        { cwd: '/repo/lumina', name: 'lumina', sessions: [] }
      ],
      openTabs: [
        { id: 'sess-pig', cwd: '/repo/pig', title: 'Pig Session', kind: 'project', loadState: 'ready' }
      ],
      activeSessionByCwd: { '/repo/pig': 'sess-pig' },
      activeTabByCwd: { '/repo/pig': 'sess-pig' },
      currentProjectCwd: '/repo/pig',
      activeTabId: 'sess-pig'
    })

    let latestSync!: ReturnType<typeof useSpaceWorkspaceSync>
    function SyncProbe() {
      latestSync = useSpaceWorkspaceSync()
      return null
    }
    await act(async () => {
      root.render(h(SyncProbe))
    })
    await flush()
    assert.equal(useSessionsStore.getState().currentProjectCwd, '/repo/pig')
    assert.equal(useSessionsStore.getState().activeTabId, 'sess-pig')

    // Switch to Space 2 (/repo/lumina has no open tabs -> opens its New Session home: activeTabId === null)
    await act(async () => {
      await useProjectSpacesStore.getState().selectSpace('space-2')
    })
    await flush()
    assert.equal(useSessionsStore.getState().currentProjectCwd, '/repo/lumina')
    assert.equal(useSessionsStore.getState().activeTabId, null, 'project with no open tabs lands on New Session home')

    // Switch to Empty Space -> clears currentProjectCwd & activeTabId so Empty Space screen renders
    await act(async () => {
      await useProjectSpacesStore.getState().selectSpace('space-empty')
    })
    await flush()
    assert.equal(useSessionsStore.getState().currentProjectCwd, null)
    assert.equal(useSessionsStore.getState().activeTabId, null)
    assert.equal(latestSync.spaceProjects.length, 0)

    // Switch back to Default -> restores /repo/pig and its open tab 'sess-pig'
    await act(async () => {
      await useProjectSpacesStore.getState().selectSpace('default')
    })
    await flush()
    assert.equal(useSessionsStore.getState().currentProjectCwd, '/repo/pig')
    assert.equal(useSessionsStore.getState().activeTabId, 'sess-pig')

    // Explicitly jumping to /repo/lumina (e.g. from bookmark/notification) switches activeSpaceId to space-2
    await act(async () => {
      await useSessionsStore.getState().selectProjectCwd('/repo/lumina')
    })
    await flush()
    assert.equal(useProjectSpacesStore.getState().activeSpaceId, 'space-2')
    assert.equal(useSessionsStore.getState().currentProjectCwd, '/repo/lumina')

    // 3) EmptyProjectsView renders the greeting + 3 action cards (with Move Project when other spaces have projects,
    // and Terminal when globally empty)
    const { EmptyProjectsView } = await import('../src/renderer/src/components/EmptyProjectsView')
    let openProjectCalls = 0
    let botCalls = 0
    let terminalCalls = 0
    await act(async () => {
      await useProjectSpacesStore.getState().selectSpace('space-empty')
    })
    await act(async () => {
      root.render(
        h(EmptyProjectsView, {
          activeSpace: { id: 'space-empty', name: '空空间' },
          onOpenProject: () => { openProjectCalls++ },
          onOpenBot: () => { botCalls++ },
          onOpenTerminal: () => { terminalCalls++ }
        })
      )
    })
    await flush()
    assert.ok(container.textContent?.includes('「空空间」还没有项目'))
    assert.equal(container.querySelectorAll('[data-slot="card"]').length, 3)
    assert.ok(container.querySelector('[data-empty-card="open-project"]'))
    assert.ok(container.querySelector('[data-empty-card="move-project"]'))
    assert.ok(container.querySelector('[data-empty-card="bot"]'))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-empty-card="open-project"]')!.click()
      container.querySelector<HTMLButtonElement>('[data-empty-card="bot"]')!.click()
    })
    assert.equal(openProjectCalls, 1)
    assert.equal(botCalls, 1)

    await act(async () => {
      useSessionsStore.setState({ projects: [] })
    })
    await flush()
    assert.ok(container.textContent?.includes('添加一个项目来启动你的第一个工作区'))
    assert.ok(container.querySelector('[data-empty-card="terminal"]'))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-empty-card="terminal"]')!.click()
    })
    assert.equal(terminalCalls, 1)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--spaces-store-fixture') {
  await runStoreFixture()
} else if (process.argv[2] === '--spaces-ui-fixture') {
  await runUiFixture()
} else {
  test('ProjectSpaceStore persists spaces atomically, relocates projects on space removal, and rejects corrupt files', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--spaces-store-fixture'], { timeoutMs: 10_000 })
    assert.equal(exitCode, 0, stderr || stdout)
  }, 15_000)

  test('Projects sidebar switches spaces, creates spaces via dialog, and filters projects per space', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--spaces-ui-fixture'], { timeoutMs: 12_000 })
    assert.equal(exitCode, 0, stderr || stdout)
  }, 15_000)
}

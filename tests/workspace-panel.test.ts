/**
 * The right column is the only place git state becomes clickable, so this fixture drives the real store
 * and the real panel against a stubbed bridge: grouped rows, the flat 全部 list, the click that opens a
 * changes tab, folding a group, the empty states and a refresh that keeps its rows. A drag is checked
 * too, because the width is what decides whether the panel is usable at all — and so is the switch
 * between the changes list and the file tree that now share the column.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, SidebarPrefs, WorktreeDiff } from '../src/shared/api'

const CWD = '/project'

function worktree(patch: Partial<WorktreeDiff> = {}): WorktreeDiff {
  return { git: true, staged: [], unstaged: [], all: [], ...patch }
}

const full = worktree({
  staged: [{ path: 'src/staged.ts', status: 'added', additions: 3, deletions: 0 }],
  unstaged: [
    { path: 'src/work.ts', status: 'modified', additions: 2, deletions: 1 },
    { path: 'src/new.ts', status: 'untracked', additions: 4, deletions: 0 }
  ],
  all: [
    { path: 'src/new.ts', status: 'untracked', additions: 4, deletions: 0 },
    { path: 'src/staged.ts', status: 'added', additions: 3, deletions: 0 },
    { path: 'src/work.ts', status: 'modified', additions: 2, deletions: 1 }
  ]
})

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { mock } = await import('bun:test')
  const opened: { path: string; scope?: string }[] = []
  const filesOpened: string[] = []
  const sessionState = {
    openTabs: [] as { id: string; kind: string }[],
    activeTabId: null as string | null,
    openChangesTab: async (_cwd: string, path?: string, scope?: string) => {
      if (path) opened.push({ path, scope })
    },
    openFileTab: async (_cwd: string, path: string) => {
      filesOpened.push(path)
    }
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: Object.assign((select: (state: typeof sessionState) => unknown) => select(sessionState), {
      getState: () => sessionState
    })
  }))
  const api: Partial<SessionApi> = {
    readWorktreeDiff: async () => full,
    readWorktreePatch: async () => ({ git: true, patch: '', truncated: false }),
    watchWorktreeDiff: async () => 'lease',
    unwatchWorktreeDiff: async () => {},
    onDiffChanged: () => () => {},
    onDiffWatchError: () => () => {},
    getSidebarPrefs: async () => ({
      projectsCollapsed: false,
      chatsCollapsed: false,
      split: 0.5,
      reviewOpen: true,
      reviewWidth: 320
    }),
    setSidebarPrefs: async (patch) => ({
      projectsCollapsed: false,
      chatsCollapsed: false,
      split: 0.5,
      reviewOpen: patch.reviewOpen ?? true,
      reviewWidth: patch.reviewWidth ?? 320
    })
  }
  Object.defineProperty(window, 'api', { value: api, configurable: true })

  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { useDiffStore } = await import('../src/renderer/src/stores/diff')
  const { WorkspacePanel } = await import('../src/renderer/src/components/panel/WorkspacePanel')

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const row = (path: string) => container.querySelector(`button[title="${path}"]`)
  const rowTexts = () =>
    [...container.querySelectorAll('aside button[title]')].map((button) => button.textContent ?? '')
  const click = async (target: Element | null | undefined) => {
    assert.ok(target, 'expected the element to exist')
    await act(async () => {
      target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
  }
  const render = async (cwd: string, hidden = false) => {
    await act(async () => {
      root.render(createElement(WorkspacePanel, { cwd, hidden }))
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  // The panel looks saved the moment its state changes, so a preference write that fails has to be
  // reported: otherwise the only sign is the setting reverting on the next launch. The queue has to
  // survive the failure too, or every later write would be skipped.
  if (name === 'prefs-failure') {
    await act(async () => {
      useDiffStore.setState({ reviewReady: false, prefsError: null })
      api.getSidebarPrefs = async () => {
        throw new Error("Error invoking remote method 'system:get-sidebar-prefs': Error: EACCES: permission denied")
      }
      await useDiffStore.getState().loadReviewPrefs()
    })
    assert.equal(
      useDiffStore.getState().prefsError,
      'EACCES: permission denied',
      'a read that failed says so, with main\'s own words'
    )

    api.setSidebarPrefs = async () => {
      throw new Error("Error invoking remote method 'system:set-sidebar-prefs': Error: EACCES: permission denied")
    }
    await act(async () => {
      useDiffStore.getState().setReviewOpen(true)
      await Promise.resolve()
    })
    assert.equal(useDiffStore.getState().reviewOpen, true, 'the panel keeps the state it was given')
    assert.equal(
      useDiffStore.getState().prefsError,
      'EACCES: permission denied',
      'and the failed write is not swallowed'
    )

    const saved: Partial<SidebarPrefs>[] = []
    api.setSidebarPrefs = async (patch) => {
      saved.push(patch)
      return { projectsCollapsed: false, chatsCollapsed: false, split: 0.5, reviewOpen: false, reviewWidth: 320 }
    }
    await act(async () => {
      useDiffStore.getState().setReviewOpen(false)
      await Promise.resolve()
    })
    assert.deepEqual(saved, [{ reviewOpen: false }], 'a write after the failure still goes out')
    assert.equal(useDiffStore.getState().prefsError, null, 'and clears the message once it lands')
  } else if (name === 'prefs-race') {
    // Writes queue, so a failure can land after a later write was already queued. The message has to
    // follow the field it belongs to: cleared by a later save of that same field, kept by a save of
    // another one, because main merges one field at a time and the toggle was still never written.
    const held: { patch: Partial<SidebarPrefs>; resolve: () => void; reject: (error: Error) => void }[] = []
    const flush = () => new Promise((done) => setTimeout(done, 0))
    api.setSidebarPrefs = (patch) =>
      new Promise((resolve, reject) => {
        held.push({
          patch,
          resolve: () => resolve({ projectsCollapsed: false, chatsCollapsed: false, split: 0.5, reviewOpen: false, reviewWidth: 320 }),
          reject
        })
      })
    const failure = new Error("Error invoking remote method 'system:set-sidebar-prefs': Error: EACCES: permission denied")

    await act(async () => {
      useDiffStore.setState({ prefsError: null })
      useDiffStore.getState().setReviewOpen(true)
      await flush()
      useDiffStore.getState().setReviewOpen(false)
      await flush()
    })
    assert.equal(held.length, 1, 'the second write waits for the first')
    await act(async () => {
      held[0].reject(failure)
      await flush()
    })
    assert.equal(held.length, 2, 'and goes out once the first settles')
    assert.equal(useDiffStore.getState().prefsError, 'EACCES: permission denied')
    await act(async () => {
      held[1].resolve()
      await flush()
    })
    assert.equal(
      useDiffStore.getState().prefsError,
      null,
      'a later save of the same field clears the message'
    )

    await act(async () => {
      useDiffStore.getState().setReviewOpen(true)
      await flush()
      useDiffStore.getState().commitReviewWidth()
      await flush()
    })
    assert.equal(held.length, 3, 'the first of the pair is in flight, the second waits behind it')
    await act(async () => {
      held[2].reject(failure)
      await flush()
    })
    assert.equal(held.length, 4, 'and starts once that one settles')
    assert.equal(useDiffStore.getState().prefsError, 'EACCES: permission denied')
    await act(async () => {
      held[3].resolve()
      await flush()
    })
    assert.equal(
      useDiffStore.getState().prefsError,
      'EACCES: permission denied',
      'but a save of another field leaves it alone: the toggle still never reached the disk'
    )
    assert.equal(held[2].patch.reviewOpen, true)
    assert.deepEqual(Object.keys(held[3].patch), ['reviewWidth'])
  } else if (name === 'grouped') {
    await render(CWD)
    const text = container.textContent ?? ''
    assert.match(text, /变更/)
    assert.match(text, /已暂存/)
    assert.match(text, /未提交/)
    const header = container.querySelector('aside header')!
    assert.equal(header.textContent, '文件变更3', 'the switcher carries the count of changed files, not lines')
    assert.deepEqual(rowTexts(), ['Astaged.tssrc+3-0', 'Mwork.tssrc+2-1', 'Unew.tssrc+4-0'])

    // The panel's rows keep the left column's rhythm: inset, rounded, 2px of air between them.
    const workRow = row('src/work.ts')!
    assert.match(workRow.className, /rounded-sm/, 'the hover background rounds off')
    assert.match(workRow.className, /pl-6/, 'a grouped row lines up with the group label above it')
    const list = workRow.parentElement!
    assert.match(list.className, /gap-0\.5/, 'rows are spaced like the left column')
    assert.match(list.className, /px-1/, 'and inset so the hover can round')

    await click(row('src/work.ts'))
    // The row carries its own group, so the canvas opens under 未提交 rather than 全部变更.
    assert.deepEqual(opened, [{ path: 'src/work.ts', scope: 'unstaged' }])

    // A group header folds only its own rows; the rail has no fold-all of its own.
    const unstaged = [...container.querySelectorAll('button[aria-expanded]')].find((button) =>
      (button.textContent ?? '').startsWith('未提交')
    )
    assert.ok(unstaged, 'expected the 未提交 group header')
    await click(unstaged)
    assert.deepEqual(rowTexts(), ['Astaged.tssrc+3-0'])
    await click(unstaged)
    assert.equal(rowTexts().length, 3)

    // Radix keeps `value` off the DOM, so the flat-view switch is found by its label.
    const flatToggle = [...container.querySelectorAll('button[role="radio"]')].find(
      (button) => button.textContent === '全部'
    )
    await click(flatToggle)
    assert.deepEqual(rowTexts(), ['Unew.tssrc+4-0', 'Astaged.tssrc+3-0', 'Mwork.tssrc+2-1'])
    await click(row('src/staged.ts'))
    // The flat 全部 list has no group of its own: its rows open the merge every path belongs to.
    assert.deepEqual(opened[1], { path: 'src/staged.ts', scope: 'all' })
  } else if (name === 'states') {
    api.readWorktreeDiff = async (cwd: string) => {
      if (cwd === '/broken') throw new Error('Git 不可用')
      if (cwd === '/plain') return worktree({ git: false })
      return worktree()
    }
    await render('/broken')
    assert.match(container.textContent ?? '', /Git 不可用/)

    await render('/plain')
    assert.match(container.textContent ?? '', /当前目录不是 Git 仓库/)

    await render('/clean')
    assert.match(container.textContent ?? '', /工作区没有未提交的变更/)

    // A count that nobody has read is unknown, and a group that holds one says its file count only:
    // adding up the half it happens to know would read as a total.
    api.readWorktreeDiff = async () =>
      worktree({
        staged: [{ path: 'src/staged.ts', status: 'added', additions: 3, deletions: 0 }],
        unstaged: [{ path: 'src/new.ts', status: 'untracked', additions: null, deletions: null }],
        all: [
          { path: 'src/new.ts', status: 'untracked', additions: null, deletions: null },
          { path: 'src/staged.ts', status: 'added', additions: 3, deletions: 0 }
        ]
      })
    await render('/unread')
    const [stagedHeader, unstagedHeader] = [...container.querySelectorAll('button[aria-expanded]')]
    assert.match(stagedHeader!.textContent ?? '', /已暂存\(1\)\+3-0/, 'a group whose counts are all known keeps them')
    assert.match(unstagedHeader!.textContent ?? '', /未提交\(1\)$/)
  } else if (name === 'refresh') {
    await render(CWD)
    assert.equal(rowTexts().length, 3)

    // A refresh keeps the list that is already there; only a first read has nothing to show yet.
    await act(async () => {
      useDiffStore.setState((state) => ({
        worktrees: { ...state.worktrees, [CWD]: { ...state.worktrees[CWD], status: 'loading' } }
      }))
    })
    assert.equal(rowTexts().length, 3)
    assert.doesNotMatch(container.textContent ?? '', /正在读取变更/)

    api.readWorktreeDiff = () => new Promise(() => {})
    await render('/cold')
    assert.match(container.textContent ?? '', /正在读取变更/)
  } else if (name === 'shell') {
    // The column blends into the page like the left sidebar, and collapsing lives in the top bar only.
    await render(CWD)
    const panel = container.querySelector('aside')
    assert.ok(panel, 'expected the review column')
    assert.doesNotMatch(panel!.className, /border-[ltrb]/, 'no separator lines around the column')
    assert.match(panel!.className, /\bmr-2\b/, 'keeps the page margin the chat card has when collapsed')
    assert.equal(container.querySelector('button[aria-label="收起变更栏"]'), null)
    assert.equal(container.querySelector('button[aria-label="折叠全部"]'), null, 'folding lives in the canvas')
    const sizes = [...container.querySelectorAll('footer button[role="radio"]')]
    assert.equal(sizes.length, 2)
    for (const size of sizes) assert.match(size.className, /\bh-6\b/, 'the switcher is one size down')
    assert.match(container.querySelector('footer')!.className, /\bpb-2\b/, 'the footer clears the window edge like the left column')

    // Collapsing animates the same way the left column does: the width goes to 0 and the gap goes
    // with it, and the rail is taken out of the tab order while it is off screen.
    await render(CWD, true)
    const collapsed = container.querySelector('aside')!
    assert.equal(collapsed.style.width, '0px', 'the rail collapses to nothing')
    assert.match(collapsed.className, /transition-\[width,margin\]/, 'and animates there')
    assert.match(collapsed.className, /\bmr-0\b/, 'taking the page margin with it')
    assert.equal(collapsed.getAttribute('aria-hidden'), 'true')
    assert.ok(collapsed.hasAttribute('inert'), 'and stops answering the keyboard')
  } else if (name === 'views') {
    const treeCalls: string[] = []
    api.readDirectory = async (_cwd: string, path: string) => {
      treeCalls.push(path)
      if (path === '') {
        return {
          path,
          entries: [
            { name: 'node_modules', path: 'node_modules', kind: 'directory', ignored: true },
            { name: 'src', path: 'src', kind: 'directory', ignored: false },
            { name: 'readme.md', path: 'readme.md', kind: 'file', ignored: false }
          ]
        }
      }
      return {
        path,
        entries: [{ name: 'work.ts', path: 'src/work.ts', kind: 'file', ignored: false }]
      }
    }
    const switcher = (label: string) =>
      [...container.querySelectorAll('header button[role="radio"]')].find((button) =>
        (button.textContent ?? '').startsWith(label)
      )

    await render(CWD)
    assert.equal(rowTexts().length, 3, 'the changes list is what the column opens on')

    await click(switcher('文件'))
    assert.deepEqual(treeCalls, [''], 'the tree reads the root the first time it is shown')
    assert.deepEqual(rowTexts(), ['node_modules', 'src', 'readme.md'])

    // A directory reads its own level, once, and its rows land under it.
    await click(row('src'))
    assert.deepEqual(treeCalls, ['', 'src'])
    assert.deepEqual(rowTexts(), ['node_modules', 'src', 'work.ts', 'readme.md'])
    await click(row('src'))
    assert.deepEqual(rowTexts(), ['node_modules', 'src', 'readme.md'])
    await click(row('src'))
    assert.deepEqual(treeCalls, ['', 'src', 'src'], 'closing takes the rows away, and opening reads the level again')

    // What git ignores is listed but dimmed, and the footer toggle hides it outright.
    assert.match(row('node_modules')!.className, /text-muted-foreground/)
    await click(container.querySelector('footer button[aria-pressed]'))
    assert.deepEqual(rowTexts(), ['src', 'work.ts', 'readme.md'])

    // A file opens its own tab.
    await click(row('src/work.ts'))
    assert.deepEqual(filesOpened, ['src/work.ts'])
  } else if (name === 'drag') {
    await render(CWD)
    const handle = container.querySelector('div[aria-label="调整侧边栏宽度"]')
    assert.ok(handle, 'expected the resize handle')
    assert.match(handle!.className, /\bleft-0\b/, 'the full handle stays inside the clipped panel')
    assert.doesNotMatch(handle!.className, /-left-1/)
    const writes: number[] = []
    api.setSidebarPrefs = async (patch) => {
      if (patch.reviewWidth !== undefined) writes.push(patch.reviewWidth)
      return { projectsCollapsed: false, chatsCollapsed: false, split: 0.5, reviewOpen: true, reviewWidth: patch.reviewWidth ?? 320 }
    }
    // happy-dom lays nothing out, so the drag start has to be given a width to work from.
    Object.defineProperty(handle!.parentElement!, 'offsetWidth', { value: 320, configurable: true })
    Object.assign(handle!, { setPointerCapture: () => {}, releasePointerCapture: () => {} })
    const pointer = (type: string, clientX: number) =>
      new window.MouseEvent(type, { bubbles: true, clientX, pointerId: 1 } as MouseEventInit)
    await act(async () => {
      handle!.dispatchEvent(pointer('pointerdown', 500))
      handle!.dispatchEvent(pointer('pointermove', 420))
    })
    assert.equal(useDiffStore.getState().reviewWidth, 400, 'drag left widens the panel')
    await act(async () => {
      handle!.dispatchEvent(pointer('pointermove', 100))
    })
    assert.equal(useDiffStore.getState().reviewWidth, 720, 'the width stops at its maximum')
    await act(async () => {
      handle!.dispatchEvent(pointer('pointerup', 100))
    })
    assert.equal(writes.length, 1)
    assert.equal(writes[0], 720)

    await act(async () => {
      handle!.dispatchEvent(pointer('pointerdown', 500))
      handle!.dispatchEvent(pointer('pointermove', 450))
      handle!.dispatchEvent(pointer('pointercancel', 450))
      await Promise.resolve()
    })
    assert.equal(useDiffStore.getState().reviewWidth, 370)
    const committed = writes.length
    await act(async () => {
      handle!.dispatchEvent(pointer('pointermove', 300))
      await Promise.resolve()
    })
    assert.equal(useDiffStore.getState().reviewWidth, 370, 'a cancelled drag stops moving')
    assert.equal(writes.length, committed, 'lost capture after cancellation does not commit twice')

    await act(async () => {
      handle!.dispatchEvent(pointer('pointerdown', 500))
      handle!.dispatchEvent(pointer('pointermove', 460))
      handle!.dispatchEvent(pointer('lostpointercapture', 460))
      await Promise.resolve()
    })
    assert.equal(useDiffStore.getState().reviewWidth, 360)
    assert.equal(writes.length, committed + 1, 'lost capture commits the drag once')
  }

  await act(async () => {
    root.unmount()
  })
  container.remove()
  await GlobalRegistrator.unregister()
}

if (process.argv[2] === '--review-panel-fixture') {
  await runFixture(process.argv[3])
} else {
  for (const [name, title] of Object.entries({
    'prefs-failure': 'a preference that could not be read or saved is reported, and the queue survives it',
    'prefs-race': 'a failure that lands after a queued write is cleared by that write only for its own field',
    grouped: 'grouped rows list both stages and a click reveals the file in the changes tab',
    shell: 'the column has no separators and no duplicate collapse button',
    states: 'a broken read, a non-git folder and a clean worktree each say so',
    refresh: 'a refresh keeps the list while only a first read shows the loading text',
    views: 'the column switches between the changes list and the file tree',
    drag: 'dragging the edge resizes the panel and writes the preference once'
  })) {
    test(`review panel: ${title}`, async () => {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, '--review-panel-fixture', name],
        { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' }
      )
      const timeout = setTimeout(() => child.kill(), 12_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 15_000)
  }
}

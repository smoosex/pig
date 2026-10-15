/**
 * The right column is the only place git state becomes clickable, so this fixture drives the real store
 * and the real panel against a stubbed bridge: grouped rows, the flat 全部 list, the click that opens a
 * changes tab, folding a group, the empty states and a refresh that keeps its rows. Its fixed-width rail
 * keeps the file tree and changes list mounted when it collapses.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, SidebarPrefs, WorktreeDiff } from '../src/shared/api'
import type { OpenTab } from '../src/renderer/src/stores/sessions'

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
    openTabs: [] as Pick<OpenTab, 'id' | 'kind' | 'cwd' | 'path'>[],
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
      sidebarTab: 'projects',
      split: 0.5,
      reviewOpen: true
    }),
    setSidebarPrefs: async (patch) => ({
      sidebarTab: 'projects',
      split: 0.5,
      reviewOpen: patch.reviewOpen ?? true
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
      return { sidebarTab: 'projects', split: 0.5, reviewOpen: false }
    }
    await act(async () => {
      useDiffStore.getState().setReviewOpen(false)
      await Promise.resolve()
    })
    assert.deepEqual(saved, [{ reviewOpen: false }], 'a write after the failure still goes out')
    assert.equal(useDiffStore.getState().prefsError, null, 'and clears the message once it lands')
  } else if (name === 'prefs-race') {
    // A failed save must not discard a newer toggle that is already queued behind it.
    const held: { patch: Partial<SidebarPrefs>; resolve: () => void; reject: (error: Error) => void }[] = []
    const flush = () => new Promise((done) => setTimeout(done, 0))
    api.setSidebarPrefs = (patch) =>
      new Promise((resolve, reject) => {
        held.push({
          patch,
          resolve: () => resolve({ sidebarTab: 'projects', split: 0.5, reviewOpen: false }),
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

    assert.deepEqual(held.map(({ patch }) => patch), [{ reviewOpen: true }, { reviewOpen: false }])
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
    await act(async () => {
      sessionState.openTabs = [{ id: 'diff', kind: 'diff', cwd: CWD }]
      sessionState.activeTabId = 'diff'
      useDiffStore.setState({ visible: { [CWD]: 'src/work.ts' } })
    })
    assert.ok(row('src/work.ts')!.classList.contains('bg-sidebar-foreground/12'))
    assert.ok(row('src/work.ts')!.classList.contains('hover:bg-sidebar-foreground/12!'))
    assert.ok(!row('src/work.ts')!.className.includes('backdrop-blur'))
    assert.ok(!row('src/work.ts')!.className.includes('sidebar-hover-target'))
    assert.ok(!row('src/new.ts')!.classList.contains('bg-sidebar-foreground/12'))
    assert.ok(row('src/new.ts')!.classList.contains('hover:bg-transparent!'))
    assert.ok(row('src/work.ts')!.hasAttribute('data-sidebar-selected'))

    // A group header folds only its own rows; the rail has no fold-all of its own.
    const unstaged = [...container.querySelectorAll('button[aria-expanded]')].find((button) =>
      (button.textContent ?? '').startsWith('未提交')
    )
    assert.ok(unstaged, 'expected the 未提交 group header')
    assert.ok(unstaged.parentElement!.classList.contains('pb-0.5'))
    await click(unstaged)
    assert.deepEqual(rowTexts(), ['Astaged.tssrc+3-0'])
    assert.ok(!unstaged.parentElement!.classList.contains('pb-0.5'), 'a collapsed group does not double the next gap')
    await click(unstaged)
    assert.equal(rowTexts().length, 3)
    assert.ok(unstaged.parentElement!.classList.contains('pb-0.5'))

    // Radix keeps `value` off the DOM, so the flat-view switch is found by its label.
    const flatToggle = [...container.querySelectorAll('button[role="radio"]')].find(
      (button) => button.textContent === '全部'
    )
    await click(flatToggle)
    assert.deepEqual(rowTexts(), ['Unew.tssrc+4-0', 'Astaged.tssrc+3-0', 'Mwork.tssrc+2-1'])
    await click(row('src/staged.ts'))
    // The flat 全部 list has no group of its own: its rows open the merge every path belongs to.
    assert.deepEqual(opened[1], { path: 'src/staged.ts', scope: 'all' })
  } else if (name === 'sticky') {
    const observers: { targets: Set<Element>; update: () => void }[] = []
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        readonly targets = new Set<Element>()
        constructor(update: () => void) { observers.push({ targets: this.targets, update }) }
        observe(target: Element) { this.targets.add(target) }
        unobserve(target: Element) { this.targets.delete(target) }
        disconnect() { this.targets.clear() }
      }
    })
    await render(CWD)
    const groups = [...container.querySelectorAll<HTMLElement>('[data-change-group]')]
    assert.equal(groups.length, 2)
    assert.ok(groups[0].parentElement!.classList.contains('flex-col'))
    assert.ok(groups[0].parentElement!.classList.contains('gap-0.5'), 'group titles have the same gap above them as file rows')
    const [{ header: stagedHeader, list: stagedList }, { header: unstagedHeader, list: unstagedList }] =
      groups.map((group) => ({
        header: group.firstElementChild as HTMLElement,
        list: group.lastElementChild as HTMLElement
      }))
    for (const header of [stagedHeader, unstagedHeader]) {
      assert.ok(header.classList.contains('sticky'), 'group titles still pin while scrolling')
      assert.ok(header.classList.contains('bg-transparent'))
      assert.ok(header.classList.contains('pb-0.5'), 'the transparent padding separates the title background from the first row')
      assert.ok(!header.classList.contains('bg-sidebar'))
      assert.ok(!header.classList.contains('solid:bg-sidebar'), 'the opaque column backs solid titles without hiding their shared hover layer')
      assert.ok(!header.className.includes('backdrop-blur'))
      const button = header.querySelector('button')!
      assert.ok(button.classList.contains('hover:bg-transparent!'))
      assert.ok(header.hasAttribute('data-sidebar-hover-occlusion'), 'sticky titles also clip the shared hover layer')
      assert.ok(!button.classList.contains('bg-sidebar-foreground/12'), 'expanded groups are not selections')
    }

    // happy-dom has no layout: 28px title + 2px bottom padding, 24px rows, 2px row/group gaps.
    const area = groups[0].parentElement!.parentElement!
    let scroll = 0
    stagedHeader.getBoundingClientRect = () => new window.DOMRect(0, Math.min(0, 24 - scroll), 320, 30)
    stagedList.getBoundingClientRect = () => new window.DOMRect(0, 30 - scroll, 320, 24)
    unstagedHeader.getBoundingClientRect = () => new window.DOMRect(0, Math.max(0, 56 - scroll), 320, 30)
    unstagedList.getBoundingClientRect = () => new window.DOMRect(0, 86 - scroll, 320, 50)
    const observer = observers.find((item) => item.targets.has(area))!
    assert.ok(observer)
    observer.update()
    assert.equal(stagedList.style.clipPath, '')
    assert.equal(unstagedList.style.clipPath, '')

    scroll = 12
    area.dispatchEvent(new window.Event('scroll'))
    assert.equal(stagedList.style.clipPath, 'inset(12px 0 0)', 'the pinned title keeps its 2px gap below the background')
    assert.equal(unstagedList.style.clipPath, '', 'a header still in normal flow clips nothing')

    scroll = 60
    area.dispatchEvent(new window.Event('scroll'))
    assert.equal(stagedList.style.clipPath, 'inset(24px 0 0)')
    assert.equal(unstagedList.style.clipPath, 'inset(4px 0 0)', 'each group clips below its own sticky title and gap')

    scroll = 0
    observer.update()
    assert.equal(stagedList.style.clipPath, '', 'resize updates also remove an obsolete clip')
    assert.equal(unstagedList.style.clipPath, '')

    await click([...container.querySelectorAll('footer button[role="radio"]')].find((button) => button.textContent === '全部'))
    assert.equal(container.querySelector('[data-change-group]'), null)
    assert.equal(observer.targets.size, 0, 'changing list shape disconnects the old observer')
    const flatList = row('src/work.ts')!.parentElement!
    assert.equal(flatList.style.clipPath, '', 'flat rows do not inherit a group clip')
    stagedList.style.clipPath = 'inset(1px 0 0)'
    scroll = 12
    area.dispatchEvent(new window.Event('scroll'))
    assert.equal(flatList.style.clipPath, '')
    assert.equal(stagedList.style.clipPath, 'inset(1px 0 0)', 'the old scroll listener is removed')
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
    assert.match(panel!.firstElementChild!.className, /\bpr-2\b/, 'the window inset stays inside the shared sidebar width')
    assert.equal(container.querySelector('button[aria-label="收起变更栏"]'), null)
    assert.equal(container.querySelector('button[aria-label="折叠全部"]'), null, 'folding lives in the canvas')
    const sizes = [...container.querySelectorAll('footer button[role="radio"]')]
    assert.equal(sizes.length, 2)
    for (const size of sizes) assert.match(size.className, /\bh-6\b/, 'the switcher is one size down')
    for (const toggle of container.querySelectorAll('button[role="radio"]')) {
      assert.ok(toggle.classList.contains('hover:bg-sidebar-foreground/6!'))
      assert.ok(toggle.classList.contains('data-[state=on]:bg-sidebar-foreground/12'))
      assert.ok(toggle.classList.contains('data-[state=on]:hover:bg-sidebar-foreground/12!'))
      assert.ok(toggle.classList.contains('duration-100'))
      assert.ok(!toggle.className.includes('backdrop-blur'))
    }
    assert.ok(container.querySelector('span.will-change-transform')!.classList.contains('bg-sidebar-foreground/6'))
    assert.match(container.querySelector('footer')!.className, /\bpb-2\b/, 'the footer clears the window edge like the left column')

    // The rail collapses like the left sidebar, retaining its inner inset inside the clipped contents.
    await render(CWD, true)
    const collapsed = container.querySelector('aside')!
    assert.ok(collapsed.classList.contains('w-0'), 'the rail collapses to nothing')
    assert.match(collapsed.className, /transition-\[width,background-color\]/, 'width and background animate without fading content')
    assert.doesNotMatch(collapsed.className, /\bmr-/, 'an outer margin cannot offset the centered conversation')
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
    assert.ok(container.querySelector('span.will-change-transform')!.classList.contains('bg-sidebar-foreground/6'))
    for (const fileRow of container.querySelectorAll('[data-sidebar-hover-row]')) {
      assert.ok(fileRow.classList.contains('hover:bg-transparent!'))
      assert.ok(fileRow.classList.contains('duration-100'))
      assert.ok(!fileRow.className.includes('backdrop-blur'))
    }

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
    const ignoredToggle = container.querySelector('footer button[aria-pressed="true"]')!
    assert.ok(ignoredToggle.classList.contains('aria-pressed:bg-sidebar-foreground/12'))
    assert.ok(ignoredToggle.classList.contains('aria-pressed:hover:bg-sidebar-foreground/12!'))
    assert.ok(!ignoredToggle.className.includes('backdrop-blur'))

    // A file opens its own tab.
    await click(row('src/work.ts'))
    assert.deepEqual(filesOpened, ['src/work.ts'])
    sessionState.openTabs = [{ id: 'file', kind: 'file', cwd: CWD, path: 'src/work.ts' }]
    sessionState.activeTabId = 'file'
    await render(CWD)
    assert.ok(row('src/work.ts')!.classList.contains('bg-sidebar-foreground/12'))
    assert.ok(row('src/work.ts')!.classList.contains('hover:bg-sidebar-foreground/12!'))
    assert.ok(!row('src/work.ts')!.classList.contains('hover:bg-sidebar-foreground/6!'))
  } else if (name === 'width') {
    const writes: Partial<SidebarPrefs>[] = []
    api.setSidebarPrefs = async (patch) => {
      writes.push(patch)
      return { sidebarTab: 'projects', split: 0.5, reviewOpen: true }
    }
    await render(CWD)
    const panel = container.querySelector('aside')!
    const content = panel.firstElementChild!
    assert.ok(panel.classList.contains('w-62'), 'the right rail uses the same width as the left sidebar')
    assert.ok(content.classList.contains('w-62') && content.classList.contains('shrink-0'))
    assert.equal(panel.style.width, '', 'no stored width overrides the shared CSS width')
    assert.ok(!panel.classList.contains('max-w-1/2') && !panel.classList.contains('mr-2'))
    assert.equal(panel.querySelector('[role="separator"]'), null, 'there is no resize handle')
    await render(CWD, true)
    assert.ok(panel.classList.contains('w-0'))
    assert.equal(panel.getAttribute('aria-hidden'), 'true')
    assert.ok(panel.hasAttribute('inert'))
    assert.equal(panel.firstElementChild, content, 'collapsing retains the full-width contents')
    await render(CWD)
    assert.ok(panel.classList.contains('w-62'))
    assert.equal(panel.firstElementChild, content)
    assert.deepEqual(writes, [], 'mounting and collapsing do not write a width preference')
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
    'prefs-race': 'toggle writes remain ordered and a later success clears a prior failure',
    grouped: 'grouped rows list both stages and a click reveals the file in the changes tab',
    sticky: 'transparent sticky titles clip scrolled rows without painting another surface',
    shell: 'the column has no separators and no duplicate collapse button',
    states: 'a broken read, a non-git folder and a clean worktree each say so',
    refresh: 'a refresh keeps the list while only a first read shows the loading text',
    views: 'the column switches between the changes list and the file tree',
    width: 'the fixed rail matches the left sidebar and retains its contents while collapsing'
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

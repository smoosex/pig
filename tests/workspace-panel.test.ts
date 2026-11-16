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
import { runSelf } from './helpers/subprocess.ts'

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
  // Happy DOM rejects cancelled WAAPI promises; use Motion's JS fallback.
  Reflect.deleteProperty(Element.prototype, 'animate')
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
    countUntrackedFiles: async () => ({}),
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
  const row = (path: string) => container.querySelector(`aside button[data-sidebar-hover-row][title="${path}"]`)
  const rowTexts = () =>
    [...container.querySelectorAll('aside button[data-sidebar-hover-row][title]')].map((button) => button.textContent ?? '')
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
    const viewport = container.querySelector<HTMLElement>('[data-change-viewport]')!
    const area = viewport.firstElementChild as HTMLElement
    const pinned = () => container.querySelector<HTMLElement>('[data-change-pinned-header]')!
    const heading = () => pinned().querySelector<HTMLElement>('[data-change-heading]')!
    const sections = [...area.querySelectorAll<HTMLElement>('[data-change-group]')]
    const inline = sections[1].querySelector<HTMLElement>('[data-change-heading]')!
    assert.equal(heading().dataset.changeHeading, 'staged')
    assert.equal(sections[0].querySelector('[data-change-heading]'), null, 'first title is moved, not duplicated in the scrolling content')
    assert.equal(inline.dataset.changeHeading, 'unstaged')
    assert.equal(viewport.previousElementSibling, pinned())
    assert.ok(pinned().previousElementSibling!.hasAttribute('data-workspace-filter'))
    assert.ok(pinned().classList.contains('shrink-0'))
    assert.ok(!viewport.contains(pinned()), 'title, its padding and filter are all outside the scrolling paint area')
    assert.ok(viewport.classList.contains('overflow-hidden'))
    assert.ok(area.classList.contains('overflow-y-auto'))
    assert.equal(area.querySelector('.sticky'), null, 'no transparent sticky overlay remains in the scrolling region')
    assert.equal(area.querySelector('[data-sidebar-hover-occlusion]'), null)
    assert.equal(area.querySelector('[style*="clip-path"]'), null)

    // Model a real viewport and the next group's inline heading crossing its top.
    let nextBottom = 180
    area.getBoundingClientRect = () => new window.DOMRect(0, 100, 320, 400)
    inline.getBoundingClientRect = () => new window.DOMRect(0, nextBottom - 30, 320, 30)
    const observer = observers.find(item => item.targets.has(sections[0]))!
    assert.ok(observer.targets.has(area))
    const scroll = async (bottom: number) => {
      nextBottom = bottom
      await act(async () => { area.dispatchEvent(new window.Event('scroll')) })
    }
    await scroll(101)
    assert.equal(heading().dataset.changeHeading, 'staged', 'next title stays inline until it has passed out of the viewport')
    await scroll(-500)
    assert.equal(heading().dataset.changeHeading, 'unstaged', 'a fast jump switches the separate title')
    assert.ok(pinned().textContent!.includes('未提交(2)+6-1'))
    assert.equal(area.querySelectorAll('button[title]').length, 3, 'handoff does not remount or hide file rows')
    await scroll(100)
    assert.equal(heading().dataset.changeHeading, 'unstaged')
    await scroll(180)
    assert.equal(heading().dataset.changeHeading, 'staged', 'reverse scrolling restores the previous title')

    await scroll(80)
    await click(heading().querySelector('button'))
    assert.equal(row('src/work.ts'), null, 'the external control collapses only its current group')
    assert.ok(row('src/staged.ts'))
    assert.equal(heading().querySelector('button')!.getAttribute('aria-expanded'), 'false')
    await click(heading().querySelector('button'))
    assert.ok(row('src/work.ts'))
    assert.ok(row('src/new.ts'))

    // A filter can remove the current group; no stale external title survives.
    const filter = container.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(filter, 'staged')
      filter.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(heading().dataset.changeHeading, 'staged')
    assert.equal(row('src/work.ts'), null)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(filter, 'work')
      filter.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(heading().dataset.changeHeading, 'unstaged', 'a lone unstaged group uses the external title too')
    assert.equal(area.querySelector('[data-change-heading]'), null)
    assert.ok(row('src/work.ts'))

    await click([...container.querySelectorAll('footer button[role="radio"]')].find(button => button.textContent === '全部'))
    assert.equal(container.querySelector('[data-change-pinned-header]'), null, 'flat mode has no reserved title area')
    assert.equal(container.querySelector('[data-change-group]'), null)
    assert.equal(observer.targets.size, 0, 'switching modes disconnects observers of the old sections')
    await scroll(-500)
    assert.equal(container.querySelector('[data-change-pinned-header]'), null, 'old scroll listeners cannot restore a title')
  } else if (name === 'states') {
    api.readWorktreeDiff = async (cwd: string) => {
      if (cwd === '/broken') throw new Error('Git 不可用')
      if (cwd === '/plain') return worktree({ git: false })
      return worktree()
    }
    await render('/broken')
    assert.match(container.textContent ?? '', /Git 不可用/)
    assert.equal(container.querySelector('[data-slot="empty"]'), null)

    await render('/plain')
    assert.match(container.textContent ?? '', /当前目录不是 Git 仓库/)
    assert.equal(container.querySelector('[data-slot="empty"]'), null)

    await render('/clean')
    const empty = container.querySelector('[data-slot="empty"]')!
    assert.ok(empty, 'a clean worktree has a dedicated empty state')
    assert.equal(empty.querySelector('[data-slot="empty-title"]')!.textContent, '没有更改')
    assert.equal(empty.querySelector('[data-slot="empty-description"]')!.textContent, '你或你的智能体在此工作树中所做的编辑会显示在这里。')
    const icon = empty.querySelector('[data-slot="empty-icon"]')!
    assert.ok(icon.classList.contains('rounded-full'))
    assert.ok(icon.querySelector('svg.lucide-file-diff'))
    assert.ok(empty.classList.contains('justify-center'))
    assert.ok(empty.parentElement!.classList.contains('min-h-full'), 'the empty state fills the list viewport to center vertically')
    await click(container.querySelector('button[aria-label="以树状显示"]'))
    assert.ok(container.querySelector('[data-slot="empty"]'), 'the tree view keeps the same clean state')
    await click(container.querySelector('button[aria-label="以树状显示"]'))

    // An unknown file must not hide known counts on files, groups or directories.
    api.readWorktreeDiff = async () =>
      worktree({
        staged: [{ path: 'src/staged.ts', status: 'added', additions: 3, deletions: 0 }],
        unstaged: [
          { path: 'src/new.ts', status: 'untracked', additions: null, deletions: null },
          { path: 'src/work.ts', status: 'modified', additions: 2, deletions: 1 }
        ],
        all: [
          { path: 'src/new.ts', status: 'untracked', additions: null, deletions: null },
          { path: 'src/work.ts', status: 'modified', additions: 2, deletions: 1 },
          { path: 'src/staged.ts', status: 'added', additions: 3, deletions: 0 }
        ]
      })
    await render('/unread')
    const [stagedHeader, unstagedHeader] = [...container.querySelectorAll('button[aria-expanded]')]
    assert.match(stagedHeader!.textContent ?? '', /已暂存\(1\)\+3-0/, 'a group whose counts are all known keeps them')
    assert.match(unstagedHeader!.textContent ?? '', /未提交\(2\)\+2-1$/)
    assert.match(row('src/staged.ts')!.textContent ?? '', /\+3-0$/)
    assert.match(row('src/work.ts')!.textContent ?? '', /\+2-1$/)
    assert.doesNotMatch(container.textContent ?? '', /未计入/)
    await click(container.querySelector('button[aria-label="以树状显示"]'))
    const directories = [...container.querySelectorAll('button[title="src"]')]
    assert.ok(directories.some((directory) => /\+2-1$/.test(directory.textContent ?? '')))

    api.countUntrackedFiles = async () => { throw new Error('EIO: count read failed') }
    await render('/count-failed')
    assert.match(container.textContent ?? '', /部分行数统计失败：EIO: count read failed/)
    assert.match(container.querySelector('[data-change-pinned-header] button[aria-expanded]')!.textContent ?? '', /已暂存\(1\)\+3-0$/)
    assert.match(container.querySelector('[data-change-group="unstaged"] button[aria-expanded]')!.textContent ?? '', /未提交\(2\)\+2-1$/)
    assert.match(container.textContent ?? '', /src\/new\.ts|new\.ts/)
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
    for (const toggle of sizes) {
      assert.ok(toggle.classList.contains('rounded-full'))
      assert.ok(toggle.classList.contains('data-[state=on]:bg-transparent!'))
      assert.ok(!toggle.className.includes('backdrop-blur'))
    }
    const footer = container.querySelector('footer')!
    assert.ok(footer.previousElementSibling!.querySelector('[data-slot="separator"]'), 'a divider sits above the footer')
    assert.equal(footer.querySelectorAll('button').length, 3, 'two mode choices and only the tree action')
    assert.equal(footer.querySelectorAll('[data-diff-mode-pill]').length, 1)
    const all = sizes.find(button => button.textContent === '全部')!
    await click(all)
    assert.equal(all.getAttribute('data-state'), 'on')
    assert.ok(all.querySelector('[data-diff-mode-pill]'), 'the capsule follows the selected mode')
    await click(sizes.find(button => button.textContent === '分组'))
    assert.equal(footer.querySelectorAll('[data-diff-mode-pill]').length, 1)
    assert.equal(container.querySelectorAll('header [data-panel-pill]').length, 1)
    assert.ok(container.querySelector('header [data-panel-pill]')!.classList.contains('rounded-full'))
    assert.match(container.querySelector('footer')!.className, /\bpy-2\b/, 'the footer clears the window edge like the left column')

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
    const searches: string[] = []
    let cancellations = 0
    const late = Promise.withResolvers<import('../src/shared/api').FileSearchResult>()
    api.searchFiles = async (_cwd, query, hideIgnored) => {
      searches.push(query)
      if (query === 'late') return late.promise
      if (query === 'failure') throw new Error('Search failed')
      return { entries: query === 'deep' ? [{ name: 'deep.ts', path: 'unopened/deep.ts', kind: 'file', ignored: false }] : [], truncated: query === 'deep' && hideIgnored }
    }
    api.cancelFileSearch = async () => { cancellations++ }
    const filter = async (label: string, value: string) => {
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
    }
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
    await filter('筛选变更文件', 'WORK.TS')
    assert.equal(rowTexts().length, 1)
    assert.ok(row('src/work.ts'))
    assert.equal(row('src/staged.ts'), null)
    await filter('筛选变更文件', 'absent')
    assert.match(container.textContent!, /没有匹配的文件/)
    assert.equal(container.querySelector('[data-slot="empty"]'), null, 'filtering never presents a dirty worktree as clean')
    await filter('筛选变更文件', '')

    await click(switcher('文件'))
    const fileFilter = container.querySelector('[data-workspace-filter]')!
    assert.ok(fileFilter.parentElement!.classList.contains('pb-2'), 'file-page bottom clearance stays outside the scroll viewport')
    assert.ok(fileFilter.nextElementSibling!.classList.contains('overflow-y-auto'), 'the inset contains the scroll viewport, not just its scrolling contents')
    assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="定位当前文件"]')!.disabled, true)
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
    await click(container.querySelector('[data-workspace-filter] button[aria-pressed]'))
    assert.deepEqual(rowTexts(), ['src', 'work.ts', 'readme.md'])
    const ignoredToggle = container.querySelector('[data-workspace-filter] button[aria-pressed="true"]')!
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
    const { useFilesStore } = await import('../src/renderer/src/stores/files')
    await act(async () => useFilesStore.setState(state => ({ expanded: { ...state.expanded, '/other': { keep: true } } })))
    await click(container.querySelector('[aria-label="全部收起"]'))
    assert.equal(row('src/work.ts'), null)
    assert.deepEqual(useFilesStore.getState().expanded[CWD], {})
    assert.equal(useFilesStore.getState().expanded['/other']!.keep, true)
    const revealed: string[] = []
    window.HTMLElement.prototype.scrollIntoView = function () { revealed.push(this.getAttribute('data-file-path')!) }
    await click(container.querySelector('[aria-label="定位当前文件"]'))
    assert.ok(row('src/work.ts'))
    assert.deepEqual(revealed, ['src/work.ts'])
    await filter('筛选文件', 'deep')
    assert.ok(row('unopened/deep.ts'), 'search includes directories that were never expanded')
    assert.match(container.textContent!, /结果不完整/)
    await filter('筛选文件', 'late')
    await filter('筛选文件', 'failure')
    await act(async () => late.resolve({ entries: [{ name: 'old.ts', path: 'old.ts', kind: 'file', ignored: false }], truncated: false }))
    assert.equal(row('old.ts'), null, 'a late search cannot replace the current result')
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Search failed/)
    await filter('筛选文件', '')
    assert.ok(row('src/work.ts'), 'clearing search restores the expanded tree')
    assert.ok(searches.includes('deep') && cancellations >= 2)
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
    sticky: 'group titles stay outside the scrolling viewport through jumps, reverse scrolling, collapse and filtering',
    shell: 'the column has animated footer modes and a divider without outer borders or duplicate collapse actions',
    states: 'a broken read, a non-git folder and a clean worktree each say so',
    refresh: 'a refresh keeps the list while only a first read shows the loading text',
    views: 'the column switches between the changes list and the file tree',
    width: 'the fixed rail matches the left sidebar and retains its contents while collapsing'
  })) {
    test(`review panel: ${title}`, async () => {
      const { exitCode: code, stdout, stderr } = await runSelf(import.meta.path, ['--review-panel-fixture', name], {
        cwd: new URL('..', import.meta.url).pathname,
        timeoutMs: 12_000
      })
      assert.equal(code, 0, stderr || stdout)
    }, 15_000)
  }
}

/**
 * The changes tab lists one scope of the worktree, every changed file a collapsible card. This fixture
 * drives the real store and the real tab against a stubbed bridge and one hand-written patch, so the
 * shape that matters to the review flow — one card per file, a header that folds it, the fold-all
 * control, the three scopes the toolbar switches between, fold state that outlives the tab, the
 * one-shot reveal asked for by the column and the reading position that column follows — is pinned
 * without rendering a single diff body. The reads it holds open pin what a refresh does to bytes that
 * were already on their way: they are dropped, and the card reads again instead of keeping the old ones.
 *
 * happy-dom lays nothing out, so the fixture fakes a geometry: cards are 200px tall, the region is
 * 400px of a 1200px scroll, and scrolling means moving that fake offset.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionApi, UntrackedFileResult, WorktreeDiff } from '../src/shared/api'

const CWD = '/project'
const OTHER_CWD = '/other-project'

const PATCH = `diff --git a/src/staged.ts b/src/staged.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/staged.ts
@@ -0,0 +1,2 @@
+export const staged = 1
+export const other = 2
diff --git a/src/work.ts b/src/work.ts
index 1111111..2222222 100644
--- a/src/work.ts
+++ b/src/work.ts
@@ -1,3 +1,3 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 4
`

const diff: WorktreeDiff = {
  git: true,
  staged: [{ path: 'src/staged.ts', status: 'added', additions: 2, deletions: 0 }],
  unstaged: [
    { path: 'src/work.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'src/new.ts', status: 'untracked', additions: null, deletions: null }
  ],
  all: [
    { path: 'src/new.ts', status: 'untracked', additions: 1, deletions: 0 },
    { path: 'src/staged.ts', status: 'added', additions: 2, deletions: 0 },
    { path: 'src/work.ts', status: 'modified', additions: 1, deletions: 1 }
  ]
}

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // Bodies mount behind an IntersectionObserver; individual assertions opt into visibility.
  let observeImmediately = false
  class StubObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      if (observeImmediately) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
    }
    disconnect(): void {}
  }
  Object.assign(globalThis, { IntersectionObserver: StubObserver })
  let frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  }
  const cancelFrame = (id: number) => { frames.delete(id) }
  Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
  Object.assign(window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
  const { mock } = await import('bun:test')
  const sessionState = {
    openTabs: [] as { id: string; kind: string; cwd: string; diffScope?: string }[],
    activeTabId: null as string | null,
    openChangesTab: async () => {},
    setChangesScope: (cwd: string, scope: string) => {
      sessionState.openTabs = sessionState.openTabs.map((tab) =>
        tab.kind === 'diff' && tab.cwd === cwd ? { ...tab, diffScope: scope } : tab
      )
    }
  }
  mock.module('../src/renderer/src/stores/sessions', () => ({
    useSessionsStore: Object.assign((select: (state: typeof sessionState) => unknown) => select(sessionState), {
      getState: () => sessionState
    })
  }))
  const readScopes: string[] = []
  const readPaths: string[] = []
  /** Reads that are held open so a refresh can land while the bytes are still in the air. */
  const heldReads: ((result: UntrackedFileResult) => void)[] = []
  let holdReads = false
  /** A read that main refuses, as the renderer sees it: the invoke itself rejects. */
  let readFailure: Error | null = null
  /** A patch that does not cover every path the lists hold, as an unreadable one arrives. */
  let patchOverride: string | null = null
  const untrackedFiles: Record<string, UntrackedFileResult> = {
    'src/new.ts': { kind: 'text', contents: 'export const fresh = true\n', lines: 1 }
  }
  const api: Partial<SessionApi> = {
    readWorktreeDiff: async () => diff,
    readWorktreePatch: async (_cwd, scope) => {
      readScopes.push(scope)
      return {
        git: true,
        patch: patchOverride ?? PATCH,
        truncated: false
      }
    },
    readUntrackedFile: async (_cwd, path) => {
      readPaths.push(path)
      if (readFailure) throw readFailure
      if (holdReads) return await new Promise<UntrackedFileResult>((resolve) => heldReads.push(resolve))
      return untrackedFiles[path] ?? { kind: 'missing' }
    },
    watchWorktreeDiff: async () => 'lease',
    unwatchWorktreeDiff: async () => {},
    onDiffChanged: () => () => {},
    onDiffWatchError: () => () => {}
  }
  Object.defineProperty(window, 'api', { value: api, configurable: true })

  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const { ChangesView } = await import('../src/renderer/src/components/diff/ChangesView')
  const { buildSections } = await import('../src/renderer/src/components/diff/sections')
  const { patchKey, rememberScrollTop, useDiffStore } = await import('../src/renderer/src/stores/diff')

  let container = document.createElement('div')
  document.body.append(container)
  let root = createRoot(container)

  const cards = () => [...container.querySelectorAll<HTMLElement>('section[id^="diff-section:"]')]
  const headers = () => cards().map((card) => card.querySelector('button')!)
  const click = async (target: Element | undefined) => {
    assert.ok(target, 'expected the element to exist')
    await act(async () => {
      target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
  }
  const pump = async () => {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }
  const flushFrame = async () => {
    const frame = frames.entries().next().value as [number, FrameRequestCallback] | undefined
    assert.ok(frame, 'expected a pending animation frame')
    frames.delete(frame![0])
    await act(async () => { frame![1](performance.now()) })
    await pump()
  }

  const mount = async () => {
    // A switch away from the tab unmounts the view, so each mount gets its own container and root.
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(ChangesView, { cwd: CWD }))
    })
    await pump()
    // The patch read lands a commit later than the file list, so the sections need a frame of their own.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    region()
  }

  // A fake layout, patched on the prototype so it answers from the first effect: cards are 200px tall
  // inside a 400px region holding 1200px, and the offset is shared because the region is the only
  // thing that scrolls here.
  const layout = { offset: 0, card: 200, viewport: 400, content: 1200 }
  const isCard = (element: Element) => cards().includes(element as HTMLElement)
  // happy-dom puts these on HTMLElement.prototype, so that is where the fake layout has to stand in.
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: {
      get(this: Element) {
        return isCard(this) ? layout.card : layout.viewport
      },
      configurable: true
    },
    scrollHeight: {
      get(this: Element) {
        return isCard(this) ? layout.card : layout.content
      },
      configurable: true
    },
    scrollTop: {
      get: () => layout.offset,
      set: (value: number) => {
        layout.offset = value
      },
      configurable: true
    }
  })
  Element.prototype.getBoundingClientRect = function () {
    const index = cards().indexOf(this as HTMLElement)
    // Only cards move with the offset; everything else (the region itself, the toolbar) is the frame.
    const top = index < 0 ? 0 : layout.card * (index + 1) - layout.offset
    const height = index < 0 ? layout.viewport : layout.card
    return {
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: 800,
      width: 800,
      height,
      toJSON: () => ({})
    } as DOMRect
  }
  const region = (): HTMLElement => cards()[0].parentElement!
  const scrollTo = async (offset: number) => {
    await act(async () => {
      const element = region()
      element.scrollTop = offset
      element.dispatchEvent(new window.Event('scroll'))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    if (frames.size > 0) await flushFrame()
  }

  await mount()

  assert.deepEqual(
    cards().map((card) => card.id),
    ['diff-section:src/new.ts', 'diff-section:src/staged.ts', 'diff-section:src/work.ts']
  )
  for (const card of cards()) {
    assert.match(card.className, /rounded-lg/, 'each file is its own card')
    assert.match(card.className, /border/, 'the card is outlined')
  }
  assert.match(
    cards()[0].parentElement!.className,
    /bg-chat-background/,
    'the canvas is the conversation surface'
  )
  assert.match(cards()[0].className, /bg-popover/, 'a card is a raised sheet on it')
  assert.deepEqual(
    headers().map((header) => header.getAttribute('aria-expanded')),
    ['false', 'false', 'false'],
    'every file starts folded'
  )

  await click(headers()[0])
  assert.equal(headers()[0].getAttribute('aria-expanded'), 'true', 'a header opens its file')
  assert.ok(cards()[0].querySelector('div.border-t'), 'an open card carries its body')
  await click(headers()[0])
  assert.equal(headers()[0].getAttribute('aria-expanded'), 'false')
  assert.equal(cards()[0].querySelector('div.border-t'), null, 'a folded card is only its header')

  const unfoldAll = container.querySelector<HTMLButtonElement>('button[aria-label="展开全部"]')!
  await click(unfoldAll)
  assert.deepEqual(
    headers().map((header) => header.getAttribute('aria-expanded')),
    ['true', 'true', 'true']
  )
  const foldAll = container.querySelector<HTMLButtonElement>('button[aria-label="折叠全部"]')!
  await click(foldAll)
  assert.deepEqual(
    headers().map((header) => header.getAttribute('aria-expanded')),
    ['false', 'false', 'false']
  )

  // Opening one file by hand, then switching to another tab and back: it stays open.
  await click(headers()[1])
  await act(async () => {
    root.unmount()
  })
  await mount()
  assert.deepEqual(
    headers().map((header) => header.getAttribute('aria-expanded')),
    ['false', 'true', 'false'],
    'a file opened by hand is still open after the tab was left and re-entered'
  )
  assert.equal(useDiffStore.getState().visible[CWD], 'src/new.ts', 'the card in view is what the column marks')

  await scrollTo(450)
  // 400px of viewport centred on the offset: the middle sits inside the third card.
  assert.equal(useDiffStore.getState().visible[CWD], 'src/work.ts', 'the column follows the reading')

  await act(async () => {
    root.unmount()
  })
  await mount()
  assert.equal(region().scrollTop, 450, 'the reading position is restored with the tab')
  assert.equal(useDiffStore.getState().visible[CWD], 'src/work.ts', 'and so is the marked row')

  await scrollTo(600)
  await act(async () => { await useDiffStore.getState().loadWorktreePatch(CWD, 'all') })
  await pump()
  assert.equal(region().scrollTop, 600, 'a patch refresh restores the latest reading position, not the mount snapshot')

  // Clicking a row in the review column reveals one file only; the rest fold away.
  await act(async () => {
    useDiffStore.getState().focusPath(CWD, 'src/work.ts')
  })
  await pump()
  assert.deepEqual(
    headers().map((header) => header.getAttribute('aria-expanded')),
    ['false', 'false', 'true'],
    'the revealed file is the only open one'
  )
  assert.equal(useDiffStore.getState().focus, null, 'the request is consumed rather than kept as a mode')
  assert.equal(
    Math.round(cards()[2].getBoundingClientRect().top - region().getBoundingClientRect().top),
    0,
    'the revealed card is put at the top of the canvas'
  )

  // The same component instance can move between worktrees. A reveal consumed by the old canvas must
  // not suppress restoration for the new one, and each cwd keeps its own offset.
  rememberScrollTop(patchKey(CWD, 'all'), 90)
  rememberScrollTop(patchKey(OTHER_CWD, 'all'), 260)
  await act(async () => {
    sessionState.openTabs = [{ id: `diff:${OTHER_CWD}`, cwd: OTHER_CWD, kind: 'diff', diffScope: 'all' }]
    root.render(createElement(ChangesView, { cwd: OTHER_CWD }))
  })
  await pump()
  assert.equal(region().scrollTop, 260, 'a new cwd restores even after the previous canvas revealed a file')
  await act(async () => {
    sessionState.openTabs = [{ id: `diff:${CWD}`, cwd: CWD, kind: 'diff', diffScope: 'all' }]
    root.render(createElement(ChangesView, { cwd: CWD }))
  })
  await pump()
  assert.equal(region().scrollTop, 90, 'switching back restores the first cwd independently')

  // Once a focused path disappears from the current sections, its alignment loop is cancelled rather
  // than spending the deadline polling a card that can no longer mount.
  await act(async () => { useDiffStore.getState().focusPath(CWD, 'src/work.ts') })
  await pump()
  assert.ok(frames.size > 0, 'a reveal keeps a frame while its layout settles')
  await act(async () => {
    useDiffStore.setState((state) => {
      const current = state.worktrees[CWD]!
      const currentDiff = current.diff!
      return {
        worktrees: {
          ...state.worktrees,
          [CWD]: {
            ...current,
            diff: {
              ...currentDiff,
              unstaged: currentDiff.unstaged.filter((entry) => entry.path !== 'src/work.ts'),
              all: currentDiff.all.filter((entry) => entry.path !== 'src/work.ts')
            }
          }
        }
      }
    })
  })
  await pump()
  assert.equal(frames.size, 0, 'removing the reveal target cancels its pending RAF immediately')
  await act(async () => { await useDiffStore.getState().loadWorktree(CWD) })
  await pump()

  // A card may miss the first commit or lazy mount. One absent frame is tolerated and alignment resumes
  // when the element appears on the next frame.
  await act(async () => {
    sessionState.openTabs = [{ id: `diff:${OTHER_CWD}`, cwd: OTHER_CWD, kind: 'diff', diffScope: 'all' }]
    root.render(createElement(ChangesView, { cwd: OTHER_CWD }))
  })
  await pump()
  const originalGetElementById = document.getElementById.bind(document)
  let hideTarget = true
  document.getElementById = ((id: string) =>
    hideTarget && id === 'diff-section:src/work.ts' ? null : originalGetElementById(id)
  ) as typeof document.getElementById
  await act(async () => { useDiffStore.getState().focusPath(OTHER_CWD, 'src/work.ts') })
  await pump()
  await flushFrame()
  assert.ok(frames.size > 0, 'a missing element keeps a bounded reveal pending')
  hideTarget = false
  await flushFrame()
  assert.equal(
    Math.round(cards()[2].getBoundingClientRect().top - region().getBoundingClientRect().top),
    0,
    'the reveal completes when the target appears after one frame'
  )
  document.getElementById = originalGetElementById
  await act(async () => {
    sessionState.openTabs = [{ id: `diff:${CWD}`, cwd: CWD, kind: 'diff', diffScope: 'all' }]
    root.render(createElement(ChangesView, { cwd: CWD }))
  })
  await pump()

  // Folding the revealed file by hand and leaving the tab must not replay the reveal on the way back.
  await click(headers()[2])
  await act(async () => {
    root.unmount()
  })
  await mount()
  assert.deepEqual(
    headers().map((header) => header.getAttribute('aria-expanded')),
    ['false', 'false', 'false'],
    'a consumed reveal is not replayed on the next visit'
  )

  // The toolbar's control switches the tab's scope, not a filter inside the tab: the canvas then holds
  // only that side's files and the bridge is asked for that side's diff, while the tab's title (the
  // store's business) names the same group.
  const openScope = async (scope: string) => {
    await act(async () => {
      sessionState.openTabs = [
        { id: `diff:${CWD}`, cwd: CWD, kind: 'diff', diffScope: scope }
      ]
      useDiffStore.setState({ expanded: {} })
    })
    await mount()
  }

  await openScope('staged')
  assert.deepEqual(
    cards().map((card) => card.id),
    ['diff-section:src/staged.ts'],
    '已暂存 lists only the index side'
  )
  assert.equal(readScopes.at(-1), 'staged', 'and reads the index diff rather than the worktree one')
  assert.match(container.textContent ?? '', /1 个更改/, 'the count follows the scope')

  await act(async () => {
    root.unmount()
  })
  await openScope('unstaged')
  assert.deepEqual(
    cards().map((card) => card.id),
    ['diff-section:src/work.ts', 'diff-section:src/new.ts'],
    '未提交 lists the worktree side, untracked files included'
  )
  assert.equal(readScopes.at(-1), 'unstaged')

  await act(async () => {
    root.unmount()
  })
  await openScope('all')
  assert.equal(cards().length, 3, '全部变更 lists every path once')
  assert.equal(readScopes.at(-1), 'all')

  // App keeps the same component instance while switching diff tabs/scopes. A cached patch can stay
  // ready throughout, so scopeKey itself has to trigger consumption of the new saved offset.
  rememberScrollTop(patchKey(CWD, 'staged'), 120)
  await act(async () => {
    sessionState.openTabs = [{ id: `diff:${CWD}`, cwd: CWD, kind: 'diff', diffScope: 'staged' }]
    root.render(createElement(ChangesView, { cwd: CWD }))
  })
  await pump()
  assert.equal(region().scrollTop, 120, 'a reused instance restores the new scope without another IPC transition')
  await act(async () => {
    sessionState.openTabs = [{ id: `diff:${CWD}`, cwd: CWD, kind: 'diff', diffScope: 'all' }]
    root.render(createElement(ChangesView, { cwd: CWD }))
  })
  await pump()

  // Untracked contents are read per card: nothing asks for them until one is opened, and asking twice
  // for the same card reads once.
  assert.deepEqual(readPaths, [], 'a mounted canvas reads no untracked file on its own')
  await act(async () => {
    await useDiffStore.getState().loadUntrackedFile(CWD, 'src/new.ts')
    await useDiffStore.getState().loadUntrackedFile(CWD, 'src/new.ts')
  })
  assert.deepEqual(readPaths, ['src/new.ts'], 'asking twice reads once')
  assert.deepEqual(useDiffStore.getState().untracked[CWD]?.['src/new.ts'], {
    kind: 'text',
    contents: 'export const fresh = true\n',
    lines: 1
  })
  // The count comes back with those bytes: the row is numbered from the read, not from a refresh.
  const counted = (path: string) =>
    useDiffStore
      .getState()
      .worktrees[CWD]?.diff?.all.find((entry) => entry.path === path)
  assert.deepEqual(
    { additions: counted('src/new.ts')?.additions, deletions: counted('src/new.ts')?.deletions },
    { additions: 1, deletions: 0 },
    'the read fills in the untracked row it read'
  )

  // A refresh that lands while a card's bytes are still in the air: those bytes describe the worktree
  // as it was, so they are dropped rather than written over the fresher lists, the card reads again
  // instead of being refused for the read that is already running, and it does not wait for an edit.
  await act(async () => {
    useDiffStore.setState({ untracked: {} })
    holdReads = true
    void useDiffStore.getState().loadUntrackedFile(CWD, 'src/new.ts')
  })
  assert.deepEqual(readPaths, ['src/new.ts', 'src/new.ts'], 'the card reads the file it shows')
  await act(async () => {
    await useDiffStore.getState().loadWorktreePatch(CWD, 'all')
  })
  await act(async () => {
    heldReads.shift()?.({ kind: 'text', contents: 'stale bytes\n', lines: 42 })
  })
  assert.equal(
    useDiffStore.getState().untracked[CWD]?.['src/new.ts'],
    undefined,
    'a response from before the refresh is not written'
  )
  assert.equal(counted('src/new.ts')?.additions, 1, 'nor does it number the row from the old bytes')
  assert.deepEqual(
    readPaths,
    ['src/new.ts', 'src/new.ts', 'src/new.ts'],
    'and the card reads again rather than waiting for the next edit'
  )
  await act(async () => {
    heldReads.shift()?.({ kind: 'text', contents: 'export const newer = true\n', lines: 1 })
  })
  assert.deepEqual(
    useDiffStore.getState().untracked[CWD]?.['src/new.ts'],
    { kind: 'text', contents: 'export const newer = true\n', lines: 1 },
    'what the card shows is the read that came after the refresh'
  )

  // A worktree that went away cannot be brought back by a response that was already on its way.
  await act(async () => {
    useDiffStore.setState({ untracked: {} })
    void useDiffStore.getState().loadUntrackedFile(CWD, 'src/new.ts')
    useDiffStore.getState().forgetWorktree(CWD)
  })
  await act(async () => {
    heldReads.shift()?.({ kind: 'text', contents: 'ghost bytes\n', lines: 7 })
  })
  assert.equal(CWD in useDiffStore.getState().untracked, false, 'a forgotten worktree stays forgotten')
  assert.equal(readPaths.length, 4, 'and nothing reads for it again')
  holdReads = false

  // A read main refused is kept as a failure with main's own words, not dressed up as a file that is not
  // there: the card says what happened.
  await act(async () => {
    useDiffStore.setState({ untracked: {} })
    readFailure = new Error(
      "Error invoking remote method 'diff:read-untracked': Error: EACCES: permission denied, open '/project/src/new.ts'"
    )
    await useDiffStore.getState().loadUntrackedFile(CWD, 'src/new.ts')
  })
  assert.deepEqual(
    useDiffStore.getState().untracked[CWD]?.['src/new.ts'],
    { kind: 'failed', message: "EACCES: permission denied, open '/project/src/new.ts'" },
    'a rejected read keeps what main said'
  )
  const sections = buildSections(
    diff,
    { git: true, patch: PATCH, truncated: false },
    'all',
    useDiffStore.getState().untracked[CWD] ?? {}
  )
  const failed = sections.find((section) => section.entry.path === 'src/new.ts')
  assert.equal(failed?.note, 'failed', 'and the card has a note to show it')
  assert.match(failed?.message ?? '', /EACCES/, 'carrying the reason')
  readFailure = null

  // Git listed a path the parser did not hand back: the card says the change could not be parsed instead of
  // showing the text for a file that has nothing in it.
  await act(async () => {
    patchOverride = PATCH.slice(0, PATCH.indexOf('diff --git a/src/work.ts'))
  })
  await openScope('all')
  const unparsed = cards().find((card) => card.id === 'diff-section:src/work.ts')
  observeImmediately = true
  await click(unparsed?.querySelector('button') ?? undefined)
  await pump()
  assert.match(
    unparsed?.textContent ?? '',
    /无法解析此文件的变更/,
    'a path the patch does not cover is not reported as an empty diff'
  )
  patchOverride = null

  await act(async () => {
    root.unmount()
  })
}

if (process.argv[2] === '--changes-view-fixture') {
  await runFixture()
} else {
  test('changes view: every file is its own collapsible card', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--changes-view-fixture'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe'
    })
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
    }
  })
}

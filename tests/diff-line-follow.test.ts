/**
 * Following a diff row into the file it came from.
 *
 * The diff card has to offer the follow only for a row that exists in the file as it is now, and it has
 * to name the row the pointer is actually on rather than the one it came from. The library is mocked
 * here the way the other diff fixtures mock it — the wiring is what is being pinned, not Shiki — and the
 * mock plays the interaction manager's part: it hands the surface's own callbacks to the case, which
 * drives them the way the library does, from outside React rather than during a render.
 *
 * Each case runs in its own process, like the other component fixtures: the bridge is bound once per
 * process by whichever test file imports a store first, so a stub installed here has to stay out of
 * everyone else's.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { FileReadResult, SessionApi } from '../src/shared/api'

const CWD = '/project'
const PATH = 'src/work.ts'

/** A diff the library would hand over for one hunk with an addition and a deletion. */
const FILE_DIFF = { name: PATH, hunks: [] }

/** The row the pointer is on, as the interaction manager reports it. */
interface HoveredLine {
  lineNumber: number
  side: 'deletions' | 'additions'
}

/** The surface's own interaction options, which the case drives the way the library does. */
interface SurfaceOptions {
  enableGutterUtility?: boolean
  onLineEnter?: (line: { lineNumber: number; annotationSide: HoveredLine['side'] }) => void
  onLineLeave?: () => void
}

async function fixture(name: string, hoveredLine: HoveredLine): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  const api: Partial<SessionApi> = {
    readFile: async (): Promise<FileReadResult> => ({ kind: 'text', contents: 'a\nb\nc\n', mtimeMs: 1, size: 6 })
  }
  Object.defineProperty(globalThis, 'window', { value: { api }, configurable: true })

  // One surface is mounted, so its options and the row the pointer is on are handed to the case once.
  const surface: { options?: SurfaceOptions } = {}
  const { mock } = await import('bun:test')
  mock.module('@pierre/diffs/react', () => ({
    FileDiff: ({
      fileDiff,
      options,
      renderGutterUtility
    }: {
      fileDiff: unknown
      options: SurfaceOptions
      renderGutterUtility?: (getHoveredLine: () => unknown) => unknown
    }) => {
      surface.options = options
      const drawn = renderGutterUtility ? renderGutterUtility(() => hoveredLine) : null
      return createElement('div', { 'data-diff': (fileDiff as { name: string }).name }, drawn as never)
    },
    Virtualizer: ({ children }: { children: unknown }) => createElement('div', null, children as never)
  }))

  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const DiffBody = (await import('../src/renderer/src/components/diff/DiffBody')).default
  const { useFilesStore } = await import('../src/renderer/src/stores/files')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  const opened: string[] = []
  useSessionsStore.setState({
    openFileTab: async (cwd: string, path: string) => {
      opened.push(`${cwd}\u0000${path}`)
    }
  } as never)

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(DiffBody, {
        cwd: CWD,
        path: PATH,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileDiff: FILE_DIFF as any,
        style: 'unified',
        scroll: false
      })
    )
  })

  try {
    assert.ok(surface.options, 'the surface was configured')
    assert.equal(surface.options.enableGutterUtility, true, 'the utility is switched on')

    // The pointer moves onto a row, which is what makes the affordance worth drawing at all.
    const enter = () =>
      act(async () => {
        surface.options?.onLineEnter?.({ lineNumber: hoveredLine.lineNumber, annotationSide: hoveredLine.side })
      })
    const drawn = () => container.querySelector('button[aria-label]')

    await enter()
    if (name === 'offer') {
      const button = drawn()
      assert.ok(button, 'an addition row carries the affordance')
      assert.match(button.getAttribute('aria-label') ?? '', /line 7/)
      assert.equal(
        container.querySelectorAll('button[aria-label]').length,
        1,
        'one affordance, not one per row'
      )
      return
    }

    if (name === 'deletion') {
      // A deletion's number belongs to the file as it was, so the surface draws nothing for it.
      assert.equal(drawn(), null, 'a deletion row draws no follow')
      return
    }

    if (name === 'follow') {
      const button = drawn() as HTMLButtonElement | null
      assert.ok(button, 'the affordance is on screen')
      await act(async () => {
        button.click()
      })
      assert.deepEqual(opened, [`${CWD}\u0000${PATH}`], 'the tab for that file is asked for')
      assert.deepEqual(
        useFilesStore.getState().reveal,
        { cwd: CWD, path: PATH, line: 7, token: 1 },
        'the line waits for the tab'
      )
      return
    }

    if (name === 'leaves') {
      await enter()
      assert.ok(drawn(), 'the affordance is there while the pointer is on a row')
      await act(async () => {
        surface.options?.onLineLeave?.()
      })
      assert.equal(drawn(), null, 'and it goes when the pointer leaves')
      return
    }

    throw new Error(`unknown case ${name}`)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--diff-follow-fixture') {
  // The row the pointer is on arrives as an argument, so the case is spelled out where it is run.
  const hoveredLine = JSON.parse(process.argv[4] ?? '') as HoveredLine
  await fixture(process.argv[3] ?? 'offer', hoveredLine)
} else {
  const cases: [string, string, HoveredLine][] = [
    ['offer', 'a diff row offers a follow only where the file has that line', { lineNumber: 7, side: 'additions' }],
    ['deletion', 'a deletion row carries no follow', { lineNumber: 4, side: 'deletions' }],
    ['follow', 'following a row asks for the tab and the line together', { lineNumber: 7, side: 'additions' }],
    ['leaves', 'the follow goes away when the pointer leaves the row', { lineNumber: 7, side: 'additions' }]
  ]
  for (const [name, description, hoveredLine] of cases) {
    test(description, async () => {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, '--diff-follow-fixture', name, JSON.stringify(hoveredLine)],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stdout + stderr)
    })
  }
}

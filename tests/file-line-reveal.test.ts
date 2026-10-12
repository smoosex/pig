/**
 * The line a file tab lands on when a diff row is followed into it.
 *
 * The request is not the tab's own state: it waits in the file store until there is an editor to tell, so
 * the tab has to take it, hand the line over, and let go of it — otherwise leaving the tab and coming back
 * would jump again. The waiting matters for a tab that was only just opened, whose surface and editor do
 * not exist yet when the request arrives, and for one whose surface a document refresh replaced while the
 * request was still queued: an editor the library has already cleaned up cannot be told anything, so the
 * request has to stay until the replacement reports in. A document that settled into something an editor
 * cannot hold has its request dropped rather than left for the next reader of that tab.
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

/** One stubbed editor: what it was told, and whether the library still has it. */
interface EditorCall {
  focused: { lineNumber: number }[]
  live: boolean
  focus: (options: { lineNumber: number }) => void
}

async function fixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  // The document is a plain text file, except in the case that asks what a refusal does to a request.
  // The one case that needs a refresh in flight holds every read after the first open, so the request
  // can arrive while the document is loading and the surface it was read for is on its way out.
  const readable = name !== 'unreadable'
  let opens = 0
  const held: (() => void)[] = []
  const api: Partial<SessionApi> = {
    readFile: async (): Promise<FileReadResult> => {
      opens += 1
      if (name === 'refreshed' && opens > 1) await new Promise<void>((resolve) => held.push(resolve))
      return readable
        ? { kind: 'text', contents: 'a\nb\nc\n', mtimeMs: 1, size: 6 }
        : { kind: 'missing' }
    },
    onDiffChanged: () => () => {}
  }
  Object.defineProperty(globalThis, 'window', { value: { api }, configurable: true })

  // Each surface mounts its own editor, and one the library has cleaned up answers nothing — which is
  // what makes a reveal spent on a replaced surface disappear rather than land.
  const focused: { lineNumber: number }[] = []
  const editors: unknown[] = []
  const attach = (): EditorCall => {
    const instance: EditorCall = {
      focused,
      live: true,
      focus: (options: { lineNumber: number }) => {
        // An editor the library has cleaned up answers nothing, which is what makes a reveal spent on a
        // replaced surface disappear instead of landing.
        if (instance.live) focused.push(options)
      }
    }
    return instance
  }
  const { mock } = await import('bun:test')
  mock.module('@pierre/diffs/edit', () => ({ Editor: class {} }))
  mock.module('@pierre/diffs/react', () => ({
    EditProvider: ({ children }: { children?: unknown }) =>
      React.createElement('div', null, children as never),
    Virtualizer: ({ children }: { children?: unknown }) => React.createElement('div', null, children as never),
    // The surface hands the tab's editor options through, and reports the editor it created the way the
    // library does once it has one rendering. A surface that goes away takes its editor with it.
    File: (props: { editorOptions?: { onAttach?: (editor: unknown) => void } }) => {
      // One editor per surface, so a surface that goes away takes a live one with it.
      const instance = React.useRef(attach())
      editors.push('mount')
      React.useEffect(() => {
        props.editorOptions?.onAttach?.(instance.current)
        return () => {
          instance.current.live = false
        }
      }, [])
      return React.createElement('div', { 'data-file': '' })
    }
  }))
  const React = await import('react')
  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const FileView = (await import('../src/renderer/src/components/files/FileView')).default
  const { useFilesStore } = await import('../src/renderer/src/stores/files')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  useSettingsStore.setState({ localeSetting: 'en', locale: 'en' })

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const mount = async (target = root) => {
    await act(async () => {
      target.render(createElement(FileView, { cwd: CWD, path: PATH }))
    })
    // The document is read, and the surface reports the editor it created.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }
  await mount()

  try {
    if (name === 'landed') {
      assert.equal(focused.length, 0, 'nothing is focused until a row is followed')
      await act(async () => {
        useFilesStore.getState().revealLine(CWD, PATH, 3)
      })
      assert.deepEqual(focused, [{ lineNumber: 3 }], 'the editor is told the line')
      assert.equal(useFilesStore.getState().reveal, null, 'the request is let go of')
      return
    }

    if (name === 'replayed') {
      await act(async () => {
        useFilesStore.getState().revealLine(CWD, PATH, 3)
      })
      assert.equal(focused.length, 1, 'the follow lands once')
      // Coming back to the tab is a fresh mount of the surface, and the request is already gone.
      await act(async () => {
        root.unmount()
      })
      const again = createRoot(container)
      await act(async () => {
        again.render(createElement(FileView, { cwd: CWD, path: PATH }))
      })
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
      }
      assert.equal(focused.length, 1, 'returning to the tab does not jump again')
      await act(async () => {
        again.unmount()
      })
      return
    }

    if (name === 'deferred') {
      // The tab was only just opened: the request is already waiting when the surface mounts, and the
      // editor it creates is the one that gets told.
      await act(async () => {
        useFilesStore.getState().revealLine(CWD, PATH, 2)
      })
      const fresh = createRoot(container)
      await act(async () => {
        fresh.render(createElement(FileView, { cwd: CWD, path: PATH }))
      })
      for (let i = 0; i < 4; i += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
      }
      assert.deepEqual(focused, [{ lineNumber: 2 }], 'the waiting request lands once there is an editor')
      assert.equal(useFilesStore.getState().reveal, null, 'and it is let go of')
      await act(async () => {
        fresh.unmount()
      })
      return
    }

    if (name === 'refreshed') {
      // A change event arrives while the request is waiting: the document goes back to loading, the
      // surface and its editor are replaced, and only the replacement can be told the line.
      const reading = useFilesStore.getState().reloadDocument(CWD, PATH)
      // The document is loading and the surface it was read for is on its way out before the request
      // arrives, which is the order a change event and a click produce.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await act(async () => {
        useFilesStore.getState().revealLine(CWD, PATH, 3)
      })
      assert.deepEqual(focused, [], 'nothing is told while the document is still loading')
      assert.ok(useFilesStore.getState().reveal, 'the request is still waiting')
      await act(async () => {
        held.splice(0).forEach((release) => release())
        await reading
      })
      assert.deepEqual(
        focused,
        [{ lineNumber: 3 }],
        'the request lands on the editor the replacement surface created'
      )
      assert.equal(useFilesStore.getState().reveal, null, 'and it is let go of')
      return
    }

    if (name === 'unreadable') {
      assert.equal(useFilesStore.getState().documents[`${PATH}\u0000${CWD}`]?.status, 'ready')
      await act(async () => {
        useFilesStore.getState().revealLine(CWD, PATH, 3)
      })
      assert.deepEqual(focused, [], 'a file with no editor is not told a line')
      assert.equal(useFilesStore.getState().reveal, null, 'its request is dropped too')
      return
    }

    throw new Error(`unknown case ${name}`)
  } finally {
    container.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--file-reveal-fixture') {
  await fixture(process.argv[3] ?? 'landed')
} else {
  for (const [name, description] of Object.entries({
    landed: 'a followed row lands the editor on that line and lets the request go',
    replayed: 'returning to the tab does not jump again',
    deferred: 'a request that arrived before the surface lands on the editor it creates',
    refreshed: 'a request survives the surface a document refresh replaces',
    unreadable: 'a file with no editor drops the request instead of waiting'
  })) {
    test(description, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--file-reveal-fixture', name], {
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

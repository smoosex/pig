/**
 * The tree's field for a name, driven through the real menu.
 *
 * What this pins is the focus, which is the part that cannot be reasoned about from the source alone: a
 * Radix menu returns the focus to whatever it was opened from once it closes, and it closes *after* the
 * field it just opened has taken focus — so a field that does nothing about it is mounted, visible and
 * unable to be typed into. `onCloseAutoFocus` is what holds that return back, and this is the fixture
 * that says so.
 *
 * The rest is placement: a new folder leads the level, a new file follows the folders, and a rename
 * stands on the row it names.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { FileTreeEntry, SessionApi } from '../src/shared/api'

const CWD = '/project'

const file = (path: string): FileTreeEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'file',
  ignored: false
})

const folder = (path: string): FileTreeEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'directory',
  ignored: false
})

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: NoopResizeObserver, IntersectionObserver: undefined })
  Object.assign(window, { ResizeObserver: NoopResizeObserver, IntersectionObserver: undefined })

  /**
   * The worktree as the stub knows it: what has been made, renamed and trashed lands here, so a level
   * that is read again answers with the rows that actually exist rather than the ones it started with.
   */
  const listing = new Map<string, FileTreeEntry[]>([
    ['', [folder('src'), file('readme.md')]],
    ['src', [file('src/main.ts'), folder('src/deep')]]
  ])
  const reads: string[] = []
  const created: { kind: 'file' | 'directory'; path: string }[] = []
  const make = (path: string, kind: 'file' | 'directory'): FileTreeEntry => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind,
    ignored: false
  })
  const levelOf = (path: string): string => {
    const cut = path.lastIndexOf('/')
    return cut === -1 ? '' : path.slice(0, cut)
  }
  const entriesFor = (path: string): FileTreeEntry[] => listing.get(path) ?? []
  const renamed: { path: string; name: string }[] = []
  Object.assign(window, {
    api: {
      readDirectory: async (_cwd: string, path: string) => {
        reads.push(path)
        return { path, entries: entriesFor(path) }
      },
      onDiffChanged: () => () => {},
      createFile: async (_cwd: string, path: string) => {
        created.push({ kind: 'file', path })
        listing.set(levelOf(path), [...(listing.get(levelOf(path)) ?? []), make(path, 'file')])
        return { path }
      },
      createDirectory: async (_cwd: string, path: string) => {
        created.push({ kind: 'directory', path })
        listing.set(levelOf(path), [...(listing.get(levelOf(path)) ?? []), make(path, 'directory')])
        return { path }
      },
      renameEntry: async (_cwd: string, path: string, next: string) => {
        renamed.push({ path, name: next })
        const to = levelOf(path) ? `${levelOf(path)}/${next}` : next
        const level = levelOf(path)
        listing.set(
          level,
          (listing.get(level) ?? []).map((entry) => (entry.path === path ? { ...entry, name: next, path: to } : entry))
        )
        return { path: to }
      },
      copyPath: async () => {},
      trashEntry: async (_cwd: string, path: string) => {
        const level = levelOf(path)
        listing.set(level, (listing.get(level) ?? []).filter((entry) => entry.path !== path))
      },
      revealFileExternally: async () => {}
    } as unknown as SessionApi
  })

  const { act, createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { FileTree } = await import('../src/renderer/src/components/files/FileTree')
  const { useFilesStore } = await import('../src/renderer/src/stores/files')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  const { fileTabId } = await import('../src/renderer/src/stores/sessions/tabs-slice')
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })

  const opened: string[] = []
  const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
  useSessionsStore.setState({
    openTabs: [
      { id: fileTabId(CWD, 'readme.md'), cwd: CWD, path: 'readme.md', title: 'readme.md', kind: 'file', loadState: 'ready' }
    ],
    activeTabId: fileTabId(CWD, 'readme.md'),
    openFileTab: async (cwd: string, path: string) => {
      opened.push(`${cwd}\u0000${path}`)
    }
  } as never)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(h(FileTree, { cwd: CWD }))
  })

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  await flush()

  /** Right-clicks the row whose title is this name, and runs the menu item with that label. */
  const openMenu = async (rowTitle: string, label: string) => {
    const rows = [...host.querySelectorAll<HTMLButtonElement>('button[title]')]
    const row = rows.find((item) => item.getAttribute('title') === rowTitle)
    assert.ok(row, `the tree shows ${rowTitle}`)
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    await flush()
    // Only the menu that is actually open: a content node that is closing is still in the document for
    // a tick, and a click aimed at it is a click nobody hears.
    const open = [...document.querySelectorAll<HTMLElement>('[data-slot="context-menu-content"][data-state="open"]')]
    assert.equal(open.length, 1, 'exactly one menu is open')
    const item = [...open[0]!.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].find((node) =>
      node.textContent?.includes(label)
    )
    assert.ok(item, `the menu offers ${label}`)
    await act(async () => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()
  }

  const field = (): HTMLInputElement => {
    const input = host.querySelector<HTMLInputElement>('input')
    assert.ok(input, 'the field is on screen')
    return input
  }
  /**
   * The tree as the reader sees it, with the field standing in for the row it is on. The field's own row
   * is a div rather than a button, so asking a listing by title alone would leave it out entirely — and
   * where that field sits among the others is the whole point of the placement cases.
   */
  const rowNames = (): string[] => {
    const rows = [...host.querySelectorAll<HTMLElement>('button[title], input')]
    return rows.map((item) =>
      item instanceof HTMLInputElement ? '' : item.getAttribute('title') ?? ''
    )
  }
  const type = async (value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(field(), value)
      field().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = async (key: string) => {
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
    await flush()
  }

  try {
    if (name === 'new-file-focus') {
      await openMenu('src', '新建文件')
      const input = field()
      assert.equal(document.activeElement, input, 'the field takes the focus the menu gave up')
      assert.equal(input.value, '', 'a new file starts with no name')
      await type('thing.ts')
      await press('Enter')
      assert.deepEqual(created, [{ kind: 'file', path: 'src/thing.ts' }])
      assert.deepEqual(opened, [`${CWD}\u0000src/thing.ts`], 'the new file opens in its own tab')
      return
    }

    if (name === 'new-folder-focus') {
      await openMenu('src', '新建文件夹')
      assert.equal(document.activeElement, field(), 'the field takes the focus here too')
      await type('nested')
      await press('Enter')
      assert.deepEqual(created, [{ kind: 'directory', path: 'src/nested' }])
      // The level it was made in is opened so the reader can see what they just made.
      assert.equal(useFilesStore.getState().expanded[CWD]?.['src/nested'], true)
      return
    }

    if (name === 'rename-focus') {
      await openMenu('readme.md', '重命名')
      const input = field()
      assert.equal(document.activeElement, input, 'the field takes the focus')
      assert.equal(input.value, 'readme.md', 'and starts on the name the row has')
      await type('notes.md')
      await press('Enter')
      assert.deepEqual(renamed, [{ path: 'readme.md', name: 'notes.md' }])
      return
    }

    if (name === 'created-row-shows') {
      // The row has to be on screen once the name is given: nothing tells the tree that a name it never
      // asked about has appeared, so the level it was made in has to be read again.
      await openMenu('src', '新建文件')
      await type('thing.ts')
      await press('Enter')
      assert.ok(
        rowNames().includes('src/thing.ts'),
        `the new file is on screen (saw ${JSON.stringify(rowNames())})`
      )
      return
    }

    if (name === 'renamed-row-shows') {
      await openMenu('readme.md', '重命名')
      await type('notes.md')
      await press('Enter')
      const names = rowNames()
      assert.ok(names.includes('notes.md'), `the new name is on screen (saw ${JSON.stringify(names)})`)
      assert.ok(!names.includes('readme.md'), 'and the old one is gone')
      return
    }

    if (name === 'trashed-row-goes') {
      await openMenu('readme.md', '移到废纸篓')
      assert.ok(
        !rowNames().includes('readme.md'),
        `the row is gone from the tree (saw ${JSON.stringify(rowNames())})`
      )
      return
    }

    if (name === 'empty-space') {
      // The space below the last row answers for the worktree itself, so a folder can be made at the root
      // without right-clicking a folder that happens to be there.
      const spacer = host.querySelector<HTMLElement>('div.min-h-8')
      assert.ok(spacer, 'the tree leaves a space under its rows')
      await act(async () => {
        spacer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
      })
      await flush()
      const open = [...document.querySelectorAll<HTMLElement>('[data-slot="context-menu-content"][data-state="open"]')]
      assert.equal(open.length, 1, 'exactly one menu is open')
      const labels = [...open[0]!.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].map(
        (item) => item.textContent
      )
      // Nothing was right-clicked, so there is no row to rename or move to the trash.
      assert.equal(labels.some((label) => label?.includes('重命名')), false, 'no row, nothing to rename')
      assert.equal(labels.some((label) => label?.includes('移到废纸篓')), false, 'and nothing to trash')
      const folder = [...open[0]!.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].find((item) =>
        item.textContent?.includes('新建文件夹')
      )
      assert.ok(folder, 'a folder can be made at the root')
      await act(async () => {
        folder.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await flush()
      const input = field()
      assert.equal(document.activeElement, input, 'and its field is focused')
      await type('top')
      await press('Enter')
      assert.deepEqual(created, [{ kind: 'directory', path: 'top' }], 'made at the worktree root')
      return
    }

    if (name === 'placement') {
      await openMenu('src', '新建文件')
      // src holds a file and a folder: the field goes above the file that leads it, folders after.
      assert.equal(rowNames()[0], 'src')
      assert.equal(rowNames()[1], '', 'a new file follows the folders, so it leads the files')
      assert.equal(field().value, '')
      await press('Escape')
      assert.equal(host.querySelector('input'), null, 'Escape closes the field')

      await openMenu('src', '新建文件夹')
      assert.deepEqual(rowNames().slice(0, 3), ['src', '', 'src/main.ts'], 'a new folder leads the level')
      return
    }

    throw new Error(`unknown fixture: ${name}`)
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    await GlobalRegistrator.unregister()
  }
}

if (process.argv.includes('--file-tree-fixture')) {
  await runFixture(process.argv[process.argv.indexOf('--file-tree-fixture') + 1]!)
} else {
  for (const [name, description] of Object.entries({
    'new-file-focus': 'a new file is typed into without touching the field first',
    'new-folder-focus': 'a new folder is typed into without touching the field first',
    'rename-focus': 'a rename is typed into without touching the field first',
    placement: 'a new folder leads the level and a new file follows the folders',
    'created-row-shows': 'a file that was just made shows up in the tree',
    'renamed-row-shows': 'a renamed row takes its new name on screen',
    'trashed-row-goes': 'a row that was trashed leaves the tree',
    'empty-space': 'the space below the rows offers the worktree itself'
  })) {
    test(description, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--file-tree-fixture', name], {
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

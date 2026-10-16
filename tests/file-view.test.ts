/**
 * The file tab against a stubbed bridge and a stubbed editor: what the editable surface is handed when
 * the tab switches. The editor reads its bytes once, when its surface mounts, so the surface's identity —
 * not the header — decides which file is being typed into. Revision numbers count from zero inside each
 * document, so two files that were each read once both sit at 1: a surface keyed by the revision alone
 * hands the tab it comes back to the editor of the file it left, and the next ⌘S writes those bytes over
 * it. The editor itself is stubbed because happy-dom cannot lay one out; what matters here is the file
 * object the surface was given, which is exactly what the store and the remount key produce.
 *
 * Each case runs in its own process, like the other store fixtures: the bridge is bound once per process
 * by whichever test file imports a store first, so a stub installed here has to stay out of everyone
 * else's.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { FileReadResult, SessionApi } from '../src/shared/api'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function runFixture(name: string): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

  let disk: Record<string, string> = { 'a.ts': 'AAA alpha\n', 'b.ts': 'BBB bravo\n', 'README.md': '# Title\n', 'docs/guide.md': '# Guide\n' }
  let stamps = { 'a.ts': 1, 'b.ts': 2, 'README.md': 4, 'docs/guide.md': 5 }
  let change: ((cwd: string) => void) | null = null
  const api: Partial<SessionApi> = {
    readFile: async (_cwd, path): Promise<FileReadResult> => {
      if (!(path in disk)) return { kind: 'missing' }
      return { kind: 'text', contents: disk[path], mtimeMs: stamps[path as keyof typeof stamps], size: disk[path].length }
    },
    onDiffChanged: (listener) => {
      change = listener
      return () => {}
    }
  }
  Object.defineProperty(window, 'api', { value: api, configurable: true })

  const React = await import('react')
  const { useSettingsStore } = await import('../src/renderer/src/stores/settings')
  // Component copy comes from the dictionary: pin it to the wording the assertions below spell out.
  useSettingsStore.setState({ localeSetting: 'zh-CN', locale: 'zh-CN' })
  const painted: { name: string; contents: string }[] = []
  const mounted: string[] = []
  const { mock } = await import('bun:test')
  mock.module('@pierre/diffs/edit', () => ({ Editor: class {} }))
  mock.module('../src/renderer/src/components/MarkdownText', () => ({
    // The preview's own link and image renderers are what this file tests, so the stub renders them.
    MarkdownText: (props: { text: string; overrides: Record<string, React.ElementType> }) => React.createElement('div', { 'data-rendered': '' },
      props.text,
      React.createElement(props.overrides.a, { href: './docs/guide.md' }, 'guide'),
      React.createElement(props.overrides.a, { href: 'https://example.com' }, 'site'),
      React.createElement(props.overrides.a, { href: '../outside.md' }, 'outside'),
      React.createElement(props.overrides.img, { src: 'docs/logo.png', alt: 'logo' }),
      React.createElement(props.overrides.a, { href: '#fn-1' }, 'note'),
      React.createElement('h2', null, 'Getting Started'),
      React.createElement(props.overrides.a, { href: '#getting-started' }, 'start'),
      React.createElement('li', { id: 'user-content-fn-1' }, 'footnote'))
  }))
  mock.module('@pierre/diffs/react', () => ({
    EditProvider: (props: { children?: unknown }) => React.createElement('div', null, props.children as never),
    Virtualizer: (props: { children?: unknown; className?: string }) =>
      React.createElement('div', { 'data-virtualizer': '', className: props.className }, props.children as never),
    File: (props: { file: { name: string; contents: string } }) => {
      painted.push({ name: props.file.name, contents: props.file.contents })
      React.useEffect(() => {
        mounted.push(props.file.name)
      }, [])
      return React.createElement('div', { 'data-file': props.file.name }, props.file.contents)
    }
  }))

  const { createRoot } = await import('react-dom/client')
  const { fileKey, useFilesStore } = await import('../src/renderer/src/stores/files')
  const { default: FileView } = await import('../src/renderer/src/components/files/FileView')

  const cwd = '/view'
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  const open = async (path: string) => {
    await React.act(async () => {
      root.render(React.createElement(FileView, { cwd, path }))
    })
    await settle(path)
  }
  const settle = async (path: string) => {
    for (let i = 0; i < 200; i++) {
      if (useFilesStore.getState().documents[fileKey(cwd, path)]?.status === 'ready') break
      await React.act(async () => {
        await sleep(5)
      })
    }
    await React.act(async () => {
      await sleep(5)
    })
  }
  const shown = () => painted.at(-1)

  if (name === 'switch') {
    await open('a.ts')
    assert.deepEqual(shown(), { name: 'a.ts', contents: 'AAA alpha\n' })

    await open('b.ts')
    assert.deepEqual(shown(), { name: 'b.ts', contents: 'BBB bravo\n' })

    // Back to a tab whose document is already in memory: no notice renders in between, so only the
    // surface's key decides whether the editor is rebuilt for that file or handed the old one.
    await open('a.ts')
    assert.deepEqual(
      shown(),
      { name: 'a.ts', contents: 'AAA alpha\n' },
      'the surface belongs to the file the tab names, not to whichever file was read last'
    )
    return
  }

  if (name === 'reload') {
    await open('a.ts')
    const before = mounted.length

    disk = { ...disk, 'a.ts': 'AAA alpha and more\n' }
    stamps = { ...stamps, 'a.ts': 3 }
    assert.ok(change, 'the store subscribes to worktree changes when a file tab mounts')
    await React.act(async () => {
      change!(cwd)
    })
    await settle('a.ts')

    assert.deepEqual(shown(), { name: 'a.ts', contents: 'AAA alpha and more\n' })
    assert.ok(mounted.length > before, 'bytes the editor has already taken are handed over as a new surface')
    return
  }

  if (name === 'refresh-failure') {
    const failing = new Set<string>()
    api.readFile = async (_cwd, path): Promise<FileReadResult> => {
      if (failing.has(path)) {
        throw new Error("Error invoking remote method 'files:read': Error: EACCES: permission denied")
      }
      if (!(path in disk)) return { kind: 'missing' }
      return { kind: 'text', contents: disk[path], mtimeMs: stamps[path as keyof typeof stamps], size: disk[path].length }
    }
    await open('a.ts')
    assert.doesNotMatch(container.textContent ?? '', /读取失败/)

    // The worktree changed and the read did not come back: main names only the worktree, so the tab says
    // what happened rather than calling this file changed — and offers no 覆盖, since nothing is known
    // about the bytes on disk.
    failing.add('a.ts')
    await React.act(async () => {
      change!(cwd)
    })
    await React.act(async () => {
      await sleep(5)
    })
    assert.match(container.textContent ?? '', /读取失败：EACCES: permission denied/)
    assert.match(container.textContent ?? '', /重新加载/)
    assert.doesNotMatch(container.textContent ?? '', /覆盖/)
    assert.deepEqual(shown(), { name: 'a.ts', contents: 'AAA alpha\n' }, 'the surface keeps the bytes it has')

    // Another file has its own document, and its own answer about it.
    await open('b.ts')
    assert.doesNotMatch(container.textContent ?? '', /读取失败/)

    // Asking again is the bar's own button. When that read fails too the tab says why and still offers
    // it: nothing about the file itself says it is unreadable, so the reader is not made to close it.
    await open('a.ts')
    const askAgain = [...container.querySelectorAll('button')].find((button) => button.textContent === '重新加载')
    assert.ok(askAgain, 'a refresh that failed can be asked for again')
    await React.act(async () => {
      askAgain.click()
      await sleep(5)
    })
    assert.match(container.textContent ?? '', /EACCES: permission denied/)
    assert.doesNotMatch(container.textContent ?? '', /覆盖/)

    disk = { ...disk, 'a.ts': 'AAA alpha again\n' }
    failing.delete('a.ts')
    const again = [...container.querySelectorAll('button')].find((button) => button.textContent === '重新加载')
    assert.ok(again, 'the failed read can be asked for again without closing the tab')
    await React.act(async () => {
      again.click()
    })
    await settle('a.ts')
    assert.deepEqual(shown(), { name: 'a.ts', contents: 'AAA alpha again\n' })
    return
  }

  if (name === 'open-failure') {
    let asked = 0
    api.openFileExternally = async () => {
      asked += 1
      throw new Error("Error invoking remote method 'files:open-externally': Error: 没有找到能打开它的程序")
    }
    await open('a.ts')
    const trigger = [...container.querySelectorAll('button')].find((button) => button.textContent === '打开方式…')
    assert.ok(trigger, 'the header hands the file to the desktop')
    await React.act(async () => {
      trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (node) => node.textContent === '用默认应用打开'
    )
    assert.ok(item, 'the menu opened')
    await React.act(async () => {
      // What a mouse does to a menu item: the press, the release, and then the click the browser sends
      // after them. Radix synthesizes that click only when the press did not happen, so leaving it out
      // would fire the item twice.
      for (const type of ['pointerdown', 'pointerup'] as const) {
        item.dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0 }))
      }
      item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await sleep(0)
    })
    assert.equal(asked, 1, 'the menu item asks main to open the file')
    assert.match(container.textContent ?? '', /打开失败：没有找到能打开它的程序/, 'a refusal that arrives late is still said')

    // The pane is not remounted when the tab switches, so the message has to leave with the file.
    await open('b.ts')
    assert.doesNotMatch(container.textContent ?? '', /打开失败/)
    return
  }

  if (name === 'markdown') {
    const preview = () => container.querySelector('[data-markdown-preview]')
    const editorHidden = () => container.querySelector('[data-virtualizer]')!.classList.contains('invisible')
    const button = () => container.querySelector<HTMLButtonElement>('[data-markdown-view-toggle]')!
    const toggle = (label: string) => {
      assert.equal(button().getAttribute('aria-label'), label, 'one button names the view it switches to')
      return button()
    }

    await open('a.ts')
    assert.equal(container.querySelector('[data-markdown-view-toggle]'), null, 'only markdown offers a preview')

    const { useSessionsStore } = await import('../src/renderer/src/stores/sessions')
    const { worktreeFileUrl } = await import('../src/shared/worktree-files')
    const followed: string[] = []
    useSessionsStore.setState({ openFileTab: async (_cwd, target) => { followed.push(target) } })

    await open('README.md')
    assert.ok(preview(), 'markdown opens on its preview')
    const link = (text: string) => [...preview()!.querySelectorAll('a')].find((a) => a.textContent === text)!
    assert.equal(preview()!.querySelector('img')!.getAttribute('src'), worktreeFileUrl(cwd, 'docs/logo.png'), 'images resolve against the file')
    assert.equal(link('site').getAttribute('target'), '_blank', 'only external links leave the app')
    assert.equal(link('guide').getAttribute('target'), null)
    await React.act(async () => { link('guide').click() })
    await React.act(async () => { link('outside').click() })
    assert.deepEqual(followed, ['docs/guide.md'], 'a relative link opens its file tab and a path out of the worktree does nothing')
    const scrolled: string[] = []
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id || this.textContent || '') }
    await React.act(async () => { link('note').click() })
    await React.act(async () => { link('start').click() })
    assert.deepEqual(scrolled, ['user-content-fn-1', 'Getting Started'], 'anchors land on an id first, then on a heading slug')
    assert.ok(editorHidden(), 'the editor stays laid out under the preview instead of leaving the layout')
    assert.ok(button().querySelector('.lucide-code'))
    const surfaces = mounted.length
    await React.act(async () => { toggle('查看源码').click() })
    assert.equal(preview(), null)
    assert.ok(!editorHidden())
    assert.ok(button().querySelector('.lucide-eye'), 'the icon follows the view')

    await React.act(async () => { useFilesStore.getState().setDraft(cwd, 'README.md', '# Edited\n') })
    await React.act(async () => { toggle('查看预览').click() })
    assert.ok(preview()!.textContent!.startsWith('# Edited\n'), 'the preview renders the unsaved draft')
    assert.equal(mounted.length, surfaces, 'switching views keeps the editor and its unsaved state mounted')

    await React.act(async () => { useFilesStore.getState().revealLine(cwd, 'README.md', 1) })
    assert.equal(preview(), null, 'a line reveal shows the source it lands in')
    await React.act(async () => { useFilesStore.getState().clearReveal() })
    assert.equal(preview(), null, 'and stays there once the reveal is done')

    await open('b.ts')
    await open('README.md')
    assert.equal(preview(), null, 'the chosen view belongs to the file')

    await open('docs/guide.md')
    assert.ok(preview(), 'another markdown file has its own choice')
    await React.act(async () => { toggle('查看源码').click() })
    await React.act(async () => { toggle('查看预览').click() })
    await open('README.md')
    assert.equal(preview(), null, 'choosing a view in one file leaves the others alone')
    return
  }

  throw new Error(`Unknown fixture: ${name}`)
}

if (process.argv[2] === '--file-view-fixture') {
  await runFixture(process.argv[3])
} else {
  for (const [name, description] of Object.entries({
    switch: 'a tab that comes back to an open file gives the surface that file\'s bytes',
    reload: 'an external change replaces the surface rather than editing the one already on screen',
    'refresh-failure': 'a refresh that could not read says so and offers only a retry',
    'open-failure': 'a file the desktop will not open reports the reason on the tab',
    markdown: 'markdown toggles between a preview of the draft and the mounted source editor'
  })) {
    test(`file view: ${description}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--file-view-fixture', name], {
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

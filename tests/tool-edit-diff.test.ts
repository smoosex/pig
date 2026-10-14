/**
 * The edit tool's diff in the process log is rendered by @pierre/diffs: the two blocks go through
 * jsdiff so the reader sees hunks with context instead of the whole block with its middle marked
 * deleted and re-added, and the body is fetched only once the step is opened.
 *
 * The library is mocked, so this pins the wiring — one parse per edit with both sides named after the
 * file, a single virtualized panel holding every parse, a marker only when the step carries several
 * edits — without standing up Shiki in happy-dom.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

const PATH = 'src/big.ts'

async function runFixture(): Promise<void> {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register({ url: 'http://localhost' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { api: { supportsGlass: false } })
  const { mock } = await import('bun:test')
  const parses: { old: unknown; next: unknown }[] = []
  const rendered: { name: string; from: string }[] = []
  const virtualizers: string[] = []
  mock.module('@pierre/diffs', () => ({
    // The process log pulls the shared highlighter in for read/write panels; the edit body below only
    // needs the parser, so the highlighter never gets asked to render anything here.
    getSharedHighlighter: async () => ({ codeToHtml: () => '' }),
    parseDiffFromFile: (oldFile: { name: string; contents: string }, newFile: { name: string; contents: string }) => {
      parses.push({ old: oldFile, next: newFile })
      return { name: oldFile.name, from: oldFile.contents, to: newFile.contents }
    }
  }))
  mock.module('@pierre/diffs/react', () => ({
    FileDiff: ({ fileDiff }: { fileDiff: { name: string; from: string; to: string } }) => {
      rendered.push(fileDiff)
      return createElement('div', { 'data-diff': fileDiff.name }, `${fileDiff.from}->${fileDiff.to}`)
    },
    Virtualizer: ({ children, className }: { children: unknown; className: string }) => {
      virtualizers.push(className)
      return createElement('div', { 'data-virtualizer': '' }, children as never)
    }
  }))
  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ToolRow } = await import('../src/renderer/src/components/turn/ToolDetails')
  const pump = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }
  // A remount needs its own container and root, so opening a step builds a fresh pair.
  const open = async (edits: { oldText: string; newText: string }[]) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ToolRow, { step: { id: 'edit-1', name: 'edit', args: { path: PATH, edits } } }))
    })
    const trigger = container.querySelector<HTMLButtonElement>('button')
    assert.ok(trigger, 'the step renders a disclosure')
    const before = rendered.length
    await act(async () => {
      trigger.click()
    })
    await pump()
    assert.ok(rendered.length > before, 'the diff is built only once the step is opened')
    return { container, root }
  }
  try {
    const two = await open([
      { oldText: 'one\ntwo', newText: 'one\nTWO' },
      { oldText: 'three', newText: 'three\nfour' }
    ])
    assert.equal(rendered.length, 2, 'one diff body per edit')
    assert.deepEqual(parses[0], {
      old: { name: PATH, contents: 'one\ntwo' },
      next: { name: PATH, contents: 'one\nTWO' }
    })
    assert.deepEqual(parses[1], {
      old: { name: PATH, contents: 'three' },
      next: { name: PATH, contents: 'three\nfour' }
    })
    assert.equal(virtualizers.length, 1, 'both edits share one scrolling panel')
    assert.match(virtualizers[0], /max-h-80/, 'the panel keeps the old height cap')
    const twoText = two.container.textContent ?? ''
    assert.match(twoText, /edit 1/)
    assert.match(twoText, /edit 2/)
    assert.match(twoText, /one\ntwo->one\nTWO/, 'the parsed diff reaches the body')
    await act(async () => {
      two.root.unmount()
    })

    const one = await open([{ oldText: 'one\ntwo', newText: 'one\nTWO' }])
    assert.equal(rendered.length, 3, 'the body is built for the second step too')
    assert.doesNotMatch(one.container.textContent ?? '', /edit 1/, 'a single edit needs no marker')
    assert.equal(one.container.querySelectorAll('[data-virtualizer]').length, 1, 'one panel per step')
    assert.equal(virtualizers.length, 2, 'the single-edit step still owns a panel')
    await act(async () => {
      one.root.unmount()
    })
  } finally {
    await GlobalRegistrator.unregister()
  }
}

if (process.argv[2] === '--tool-edit-diff-fixture') {
  await runFixture()
} else {
  test('process log: the edit diff is handed to @pierre/diffs when the step opens', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--tool-edit-diff-fixture'], {
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

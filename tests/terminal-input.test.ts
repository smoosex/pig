import { test } from 'bun:test'
import assert from 'node:assert/strict'

if (process.argv.includes('--terminal-input-fixture')) {
  const { mock } = await import('bun:test')
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  const { TERMINAL_MAX_WRITE, TERMINAL_COLS, TERMINAL_ROWS } = await import('../src/shared/terminal')
  let input!: (data: string) => void
  let binaryInput!: (data: string) => void
  let resizeObserver!: () => void
  let resizeListener!: (size: { cols: number; rows: number }) => void
  let measured = { cols: 4000, rows: 2000 }
  let terminal!: FakeTerminal
  const creates: number[][] = []
  const resizes: number[][] = []
  const binaryWrites: string[] = []
  Object.assign(globalThis, { ResizeObserver: class {
    constructor(callback: () => void) { resizeObserver = callback }
    observe() {}
    disconnect() {}
  } })
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 1 }
  const output: string[] = []
  const writes: string[] = []
  let rejectWrite = false
  class FakeTerminal {
    constructor() { terminal = this }
    unicode = { activeVersion: '' }
    element?: HTMLElement
    cols = 80
    rows = 24
    options = {}
    focuses = 0
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData(listener: (data: string) => void) { input = listener }
    onBinary(listener: (data: string) => void) { binaryInput = listener }
    onResize(listener: typeof resizeListener) { resizeListener = listener }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      resizeListener({ cols, rows })
    }
    open(element: HTMLElement) {
      this.element = element
      Object.defineProperties(element, { clientWidth: { value: 100 }, clientHeight: { value: 100 } })
    }
    write(data: string) { output.push(data) }
    focus() { this.focuses++ }
  }
  mock.module('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
  mock.module('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return measured } } }))
  mock.module('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
  mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
  mock.module('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} } }))
  mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: { subscribe() {} } }))
  mock.module('../src/renderer/src/ipc/api', () => ({ api: { terminal: {
    onEvent() {},
    create: async (_id: string, _cwd: string | null, cols: number, rows: number) => {
      creates.push([cols, rows])
      return {}
    },
    resize: async (_id: string, cols: number, rows: number) => { resizes.push([cols, rows]) },
    write: async (_id: string, data: string, binary?: boolean) => {
      if (binary) binaryWrites.push(data)
      assert.ok(data.length <= TERMINAL_MAX_WRITE)
      writes.push(data)
      if (rejectWrite) throw new Error('input rejected')
    }
  } } }))
  let fontLoads = 0
  let fontDelay: Promise<unknown[]> | null = null
  Object.defineProperty(document, 'fonts', { value: { load: async () => {
    if (++fontLoads === 1) throw new Error('font missing')
    return fontDelay ?? []
  } } })
  const { attachTerminal } = await import('../src/renderer/src/terminal/runtime')
  const host = document.createElement('div')
  document.body.append(host)
  const detach = attachTerminal('terminal:input', null, host)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.ok(terminal.element, 'a failed font load still opens the pane')
  assert.ok(output.some((line) => line.includes('font missing')), 'the font failure is visible')
  const maximum = [TERMINAL_COLS.max, TERMINAL_ROWS.max]
  assert.deepEqual(creates, [maximum], 'startup measurements are clamped before create')
  assert.deepEqual([terminal.cols, terminal.rows], maximum)
  measured = { cols: 80, rows: 24 }
  resizeObserver()
  assert.deepEqual(resizes.at(-1), [80, 24])
  measured = { cols: 8000, rows: 3000 }
  resizeObserver()
  assert.deepEqual(resizes.at(-1), maximum, 'subsequent resize remains within the IPC limits')
  assert.deepEqual([terminal.cols, terminal.rows], maximum, 'xterm and the PTY share the same size')
  measured = { cols: 1, rows: 0 }
  resizeObserver()
  assert.deepEqual(resizes.at(-1), [TERMINAL_COLS.min, TERMINAL_ROWS.min])

  const paste = 'x'.repeat(TERMINAL_MAX_WRITE - 1) + '🐷' + 'y'.repeat(TERMINAL_MAX_WRITE * 2)
  input(paste)
  input('next key')
  assert.equal(writes.slice(0, -1).join(''), paste)
  assert.equal(writes.at(-1), 'next key')
  assert.ok(writes.length > 3)
  for (const chunk of writes) {
    assert.ok(!/[\ud800-\udbff]$/.test(chunk), 'no dangling high surrogate')
    assert.ok(!/^[\udc00-\udfff]/.test(chunk), 'no dangling low surrogate')
  }
  rejectWrite = true
  input('rejected key')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(output.some((line) => line.includes('input rejected')), 'the operation failure is visible')
  rejectWrite = false
  input('still usable')
  assert.equal(writes.at(-1), 'still usable', 'an input rejection must not mark the shell ended')
  // Traditional X10 mouse encoding uses binary bytes above 127 for coordinates.
  const mouse = '\x1b[M' + String.fromCharCode(32, 200, 255)
  binaryInput(mouse)
  assert.deepEqual(binaryWrites, [mouse], 'onBinary is forwarded with its encoding flag')
  input('after mouse')
  assert.equal(writes.at(-1), 'after mouse')
  detach()
  const loadsBefore = fontLoads
  let finishFonts!: () => void
  fontDelay = new Promise((resolve) => { finishFonts = () => resolve([]) })
  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: TerminalPanel } = await import('../src/renderer/src/components/terminal/TerminalPanel')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(host)
  const renderPanel = (active: boolean) => root.render(createElement(TerminalPanel, {
    terminalId: 'terminal:retry', cwd: null, active, onFocus: () => {}
  }))
  await act(async () => { renderPanel(true) })
  const delayedTerminal = terminal
  assert.ok(fontLoads > loadsBefore, 'a rejected font load is not cached for later terminals')
  assert.equal(delayedTerminal.element, undefined, 'font loading is still pending')
  await act(async () => { renderPanel(false) })
  await act(async () => { finishFonts() })
  assert.ok(delayedTerminal.element, 'the inactive terminal still initializes')
  assert.equal(delayedTerminal.focuses, 0, 'finishing fonts must not focus the pane the user left')
  await act(async () => { renderPanel(true) })
  assert.equal(delayedTerminal.focuses, 1, 'explicitly returning to the pane still focuses it')
  await act(async () => { root.unmount() })
  GlobalRegistrator.unregister()
} else {
  test('terminal clamps measured sizes, forwards binary mouse events and chunks oversized pastes', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--terminal-input-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stdout + stderr)
  })
}

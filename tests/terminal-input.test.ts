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
  let keyHandler!: (event: KeyboardEvent) => boolean
  const clears: string[] = []
  const creates: number[][] = []
  let rejectCreate = false
  let receiveEvent!: (event: import('../src/shared/terminal').TerminalEvent) => void
  const acks: number[] = []
  let agentState!: (state: import('../src/shared/terminal-agent').TerminalAgentState) => void
  let streaming = true
  let abortFailure = false
  const aborted: string[] = []
  const released: string[][] = []
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
    cleared = 0
    clear() { this.cleared++ }
    loadAddon() {}
    attachCustomKeyEventHandler(handler: typeof keyHandler) { keyHandler = handler }
    onData(listener: (data: string) => void) { input = listener }
    onBinary(listener: (data: string) => void) { binaryInput = listener }
    resizeCallback?: typeof resizeListener
    onResize(listener: typeof resizeListener) { resizeListener = listener; this.resizeCallback = listener }
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
      this.resizeCallback?.({ cols, rows })
    }
    open(element: HTMLElement) {
      this.element = element
      Object.defineProperties(element, { clientWidth: { value: 100 }, clientHeight: { value: 100 } })
    }
    write(data: string, callback?: () => void) { output.push(data); callback?.() }
    focus() { this.focuses++ }
  }
  mock.module('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
  mock.module('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return measured } } }))
  mock.module('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
  mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
  mock.module('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} } }))
  mock.module('../src/renderer/src/stores/sessions', () => ({ useSessionsStore: Object.assign(
    (selector: (state: { runtime: Record<string, { isStreaming: boolean }> }) => unknown) => selector({ runtime: { owner: { isStreaming: streaming } } }),
    { subscribe() {} }
  ) }))
  mock.module('../src/renderer/src/ipc/api', () => ({ api: {
    abort: async (id: string) => { aborted.push(id); if (abortFailure) throw new Error('abort failed') },
    terminal: {
    onEvent(listener: typeof receiveEvent) { receiveEvent = listener },
    ack: async (_id: string, length: number) => { acks.push(length) },
    clear: async (id: string) => { clears.push(id) },
    onAgentState(listener: typeof agentState) { agentState = listener; return () => {} },
    releaseAgent: async (id: string, expected: string) => { released.push([id, expected]) },
    getAgentState: async (terminalId: string) => ({ terminalId, agentSessionId: null }),
    create: async (_id: string, _cwd: string | null, cols: number, rows: number) => {
      creates.push([cols, rows])
      if (rejectCreate) throw new Error('shell create failed')
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
  const { attachTerminal, ensureTerminal } = await import('../src/renderer/src/terminal/runtime')
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
  keyHandler(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
  assert.deepEqual(clears, ['terminal:input'], 'Cmd+K requests a shared parser clear')
  assert.equal(terminal.cleared, 0, 'local screen waits for the ordered worker marker')
  receiveEvent({ terminalId: 'terminal:input', kind: 'clear' })
  assert.equal(terminal.cleared, 1)
  keyHandler(new KeyboardEvent('keydown', { key: 'K', metaKey: true, shiftKey: true }))
  assert.equal(clears.length, 1, 'Shift variants stay with app shortcuts')
  detach()
  const loadsBefore = fontLoads
  let finishFonts!: () => void
  fontDelay = new Promise((resolve) => { finishFonts = () => resolve([]) })
  const { createElement, act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: TerminalPanel } = await import('../src/renderer/src/components/terminal/TerminalPanel')
  const { TooltipProvider } = await import('../src/renderer/src/components/ui/tooltip')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(host)
  let paneFocuses = 0
  const renderPanel = (active: boolean) => root.render(createElement(TooltipProvider, null, createElement(TerminalPanel, {
    terminalId: 'terminal:retry', cwd: null, active, onFocus: () => { paneFocuses++ }
  })))
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
  const clickButton = async (pattern: RegExp) => {
    const button = [...document.querySelectorAll('button')].find((node) => pattern.test(node.textContent || node.getAttribute('aria-label') || ''))
    assert.ok(button, `missing button: ${pattern}`)
    await act(async () => { button.click() })
  }
  const control = async (agentSessionId: string | null) => {
    await act(async () => { agentState({ terminalId: 'terminal:retry', agentSessionId }) })
  }
  // Agent controls never steal the pane's focus or forward dialog focus into its activation callback.
  await control('owner')
  await clickButton(/释放 Agent 控制|Release agent control/i)
  abortFailure = true
  await clickButton(/停止 Agent 并释放|Stop agent and release/i)
  assert.deepEqual(aborted, ['owner'])
  assert.equal(released.length, 0, 'failed stop must preserve control')
  abortFailure = false
  await clickButton(/直接释放|Release directly/i)
  assert.deepEqual(released, [['terminal:retry', 'owner']], 'release includes the confirmed owner')
  assert.equal(aborted.length, 1, 'direct release never stops the agent')
  await clickButton(/释放 Agent 控制|Release agent control/i)
  await control('replacement')
  await clickButton(/停止 Agent 并释放|Stop agent and release/i)
  assert.equal(released.length, 1, 'stale confirmation must not release a new owner')
  assert.equal(aborted.length, 1, 'stale confirmation must not stop a different agent')
  streaming = false
  await act(async () => { renderPanel(true) })
  await clickButton(/^取消$|^Cancel$/i)
  assert.equal(released.length, 1, 'idle cancellation preserves control')
  await clickButton(/释放 Agent 控制|Release agent control/i)
  await clickButton(/^释放控制$|^Release control$/i)
  assert.deepEqual(released.at(-1), ['terminal:retry', 'replacement'])
  assert.equal(aborted.length, 1, 'idle release never calls abort')
  await act(async () => { root.unmount() })
  assert.equal(paneFocuses, 0, 'Bot/dialog focus must not activate a pane')

  const beforeBackground = creates.length
  await ensureTerminal('terminal:background', '/worktree')
  const background = terminal
  assert.equal(background.focuses, 0, 'background startup never focuses xterm')
  assert.deepEqual(creates.at(-1), [120, 30], 'parked shells start at a predictable grid size')
  receiveEvent({ terminalId: 'terminal:background', kind: 'output', data: 'background output' })
  assert.equal(acks.at(-1), 'background output'.length, 'unseen terminals still parse and ACK output')
  const detachBackground = attachTerminal('terminal:background', '/worktree', host)
  await ensureTerminal('terminal:background', '/worktree')
  assert.equal(terminal, background, 'later attachment reuses the same xterm')
  assert.equal(creates.length, beforeBackground + 1, 'later attachment never starts a second shell')
  assert.equal(background.focuses, 0, 'attachment alone does not request focus')
  detachBackground()
  rejectCreate = true
  await assert.rejects(ensureTerminal('terminal:failure', null), /shell create failed/)
  await assert.rejects(ensureTerminal('terminal:failure', null), /shell create failed/, 'readiness failures remain observable')
  GlobalRegistrator.unregister()
} else {
  test('terminal clamps measured sizes, forwards binary mouse events and chunks oversized pastes', async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, '--terminal-input-fixture'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(code, 0, stdout + stderr)
  })
}

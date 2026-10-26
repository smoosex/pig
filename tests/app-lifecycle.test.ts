import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow } from 'electron'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

async function fixture(mode: string): Promise<void> {
  if (mode === 'loading-screen') {
    const calls: string[] = []
    class FakeContents extends EventEmitter {
      url = ''
      script = ''
      mainFrame = {}
      ipc = new EventEmitter()
      isDestroyed() { return this.destroyed }
      destroyed = false
      close() { calls.push('close'); this.destroyed = true }
      focus() { calls.push('focus') }
      async loadURL(url: string) { this.url = url }
      async executeJavaScript(script: string) { this.script = script }
    }
    class FakeView {
      static instance: FakeView
      contents = new FakeContents()
      // Electron's getter returns undefined once the contents are destroyed.
      get webContents() { return this.contents.destroyed ? undefined : this.contents }
      constructor(readonly options: Electron.WebContentsViewConstructorOptions) { FakeView.instance = this }
      setBackgroundColor() {}
      setBounds(bounds: Electron.Rectangle) { calls.push(`bounds:${bounds.width}x${bounds.height}`) }
    }
    const window = Object.assign(new EventEmitter(), {
      webContents: new FakeContents(),
      contentView: { addChildView: () => calls.push('add'), removeChildView: () => calls.push('remove') },
      getContentSize: () => [1100, 760],
      isDestroyed: () => false
    })
    mock.module('electron', () => ({ WebContentsView: FakeView }))
    const { attachStartupScreen } = await import('../src/main/startup-window')
    const { STARTUP_EXIT_SCRIPT, STARTUP_EXIT_MS } = await import('../src/main/startup-screen')
    const { ready } = attachStartupScreen(window as unknown as BrowserWindow)
    const view = FakeView.instance
    assert.equal(view.options.webPreferences?.sandbox, true)
    assert.equal(view.options.webPreferences?.preload, undefined)
    assert.deepEqual(calls, ['bounds:1100x760', 'add'], 'the screen covers the whole window')
    const html = decodeURIComponent(view.contents.url.split(',')[1])
    assert.ok(html.includes('prefers-reduced-motion'))
    assert.ok(html.includes("default-src 'none'"))
    assert.ok(html.includes('__pigStartupExit'))
    window.emit('resize')
    view.contents.emit('did-finish-load')
    await ready
    window.webContents.ipc.emit('window:startup-ready', { senderFrame: {} })
    assert.equal(view.contents.script, '', 'only the app document can lift the screen')
    window.webContents.ipc.emit('window:startup-ready', { senderFrame: window.webContents.mainFrame })
    await flush()
    assert.equal(view.contents.script, STARTUP_EXIT_SCRIPT)
    assert.equal(calls.at(-1), 'focus', 'the app takes focus while the screen still covers it')
    assert.equal(calls.includes('remove'), false, 'the screen stays while it fades out')
    await Bun.sleep(STARTUP_EXIT_MS + 50)
    assert.deepEqual(calls.slice(-2), ['remove', 'close'])
    window.emit('closed')
    assert.equal(calls.filter((call) => call === 'close').length, 1, 'closing the window after the fade does not touch the screen again')

    const failing = Object.assign(new EventEmitter(), { ...window, webContents: new FakeContents() })
    attachStartupScreen(failing as unknown as BrowserWindow)
    const failed = FakeView.instance
    failing.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', '', true)
    failing.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', '', false)
    await flush()
    assert.equal(failed.contents.script, '', 'aborted navigations and subframe failures keep the screen')
    failing.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', '', true)
    await flush()
    assert.equal(failed.contents.script, STARTUP_EXIT_SCRIPT, 'a failed app load uncovers its error page')
    return
  }

  const events: string[] = []
  const handlers = new Map<string, (...args: any[]) => void>()
  const shell = deferred<void>()
  const loading = deferred<void>()
  const terminalCleanup = deferred<void>()
  let exitCode: number | undefined
  const main = {
    show: () => events.push('main:show'), hide: () => events.push('main:hide'), isDestroyed: () => false
  }
  const noop = () => {}
  const asyncNoop = async () => {}
  mock.module('electron', () => ({
    app: {
      isPackaged: true, requestSingleInstanceLock: () => true,
      whenReady: asyncNoop, on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
      exit: (code: number) => { exitCode = code }
    },
    BrowserWindow: { getAllWindows: () => [main] },
    nativeTheme: {}
  }))
  mock.module('@electron-toolkit/utils', () => ({
    electronApp: { setAppUserModelId: noop }, optimizer: { watchWindowShortcuts: noop }
  }))
  const modules: Record<string, Record<string, unknown>> = {
    'startup-window': { attachStartupScreen: () => ({ ready: loading.promise, dismiss: noop }) },
    'window': {
      createMainWindow: () => { events.push('main:reopen') },
      createStartupMainWindow: () => {
        events.push('main:create')
        return { window: main, loadApp: () => events.push('main:load') }
      }
    },
    'tab-close-menu': { installTabCloseMenu: noop },
    'window-surface': { applyWindowSurfaceStyle: noop },
    'ipc/index': { registerIpc: noop },
    'ipc/terminal': { shutdownTerminals: () => { events.push('terminal:cleanup'); return terminalCleanup.promise } },
    'processes/index': { shutdownProcesses: asyncNoop },
    'terminal/history': { pruneTerminalHistories: asyncNoop },
    'i18n': { initLocale: asyncNoop },
    'pig-settings': { loadPigSettings: async () => { events.push('settings'); return { shortcuts: {} } } },
    'session-names': { forwardSessionNames: noop },
    'pi/session-registry': { closeSessionsForCwd: asyncNoop, disposeAll: asyncNoop },
    'pi/session-removal': { removeProjectSessions: asyncNoop },
    'pi/model-settings': { startModelRuntime: asyncNoop },
    'pi/model-catalog': { startModelCatalog: noop },
    'project-worktrees': { worktrees: { startDeletionWorker: asyncNoop, listDeletions: async () => [], shutdown: async () => { events.push('worktrees:cleanup') } } },
    'session-image-protocol': { handleSessionImages: noop, registerSessionImageScheme: noop },
    'mcp/icon-protocol': { handleMcpIcons: noop, registerMcpIconScheme: noop },
    'worktree-file-protocol': { handleWorktreeFiles: noop, registerWorktreeFileScheme: noop },
    'open-project-sessions': { flushOpenProjectSessions: asyncNoop, loadOpenProjectSessions: async () => ({ tools: [] }), removeOpenProjectWorkspaces: asyncNoop },
    'chats': { pruneEmptyChatDirs: asyncNoop },
    'pig-dir': { pigDir: () => '/unused' },
    'shell-env': { importShellEnvironment: () => shell.promise },
    'mcp/manager': { cancelMcpOperations: asyncNoop },
    'mcp/settings': { flushToolMutations: asyncNoop, initializeMcpDefaults: asyncNoop }
  }
  for (const [path, exports] of Object.entries(modules)) {
    mock.module(fileURLToPath(new URL(`../src/main/${path}.ts`, import.meta.url)), () => exports)
  }
  await import('../src/main/index')
  await flush()
  if (mode === 'quit-before-ready') {
    handlers.get('before-quit')!({ preventDefault: noop })
    loading.resolve()
    await flush()
    assert.equal(events.includes('main:show'), false, 'a quitting app does not show its window')
  } else {
    loading.resolve()
    await flush()
    assert.deepEqual(events, ['main:create', 'main:show'], 'the window opens before the shell probe completes')
  }
  if (mode === 'handoff') {
    shell.resolve()
    await flush()
    assert.deepEqual(events.slice(-2), ['settings', 'main:load'], 'the app loads only once main has initialized')
    return
  }
  if (mode === 'quit-loading') {
    let prevented = false
    handlers.get('before-quit')!({ preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.ok(events.indexOf('main:hide') < events.indexOf('worktrees:cleanup'))
    assert.equal(exitCode, undefined, 'hiding the window does not skip mandatory terminal cleanup')
    shell.resolve()
    await flush()
    assert.equal(events.includes('settings'), false, 'quit cancels remaining startup work')
    assert.equal(events.includes('main:load'), false)
  }
  terminalCleanup.resolve()
  await flush()
  assert.equal(exitCode, 0)
}

if (process.argv[2] === '--app-lifecycle') {
  await fixture(process.argv[3])
  process.exit(0)
} else {
  for (const mode of ['loading-screen', 'handoff', 'quit-loading', 'quit-before-ready']) {
    test(`app lifecycle: ${mode}`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--app-lifecycle', mode], { stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
      }
    })
  }
}

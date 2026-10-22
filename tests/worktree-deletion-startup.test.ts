import { mock, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorktreeService } from '../src/main/worktrees'

type Failure = 'malformed' | 'unreadable'

async function fixture(failure: Failure): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-deletion-startup-'))
  const statePath = join(root, '.state.json')
  if (failure === 'malformed') await writeFile(statePath, '{invalid JSON')
  else await mkdir(statePath)
  const worktrees = new WorktreeService(root)
  const handlers = new Map<string, (...args: any[]) => unknown>()
  let ready!: () => void
  const readiness = new Promise<void>((resolve) => { ready = resolve })
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { exit = resolve })
  let windows = 0
  let menuInstalls = 0
  let workspacePrunes = 0
  let chatPrunes = 0
  const nativeTheme = { themeSource: 'system' }
  const failures: unknown[] = []
  const log = spyOn(console, 'error').mockImplementation((_message: unknown, error: unknown) => { failures.push(error) })
  const noop = () => {}
  const asyncNoop = async () => {}
  mock.module('electron', () => ({
    app: {
      isPackaged: true,
      requestSingleInstanceLock: () => true,
      whenReady: () => readiness,
      on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler) },
      exit
    },
    BrowserWindow: { getAllWindows: () => [] },
    nativeTheme
  }))
  mock.module('@electron-toolkit/utils', () => ({
    electronApp: { setAppUserModelId: noop }, optimizer: { watchWindowShortcuts: noop }
  }))
  const modules: Record<string, Record<string, unknown>> = {
    'window': { createMainWindow: () => { windows++ } },
    'tab-close-menu': { installTabCloseMenu: () => { menuInstalls++ } },
    'ipc/index': { registerIpc: noop },
    'ipc/terminal': { shutdownTerminals: asyncNoop },
    'terminal/history': { pruneTerminalHistories: asyncNoop },
    'i18n': { initLocale: asyncNoop },
    'pig-settings': { loadPigSettings: async () => ({ locale: 'en', appearance: 'dark', surfaceStyle: 'solid' }) },
    'session-names': { forwardSessionNames: noop },
    'pi/session-registry': { closeSessionsForCwd: asyncNoop, disposeAll: asyncNoop },
    'pi/session-removal': { removeProjectSessions: asyncNoop },
    'pi/model-settings': { startModelRuntime: asyncNoop },
    'pi/model-catalog': { startModelCatalog: noop },
    'project-worktrees': { worktrees },
    'session-image-protocol': { handleSessionImages: noop, registerSessionImageScheme: noop },
    'mcp/icon-protocol': { handleMcpIcons: noop, registerMcpIconScheme: noop },
    'worktree-file-protocol': { handleWorktreeFiles: noop, registerWorktreeFileScheme: noop },
    'open-project-sessions': {
      flushOpenProjectSessions: asyncNoop,
      loadOpenProjectSessions: async () => ({ tools: [] }),
      removeOpenProjectWorkspaces: async () => { workspacePrunes++ }
    },
    'chats': { pruneEmptyChatDirs: async () => { chatPrunes++ } },
    'pig-dir': { pigDir: () => root },
    'shell-env': { importShellEnvironment: asyncNoop },
    'mcp/manager': { cancelMcpOperations: asyncNoop },
    'mcp/settings': { flushToolMutations: asyncNoop, initializeMcpDefaults: asyncNoop }
  }
  for (const [path, exports] of Object.entries(modules)) {
    mock.module(fileURLToPath(new URL(`../src/main/${path}.ts`, import.meta.url)), () => exports)
  }
  try {
    await import('../src/main/index')
    assert.equal(handlers.has('second-instance'), false, 'an uninitialized process cannot reopen a window')
    ready()
    assert.equal(await exited, 1)
    assert.equal(nativeTheme.themeSource, 'dark', 'startup applies the saved native appearance before opening a window')
    const { supportsGlass } = await import('../src/main/surface-support')
    const { windowSurfaceOptions } = await import('../src/main/window-surface')
    assert.equal(windowSurfaceOptions().vibrancy, undefined)
    assert.equal(windowSurfaceOptions().backgroundColor, supportsGlass ? '#00000000' : '#1a1a1a', 'solid uses an opaque document without changing the native backing')
    assert.equal(windows, 0)
    assert.equal(menuInstalls, 0, 'a failed startup cannot replace the native menu')
    assert.equal(workspacePrunes, 0)
    assert.equal(chatPrunes, 0)
    assert.equal(handlers.has('activate'), false)
    assert.equal(handlers.has('second-instance'), false)
    assert.equal(failures.length, 1)
    if (failure === 'malformed') assert.ok(failures[0] instanceof SyntaxError)
    else assert.equal((failures[0] as NodeJS.ErrnoException).code, 'EISDIR')
  } finally {
    log.mockRestore()
    await worktrees.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--worktree-deletion-startup') {
  await fixture(process.argv[3] as Failure)
} else {
  for (const failure of ['malformed', 'unreadable'] as const) {
    test(`${failure} deletion state stops startup before opening a window`, async () => {
      const child = Bun.spawn([process.execPath, import.meta.path, '--worktree-deletion-startup', failure], {
        stdout: 'pipe', stderr: 'pipe'
      })
      const timeout = setTimeout(() => child.kill(), 5_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ])
        assert.equal(code, 0, stderr || stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }, 10_000)
  }
}

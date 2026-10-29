/** Pi-compatible shell execution with a final permission check immediately before spawn. */
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { pathToFileURL } from 'node:url'
import { getShellConfig, type BashOperations } from '@earendil-works/pi-coding-agent'
import { sdkFile } from '../mcp/sdk'

type ShellHelpers = {
  getShellEnv(): NodeJS.ProcessEnv
  trackDetachedChildPid(pid: number): void
  untrackDetachedChildPid(pid: number): void
  killProcessTree(pid: number): void
}
type ChildHelpers = { waitForChildProcess(child: ReturnType<typeof spawn>): Promise<number | null> }
let helpers: Promise<[ShellHelpers, ChildHelpers]> | undefined
const sdkHelpers = () => (helpers ??= Promise.all([
  import(pathToFileURL(sdkFile('utils/shell.js')).href),
  import(pathToFileURL(sdkFile('utils/child-process.js')).href)
]))

export function guardedShellOperations(
  shellPath: string | undefined,
  guard: { check(): void; dispose(): void },
  resolveConfig: () => ReturnType<typeof getShellConfig> = () => getShellConfig(shellPath)
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
        throw new Error('Invalid timeout: must be a finite number of seconds within the supported range')
      }
      signal?.throwIfAborted()
      const [shell, childProcess] = await sdkHelpers()
      const config = resolveConfig()
      try { await access(cwd, fsConstants.F_OK) } catch { throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`) }
      signal?.throwIfAborted()
      guard.check()
      const stdin = config.commandTransport === 'stdin'
      const child = spawn(config.shell, stdin ? config.args : [...config.args, command], {
        cwd, detached: process.platform !== 'win32', env: env ?? shell.getShellEnv(),
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true
      })
      // Mode changes cannot revoke a process that has already been spawned.
      guard.dispose()
      if (stdin) { child.stdin?.on('error', () => {}); child.stdin?.end(command) }
      if (child.pid) shell.trackDetachedChildPid(child.pid)
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = () => { if (child.pid) shell.killProcessTree(child.pid) }
      try {
        if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; abort() }, timeout * 1000)
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
        const exitCode = await childProcess.waitForChildProcess(child)
        if (signal?.aborted) throw new Error('aborted')
        if (timedOut) throw new Error(`timeout:${timeout}`)
        return { exitCode: exitCode ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1) }
      } finally {
        if (child.pid) shell.untrackDetachedChildPid(child.pid)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }
  }
}

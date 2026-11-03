/**
 * Subprocess fixtures. A test that needs isolated module state (extension registries, caches,
 * process-wide globals) spawns this same file again and drives it through a flag.
 *
 * The runner owns capture, the timeout and cleanup: a fixture that hangs is killed, and the child is
 * killed on every path so a failed assertion cannot leave it running behind the rest of the suite.
 */

export type ChildRun = {
  exitCode: number
  stdout: string
  stderr: string
}

export type RunOptions = {
  cwd?: string
  /** Added on top of the parent's environment; the child still inherits PATH and friends. */
  env?: Record<string, string | undefined>
  /** Kill the child after this long; the run still resolves with whatever the child produced. */
  timeoutMs?: number
}

export async function runChild(command: string[], options: RunOptions = {}): Promise<ChildRun> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env === undefined ? undefined : { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs })
  })
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    return { exitCode, stdout, stderr }
  } finally {
    child.kill()
  }
}

/** Runs this test file again as its own process, which is how the suite isolates module state. */
export function runSelf(path: string, args: string[] = [], options: RunOptions = {}): Promise<ChildRun> {
  return runChild([process.execPath, path, ...args], options)
}

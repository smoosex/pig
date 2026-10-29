/** Binds file tools to srt, so a symlink switched after the UI check cannot escape filesystem policy. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentDir, withFileMutationQueue, type createReadToolDefinition } from '@earendil-works/pi-coding-agent'
import { sandboxCommand, type SandboxRequest } from './service'
import { sandboxEnvironment } from './environment'

type Result = Awaited<ReturnType<ReturnType<typeof createReadToolDefinition>['execute']>>
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function executeFileTool(name: string, params: Record<string, unknown>, request: SandboxRequest, guard?: { check(): void; dispose(): void }): Promise<Result> {
  // The worker's queue is process-local. Hold Pi's host queue too so sibling edits/writes retain the
  // same serialization as before sandboxing (and serialize with ordinary full-access file tools).
  return name === 'write' || name === 'edit'
    ? withFileMutationQueue(params.path as string, () => runFileTool(name, params, request, guard))
    : runFileTool(name, params, request, guard)
}

async function runFileTool(name: string, params: Record<string, unknown>, request: SandboxRequest, guard?: { check(): void; dispose(): void }): Promise<Result> {
  request.signal?.throwIfAborted()
  guard?.check()
  const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './file-worker.ts' : './file-worker.js', import.meta.url))
  const wrapped = await sandboxCommand(`${quote(process.execPath)} ${quote(worker)}`, { ...request, shell: '/bin/sh' })
  try {
    request.signal?.throwIfAborted()
    guard?.check()
    return await new Promise<Result>((resolveResult, reject) => {
      const child = spawn('/bin/sh', ['-c', wrapped.command], {
        cwd: request.workspace.cwd, detached: true,
        env: { ...sandboxEnvironment(), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe']
      })
      guard?.dispose()
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let bytes = 0
      let failure: Error | undefined
      const stop = () => {
        if (!child.pid) return
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { failure = error as Error; child.kill('SIGKILL') }
        }
      }
      const abort = () => { failure = new Error('File operation aborted'); stop() }
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 64 * 1024 * 1024) { failure = new Error('Sandboxed file result exceeds 64 MiB'); stop() }
        else stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.reduce((size, part) => size + part.length, 0) < 16_384) stderr.push(chunk) })
      child.once('error', reject)
      child.stdin.on('error', (error) => { failure ??= error })
      child.once('close', (code) => {
        request.signal?.removeEventListener('abort', abort)
        if (failure || code !== 0) {
          reject(failure ?? new Error(`Sandboxed ${name} failed: ${Buffer.concat(stderr).toString().trim() || `exit ${code}`}`))
          return
        }
        // JSON/shape failures are protocol errors, not an empty successful file result.
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString()) as Result
          if (!result || !Array.isArray(result.content)) throw new Error('Invalid sandboxed file result')
          resolveResult(result)
        } catch (error) { reject(error) }
      })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
      child.stdin.end(JSON.stringify({ name, cwd: request.workspace.cwd, params, runtime: { agentDir: resolve(getAgentDir()) } }))
    })
  } finally {
    wrapped.finish()
  }
}

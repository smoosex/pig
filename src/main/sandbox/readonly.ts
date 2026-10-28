/** Host for the isolated, deny-all-network srt instance. A worker failure rejects every pending wrap. */
import { Worker } from 'node:worker_threads'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

let worker: Worker | undefined
let sequence = 0
let failure: Error | undefined
const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>()
const cleanups = new Set<Promise<unknown>>()

function fail(error: Error): void {
  failure = error
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function start(config: SandboxRuntimeConfig): Worker {
  if (failure) throw failure
  if (worker) return worker
  // Bun unit tests load the source; electron-vite emits this entry beside index.js in production.
  const url = new URL(import.meta.url.endsWith('.ts') ? './readonly-worker.ts' : './readonly-worker.js', import.meta.url)
  worker = new Worker(url, { workerData: config })
  worker.on('message', (message: { id: number; value?: string; error?: string }) => {
    const request = pending.get(message.id)
    if (!request) {
      if (message.error !== undefined && message.id === 0) fail(new Error(message.error))
      return
    }
    pending.delete(message.id)
    if (message.error !== undefined) request.reject(new Error(message.error))
    else if (typeof message.value === 'string') request.resolve(message.value)
    else request.reject(new Error('Invalid read-only sandbox response'))
    if (!pending.size) worker?.unref()
  })
  worker.once('error', fail)
  worker.once('exit', () => {
    worker = undefined
    if (pending.size) fail(new Error('Read-only sandbox worker exited'))
  })
  worker.unref()
  return worker
}

function request(config: SandboxRuntimeConfig, input: object, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const host = start(config)
  const id = ++sequence
  host.ref()
  return new Promise<string>((resolve, reject) => {
    const abort = () => {
      pending.delete(id)
      host.postMessage({ id: 0, cancel: id })
      if (!pending.size) host.unref()
      reject(signal!.reason)
    }
    pending.set(id, {
      resolve(value) { signal?.removeEventListener('abort', abort); resolve(value) },
      reject(error) { signal?.removeEventListener('abort', abort); reject(error) }
    })
    signal?.addEventListener('abort', abort, { once: true })
    host.postMessage({ id, ...input })
  })
}

export function wrapReadOnly(command: string, shell: string, filesystem: SandboxRuntimeConfig['filesystem'], commandId: string, signal?: AbortSignal): Promise<string> {
  return request({ network: { allowedDomains: [], deniedDomains: ['*'] }, filesystem }, { command, shell, filesystem, commandId }, signal)
}

const emptyConfig = { network: { allowedDomains: [], deniedDomains: ['*'] }, filesystem: { allowWrite: [], denyRead: [], denyWrite: [] } }

/** finish() is synchronous to its caller; asynchronous cleanup remains tracked and fails the host. */
export function finishReadOnly(commandId: string): void {
  const cleanup = request(emptyConfig, { finish: commandId })
  cleanups.add(cleanup)
  void cleanup.then(() => { cleanups.delete(cleanup) }, (error: Error) => { cleanups.delete(cleanup); fail(error) })
}

/** Called after commands have stopped; the proxy and Linux bridge must not outlive Pig. */
export async function shutdownReadOnly(): Promise<void> {
  if (!worker) return
  const host = worker
  try {
    await Promise.all(cleanups)
    if (failure) throw failure
    await request(emptyConfig, { reset: true }, AbortSignal.timeout(5_000))
  } finally {
    await host.terminate()
  }
}

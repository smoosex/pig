/** A separate srt singleton: read-only commands must never share the default mode's network proxy. */
import { parentPort, workerData } from 'node:worker_threads'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { sandboxAssets } from './assets'

const port = parentPort!
const ready = SandboxManager.initialize({
  ...workerData as SandboxRuntimeConfig, ...sandboxAssets(),
  network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true, allowLocalBinding: false }
}, undefined, false)
const wrapping = new Map<number, AbortController>()
const commands = new Map<number, string>()

function cleanup(id: number): void {
  if (!commands.delete(id)) return
  SandboxManager.cleanupAfterCommand()
}

type Request = { id: number; command?: string; shell?: string; filesystem?: SandboxRuntimeConfig['filesystem']; commandId?: string; reset?: boolean; cancel?: number; finish?: string }
port.on('message', async (request: Request) => {
  // This worker boundary turns initialization, cleanup and wrapping failures into rejected host calls.
  const controller = new AbortController()
  if (request.command !== undefined) wrapping.set(request.id, controller)
  try {
    if (request.cancel !== undefined) {
      wrapping.get(request.cancel)?.abort()
      cleanup(request.cancel)
      return
    }
    await ready
    if (request.reset) {
      await SandboxManager.reset()
      port.postMessage({ id: request.id, value: '' })
      port.close()
    } else if (request.finish !== undefined) {
      for (const [id, commandId] of commands) if (commandId === request.finish) cleanup(id)
      port.postMessage({ id: request.id, value: '' })
    } else {
      controller.signal.throwIfAborted()
      const command = await SandboxManager.wrapWithSandbox(request.command!, request.shell!, { filesystem: request.filesystem }, controller.signal, { commandId: request.commandId })
      commands.set(request.id, request.commandId!)
      if (controller.signal.aborted) cleanup(request.id)
      else port.postMessage({ id: request.id, value: command })
    }
  } catch (error) {
    port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  } finally {
    wrapping.delete(request.id)
  }
})
// A request still awaits this original rejection and reports it; never fall back to a usable command.
void ready.catch(() => undefined)

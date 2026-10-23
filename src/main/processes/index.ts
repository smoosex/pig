/** The one background process controller: registered for the pig-process plugin, closed with its sessions. */
import { registerProcessAgentHost } from '../plugins/pig-process-host'
import { BackgroundProcessController, type BackgroundProcessDeps } from './controller'

let controller: BackgroundProcessController | undefined

export function registerBackgroundProcesses(deps: BackgroundProcessDeps): void {
  controller = new BackgroundProcessController(deps)
  registerProcessAgentHost(controller)
}

export function backgroundProcesses(): BackgroundProcessController {
  if (!controller) throw new Error('Background processes are not registered')
  return controller
}

export function closeSessionProcesses(sessionId: string): Promise<void> {
  return controller ? controller.sessionClosed(sessionId) : Promise.resolve()
}

export function shutdownProcesses(): Promise<void> {
  return controller ? controller.shutdown() : Promise.resolve()
}

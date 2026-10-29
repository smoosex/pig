/** The app's single SubagentManager, published to the extension; IPC installs the window publisher. */
import type { BrowserWindow } from 'electron'
import type { SubagentListUpdate } from '../../shared/api'
import { registerSubagentHost } from '../plugins/pig-subagent-host'
import { startModelRuntime } from '../pi/model-settings'
import { SubagentManager } from './manager'
import { chooseModel } from './runner'
import { createSdkRunner } from './sdk-runner'
import { subagentApprovalUI } from './approval'
import { readSubagentSettings } from './settings'
import { createFileStore } from './store'
import { pruneOrphanSubagents } from './cleanup'

const PUSH_INTERVAL_MS = 150
const dirty = new Set<string>()
let pushTimer: ReturnType<typeof setTimeout> | undefined
let publish: (updates: SubagentListUpdate[]) => void = () => {}
let publishError: (sessionId: string, error: unknown) => void = () => {}

export function setSubagentErrorPublisher(next: typeof publishError): void {
  publishError = next
}

function push(): void {
  pushTimer = undefined
  const updates = [...dirty].map((parentSessionId) => ({ parentSessionId, subagents: manager.snapshot(parentSessionId) }))
  dirty.clear()
  publish(updates)
}

export function setSubagentPublisher(next: (updates: SubagentListUpdate[]) => void): void {
  publish = next
}

let startup: Promise<void> | undefined
let parentSession: (sessionId: string) => { win?: BrowserWindow } | undefined = () => undefined
const store = createFileStore()

export function setSubagentParentSession(lookup: typeof parentSession): void {
  parentSession = lookup
}

export const manager = new SubagentManager({
  runner: createSdkRunner((spec) => subagentApprovalUI(spec, (sessionId) => parentSession(sessionId))),
  store: {
    ...store,
    // List/attach can load and repair an index too; they must not race the startup sweep either.
    load: async (id) => { await startup; return store.load(id) }
  },
  settings: readSubagentSettings,
  chooseModel: async (settings, parent) => {
    const runtime = await startModelRuntime()
    return chooseModel(settings, parent, {
      exists: (provider, id) => !!runtime.getModel(provider, id),
      available: (provider, id) => runtime.getAvailableSnapshot().some((model) => model.provider === provider && model.id === id)
    })
  },
  onError: (sessionId, error) => publishError(sessionId, error),
  onChange: (parentSessionId) => {
    dirty.add(parentSessionId)
    pushTimer ??= setTimeout(push, PUSH_INTERVAL_MS)
  }
})

export function startSubagents(): void {
  startup ??= pruneOrphanSubagents(undefined, (id) => manager.snapshot(id).length > 0)
    .catch((error) => console.error('Could not clean orphan subagents:', error))
  const ready = startup
  registerSubagentHost({
    // No new child files may be created until the startup sweep has finished.
    spawn: async (request) => { await ready; return manager.spawn(request) },
    attach: (id, deliver) => manager.attach(id, deliver),
    detach: (id, deliver) => manager.detach(id, deliver)
  })
}

export function closeSubagents(parentSessionId: string): Promise<void> {
  return manager.closeParent(parentSessionId)
}

export function removeSubagents(parentSessionId: string): Promise<void> {
  return manager.removeParent(parentSessionId)
}

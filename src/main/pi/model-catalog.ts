/**
 * The shared model catalog: one snapshot of `ModelRuntime.getAvailableSnapshot()`, pushed to every
 * window while a refresh runs and after extension/auth lifecycle changes.
 *
 * Session controls no longer carry a model list. One main-side runtime answers for the whole app, so
 * copying its list into every open session made a refresh O(open sessions) and left each picker
 * holding a copy that the next refresh could not reach. Here the list is read once and every picker
 * reads the same snapshot.
 *
 * `refreshModelCatalog()` is called by a picker's refresh button and at startup. Concurrent callers
 * share one pass, so a burst of clicks cannot stack requests behind the SDK's own four-hour catalog
 * throttle.
 */
import { BrowserWindow } from 'electron'
import type { ModelCatalog, SessionModelInfo } from '../../shared/api'
import { availableModels, startModelRuntime } from './model-settings'

let models: SessionModelInfo[] = []
/** The on-disk catalog is read lazily: a window asking before startup has it gets the list, not []. */
let loaded = false
let revision = 0
let inFlight = false
let running: Promise<ModelCatalog> | undefined

function snapshot(): ModelCatalog {
  return { models, revision, refreshing: inFlight }
}

/** Content revisions ignore refresh-state-only changes. */
function sameModels(next: SessionModelInfo[]): boolean {
  if (next.length !== models.length) return false
  return next.every((model, index) => {
    const current = models[index]!
    return current.id === model.id &&
      current.provider === model.provider &&
      current.name === model.name &&
      current.providerName === model.providerName &&
      current.contextWindow === model.contextWindow &&
      current.reasoning === model.reasoning
  })
}

/** Never awaited: a window that is gone must not fail the refresh that fed it. */
function publish(catalog: ModelCatalog): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send('models:changed', catalog)
  }
}

function readFromRuntime(): boolean {
  const next = availableModels()
  const changed = !loaded || !sameModels(next)
  if (loaded && changed) revision += 1
  if (changed) models = next
  loaded = true
  return changed
}

/**
 * The current catalog. Every reader goes through here rather than reading the cache itself, so a
 * window that asks before startup's refresh lands gets the on-disk list rather than an empty one.
 */
export async function currentModelCatalog(): Promise<ModelCatalog> {
  await startModelRuntime()
  if (!loaded) readFromRuntime()
  return snapshot()
}

/** Publishes extension/auth changes already applied to the initialized runtime, without network IO. */
export function synchronizeModelCatalog(): ModelCatalog {
  const changed = readFromRuntime()
  const catalog = snapshot()
  if (changed) publish(catalog)
  return catalog
}

/**
 * Re-reads the runtime and pushes the result.
 *
 * Both ends of the pass are pushed even when the list does not change: `refreshing` is what every
 * other picker's spinner reads, and a pass that ended silently would leave them spinning. The
 * revision moves only when the list did, so a renderer can drop a snapshot it already holds.
 */
export function refreshModelCatalog(): Promise<ModelCatalog> {
  if (running) return running
  running = (async () => {
    try {
      const runtime = await startModelRuntime()
      // Publish the existing list, never an uninitialized empty catalog.
      readFromRuntime()
      inFlight = true
      publish(snapshot())
      await runtime.refresh()
      readFromRuntime()
    } finally {
      // Cleanup must reach every picker even on failure; the original rejection goes to the caller.
      inFlight = false
      running = undefined
      publish(snapshot())
    }
    return snapshot()
  })()
  return running
}

/**
 * Startup reads the on-disk catalog first so the first paint has something to show, then refreshes
 * in the background: whatever that finds is pushed to the window when it lands, so a session opened
 * before it finishes is not left showing the catalog as it was on disk.
 */
export function startModelCatalog(): void {
  void currentModelCatalog()
    .then(() => refreshModelCatalog())
    .catch((error) => console.error('Model catalog refresh failed:', error))
}

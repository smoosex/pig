/* Pig's main bundle and jiti plugin instances share one process, so controls can cancel workers immediately. */
const controlsKey = Symbol.for('pig:persona:control-listeners')
const filesKey = Symbol.for('pig:persona:agent-file-listeners')
type Listener = () => void
const shared = globalThis as typeof globalThis & {
  [controlsKey]?: Set<Listener>
  [filesKey]?: Set<Listener>
}
function controlListeners(): Set<Listener> { return shared[controlsKey] ??= new Set() }
function fileListeners(): Set<Listener> { return shared[filesKey] ??= new Set() }

export function onPersonaControlsChanged(listener: Listener): () => void {
  controlListeners().add(listener)
  return () => { controlListeners().delete(listener) }
}
export function notifyPersonaControlsChanged(): void {
  for (const listener of controlListeners()) listener()
}

export function onPersonaAgentFileSaved(listener: Listener): () => void {
  fileListeners().add(listener)
  return () => { fileListeners().delete(listener) }
}
export function notifyPersonaAgentFileSaved(): void {
  for (const listener of fileListeners()) listener()
}

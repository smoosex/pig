/* Pig's main bundle and jiti plugin instances share one process, so controls can cancel workers immediately. */
const key = Symbol.for('pig:persona:control-listeners')
type Listener = () => void
const shared = globalThis as typeof globalThis & { [key]?: Set<Listener> }
function listeners(): Set<Listener> { return shared[key] ??= new Set() }
export function onPersonaControlsChanged(listener: Listener): () => void {
  listeners().add(listener)
  return () => { listeners().delete(listener) }
}
export function notifyPersonaControlsChanged(): void {
  for (const listener of listeners()) listener()
}

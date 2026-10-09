/** Main-only invalidation signal, shared by management actions and deferred session reloads. */
const listeners = new Set<() => void>()
export function onToolSettingsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function emitToolSettingsChanged(): void {
  for (const listener of listeners) listener()
}

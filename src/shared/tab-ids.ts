/** Changes tabs are persisted by main and restored by the renderer using the same opaque id. */
export function changesTabId(cwd: string): string {
  return `diff:${cwd}`
}

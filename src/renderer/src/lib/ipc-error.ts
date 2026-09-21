/**
 * Electron prefixes a rejected `invoke` with the channel it went through: `Error invoking remote method
 * 'files:read': Error: EACCES: permission denied`. Anything shown to a reader wants main's own words.
 */
export function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

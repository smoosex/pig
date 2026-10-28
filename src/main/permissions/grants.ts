/**
 * "Allow for this session" answers. In memory only: they end with the session and never persist,
 * so a restart asks again. A subagent asks with its parent's id and therefore shares them.
 */
const grants = new Map<string, Set<string>>()

export function hasSessionGrant(sessionId: string, keys: readonly string[]): boolean {
  const own = grants.get(sessionId)
  return own !== undefined && keys.some((key) => own.has(key))
}

export function grantSession(sessionId: string, key: string): void {
  const own = grants.get(sessionId) ?? new Set<string>()
  own.add(key)
  grants.set(sessionId, own)
}

export function forgetSessionGrants(sessionId: string): void {
  grants.delete(sessionId)
}

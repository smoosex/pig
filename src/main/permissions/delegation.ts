/** Task-scoped approval routing. A route borrows grants, never copies them or changes a mode. */
export interface ApprovalDelegation {
  controllerId: string
  check(): void
  allows(keys: readonly string[]): boolean
}
const routes = new Map<string, ApprovalDelegation>()
const listeners = new Set<(sessionId: string) => void>()

export function delegateApprovals(target: string, spec: ApprovalDelegation): () => void {
  if (target === spec.controllerId || routes.has(target) || routes.has(spec.controllerId) || [...routes.values()].some(route => route.controllerId === target)) throw new Error('Recursive or concurrent approval delegation is not allowed')
  const route: ApprovalDelegation = {
    controllerId: spec.controllerId,
    check() {
      if (routes.get(target) !== route) throw new Error('Session approval delegation expired')
      spec.check()
    },
    allows(keys) { route.check(); return spec.allows(keys) }
  }
  spec.check()
  routes.set(target, route)
  return () => {
    if (routes.get(target) !== route) return
    routes.delete(target)
    for (const listener of listeners) listener(target)
  }
}

export function approvalDelegation(target: string): ApprovalDelegation | undefined {
  const route = routes.get(target)
  if (!route) return undefined
  try { route.check(); return route } catch {
    routes.delete(target)
    for (const listener of listeners) listener(target)
    return undefined
  }
}

export function onApprovalDelegationEnded(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

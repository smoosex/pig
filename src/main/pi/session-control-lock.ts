/** A short exclusive gate for cross-session setup; normal UI input must not race configuration. */
const leases = new Map<string, symbol>()
export function reserveSessionControl(sessionId: string): { token: symbol; release(): void } {
  if (leases.has(sessionId)) throw new Error('Session configuration is in progress')
  const token = Symbol(sessionId)
  leases.set(sessionId, token)
  return { token, release: () => { if (leases.get(sessionId) === token) leases.delete(sessionId) } }
}
const uiUpdates = new Map<string, { token: symbol; release(): void; tail: Promise<void> }>()

/** UI model/thinking changes serialize together, but never queue behind an Agent-controlled task. */
export function withSessionControl<T>(sessionId: string, work: (token: symbol) => Promise<T>): Promise<T> {
  const previous = uiUpdates.get(sessionId)
  const lease = previous ?? reserveSessionControl(sessionId)
  const apply = async () => work(lease.token)
  const result = previous ? previous.tail.then(apply) : apply()
  const tail = result.then(() => {}, () => {})
  const operation = { token: lease.token, release: lease.release, tail }
  uiUpdates.set(sessionId, operation)
  void tail.then(() => {
    if (uiUpdates.get(sessionId) === operation) {
      uiUpdates.delete(sessionId)
      operation.release()
    }
  })
  return result
}

export function assertSessionControlAvailable(sessionId: string, token?: symbol): void {
  const lease = leases.get(sessionId)
  if (lease && lease !== token) throw new Error('Session configuration is in progress')
}

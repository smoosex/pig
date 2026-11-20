// Queue events only while opening a known session. The main-process snapshot cursor separates
// events already reflected in the snapshot from events that must be applied after hydration.
const opening = new Map<string, Array<{ cursor: number; apply: () => void }>>()

export function captureSessionOpenEvents(sessionId: string): (cursor?: number) => void {
  if (opening.has(sessionId)) return () => {}
  const held: Array<{ cursor: number; apply: () => void }> = []
  opening.set(sessionId, held)
  return (cursor) => {
    if (opening.get(sessionId) !== held) return
    opening.delete(sessionId)
    if (cursor !== undefined) {
      for (const event of held) {
        if (event.cursor > cursor) event.apply()
      }
    }
  }
}

export function holdSessionOpenEvent(sessionId: string, cursor: number, apply: () => void): boolean {
  const held = opening.get(sessionId)
  if (!held) return false
  held.push({ cursor, apply })
  return true
}

import { withSource } from './session-registry'
import { displayWindow, turnWindow } from './session-source'
import type { DisplayTurnsResult } from '../../shared/api'

export type { DisplayAnswer, DisplayTurn, DisplayUser, DisplayTurnsResult } from '../../shared/api'

export { displayTurnsFromEntries } from './session-display-model'

/** The tail of the branch, plus the turn weights the minimap needs for the turns it does not hold. */
export async function getDisplayTurns(sessionId: string): Promise<DisplayTurnsResult> {
  return withSource(sessionId, displayWindow)
}

/** Older turns for a reader who scrolled past the loaded window. */
export async function getTurnWindow(
  sessionId: string,
  start: number,
  count: number
): Promise<DisplayTurnsResult> {
  return withSource(sessionId, (source) => turnWindow(source, start, count))
}

/** One turn's process disclosure: read without projecting the rest of the branch. */
export async function getTurnMessages(sessionId: string, turnId: string): Promise<unknown[]> {
  return withSource(sessionId, (source) => source.turnMessages(turnId))
}

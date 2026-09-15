import { sessionManagerFor } from './session-registry'
import { displayResultFor, displayTurnsFromEntries, turnMessagesFromEntries } from './session-display-model'
import type { DisplayTurnsResult } from '../../shared/api'

export type { DisplayAnswer, DisplayTurn, DisplayUser, DisplayTurnsResult } from '../../shared/api'

export { displayTurnsFromEntries }

export function getDisplayTurns(sessionId: string): DisplayTurnsResult {
  return displayResultFor(sessionManagerFor(sessionId))
}

export function getTurnMessages(sessionId: string, turnId: string): unknown[] {
  return turnMessagesFromEntries(sessionManagerFor(sessionId).getBranch(), turnId)
}

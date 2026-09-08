import { sessionManagerFor } from './session-registry'
import {
  displayTurnsFromEntries,
  turnMessagesFromEntries,
  type DisplayAnswer,
  type DisplayTurn,
  type DisplayUser
} from './session-display-model'

export type { DisplayAnswer, DisplayTurn, DisplayUser }

export interface DisplayTurnsResult {
  leafId: string | null
  turns: DisplayTurn[]
}

export { displayTurnsFromEntries }

export function getDisplayTurns(sessionId: string): DisplayTurnsResult {
  const sessionManager = sessionManagerFor(sessionId)
  return { leafId: sessionManager.getLeafId(), turns: displayTurnsFromEntries(sessionManager.getBranch()) }
}

export function getTurnMessages(sessionId: string, turnId: string): unknown[] {
  return turnMessagesFromEntries(sessionManagerFor(sessionId).getBranch(), turnId)
}

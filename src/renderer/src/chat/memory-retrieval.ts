/** Attach tab-lifetime recall diagnostics without changing Pi messages or lazy process bodies. */
import type { LongTermRetrievalTrace } from '../../../shared/long-term-memory'
import type { Turn } from './turns'

export function withMemoryRetrieval(turn: Turn, traces: Record<string, LongTermRetrievalTrace>): Turn {
  const trace = turn.id && !turn.id.startsWith('live:') ? traces[turn.id]
    : Object.values(traces).find(item => item.renderKey === turn.renderKey)
  return trace ? { ...turn, memoryRetrieval: trace } : turn
}

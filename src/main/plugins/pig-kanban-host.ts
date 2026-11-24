/** Jiti-loaded Kanban tools share main's scoped Kanban service through this global registry. */
import type { KanbanAgentHost } from '../../shared/kanban'

const key = Symbol.for('pig:kanban-agent-host')
type Slot = Record<symbol, KanbanAgentHost | undefined>

export function registerKanbanAgentHost(host: KanbanAgentHost): void {
  ;(globalThis as Slot)[key] = host
}

export function kanbanAgentHost(): KanbanAgentHost | undefined {
  return (globalThis as Slot)[key]
}

/**
 * Presentation groups preserve Pi's event order. Only adjacent work of the same
 * kind is clustered, so intervening assistant text remains in its original place.
 */
import type { BashExecutionMessage, CustomMessage } from '../../pi/types'
import type { ProcessItem, ToolStep } from '../../chat/turns'

export type IconKind = 'thinking' | 'bash' | 'file' | 'tool'

export function stackKindForTool(name: string): IconKind {
  if (name === 'bash') return 'bash'
  if (name === 'read' || name === 'write' || name === 'edit') return 'file'
  return 'tool'
}

export function iconKinds(items: ProcessItem[]): IconKind[] {
  const kinds: IconKind[] = []
  const seen = new Set<IconKind>()
  const push = (kind: IconKind) => {
    if (seen.has(kind)) return
    seen.add(kind)
    kinds.push(kind)
  }
  for (const item of items) {
    if (item.kind === 'thinking') push('thinking')
    else if (item.kind === 'bash') push('bash')
    else if (item.kind === 'custom') push('tool')
    else if (item.kind === 'tools') {
      for (const step of item.tools) push(stackKindForTool(step.name))
    }
  }
  return kinds
}

export type WorkRow =
  | Extract<ProcessItem, { kind: 'thinking' }>
  | { kind: 'tools'; steps: ToolStep[] }
  | { kind: 'bash'; messages: BashExecutionMessage[] }
  | { kind: 'custom'; message: CustomMessage }

export function clusterWork(items: ProcessItem[]): WorkRow[] {
  const rows: WorkRow[] = []
  for (const item of items) {
    // Compactions are lifted out of the work list by the turn view.
    if (item.kind === 'compaction') continue
    if (item.kind === 'thinking') {
      rows.push({ ...item })
      continue
    }
    if (item.kind === 'tools') {
      for (const step of item.tools) {
        const last = rows[rows.length - 1]
        if (last?.kind === 'tools' && last.steps[0].name === step.name) last.steps.push(step)
        else rows.push({ kind: 'tools', steps: [step] })
      }
      continue
    }
    if (item.kind === 'bash') {
      const last = rows[rows.length - 1]
      if (last?.kind === 'bash') last.messages.push(item.message)
      else rows.push({ kind: 'bash', messages: [item.message] })
      continue
    }
    if (item.kind === 'custom') rows.push({ kind: 'custom', message: item.message })
  }
  return rows
}

export function processToolNames(items: ProcessItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === 'tools') return item.tools.map((step) => step.name)
    return item.kind === 'bash' ? ['bash'] : []
  })
}

/** Keep first-use order, matching the order of the group's stacked icons. */
export function toolUsageSummary(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, count]) => `${name} × ${count}`).join(' · ')
}

export function processSegments(items: ProcessItem[]): Array<{ kind: 'text'; text: string } | { kind: 'group'; items: ProcessItem[] }> {
  const segments: Array<{ kind: 'text'; text: string } | { kind: 'group'; items: ProcessItem[] }> = []
  let group: ProcessItem[] = []
  const flush = () => {
    if (group.length === 0) return
    segments.push({ kind: 'group', items: group })
    group = []
  }
  for (const item of items) {
    if (item.kind === 'text') {
      flush()
      segments.push({ kind: 'text', text: item.text })
    } else {
      group.push(item)
    }
  }
  flush()
  return segments
}

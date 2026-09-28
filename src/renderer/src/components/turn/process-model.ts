/**
 * Presentation groups preserve Pi's event order. Only adjacent work of the same
 * kind is clustered, so intervening assistant text remains in its original place.
 */
import type { BashExecutionMessage, CustomMessage } from '../../pi/types'
import type { MessageKey } from '../../../../shared/i18n'
import type { ProcessItem, ToolStep } from '../../chat/turns'

export type IconKind = 'thinking' | 'bash' | 'file' | 'tool'

function stackKindForTool(name: string): IconKind {
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
    else if (item.kind === 'custom' || item.kind === 'summary') push('tool')
    else if (item.kind === 'tools') {
      for (const step of item.tools) push(stackKindForTool(step.name))
    }
  }
  return kinds
}

export type WorkRow =
  | { kind: 'thinking'; text: string; durationMs: number }
  | { kind: 'tools'; steps: ToolStep[] }
  | { kind: 'bash'; messages: BashExecutionMessage[] }
  | { kind: 'custom'; message: CustomMessage }
  | { kind: 'summary'; titleKey: MessageKey; text: string }

export function clusterWork(items: ProcessItem[]): WorkRow[] {
  const rows: WorkRow[] = []
  for (const item of items) {
    // Compactions are lifted out of the work list by the turn view.
    if (item.kind === 'compaction') continue
    if (item.kind === 'thinking') {
      rows.push({ kind: 'thinking', text: item.text, durationMs: item.durationMs })
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
    else if (item.kind === 'summary')
      rows.push({ kind: 'summary', titleKey: item.titleKey, text: item.text })
  }
  return rows
}

export function countTools(items: ProcessItem[]): number {
  let n = 0
  for (const item of items) {
    if (item.kind === 'tools') n += item.tools.length
    else if (item.kind === 'bash') n += 1
  }
  return n
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

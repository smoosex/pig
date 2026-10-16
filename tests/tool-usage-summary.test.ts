import { expect, test } from 'bun:test'
import type { ProcessItem } from '../src/renderer/src/chat/turns'
import { processToolNames, toolUsageSummary } from '../src/renderer/src/components/turn/process-model'

test('tool summaries count by name and preserve first-use order', () => {
  expect(toolUsageSummary(['bash', 'read', 'bash', 'edit', 'read'])).toBe('bash × 2 · read × 2 · edit × 1')
  expect(toolUsageSummary(['web_search'])).toBe('web_search × 1')
  expect(toolUsageSummary([])).toBe('')
})

test('conversation summaries count tool calls and standalone bash, not thinking or custom messages', () => {
  const items: ProcessItem[] = [
    { kind: 'thinking', text: 'plan', durationMs: 0, live: false },
    { kind: 'tools', tools: [
      { id: '1', name: 'read', args: {} },
      { id: '2', name: 'bash', args: {} },
      { id: '3', name: 'read', args: {} }
    ] },
    { kind: 'bash', message: { role: 'bashExecution', command: 'pwd', output: '', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } },
    { kind: 'custom', message: { role: 'custom', customType: 'notice', content: '', display: true, timestamp: 2 } }
  ]
  expect(toolUsageSummary(processToolNames(items))).toBe('read × 2 · bash × 2')
})

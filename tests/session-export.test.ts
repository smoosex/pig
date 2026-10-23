import { expect, test } from 'bun:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { exportSession } from '../src/main/pi/session-actions'

for (const themeName of ['light', 'dark'] as const) {
  test(`HTML export explicitly uses Pig's ${themeName} appearance`, async () => {
    const calls: unknown[][] = []
    const session = {
      async exportToHtml(...args: unknown[]) {
        calls.push(args)
        return 'session.html'
      }
    } as unknown as AgentSession
    expect(await exportSession(session, 'session.html', themeName)).toBe('session.html')
    expect(calls).toEqual([['session.html', { themeName }]])
  })
}

test('JSONL export is independent of appearance', async () => {
  const calls: string[] = []
  const session = {
    exportToJsonl(path: string) {
      calls.push(path)
      return path
    }
  } as unknown as AgentSession
  expect(await exportSession(session, 'session.jsonl', 'light')).toBe('session.jsonl')
  expect(calls).toEqual(['session.jsonl'])
})

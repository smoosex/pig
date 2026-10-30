import { describe, expect, mock, test } from 'bun:test'

const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
const states = new Map<string, unknown>([['caller', { win }], ['target', { win }]])
const leaf = 'leaf'
let entries: unknown[] = []
let afterRead: (() => void) | undefined
mock.module('../src/main/pi/session-registry', () => ({
  sessionState(id: string) { const state = states.get(id); if (!state) throw new Error('not open'); return state },
  async withSource(_id: string, read: (source: unknown) => unknown) {
    const result = read({ leafId: () => leaf, branch: () => entries })
    const change = afterRead
    afterRead = undefined
    change?.()
    return result
  }
}))
const { registerSessionReader } = await import('../src/main/pi/session-read')
const { sessionReadHost } = await import('../src/main/plugins/pig-session-host')
registerSessionReader()

describe('session reader', () => {
  test('returns only user and completed final assistant text, with bounded pagination', async () => {
    entries = [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'secret' }] } },
      { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'intermediate' }, { type: 'toolCall' }] } },
      { type: 'message', message: { role: 'toolResult', content: 'secret' } },
      { type: 'custom', data: 'hidden' },
      { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'x'.repeat(9000) }] } }
    ]
    const result = JSON.parse(await sessionReadHost()!.read('caller', 'target', 1, 1))
    expect(result.total).toBe(2)
    expect(result.messages[0].text).toHaveLength(8000)
    expect(result.messages[0].truncated).toBe(true)
    expect(result.hasMore).toBe(false)
  })
  test('rejects a session replacement during the read', async () => {
    afterRead = () => { states.set('target', { win }) }
    await expect(sessionReadHost()!.read('caller', 'target', 0, 1)).rejects.toThrow('Session changed')
  })
  test('rejects same session, foreign window, and invalid limits', async () => {
    await expect(sessionReadHost()!.read('caller', 'caller', 0, 1)).rejects.toThrow()
    states.set('foreign', { win: { ...win } })
    await expect(sessionReadHost()!.read('caller', 'foreign', 0, 1)).rejects.toThrow()
    await expect(sessionReadHost()!.read('caller', 'target', 0, 21)).rejects.toThrow()
  })
})

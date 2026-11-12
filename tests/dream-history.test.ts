import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { runSelf } from './helpers/subprocess'

if (process.argv.includes('--dream-history-fixture')) {
  const fs = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pig-topic-history-')))
  mock.module('../src/main/features/memory/long-term/access', () => ({ isChatMemoryCwd: () => false, memoryAccess: async () => ({ project: '/project', cwd: '/project', session: 's' }) }))
  const { DreamHistory, indexDreamSource } = await import('../src/main/features/memory/dream/history')
  const path = join(root, 'history.jsonl')
  const source = { id: 's', title: 'History', cwd: '/project', path }
  let parent: string | null = null
  const timestamp = '2026-11-11T00:00:00Z'
  fs.writeFileSync(path, JSON.stringify({ type: 'session', id: 's', cwd: '/project', version: 3 }) + '\n')
  const append = (id: string, message: unknown) => {
    fs.appendFileSync(path, JSON.stringify({ type: 'message', id, parentId: parent, timestamp, message }) + '\n'); parent = id
  }
  append('u0', { role: 'user', content: 'Earlier context' })
  append('a0', { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Earlier answer' }] })
  append('u1', { role: 'user', content: 'needle ' + 'x'.repeat(40000) })
  append('calls', { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'TOOL_COMMAND' } }] })
  append('huge', { role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [{ type: 'text', text: 'z'.repeat(9 * 1024 * 1024) }] })
  append('a1', { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'text', text: 'Final needle answer' }] })
  append('u2', { role: 'user', content: 'Incomplete round needle' })
  try {
    const index = await indexDreamSource(source)
    assert.equal(index.turns.length, 3)
    const history = new DreamHistory([source])
    await assert.rejects(history.search({ query: '' }), /DREAM_QUERY/)
    await assert.rejects(history.read({ sessionId: 's', turnId: 'u1' }), /search first/)
    const hits = await history.search({ query: 'needle' })
    assert.equal(hits.items.length, 1, 'incomplete rounds are not final replies')
    const json = JSON.stringify(hits)
    assert.ok(!json.includes('TOOL_COMMAND') && !json.includes('HIDDEN'))
    assert.ok(json.includes('projectId'))
    let cursor: string | undefined, content = ''
    do {
      const page = await history.read({ sessionId: 's', turnId: 'u1', before: 0, after: 0, cursor })
      content += (page.records as { text: string }[]).map(record => record.text).join('')
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.equal(content, 'needle ' + 'x'.repeat(40000) + 'Final needle answer')
    const context = JSON.stringify(await history.read({ sessionId: 's', turnId: 'u1' }))
    assert.match(context, /Earlier context/)
    let tools = '', next: string | undefined
    do {
      const page = await history.tools({ sessionId: 's', turnId: 'u1', cursor: next })
      tools += page.text; next = page.nextCursor ?? undefined
    } while (next)
    assert.match(tools, /TOOL_COMMAND/)
    assert.match(tools, /record_bytes_limit/)
    assert.ok(!tools.includes('HIDDEN'))
    await assert.rejects(history.read({ sessionId: 's', turnId: 'u1', cursor: 'forged' }), /DREAM_CURSOR/)
    await history.validateReadSources()
    const original = fs.readFileSync(path, 'utf8')
    fs.writeFileSync(path, original.replace('Earlier answer', 'Changed answer'))
    await assert.rejects(history.validateReadSources(), /changed/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
} else test('topic history searches bounded records, expands located passages, pages tools and rejects changed evidence', async () => {
  const result = await runSelf(import.meta.path, ['--dream-history-fixture'])
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
})

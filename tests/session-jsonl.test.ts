import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  indexSessionFile,
  probeSessionRow,
  readAllEntries,
  readBranchEntries,
  readEntryById,
  readRows,
  readTreeEntries,
  readTailWindow,
  readTurnEntries,
  turnCount,
  turnRowsOf,
  UnsupportedSessionFile
} from '../src/main/pi/session-jsonl'

const header = (id = 'session-1', version = 3) =>
  JSON.stringify({ type: 'session', version, id, cwd: '/tmp/project', timestamp: '2026-01-01T00:00:00.000Z' })

function entry(id: string, parentId: string | null, role: string, content: unknown = id) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content, timestamp: 1 }
  })
}

function custom(id: string, parentId: string | null, data: unknown) {
  return JSON.stringify({ type: 'custom', customType: 'pig.pasted-text', data, id, parentId, timestamp: '2026-01-01T00:00:00.000Z' })
}

async function withFile(lines: string[], run: (path: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-jsonl-'))
  const path = join(root, 'session.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`)
  try {
    await run(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('probes the fields of every entry shape without parsing payloads', () => {
  const probe = (line: string) => probeSessionRow(Buffer.from(line))
  expect(probe(entry('u1', null, 'user'))).toEqual({ id: 'u1', parentId: null, type: 'message', role: 'user' })
  expect(probe(entry('a1', 'u1', 'toolResult'))).toEqual({ id: 'a1', parentId: 'u1', type: 'message', role: 'toolResult' })
  expect(probe(JSON.stringify({ type: 'model_change', id: 'm1', parentId: 'u1', provider: 'anthropic', modelId: 'x' })))
    .toEqual({ id: 'm1', parentId: 'u1', type: 'model_change', role: null })
  expect(probe(JSON.stringify({ type: 'thinking_level_change', id: 't1', parentId: 'm1', thinkingLevel: 'high' })))
    .toEqual({ id: 't1', parentId: 'm1', type: 'thinking_level_change', role: null })
  expect(probe(JSON.stringify({ type: 'session_info', id: 's1', parentId: 't1', name: 'renamed' })))
    .toEqual({ id: 's1', parentId: 't1', type: 'session_info', role: null })
  // The compacted payload of a compaction entry happens to hold both keys in their plain order.
  expect(probe(JSON.stringify({ type: 'compaction', id: 'c1', parentId: 'a1', summary: 'x', firstKeptEntryId: 'k', tokensBefore: 1 })))
    .toEqual({ id: 'c1', parentId: 'a1', type: 'compaction', role: null })
  expect(probe(JSON.stringify({ type: 'branch_summary', id: 'b1', parentId: 'a1', summary: 'x', fromId: 'f' })))
    .toEqual({ id: 'b1', parentId: 'a1', type: 'branch_summary', role: null })
})

test('reads the real keys of payload-first entries', () => {
  const probe = (line: string) => probeSessionRow(Buffer.from(line))
  expect(
    probe(JSON.stringify({ type: 'custom', customType: 'pig.pasted-text', data: { quoted: '{"id":"x","parentId":"y"}' }, id: 'c1', parentId: 'u1', timestamp: 'z' }))
  ).toEqual({ id: 'c1', parentId: 'u1', type: 'custom', role: null })
  expect(
    probe(JSON.stringify({ type: 'custom_message', customType: 'om', content: [{ type: 'text', text: '{"parentId":"nope"}' }], display: true, id: 'c2', parentId: null, timestamp: 'z' }))
  ).toEqual({ id: 'c2', parentId: null, type: 'custom_message', role: null })
})

test('refuses lines the probe cannot read instead of guessing', () => {
  const probe = (line: string) => probeSessionRow(Buffer.from(line))
  expect(probe(entry('u1', null, 'user').replace(/"id":"u1"/, '"id":"u1\\"x"'))).toBeNull()
  expect(probe('{"type":"message","id":"u1","parentId":null,"message":{"role":"user"')).toBeNull()
  expect(probe(JSON.stringify({
    type: 'message', id: 'u1', parentId: null, pad: 'x'.repeat(600), message: { role: 'user', content: 'hi' }
  }))).toBeNull()
  expect(probe('')).toBeNull()
  expect(probe('not json')).toBeNull()
})

test('drops a trailing line the probe accepted but JSON cannot parse', async () => {
  // A write cut off mid-line still ends with an inner `}`: the index must not count a turn (or a
  // leaf id) that no parser can produce.
  const broken = '{"type":"message","id":"u1","parentId":"u0","timestamp":"z","message":{"role":"user","content":"x"}'
  await withFile([header(), entry('u0', null, 'user'), broken], (path) => {
    const index = indexSessionFile(path)
    expect(index.branch.map((row) => row.id)).toEqual(['u0'])
    expect(index.leafId).toBe('u0')
    expect(turnCount(index)).toBe(1)
    expect(readBranchEntries(index).map((item) => (item as { id: string }).id)).toEqual(['u0'])
  })
})

test('refuses a file whose middle row the index cannot reproduce', async () => {
  // Balanced braces but invalid JSON (a trailing comma) passes the probe; the index keeps the row,
  // so reading it back has to fail loudly instead of serving counts the file does not support.
  const broken = '{"type":"message","id":"u1","parentId":"u0","timestamp":"z","message":{"role":"user","content":"x",}}'
  await withFile([header(), entry('u0', null, 'user'), broken, entry('a1', 'u1', 'assistant')], (path) => {
    const index = indexSessionFile(path)
    expect(index.branch.map((row) => row.id)).toEqual(['u0', 'u1', 'a1'])
    expect(() => readBranchEntries(index)).toThrow(UnsupportedSessionFile)
    expect(() => readAllEntries(index)).toThrow(UnsupportedSessionFile)
  })
})

test('keeps a trailing line whose braces only look unbalanced inside a string', async () => {
  const tricky = JSON.stringify({
    type: 'message', id: 'u1', parentId: 'u0', timestamp: 'z',
    message: { role: 'user', content: 'a } b { c \" d' }
  })
  await withFile([header(), entry('u0', null, 'user'), tricky], (path) => {
    const index = indexSessionFile(path)
    expect(index.branch.map((row) => row.id)).toEqual(['u0', 'u1'])
    expect(turnCount(index)).toBe(2)
    expect(readBranchEntries(index).map((item) => (item as { id: string }).id)).toEqual(['u0', 'u1'])
  })
})

test('indexes entries, the branch, and turn boundaries without reading payloads', async () => {
  await withFile(
    [
      header(),
      entry('u1', null, 'user'),
      entry('a1', 'u1', 'assistant'),
      entry('u2', 'a1', 'user'),
      entry('a2', 'u2', 'assistant'),
      entry('u3', 'a2', 'user')
    ],
    (path) => {
      const index = indexSessionFile(path)
      expect(index.sessionId).toBe('session-1')
      expect(index.cwd).toBe('/tmp/project')
      expect(index.entries.map((row) => row.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3'])
      expect(index.leafId).toBe('u3')
      expect(index.branch.map((row) => row.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3'])
      expect(index.turnStarts).toEqual([0, 2, 4])
      expect(turnCount(index)).toBe(3)
      expect(index.entries[0]!.role).toBe('user')
      expect(index.branch[1]!.role).toBe('assistant')
      expect(index.branch[1]!.type).toBe('message')
    }
  )
})

test('reads a turn window without dragging in the lines of an abandoned branch', async () => {
  await withFile(
    [
      header(),
      entry('u1', null, 'user'),
      entry('a1', 'u1', 'assistant'),
      // Abandoned branch: rewritten after a1, then the file continues on the real branch.
      entry('u2', 'a1', 'user', 'dropped question'),
      entry('a2', 'u2', 'assistant', 'dropped answer'),
      entry('u3', 'a1', 'user', 'kept question'),
      entry('a3', 'u3', 'assistant', 'kept answer')
    ],
    (path) => {
      const index = indexSessionFile(path)
      expect(index.entries).toHaveLength(6)
      expect(index.branch.map((row) => row.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
      expect(index.turnStarts).toEqual([0, 2])
      const rows = turnRowsOf(index, 'u3')!
      expect(rows.map((row) => row.id)).toEqual(['u3', 'a3'])
      const entries = readTurnEntries(index, 1, 2)
      expect(entries.map((item) => (item as { id: string }).id)).toEqual(['u3', 'a3'])
      expect(JSON.stringify(entries)).not.toContain('dropped')
      expect(readEntryById(index, 'a2')).toMatchObject({ id: 'a2' })
    }
  )
})

test('probes the real id and parentId when a payload contains the same keys', async () => {
  await withFile(
    [
      header(),
      entry('u1', null, 'user'),
      custom('c1', 'u1', {
        bodyLength: 5,
        contentLength: 5,
        quoted: '{"id":"bogus","parentId":"bogus-parent"}'
      }),
      entry('a1', 'c1', 'assistant')
    ],
    (path) => {
      const index = indexSessionFile(path)
      expect(index.byId.get('c1')!.parentId).toBe('u1')
      expect(index.leafId).toBe('a1')
      expect(index.branch.map((row) => row.id)).toEqual(['u1', 'c1', 'a1'])
    }
  )
})

test('parses a line in full when the probe cannot reach its fields', async () => {
  const padded = JSON.stringify({
    type: 'message',
    id: 'u1',
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    extension: { padding: 'x'.repeat(600) },
    message: { role: 'user', content: 'hello', timestamp: 1 }
  })
  await withFile([header(), padded], (path) => {
    const index = indexSessionFile(path)
    expect(index.branch).toHaveLength(1)
    expect(index.branch[0]).toMatchObject({ id: 'u1', parentId: null, role: 'user' })
  })
})

test('skips malformed lines the way the SDK does', async () => {
  await withFile(
    [header(), '{ not json', entry('u1', null, 'user'), '', entry('a1', 'u1', 'assistant')],
    (path) => {
      const index = indexSessionFile(path)
      expect(index.branch.map((row) => row.id)).toEqual(['u1', 'a1'])
      expect(turnCount(index)).toBe(1)
    }
  )
})

test('reads the tail without indexing the whole file', async () => {
  const lines = [header()]
  for (let turn = 0; turn < 12; turn++) {
    const previous = turn === 0 ? null : `a${turn - 1}`
    lines.push(entry(`u${turn}`, previous, 'user', `question ${turn} ${'x'.repeat(4000)}`))
    lines.push(entry(`a${turn}`, `u${turn}`, 'assistant', `answer ${turn}`))
  }
  await withFile(lines, (path) => {
    const window = readTailWindow(path, { bytes: 4096, minTurns: 3 })
    expect(window.hasMoreAbove).toBe(true)
    expect(window.leafId).toBe('a11')
    const ids = window.entries.map((item) => (item as { id: string }).id)
    expect(ids[ids.length - 1]).toBe('a11')
    expect(ids.filter((id) => id.startsWith('u'))).toHaveLength(3)
    expect(ids[0]!.startsWith('u')).toBe(true)

    // Asking for more turns than the file has reads it through, so nothing is left above.
    const whole = readTailWindow(path, { bytes: 8, minTurns: 24 })
    expect(whole.hasMoreAbove).toBe(false)
    expect(whole.entries).toHaveLength(24)
  })
})

test('reads one entry on demand', async () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'QUJD' }
  await withFile([header(), entry('u1', null, 'user', [{ type: 'text', text: '看图' }, image])], (path) => {
    const index = indexSessionFile(path)
    const parsed = readEntryById(index, 'u1') as { message: { content: unknown[] } }
    expect(parsed.message.content[1]).toEqual(image)
    expect(readEntryById(index, 'missing')).toBeUndefined()
  })
})

test('refuses what it cannot prove instead of guessing', async () => {
  await withFile([header('session-1', 2), entry('u1', null, 'user')], (path) => {
    expect(() => indexSessionFile(path)).toThrow(UnsupportedSessionFile)
  })
  await withFile([header(), entry('u1', null, 'user'), entry('u1', 'u1', 'assistant')], (path) => {
    expect(() => indexSessionFile(path)).toThrow('duplicate entry ids')
  })
  await withFile([header(), entry('u1', 'ghost', 'user')], (path) => {
    expect(() => indexSessionFile(path)).toThrow('missing parent')
  })
  await withFile(['not a session at all'], (path) => {
    expect(() => indexSessionFile(path)).toThrow('no session header')
  })
})

test('coalesces adjacent lines into one read', async () => {
  await withFile([header(), entry('u1', null, 'user'), entry('a1', 'u1', 'assistant')], (path) => {
    const index = indexSessionFile(path)
    const entries = readRows(path, index.branch)
    expect(entries.map((item) => (item as { id: string }).id)).toEqual(['u1', 'a1'])
  })
})

test('mirrors the SDK settings and context usage from the file alone', async () => {
  const { mock } = await import('bun:test')
  mock.module('electron', () => ({ app: { isPackaged: false } }))
  const { SessionManager, estimateTokens } = await import('@earendil-works/pi-coding-agent')
  const { fileContextUsage, fileSettings, tokenStatsFor } = await import('../src/main/pi/session-controls')

  const assistant = (id: string, parentId: string, usage: Record<string, number>) =>
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        provider: 'acme',
        model: 'one',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'answer' }],
        usage,
        timestamp: 2
      }
    })
  const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 }
  const turn = (id: string, parentId: string | null) => [
    entry(id, parentId, 'user', '问一句'),
    assistant(`a-${id}`, id, id === 'u1' ? usage : { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 })
  ]
  const lines = [
    header(),
    JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, provider: 'acme', modelId: 'one', timestamp: 'z' }),
    JSON.stringify({ type: 'thinking_level_change', id: 't1', parentId: 'm1', thinkingLevel: 'high', timestamp: 'z' }),
    ...turn('u1', 't1'),
    ...turn('u2', 'a-u1'),
    entry('u3', 'a-u2', 'user', '还没回答')
  ]

  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const session = { sessionId: index.sessionId, path, index, cwd: index.cwd }
    const reference = SessionManager.open(path).buildSessionContext()
    const settings = fileSettings(session)
    expect(settings.model).toEqual(reference.model)
    expect(settings.thinkingLevel).toBe(reference.thinkingLevel as 'high')

    // The last usable usage plus the estimates of the messages behind it, as getContextUsage reports.
    const messages = reference.messages as Array<{ role: string; stopReason?: string; usage?: Record<string, number> }>
    let expected = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!
      if (message.role !== 'assistant' || !message.usage) continue
      expected = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
      for (let j = i + 1; j < messages.length; j++) expected += estimateTokens(messages[j] as never)
      break
    }
    expect(fileContextUsage(session, { contextWindow: 1000 } as never)?.tokens).toBe(expected)

    // Nothing usable after a compaction: the SDK reports no size at all.
    await writeFile(
      path,
      `${[...lines, JSON.stringify({ type: 'compaction', id: 'c1', parentId: 'u3', summary: 's', firstKeptEntryId: 'u1', tokensBefore: 99, timestamp: 'z' })].join('\n')}\n`
    )
    const after = indexSessionFile(path)
    const afterSession = { kind: 'file', sessionId: after.sessionId, path, index: after, cwd: '/tmp' }
    expect(
      fileContextUsage(afterSession as never, { contextWindow: 1000 } as never)
    ).toEqual({ tokens: null, contextWindow: 1000, percent: null })

    // Lifetime spend covers every assistant line in the file and is only paid when it is asked for.
    const first = await tokenStatsFor(afterSession as never)
    expect(first).toEqual({ input: 15, output: 3, cacheRead: 3, cacheWrite: 0, total: 21 })
    expect(await tokenStatsFor(afterSession as never)).toBe(first)

    const live = {
      kind: 'live',
      sessionId: index.sessionId,
      cwd: '/tmp',
      unsubscribe: () => {},
      agentSession: { sessionManager: SessionManager.open(path) }
    }
    expect(await tokenStatsFor(live as never)).toEqual({
      input: 15,
      output: 3,
      cacheRead: 3,
      cacheWrite: 0,
      total: 21
    })
  })
})

test('a hidden custom message is skipped instead of opening a turn', async () => {
  const hidden = (display: boolean) => JSON.stringify({
    type: 'custom_message',
    customType: 'om',
    content: [{ type: 'text', text: 'note' }],
    display,
    id: `h${display ? 1 : 0}`,
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z'
  })
  await withFile([header(), hidden(false), entry('u1', 'h0', 'user'), entry('a1', 'u1', 'assistant')], (path) => {
    const index = indexSessionFile(path)
    expect(index.entries.map((row) => row.hidden === true)).toEqual([true, false, false])
    expect(index.turnStarts).toEqual([1])
    expect(turnCount(index)).toBe(1)
  })
  await withFile([header(), hidden(true), entry('u1', 'h1', 'user'), entry('a1', 'u1', 'assistant')], (path) => {
    const index = indexSessionFile(path)
    expect(index.entries.map((row) => row.hidden === true)).toEqual([false, false, false])
    expect(index.turnStarts).toEqual([0, 1])
  })
})

test('reduces tool results and compactions to the fields a tree label needs', async () => {
  const toolResult = JSON.stringify({
    type: 'message',
    id: 'r1',
    parentId: 'u1',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'x'.repeat(4096) }],
      isError: false,
      timestamp: 1
    }
  })
  const compaction = JSON.stringify({
    type: 'compaction',
    id: 'c1',
    parentId: 'r1',
    timestamp: '2026-01-01T00:00:00.000Z',
    summary: 'y'.repeat(2048),
    firstKeptEntryId: 'u1',
    tokensBefore: 123456
  })
  await withFile([header(), entry('u1', null, 'user'), toolResult, compaction], (path) => {
    const index = indexSessionFile(path)
    const reduced = readTreeEntries(index) as unknown as Array<Record<string, any>>
    expect(reduced.map((item) => item.id)).toEqual(['u1', 'r1', 'c1'])
    expect(reduced[1]!.message).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [] })
    expect(reduced[2]).toMatchObject({ type: 'compaction', tokensBefore: 123456 })
    // Only the tree path reduces: a full read still hands over the payloads.
    expect(JSON.stringify(readAllEntries(index))).toContain('x'.repeat(4096))
    expect(readTreeEntries(index)).toHaveLength(3)
  })
})

test('reads a reduced row the slow way when its bytes are not the expected shape', async () => {
  const odd = JSON.stringify({
    type: 'message',
    id: 'r1',
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'toolResult', toolCallId: 'call-1', content: [], isError: false, timestamp: 1 }
  })
  await withFile([header(), odd], (path) => {
    const index = indexSessionFile(path)
    const entries = readTreeEntries(index) as unknown as Array<Record<string, any>>
    // No toolName in the line: the stub cannot be trusted, so the parser reads it whole.
    expect(entries).toHaveLength(1)
    expect((entries[0]!.message as Record<string, unknown>).toolName).toBeUndefined()
    expect((entries[0]!.message as Record<string, unknown>).role).toBe('toolResult')
  })
})

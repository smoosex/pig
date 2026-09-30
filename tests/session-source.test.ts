import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { indexSessionFile, readTailWindow, readTreeEntries, SUMMARY_BYTES_CAP } from '../src/main/pi/session-jsonl'
import { turnMessagesFromEntries } from '../src/main/pi/session-display-model'
import {
  displayWindow,
  fileSource,
  managerSource,
  openTail,
  sessionIndex,
  turnWindow,
  windowUpdate
} from '../src/main/pi/session-source'
import type { SessionFileSession } from '../src/main/pi/session-state'
import { sessionTreeRows } from '../src/main/pi/session-tree'
import { composePromptText, createPastedTextMetadata, pastedTextFingerprint } from '../src/shared/pasted-text'

const STAMP = '2026-01-01T00:00:00.000Z'
const header = (id = 'source-1') =>
  JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp/project', timestamp: STAMP })

function message(id: string, parentId: string | null, role: string, content: unknown): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: STAMP,
    message: { role, content, timestamp: 1 }
  })
}

/** A turn with the pasted-text custom row the composer writes in front of its user message. */
function turnWithPaste(
  index: number,
  parentId: string | null,
  body = `question ${index}`,
  attachmentText = `payload ${index}`
): string[] {
  const attachment = { id: `paste-${index}`, text: attachmentText, byteSize: attachmentText.length }
  const content = composePromptText(body, [attachment])
  const legacy = createPastedTextMetadata(body, [attachment])
  return [
    JSON.stringify({
      type: 'custom',
      customType: 'pig.pasted-text',
      data: {
        version: 2,
        contentLength: content.length,
        contentHash: pastedTextFingerprint(content),
        attachments: legacy.attachments
      },
      id: `c${index}`,
      parentId,
      timestamp: STAMP
    }),
    JSON.stringify({
      type: 'message',
      id: `u${index}`,
      parentId: `c${index}`,
      timestamp: STAMP,
      message: { role: 'user', content, timestamp: 1 }
    }),
    message(`a${index}`, `u${index}`, 'assistant', `answer ${index}`)
  ]
}

async function withFile(lines: string[], run: (path: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-source-'))
  const path = join(root, 'session.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`)
  try {
    await run(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const manager = async (path: string) => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  return SessionManager.open(path)
}

test('counts and projects the same turns when the branch opens without a user message', async () => {
  const bash = JSON.stringify({
    type: 'message',
    id: 'b0',
    parentId: null,
    timestamp: STAMP,
    message: { role: 'bashExecution', command: 'ls', output: 'files', exitCode: 0, timestamp: 0 }
  })
  const lines = [header(), bash, message('u0', 'b0', 'user', 'q0'), message('a0', 'u0', 'assistant', 'a0'), message('u1', 'a0', 'user', 'q1'), message('a1', 'u1', 'assistant', 'a1')]

  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const file = displayWindow(fileSource(index))
    expect(file.totalTurns).toBe(3)
    expect(file.turns.map((turn) => turn.id)).toEqual(['b0', 'u0', 'u1'])
    expect(file.summary?.map((turn) => turn.id)).toEqual(['b0', 'u0', 'u1'])

    // The live projection must not cut the newest turn off the same window.
    const live = displayWindow(managerSource(await manager(path)))
    expect(live.totalTurns).toBe(3)
    expect(live.turns.map((turn) => turn.id)).toEqual(['b0', 'u0', 'u1'])
    expect(live.summary?.map((turn) => turn.id)).toEqual(['b0', 'u0', 'u1'])
  })
})

test('a command keeps its card when compaction follows it in the same turn', async () => {
  const bash = (id: string, parentId: string | null, command: string) => JSON.stringify({
    type: 'message', id, parentId, timestamp: STAMP,
    message: { role: 'bashExecution', command, output: `output from ${command}`, exitCode: 0, cancelled: false, timestamp: 2 }
  })
  const compaction = JSON.stringify({
    type: 'compaction', id: 'k0', parentId: 'b0', timestamp: STAMP,
    summary: 'compacted', tokensBefore: 1000
  })
  const lines = [header(), bash('b0', null, 'pwd'), compaction, message('a0', 'k0', 'assistant', 'later')]
  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const file = fileSource(index)
    const live = managerSource(await manager(path))
    for (const source of [file, live]) {
      const turns = displayWindow(source).turns
      expect(turns.map((turn) => turn.id)).toEqual(['b0'])
      expect(turns[0].bash?.command).toBe('pwd')
      expect(turns[0].hasProcess).toBe(true)
      // The marker travels with the projection, not with the on-demand process disclosure. Pi wrote
      // it after the command but before the answer, so it belongs inside the work, not below it.
      expect(turns[0].compactions).toEqual([
        { text: 'compacted', tokensBefore: 1000, afterAnswer: false, workMsBefore: 0, durationMs: 0 }
      ])
    }
  })
})

test('a mid-turn compaction is not work, and the turn keeps its work flag for its process', async () => {
  const compaction = JSON.stringify({
    type: 'compaction', id: 'k0', parentId: 'a0', timestamp: STAMP,
    summary: 'compacted', tokensBefore: 1000
  })
  const answer = (id: string, parentId: string, text: string) => JSON.stringify({
    type: 'message', id, parentId, timestamp: STAMP,
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 }
  })
  const lines = [
    header(),
    message('u0', null, 'user', 'q0'),
    answer('a0', 'u0', 'first answer'),
    compaction,
    answer('a1', 'k0', 'second answer')
  ]
  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const file = fileSource(index)
    const live = managerSource(await manager(path))
    for (const source of [file, live]) {
      const turns = displayWindow(source).turns
      expect(turns.map((turn) => turn.id)).toEqual(['u0'])
      expect(turns[0].answer).toEqual([{ type: 'text', text: 'second answer' }])
      expect(turns[0].compactions).toEqual([
        { text: 'compacted', tokensBefore: 1000, afterAnswer: false, workMsBefore: 0, durationMs: 0 }
      ])
    }
  })
})

test('commands after answers and consecutive commands are standalone turns in both sources', async () => {
  const bash = (id: string, parentId: string, command: string) => JSON.stringify({
    type: 'message', id, parentId, timestamp: STAMP,
    message: { role: 'bashExecution', command, output: `output from ${command}`, exitCode: 0, cancelled: false, timestamp: 2 }
  })
  const lines = [
    header(), message('u0', null, 'user', 'q0'), message('a0', 'u0', 'assistant', 'a0'),
    bash('b0', 'a0', 'pwd'), bash('b1', 'b0', 'ls'),
    message('u1', 'b1', 'user', 'q1'), message('a1', 'u1', 'assistant', 'a1')
  ]
  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    expect(index.turnStarts.map((at) => index.branch[at]?.id)).toEqual(['u0', 'b0', 'b1', 'u1'])
    const file = fileSource(index)
    const live = managerSource(await manager(path))
    for (const source of [file, live]) {
      expect(displayWindow(source).turns.map((turn) => turn.id)).toEqual(['u0', 'b0', 'b1', 'u1'])
      expect(turnWindow(source, 1, 2).turns.map((turn) => turn.bash?.command)).toEqual(['pwd', 'ls'])
      expect((source.turnMessages('b0')[0] as { command: string }).command).toBe('pwd')
      expect(source.turnMessages('b0')).toHaveLength(1)
    }
  })
})

test('every window matches the projection of the turns it asks for', async () => {
  const lines = [header(), message('u0', null, 'user', 'q0'), message('a0', 'u0', 'assistant', 'a0')]
  for (const index of [1, 2, 3]) {
    const previous = `a${index - 1}`
    lines.push(...turnWithPaste(index, previous))
  }

  await withFile(lines, (path) => {
    const source = fileSource(indexSessionFile(path))
    const all = source.turnWindow(0, source.turnCount())
    expect(all).toHaveLength(4)

    for (let start = 0; start < all.length; start++) {
      const page = turnWindow(source, start, 1)
      expect(page.startIndex).toBe(start)
      expect(page.turns).toEqual([all[start]!])
    }
    // A window that starts at a pasted turn still carries its attachment card.
    expect(turnWindow(source, 2, 1).turns[0]?.user?.textAttachments).toHaveLength(1)
  })
})

test('the tail window keeps the metadata row of the turn it starts at', async () => {
  const lines = [header()]
  let parent: string | null = null
  for (let index = 0; index < 300; index++) {
    const turn = turnWithPaste(index, parent, `question ${index}`, `payload ${index} ${'y'.repeat(2000)}`)
    lines.push(...turn)
    const answer = JSON.parse(turn[2]!) as { id: string; message: { content: string } }
    const padded = JSON.stringify({
      ...answer,
      message: { ...answer.message, content: `answer ${index} ${'x'.repeat(20_000)}` }
    })
    lines[lines.length - 1] = padded
    parent = answer.id
  }

  await withFile(lines, (path) => {
    const tail = openTail('source-1', path)
    expect(tail.display.indexPending).toBe(true)
    expect(tail.display.turns).toHaveLength(60)
    expect(tail.display.startIndex).toBe(0)
    // Whichever turn the slice starts at, its pasted text travels with it.
    expect(tail.display.turns[0]?.user?.textAttachments).toHaveLength(1)
    expect(tail.display.turns.every((turn) => turn.user?.textAttachments.length === 1)).toBe(true)

    // The same window read through the index keeps the row in front of its first turn.
    const index = indexSessionFile(path)
    const sliced = readTailWindow(path, { bytes: 1024 * 1024, minTurns: 60 })
    expect(sliced.hasMoreAbove).toBe(true)
    expect(sliced.entries[0]).toMatchObject({ type: 'custom', customType: 'pig.pasted-text' })
    expect((sliced.entries[1] as { id: string }).id).toBe((sliced.entries[0] as { id: string }).id.replace(/^c/, 'u'))
    const expected = turnWindow(fileSource(index), index.turnStarts.length - 60, 60)
    expect(expected.turns[0]?.user?.textAttachments).toHaveLength(1)
  })
})

test('summaries describe every turn of the branch for both sources', async () => {
  const lines = [header()]
  let parent: string | null = null
  for (let index = 0; index < 70; index++) {
    lines.push(message(`u${index}`, parent, 'user', index === 3 ? [
      { type: 'text', text: 'screenshot' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' }
    ] : `q${index}`))
    lines.push(message(`a${index}`, `u${index}`, 'assistant', `a${index}`))
    parent = `a${index}`
  }

  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const file = displayWindow(fileSource(index))
    expect(file.turns).toHaveLength(60)
    expect(file.startIndex).toBe(10)
    expect(file.summary).toHaveLength(70)
    expect(file.summary?.[0]).toMatchObject({ id: 'u0', hasImages: false })
    expect(file.summary?.[3]).toMatchObject({ id: 'u3', hasImages: true })

    // A live session gets the same weights, so its minimap keeps the turns the window left behind.
    const live = displayWindow(managerSource(await manager(path)))
    expect(live.startIndex).toBe(10)
    expect(live.summary).toHaveLength(70)
    expect(live.summary?.map((summary) => summary.id)).toEqual(file.summary?.map((summary) => summary.id))
    expect(live.summary?.[3]).toMatchObject({ hasImages: true })

    // The weights come from the index scan: the file is gone and the summary is still there.
    await rm(path, { force: true })
    expect(fileSource(index).turnSummaries()).toEqual(file.summary)
  })
})

test('both sources weigh the same turn the same way', async () => {
  // The bar length of one turn must not change when a pending file session is built, so the file
  // side (line bytes) and the manager side (the entry the SDK would write) have to agree exactly.
  const imageRow = JSON.stringify({
    type: 'message', id: 'u2', parentId: 'a1', timestamp: STAMP,
    message: { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', mimeType: 'image/png', data: 'aGk=' }] }
  })
  const lines = [
    header(),
    message('u0', null, 'user', 'plain question'),
    message('a0', 'u0', 'assistant', 'answer with a longer body '.repeat(20)),
    message('u1', 'a0', 'user', '中文问题，字长和字节长度不一样'),
    message('a1', 'u1', 'assistant', 'ok'),
    imageRow,
    message('a2', 'u2', 'assistant', 'seen')
  ]
  await withFile(lines, (path) => {
    const file = fileSource(indexSessionFile(path))
    const manager = managerSource(SessionManager.open(path))
    const fromFile = file.turnSummaries()
    const fromManager = manager.turnSummaries()
    expect(fromManager).toEqual(fromFile)
    expect(fromFile?.map((item) => item.hasImages)).toEqual([false, false, true])
    expect(fromFile?.[2]?.bytes).toBe(SUMMARY_BYTES_CAP)
    expect(fromFile?.[0]?.bytes).toBeGreaterThan(0)
  })
})

test('branch ids come from the index instead of parsing the branch', async () => {
  const lines = [header(), ...turnWithPaste(0, null), ...turnWithPaste(1, 'a0'), ...turnWithPaste(2, 'a1')]
  await withFile(lines, (path) => {
    const index = indexSessionFile(path)
    const file = fileSource(index)
    expect(file.branchIds()).toEqual(file.branch().map((entry) => entry.id))
    const manager = managerSource(SessionManager.open(path))
    expect(manager.branchIds()).toEqual(manager.branch().map((entry) => entry.id))
    // The tree reads the same set through its own path.
    expect(file.branchIds().length).toBe(index.branch.length)
  })
})

test('a cut-off last line is not counted as a turn anywhere', async () => {
  // The probe accepts a line that only looks complete (an inner `}` at the end); the index has to
  // agree with what a parser can read, otherwise windows and minimap weights drift apart.
  const cut = '{"type":"message","id":"u1","parentId":"a0","timestamp":"z","message":{"role":"user","content":"lost"}'
  await withFile([header(), message('u0', null, 'user', 'q0'), message('a0', 'u0', 'assistant', 'ok'), cut], async (path) => {
    const index = indexSessionFile(path)
    expect(index.leafId).toBe('a0')
    expect(index.branch.map((row) => row.id)).toEqual(['u0', 'a0'])
    const source = fileSource(index)
    expect(source.turnCount()).toBe(1)
    const view = displayWindow(source)
    expect(view.turns.map((turn) => turn.id)).toEqual(['u0'])
    expect(view.totalTurns).toBe(1)
    expect(view.startIndex).toBe(0)
    const update = windowUpdate(source, view.turns.length)
    expect(update.startIndex).toBe(0)
    expect(update.totalTurns).toBe(1)
    expect(update.summary?.length).toBe(1)
    // The SDK agrees: one turn, and the same leaf.
    const manager = SessionManager.open(path)
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(['u0', 'a0'])
    expect(managerSource(manager).turnCount()).toBe(1)
  })
})

test('the index update places the window that was handed out, not a default tail', async () => {
  const lines = [header()]
  let parent: string | null = null
  for (let index = 0; index < 100; index++) {
    lines.push(message(`u${index}`, parent, 'user', `q${index}`))
    lines.push(message(`a${index}`, `u${index}`, 'assistant', `a${index}`))
    parent = `a${index}`
  }

  await withFile(lines, async (path) => {
    const source = fileSource(indexSessionFile(path))
    // A tail that already covered the whole file keeps its first turn aligned at zero.
    expect(windowUpdate(source, 100)).toMatchObject({ startIndex: 0, totalTurns: 100 })
    // A sliced tail is placed by the turns it really holds.
    expect(windowUpdate(source, 60)).toMatchObject({ startIndex: 40, totalTurns: 100 })
    expect(windowUpdate(source, 60).summary).toHaveLength(100)

    const whole = openTail('source-1', path)
    expect(whole.display.indexPending).toBe(false)
    expect(windowUpdate(source, whole.display.turns.length)).toMatchObject({ startIndex: 0, totalTurns: 100 })
  })
})

test('one process disclosure reads one turn instead of the branch', async () => {
  const lines = [header()]
  let parent: string | null = null
  for (let index = 0; index < 4; index++) {
    lines.push(message(`u${index}`, parent, 'user', index === 1 ? [
      { type: 'text', text: '看图' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' }
    ] : `q${index}`))
    lines.push(message(`a${index}`, `u${index}`, 'assistant', [
      { type: 'toolCall', id: `call-${index}`, name: 'read', arguments: { path: `file-${index}.ts` } }
    ]))
    lines.push(message(`r${index}`, `a${index}`, 'toolResult', [
      { type: 'toolResult', toolCallId: `call-${index}`, content: `result ${index}`, isError: false }
    ]))
    parent = `r${index}`
  }

  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const source = fileSource(index)
    const branch = source.branch()
    for (let turn = 0; turn < 4; turn++) {
      const turnId = `u${turn}`
      const fromTurn = source.turnMessages(turnId) as Array<{ role: string; content: unknown }>
      expect(fromTurn.map((item) => item.role)).toEqual(['user', 'assistant', 'toolResult'])
      expect(fromTurn as unknown[]).toEqual(turnMessagesFromEntries(branch, turnId))
    }
    // A disclosure never ships image bytes the panel cannot render.
    const disclosure = source.turnMessages('u1') as Array<{ content: unknown }>
    expect(disclosure[0]?.content).toEqual([{ type: 'text', text: '看图' }])
    expect(() => source.turnMessages('missing')).toThrow('Turn not found: missing')
  })
})

test('a failed index is retried instead of being remembered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-source-'))
  const path = join(root, 'late.jsonl')
  const session = {
    kind: 'file',
    sessionId: 'source-1',
    cwd: root,
    path,
    index: null,
    indexing: null,
    tailById: null,
    tailTurns: 0
  } as unknown as SessionFileSession
  try {
    await expect(sessionIndex(session)).rejects.toThrow()
    await writeFile(path, `${[header(), message('u0', null, 'user', 'q0')].join('\n')}\n`)
    const index = await sessionIndex(session)
    expect(index.turnStarts).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hidden custom message is not a turn of its own anywhere', async () => {
  const hidden = JSON.stringify({
    type: 'custom_message',
    customType: 'om',
    content: [{ type: 'text', text: 'hidden' }],
    display: false,
    id: 'h0',
    parentId: null,
    timestamp: STAMP
  })
  const lines = [header(), hidden, message('u0', 'h0', 'user', 'q0'), message('a0', 'u0', 'assistant', 'a0')]
  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const source = fileSource(index)
    const window = displayWindow(source)
    expect(window.turns.map((turn) => turn.id)).toEqual(['u0'])
    expect(source.turnCount()).toBe(1)
    expect(source.turnSummaries()?.map((turn) => turn.id)).toEqual(['u0'])
    // The index update describes the window the renderer was handed: no phantom bar, no empty page.
    expect(windowUpdate(source, window.turns.length)).toMatchObject({ startIndex: 0, totalTurns: 1 })
    expect(turnWindow(source, 0, 1).turns.map((turn) => turn.id)).toEqual(['u0'])
    // The live projection of the same file agrees.
    const live = managerSource(await manager(path))
    expect(displayWindow(live).turns.map((turn) => turn.id)).toEqual(['u0'])
    expect(live.turnCount()).toBe(1)
  })
})

test('the reduced tree read shows what the full read shows', async () => {
  const tool = JSON.stringify({
    type: 'message',
    id: 'r1',
    parentId: 'a0',
    timestamp: STAMP,
    message: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'x'.repeat(8192) }],
      isError: false,
      timestamp: 1
    }
  })
  const assistant = JSON.stringify({
    type: 'message',
    id: 'a0',
    parentId: 'u0',
    timestamp: STAMP,
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a.ts' } }],
      timestamp: 1
    }
  })
  const lines = [header(), message('u0', null, 'user', 'q0'), assistant, tool]
  await withFile(lines, async (path) => {
    const index = indexSessionFile(path)
    const full = fileSource(index)
    const reduced = { ...full, treeEntries: () => readTreeEntries(index) }
    const rows = sessionTreeRows(reduced)
    expect(rows).toEqual(sessionTreeRows(full))
    // The assistant row holds no text and is not current, so only the call it made and its
    // result show up: the reduced read still labels the result from the call it answers.
    expect(rows.map((row) => row.text)).toEqual(['user: q0', '[read: /tmp/a.ts]'])
  })
})

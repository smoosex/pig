import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetSessionName,
  listProject,
  onSessionNamesResolved,
  removeProjectDir,
  sessionDirForCwd
} from '../src/main/pi/session-loader'
import type { SessionNameUpdate } from '../src/shared/api'

test('project cleanup preserves colliding cwd sessions and removes only an empty directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-delete-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const firstCwd = join(root, 'a', 'b-c')
    const secondCwd = join(root, 'a', 'b', 'c')
    const dir = sessionDirForCwd(firstCwd)
    expect(sessionDirForCwd(secondCwd)).toBe(dir)
    await mkdir(dir, { recursive: true })
    const first = join(dir, 'first.jsonl')
    const second = join(dir, 'second.jsonl')
    const header = (id: string, cwd: string) => JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() }) + '\n'
    const message = (role: 'user' | 'assistant', content: string) =>
      JSON.stringify({ type: 'message', message: { role, content } }) + '\n'
    await writeFile(first, header('first', firstCwd) + message('user', 'one') + message('assistant', 'answer') + message('user', 'two'))
    await writeFile(second, header('second', secondCwd))
    expect((await listProject(firstCwd))?.sessions[0]?.size).toBe((await stat(first)).size)
    await removeProjectDir(firstCwd)
    expect(await stat(first).catch(() => null)).toBeNull()
    expect(JSON.parse(await readFile(second, 'utf8')).cwd).toBe(secondCwd)
    await removeProjectDir(secondCwd)
    expect(await stat(dir).catch(() => null)).toBeNull()
    await removeProjectDir(secondCwd)
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A name is appended to the end of a session file, so for a long session it sits far past the prefix a
 * listing reads. The listing answers with the first message and the background scan reports the name
 * after it; only a rename has to make the scan look again.
 */
test('a name appended past the prefix reaches the listing through the background scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-name-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const cwd = join(root, 'project')
  const dir = sessionDirForCwd(cwd)
  const file = join(dir, 'long.jsonl')
  const pending: Array<(updates: SessionNameUpdate[]) => void> = []
  const unsubscribe = onSessionNamesResolved((updates) => pending.shift()?.(updates))
  const nextNames = () => new Promise<SessionNameUpdate[]>((resolve) => pending.push(resolve))
  const sessionInfo = (name: string) =>
    JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'a1', timestamp: new Date().toISOString(), name })
  try {
    await mkdir(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 3, id: 'long', cwd, timestamp: new Date().toISOString() })
    const filler = JSON.stringify({ type: 'message', id: 'a1', parentId: null, message: { role: 'assistant', content: 'x'.repeat(400) } })
    // Enough lines to spill over the 64KB prefix and over the scan's own read chunk.
    const body = `${Array.from({ length: 9000 }, () => filler).join('\n')}\n`
    await writeFile(file, `${header}\n${body}${sessionInfo('旧名')}\n\n${sessionInfo('深处的名字')}\n`)

    const names = nextNames()
    expect((await listProject(cwd))?.sessions[0]?.name).toBeUndefined()
    expect(await names).toMatchObject([{ sessionId: 'long', path: file, name: '深处的名字' }])
    expect((await listProject(cwd))?.sessions[0]?.name).toBe('深处的名字')

    // Nothing re-reads the file for a name already known, however the file grew since.
    await writeFile(file, `${await readFile(file, 'utf8')}${sessionInfo('改过的名字')}\n`)
    expect((await listProject(cwd))?.sessions[0]?.name).toBe('深处的名字')

    const renamed = nextNames()
    forgetSessionName(file)
    expect((await listProject(cwd))?.sessions[0]?.name).toBeUndefined()
    expect(await renamed).toMatchObject([{ sessionId: 'long', name: '改过的名字' }])
  } finally {
    unsubscribe()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

/** The scan reads the file back in chunks, so a name line can be cut in half by a chunk boundary. */
test('a name whose line straddles a read boundary is still found', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-cut-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const cwd = join(root, 'project')
  const dir = sessionDirForCwd(cwd)
  const file = join(dir, 'cut.jsonl')
  let resolveNames: ((updates: SessionNameUpdate[]) => void) | null = null
  const unsubscribe = onSessionNamesResolved((updates) => resolveNames?.(updates))
  try {
    await mkdir(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 3, id: 'cut', cwd, timestamp: new Date().toISOString() })
    const filler = JSON.stringify({ type: 'message', id: 'a1', parentId: null, message: { role: 'assistant', content: 'x'.repeat(400) } })
    const head = `${header}\n${Array.from({ length: 200 }, () => filler).join('\n')}\n`
    const name = JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'a1', timestamp: new Date().toISOString(), name: '跨界的名字' })
    const tail = (content: string) => JSON.stringify({ type: 'message', id: 'pad', parentId: 'i1', message: { role: 'assistant', content } })
    // Mirror of the loader's read chunk. The first read covers the file's last chunk, so the pad after
    // the name is what decides whether that read starts inside the name line.
    const readBytes = 4 * 1024 * 1024
    const overhead = Buffer.byteLength(tail(''))
    const pad = readBytes - 2 - name.length + Math.floor(name.length / 2) - overhead
    await writeFile(file, `${head}${name}\n${tail('y'.repeat(pad))}\n`)
    const size = (await stat(file)).size
    const nameStart = Buffer.byteLength(head)
    expect(nameStart > 64 * 1024).toBe(true)
    expect(size - readBytes).toBeGreaterThanOrEqual(nameStart)
    expect(size - readBytes).toBeLessThan(nameStart + name.length)

    const names = new Promise<SessionNameUpdate[]>((resolve) => { resolveNames = resolve })
    expect((await listProject(cwd))?.sessions[0]?.name).toBeUndefined()
    expect(await names).toMatchObject([{ sessionId: 'cut', name: '跨界的名字' }])
  } finally {
    unsubscribe()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

/** A rename while the scan of that file is running must not be undone by the name it replaced. */
test('a rename during the scan wins over the name the scan was reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-race-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const cwd = join(root, 'project')
  const dir = sessionDirForCwd(cwd)
  const file = join(dir, 'race.jsonl')
  const updates: SessionNameUpdate[] = []
  let resolveNames: ((updates: SessionNameUpdate[]) => void) | null = null
  const unsubscribe = onSessionNamesResolved((batch) => {
    updates.push(...batch)
    resolveNames?.(batch)
  })
  try {
    await mkdir(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 3, id: 'race', cwd, timestamp: new Date().toISOString() })
    const filler = JSON.stringify({ type: 'message', id: 'a1', parentId: null, message: { role: 'assistant', content: 'x'.repeat(400) } })
    const body = `${Array.from({ length: 9000 }, () => filler).join('\n')}\n`
    await writeFile(file, `${header}\n${body}${JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'a1', name: '旧名' })}\n`)

    // The listing queues the scan; the rename lands before the scan's read of the file finishes.
    const listing = await listProject(cwd)
    expect(listing?.sessions[0]?.name).toBeUndefined()
    forgetSessionName(file)
    await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify({ type: 'session_info', id: 'i2', parentId: 'i1', name: '刚刚改的' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(updates).toEqual([])

    // The dropped scan left no answer behind, so the next listing asks again and gets the new name.
    const renamed = new Promise<SessionNameUpdate[]>((resolve) => { resolveNames = resolve })
    expect((await listProject(cwd))?.sessions[0]?.name).toBeUndefined()
    expect(await renamed).toMatchObject([{ sessionId: 'race', name: '刚刚改的' }])
    expect((await listProject(cwd))?.sessions[0]?.name).toBe('刚刚改的')
  } finally {
    unsubscribe()
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

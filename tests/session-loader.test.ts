import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { withSessionForks } from '../src/shared/session-lineage'
import {
  forgetSessionName,
  listProject,
  listProjectFiles,
  listProjects,
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
 * An image-only first message has no text to show. The listing reports that as a flag instead of a word,
 * so the row prints the placeholder in the language the reader happens to be using.
 */
test('an image-only first message is reported as a flag rather than as copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-preview-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const cwd = join(root, 'project')
    const dir = sessionDirForCwd(cwd)
    await mkdir(dir, { recursive: true })
    const line = (entry: unknown) => JSON.stringify(entry) + '\n'
    const header = (id: string) => line({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() })
    const user = (content: unknown) => line({ type: 'message', message: { role: 'user', content } })
    await writeFile(join(dir, 'img.jsonl'), header('img') + user([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]))
    const hint = '[Image: original 2992x1868, displayed at 2000x1249. Multiply coordinates by 1.50 to map to original image.]'
    await writeFile(join(dir, 'img-hint.jsonl'), header('img-hint') + user([
      { type: 'text', text: `\n\n${hint}` }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }
    ]))
    await writeFile(join(dir, 'img-hint-large.jsonl'), header('img-hint-large') + user([
      { type: 'text', text: `\n\n${hint}` }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(70 * 1024) }
    ]))
    await writeFile(join(dir, 'text.jsonl'), header('text') + user([{ type: 'text', text: '看一下截图' }]))
    // An image-only message only lends the title while no text message follows it.
    await writeFile(join(dir, 'imgtext.jsonl'), header('imgtext') + user([{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]) + user([{ type: 'text', text: '修登录按钮' }]))

    const sessions = (await listProject(cwd))?.sessions ?? []
    const image = sessions.find((session) => session.id === 'img')
    const hintedImage = sessions.find((session) => session.id === 'img-hint')
    const largeHintedImage = sessions.find((session) => session.id === 'img-hint-large')
    const text = sessions.find((session) => session.id === 'text')
    const imgtext = sessions.find((session) => session.id === 'imgtext')
    expect(image?.firstMessage).toBe('')
    expect(image?.firstMessageIsImage).toBe(true)
    expect(hintedImage?.firstMessage).toBe('')
    expect(hintedImage?.firstMessageIsImage).toBe(true)
    expect(largeHintedImage?.firstMessage).toBe('')
    expect(largeHintedImage?.firstMessageIsImage).toBe(true)
    expect(text?.firstMessage).toBe('看一下截图')
    expect(text?.firstMessageIsImage).toBeUndefined()
    expect(imgtext?.firstMessage).toBe('修登录按钮')
    expect(imgtext?.firstMessageIsImage).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a first prompt behind a system prompt larger than the prefix still titles the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-prompt-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const cwd = join(root, 'project')
    const dir = sessionDirForCwd(cwd)
    await mkdir(dir, { recursive: true })
    const line = (entry: unknown) => JSON.stringify(entry) + '\n'
    const header = (id: string) => line({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() })
    // Multibyte text past the 256 KiB read size puts characters across a chunk boundary.
    const system = line({ type: 'message', message: { role: 'system', content: '提示'.repeat(150 * 1024) } })
    const user = (text: string) => line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })
    await writeFile(join(dir, 'long.jsonl'), header('long') + system + user('背景色加透明度') + user('later'))
    await writeFile(join(dir, 'none.jsonl'), header('none') + system)

    const sessions = (await listProject(cwd))?.sessions ?? []
    expect(sessions.find((session) => session.id === 'long')?.firstMessage).toBe('背景色加透明度')
    expect(sessions.find((session) => session.id === 'none')?.firstMessage).toBe('')
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A fork names the file it was cloned, branched, or forked from in its own header, and the listing
 * is what the sidebar threads by: the header line sits in the prefix a scan reads, so it rides along.
 */
test('a fork reports the parent session its header names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-parent-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const cwd = join(root, 'project')
    const dir = sessionDirForCwd(cwd)
    await mkdir(dir, { recursive: true })
    const header = (id: string, parent?: string) =>
      JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString(), ...(parent ? { parentSession: parent } : {}) }) + '\n'
    const message = (text: string) =>
      JSON.stringify({ type: 'message', message: { role: 'user', content: text } }) + '\n'
    await writeFile(join(dir, 'parent.jsonl'), header('parent') + message('原文'))
    await writeFile(join(dir, 'fork.jsonl'), header('fork', relative(process.cwd(), join(dir, 'parent.jsonl'))) + message('分支'))

    const sessions = (await listProject(cwd))?.sessions ?? []
    expect(sessions.find((meta) => meta.id === 'parent')?.parentSession).toBeUndefined()
    expect(sessions.find((meta) => meta.id === 'fork')?.parentSession).toBe(join(dir, 'parent.jsonl'))
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a relative PI_CODING_AGENT_DIR produces absolute paths matching SDK fork headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pig-session-relative-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = relative(process.cwd(), join(root, 'agent'))
  try {
    const cwd = join(root, 'project')
    const manager = SessionManager.create(cwd)
    const entry = manager.appendMessage({ role: 'user', content: '原文', timestamp: 1 })
    const parentId = manager.getSessionId()
    const parentPath = manager.getSessionFile()!
    const forkPath = manager.createBranchedSession(entry)!
    const forkId = manager.getSessionId()
    expect(isAbsolute(parentPath)).toBe(true)
    expect(manager.getHeader()?.parentSession).toBe(parentPath)

    const sessions = (await listProject(cwd))!.sessions
    expect(sessions.find((meta) => meta.id === parentId)?.path).toBe(parentPath)
    expect(sessions.find((meta) => meta.id === forkId)?.path).toBe(forkPath)
    expect(sessions.find((meta) => meta.id === forkId)?.parentSession).toBe(parentPath)
    expect(withSessionForks(sessions).map((row) => row.id)).toEqual([parentId, forkId])
    expect(withSessionForks(sessions)[1]!.forkedFrom).toBe(parentPath)
    expect((await listProjects())[0]!.sessions.every((meta) => isAbsolute(meta.path))).toBe(true)
    expect((await listProjectFiles(cwd)).sort()).toEqual([parentPath, forkPath].sort())
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

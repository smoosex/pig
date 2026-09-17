import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listProject, removeProjectDir, sessionDirForCwd } from '../src/main/pi/session-loader'

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
    expect((await listProject(firstCwd))?.sessions[0]?.turnCount).toBe(2)
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

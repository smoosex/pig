import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryAccess } from '../src/main/features/memory/long-term/extension'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

test('linked worktrees share project identity, but development Chat scratch never inherits the enclosing Pig repository', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pig-memory-scopes-'))
  const root = await realpath(temp)
  const previous = process.env.PIG_DIR; process.env.PIG_DIR = join(root, '.pig')
  try {
    const git = join(root, '.git')
    await mkdir(join(git, 'objects'), { recursive: true }); await mkdir(join(git, 'refs'))
    await writeFile(join(git, 'HEAD'), 'ref: refs/heads/main\n')
    const linked = join(root, 'linked'); const metadata = join(git, 'worktrees', 'w1')
    await mkdir(linked); await mkdir(metadata, { recursive: true })
    await writeFile(join(linked, '.git'), `gitdir: ${metadata}\n`)
    await writeFile(join(metadata, 'commondir'), '../..\n')
    await writeFile(join(metadata, 'gitdir'), join(linked, '.git') + '\n')
    await writeFile(join(metadata, 'HEAD'), 'ref: refs/heads/feature\n')
    const chat = join(process.env.PIG_DIR, 'chats', 'private-chat')
    await mkdir(chat, { recursive: true })
    const context = (cwd: string, id: string) => ({ cwd, sessionManager: { getSessionId: () => id } }) as unknown as ExtensionContext
    assert.equal((await memoryAccess(context(root, 'one'))).project, git)
    assert.equal((await memoryAccess(context(linked, 'two'))).project, git)
    assert.equal((await memoryAccess(context(chat, 'chat'))).project, 'chat:chat')
  } finally {
    if (previous === undefined) delete process.env.PIG_DIR; else process.env.PIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

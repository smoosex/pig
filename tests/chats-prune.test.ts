/**
 * A chat the reader never sent to has no session file, and quitting from the chat home leaves its
 * directory behind: the renderer that would take it back dies with the process. The sweep at startup
 * is what keeps those from piling up unseen, since the chat list skips anything without sessions.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({ app: { isPackaged: false } }))
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ChatsModule = typeof import('../src/main/chats')
type LoaderModule = typeof import('../src/main/pi/session-loader')

let root = ''
let chats: ChatsModule
let loader: LoaderModule
const previousPigDir = process.env.PIG_DIR
const previousAgentDir = process.env.PI_CODING_AGENT_DIR

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pig-chats-prune-'))
  process.env.PIG_DIR = root
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  chats = await import('../src/main/chats')
  loader = await import('../src/main/pi/session-loader')
})

afterAll(async () => {
  if (previousPigDir === undefined) delete process.env.PIG_DIR
  else process.env.PIG_DIR = previousPigDir
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  await rm(root, { recursive: true, force: true })
})

test('a confirmed missing chats directory is an empty catalog', async () => {
  expect(await chats.listChats()).toEqual([])
  expect(await loader.listJsonlFiles(join(root, 'missing-sessions'))).toEqual([])
})

test('the sweep takes chat directories without a session and leaves the ones that have one', async () => {
  // Nothing to sweep yet: a first launch must not fail on a missing chats directory.
  await chats.pruneEmptyChatDirs()

  const abandoned = join(root, 'chats', '11111111-1111-1111-1111-111111111111')
  const used = join(root, 'chats', '22222222-2222-2222-2222-222222222222')
  await mkdir(abandoned, { recursive: true })
  await mkdir(used, { recursive: true })
  const sessions = loader.sessionDirForCwd(used)
  await mkdir(sessions, { recursive: true })
  await writeFile(
    join(sessions, 'chat.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'chat', cwd: used, timestamp: new Date().toISOString() }) + '\n'
  )

  await chats.pruneEmptyChatDirs()

  expect(await stat(abandoned).catch(() => null)).toBeNull()
  expect(await stat(used).catch(() => null)).not.toBeNull()
  expect((await chats.listChats()).map((group) => group.cwd)).toEqual([used])
})

test('unreadable chat directories and session files fail the scan instead of hiding chats', async () => {
  const [group] = await chats.listChats()
  const sessionDir = loader.sessionDirForCwd(group.cwd)
  for (const path of [chats.chatsDir(), sessionDir, group.sessions[0].path]) {
    await chmod(path, 0o000)
    try {
      await assert.rejects(chats.listChats(), { code: 'EACCES' })
      if (path !== group.sessions[0].path) {
        await assert.rejects(chats.pruneEmptyChatDirs(), { code: 'EACCES' })
      }
    } finally {
      await chmod(path, path === group.sessions[0].path ? 0o600 : 0o700)
    }
  }
  expect((await chats.listChats()).map((item) => item.cwd)).toEqual([group.cwd])
})

test('a malformed complete JSONL record fails the chat scan', async () => {
  const cwd = await chats.createChatDir()
  const sessions = loader.sessionDirForCwd(cwd)
  await mkdir(sessions, { recursive: true })
  await writeFile(join(sessions, 'broken.jsonl'), '{broken JSON}\n')
  await assert.rejects(chats.listChats(), SyntaxError)
})

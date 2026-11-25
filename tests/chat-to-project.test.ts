/**
 * Integration tests for converting a standalone Chat into a dedicated Project directory:
 * - Default `$HOME/pig_projects` and custom parent directory resolution
 * - Copying existing files from `$PIG_DIR/chats/<id>` into the new project folder
 * - Transferring Pi JSONL session history (rewriting header `cwd` while preserving entry lines,
 *   relocating bookmarks, Kanban `linkedSessions`, and subagent `parentSessionFile` references)
 * - Keeping original chat intact when `transferSession: false`
 * - Refusing non-empty existing target directories without clobbering files
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { replyBookmarkId } from '../src/shared/bookmarks'
import { runSelf } from './helpers/subprocess.ts'

async function runFixture(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pig-chat-to-project-')))
  const fakeHome = resolve(join(root, 'home'))
  const pigDir = resolve(join(root, 'pig'))
  const piAgentDir = resolve(join(root, 'pi-agent'))
  await mkdir(fakeHome, { recursive: true })
  await mkdir(pigDir, { recursive: true })
  await mkdir(piAgentDir, { recursive: true })

  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  process.env.PIG_DIR = pigDir
  process.env.PI_CODING_AGENT_DIR = piAgentDir

  const { mock } = await import('bun:test')
  mock.module('electron', () => ({
    app: { isPackaged: false, getPath: () => fakeHome },
    BrowserWindow: { getAllWindows: () => [] }
  }))

  try {
    const { applyLocaleSetting } = await import('../src/main/i18n')
    applyLocaleSetting('zh-CN')

    const { createChatDir } = await import('../src/main/chats')
    const { sessionDirForCwd, listProject } = await import('../src/main/pi/session-loader')
    const { bookmarks } = await import('../src/main/bookmarks')
    const { kanban } = await import('../src/main/kanban/service')
    const { watchWorktree, unwatchWorktree } = await import('../src/main/git/watch')
    const { convertChatToProject, getDefaultProjectsLocation } = await import('../src/main/chat-to-project')

    // 1. Default projects location points to $HOME/pig_projects
    const defaultLoc = await getDefaultProjectsLocation()
    assert.equal(defaultLoc.defaultParentDir, join(fakeHome, 'pig_projects'))
    assert.equal(defaultLoc.parentExists, false)
    assert.equal(defaultLoc.homeDir, fakeHome)

    // 2. Prepare a standalone chat with workspace files, a Pi JSONL session, bookmark, Kanban link, and subagent index
    const chatCwd = await createChatDir()
    await mkdir(join(chatCwd, 'src'), { recursive: true })
    await writeFile(join(chatCwd, 'src', 'index.ts'), 'export const hello = "world"\n')
    await writeFile(join(chatCwd, 'notes.md'), '# Prototype notes\n')

    const sessionId = '11111111-2222-3333-4444-555555555555'
    const chatSessionDir = sessionDirForCwd(chatCwd)
    await mkdir(chatSessionDir, { recursive: true })
    const oldJsonlPath = join(chatSessionDir, `2026-11-25_${sessionId}.jsonl`)
    const jsonlLines = [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: sessionId,
        timestamp: '2026-11-25T01:00:00.000Z',
        cwd: chatCwd
      }),
      JSON.stringify({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-11-25T01:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Build prototype' }] }
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-11-25T01:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] }
      })
    ]
    await writeFile(oldJsonlPath, `${jsonlLines.join('\n')}\n`)

    // Bookmark pointing at the chat session
    await bookmarks.add({
      id: replyBookmarkId(sessionId, 'a1'),
      turnId: 'u1',
      entryId: 'a1',
      kind: 'chat',
      session: {
        id: sessionId,
        path: oldJsonlPath,
        cwd: chatCwd,
        name: 'Prototype chat',
        created: '2026-11-25T01:00:00.000Z',
        modified: '2026-11-25T01:00:02.000Z',
        size: 300,
        firstMessage: 'Build prototype'
      },
      preview: 'Done!',
      createdAt: Date.now()
    })

    // Kanban issue linked to the chat session
    const { issue } = await kanban.create({ title: 'Ship prototype' })
    await kanban.linkSession([issue.number], { sessionId, cwd: chatCwd })

    // Subagent index referencing oldJsonlPath
    const subDir = join(pigDir, 'subagents', sessionId)
    await mkdir(subDir, { recursive: true })
    await writeFile(
      join(subDir, 'index.json'),
      JSON.stringify({
        version: 1,
        subagents: [{ id: 'sub-1', parentSessionFile: oldJsonlPath }]
      })
    )

    // Simulate right-hand WorkspacePanel actively watching chatCwd before conversion
    const watchLease = await watchWorktree(chatCwd)

    // 3. Convert WITH transferSession = true (default location $HOME/pig_projects/my-proto)
    const converted = await convertChatToProject({
      chatCwd,
      folderName: 'my-proto',
      transferSession: true
    })
    // Subsequent unwatch cleanup after chatCwd is already deleted must be a clean no-op
    unwatchWorktree(chatCwd, watchLease)

    const expectedProjectDir = resolve(join(fakeHome, 'pig_projects', 'my-proto'))
    assert.equal(converted.project.cwd, expectedProjectDir)
    assert.deepEqual(converted.migratedSessionIds, [sessionId])
    assert.equal(converted.project.sessions.length, 1)
    assert.equal(converted.project.sessions[0]?.id, sessionId)

    // Files moved to new project, old chat dir removed
    assert.equal(
      await readFile(join(expectedProjectDir, 'src', 'index.ts'), 'utf8'),
      'export const hello = "world"\n'
    )
    assert.equal(await readFile(join(expectedProjectDir, 'notes.md'), 'utf8'), '# Prototype notes\n')
    assert.equal(existsSync(chatCwd), false)
    assert.equal(existsSync(oldJsonlPath), false)

    // JSONL header updated to new project cwd while message entries stay intact
    const newJsonlPath = converted.project.sessions[0]!.path
    const migratedLines = (await readFile(newJsonlPath, 'utf8')).trim().split('\n')
    assert.equal(migratedLines.length, 3)
    assert.equal((JSON.parse(migratedLines[0]!) as { cwd: string }).cwd, expectedProjectDir)
    assert.equal(migratedLines[1], jsonlLines[1])
    assert.equal(migratedLines[2], jsonlLines[2])

    // Bookmark, Kanban link, and subagent parentSessionFile all relocated cleanly
    const updatedBookmarks = await bookmarks.list()
    assert.equal(updatedBookmarks.items[0]?.kind, 'project')
    assert.equal(updatedBookmarks.items[0]?.session.cwd, expectedProjectDir)
    assert.equal(updatedBookmarks.items[0]?.session.path, newJsonlPath)

    const updatedIssue = await kanban.getByNumber(issue.number)
    assert.deepEqual(updatedIssue?.linkedSessions, [{ sessionId, cwd: expectedProjectDir }])

    const updatedSubIndex = JSON.parse(await readFile(join(subDir, 'index.json'), 'utf8')) as {
      subagents: Array<{ parentSessionFile: string }>
    }
    assert.equal(updatedSubIndex.subagents[0]?.parentSessionFile, newJsonlPath)

    // 4. Non-empty target directory is refused without overwriting existing files
    const chat2 = await createChatDir()
    await writeFile(join(chat2, 'other.txt'), 'new')
    await assert.rejects(
      convertChatToProject({
        chatCwd: chat2,
        folderName: 'my-proto',
        transferSession: false
      }),
      /不为空/
    )
    assert.equal(existsSync(join(expectedProjectDir, 'other.txt')), false)

    // 5. Convert WITH transferSession = false into a custom parent directory preserves original chat
    const customParent = join(root, 'custom-projects')
    const chat2SessionDir = sessionDirForCwd(chat2)
    await mkdir(chat2SessionDir, { recursive: true })
    const session2Id = '66666666-7777-8888-9999-000000000000'
    await writeFile(
      join(chat2SessionDir, `2026-11-25_${session2Id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id: session2Id, timestamp: '2026-11-25T02:00:00.000Z', cwd: chat2 })}\n`
    )

    const copiedOnly = await convertChatToProject({
      chatCwd: chat2,
      parentDir: customParent,
      folderName: 'fresh-proj',
      transferSession: false
    })
    assert.equal(copiedOnly.project.cwd, resolve(join(customParent, 'fresh-proj')))
    assert.deepEqual(copiedOnly.migratedSessionIds, [])
    assert.equal(await readFile(join(copiedOnly.project.cwd, 'other.txt'), 'utf8'), 'new')
    // Original chat directory and session remain untouched
    assert.equal(existsSync(chat2), true)
    assert.equal((await listProject(chat2))?.sessions.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--chat-to-project-fixture')) {
  await runFixture()
} else {
  test('converts standalone chat to project with custom/default directory and optional session transfer', async () => {
    const { exitCode, stdout, stderr } = await runSelf(
      import.meta.path,
      ['--chat-to-project-fixture'],
      { timeoutMs: 25_000 }
    )
    assert.equal(exitCode, 0, stderr || stdout)
  }, 30_000)
}

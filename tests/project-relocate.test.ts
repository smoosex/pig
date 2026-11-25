import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { replyBookmarkId } from '../src/shared/bookmarks'
import { runSelf } from './helpers/subprocess.ts'

async function fixture(): Promise<void> {
  const rawRoot = await mkdtemp(join(tmpdir(), 'pig-project-relocate-'))
  const root = await realpath(rawRoot)
  const pigDataDir = join(root, 'pig-data')
  const agentDir = join(root, 'pi-agent')
  const workspaceParent = join(root, 'workspaces')
  await mkdir(pigDataDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(workspaceParent, { recursive: true })

  process.env.PIG_DIR = pigDataDir
  process.env.PI_CODING_AGENT_DIR = agentDir

  mock.module('electron', () => ({
    BrowserWindow: { getAllWindows: () => [] },
    app: { isPackaged: false }
  }))

  const { openProjectDirectory } = await import('../src/main/project-open')
  const { forgetProjectBranches, loadOpenedWorktreeProjects, worktrees } = await import('../src/main/project-worktrees')
  const { relocateProjectDirectory, renameProjectDirectory } = await import('../src/main/project-relocate')
  const { projectSpaces } = await import('../src/main/project-spaces')
  const { kanban } = await import('../src/main/kanban/service')
  const { bookmarks } = await import('../src/main/bookmarks')
  const { rememberOpenProjectSession, loadOpenProjectSessions } = await import('../src/main/open-project-sessions')
  const { MemoryFiles, memoryRoot, projectMemoryKey } = await import('../src/main/features/memory/long-term/files')
  const { listMemoryFiles, listMemoryProjects } = await import('../src/main/features/memory/long-term/catalog')
  const { sessionDirForCwd } = await import('../src/main/pi/session-loader')
  const { readDirectory } = await import('../src/main/files/tree')
  const { readWorktreeDiff } = await import('../src/main/git/diff')
  const { git } = await import('../src/main/worktrees')

  try {
    const repoOld = join(workspaceParent, 'repo-old')
    const otherRepo = join(workspaceParent, 'repo-other')
    await mkdir(repoOld, { recursive: true })
    await mkdir(otherRepo, { recursive: true })

    // Initialize a Git repository with one commit so we can create a real managed worktree.
    await git(repoOld, ['init', '-b', 'main'])
    await git(repoOld, ['config', 'user.email', 'test@example.com'])
    await git(repoOld, ['config', 'user.name', 'Test User'])
    await writeFile(join(repoOld, 'README.md'), '# Hello\n')
    await git(repoOld, ['add', 'README.md'])
    await git(repoOld, ['commit', '-m', 'init'])

    await openProjectDirectory(repoOld)
    await openProjectDirectory(otherRepo)

    // 1. Custom Pig display alias works without renaming the directory on disk.
    const aliased = await renameProjectDirectory(repoOld, '官网重构')
    assert.equal(aliased.name, '官网重构')
    assert.equal(aliased.customName, '官网重构')
    assert.equal(aliased.cwd, repoOld)

    // Create a managed Git worktree, a Pi JSONL session, space assignment, Kanban issue, bookmark, and memory note.
    const managedWt = await worktrees.create(repoOld, { slug: 'feature' })
    const sessionManager = SessionManager.create(repoOld, sessionDirForCwd(repoOld))
    sessionManager.appendMessage({ role: 'user', content: '重构首页布局', timestamp: 100 })
    const replyEntryId = sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '已完成首页布局方案' }],
      api: 'openai-responses',
      provider: 'openai',
      model: 'gpt-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 101
    })
    const sessionId = sessionManager.getSessionId()
    const oldSessionFile = sessionManager.getSessionFile()!
    await rememberOpenProjectSession(repoOld, sessionId)

    const spaceSnap = await projectSpaces.create({ name: 'Frontend', moveProjectCwd: repoOld })
    const frontendSpaceId = spaceSnap.spaces.find((s) => s.name === 'Frontend')!.id

    const createdIssue = await kanban.create({
      title: '跟进迁移验证',
      projectCwd: repoOld
    })
    await kanban.linkSession([createdIssue.issue.number], { sessionId, cwd: repoOld })

    await bookmarks.add({
      id: replyBookmarkId(sessionId, replyEntryId),
      kind: 'project',
      turnId: 'turn-1',
      entryId: replyEntryId,
      preview: '已完成首页布局方案',
      createdAt: 101,
      session: {
        id: sessionId,
        path: oldSessionFile,
        cwd: repoOld,
        created: new Date(100).toISOString(),
        modified: new Date(101).toISOString(),
        size: 128,
        firstMessage: '重构首页布局'
      }
    })

    const oldMemKey = projectMemoryKey(join(repoOld, '.git'))
    const scopedMemory = new MemoryFiles(join(memoryRoot(), 'projects', oldMemKey), memoryRoot())
    scopedMemory.save('MEMORY.md', '# Project Notes\n- Keep layout clean\n', null)
    assert.equal((await listMemoryProjects())[0]?.name, '官网重构')

    // 2. Simulate user renaming the folder outside Pig (`repo-old` -> `repo-new`).
    const repoNew = join(workspaceParent, 'repo-new')
    await rename(repoOld, repoNew)

    // Loading opened projects must not crash on missing Git directory; marks `missing: true` and keeps sessions!
    const missingLoaded = await loadOpenedWorktreeProjects()
    assert.equal(missingLoaded.length, 2)
    assert.equal(missingLoaded[0]?.cwd, repoOld)
    assert.equal(missingLoaded[0]?.missing, true)
    assert.equal(missingLoaded[0]?.name, '官网重构')
    assert.equal(missingLoaded[0]?.sessions.some((s) => s.id === sessionId), true)

    // Missing directory reads must NOT throw GitExecError or misreport "directoryOutsideWorkspace".
    const missingDiff = await readWorktreeDiff(repoOld)
    assert.deepEqual(missingDiff, { git: false, staged: [], unstaged: [], all: [] })
    await assert.rejects(
      () => readDirectory(repoOld, ''),
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT'
    )

    // Rejects silently snapping a plain subfolder inside an already-open Git repo (`otherRepo/nested`).
    await git(otherRepo, ['init', '-b', 'main'])
    const nestedInOtherRepo = join(otherRepo, 'packages', 'sub')
    await mkdir(nestedInOtherRepo, { recursive: true })
    await assert.rejects(() => relocateProjectDirectory(repoOld, nestedInOtherRepo))

    // Even if the user ALREADY added `repoNew` to Pig first (with its own new session!),
    // relocating `repoOld` -> `repoNew` merges both projects & sessions cleanly in one step!
    await openProjectDirectory(repoNew)
    const preExistingNewSession = SessionManager.create(repoNew, sessionDirForCwd(repoNew))
    preExistingNewSession.appendMessage({ role: 'user', content: '新目录里先聊的一句', timestamp: 200 })
    const newDirSessionId = preExistingNewSession.getSessionId()

    // 3. Relocate `repoOld` -> `repoNew` and verify all state + Git worktree pointers migrate & merge cleanly.
    const relocated = await relocateProjectDirectory(repoOld, repoNew)
    assert.equal(relocated.oldCwd, repoOld)
    assert.equal(relocated.project.cwd, repoNew)
    assert.equal(relocated.project.missing, undefined)
    assert.equal(relocated.project.name, '官网重构')
    assert.deepEqual(relocated.migratedSessionIds, [sessionId])

    // Merged `repoOld` into `repoNew` without leaving duplicate entries, keeping BOTH sessions!
    const afterProjects = await loadOpenedWorktreeProjects()
    assert.deepEqual(afterProjects.map((p) => p.cwd), [otherRepo, repoNew])
    const mergedProject = afterProjects.find((p) => p.cwd === repoNew)!
    assert.equal(mergedProject.sessions.some((s) => s.id === sessionId && s.cwd === repoNew), true)
    assert.equal(mergedProject.sessions.some((s) => s.id === newDirSessionId && s.cwd === repoNew), true)

    // Migrated session JSONL header has `cwd === repoNew`, and old session file is gone.
    await assert.rejects(() => stat(oldSessionFile))
    const newSessionMeta = mergedProject.sessions.find((s) => s.id === sessionId)!
    const newHeader = JSON.parse((await readFile(newSessionMeta.path, 'utf8')).split('\n', 1)[0]!) as { cwd: string }
    assert.equal(newHeader.cwd, repoNew)

    // Managed Git worktree bidirectional pointers were repaired (`git status` works inside `managedWt.cwd`!).
    const wtStatus = await git(managedWt.cwd, ['status', '--porcelain'])
    assert.equal(wtStatus.trim(), '')
    assert.equal(mergedProject.worktrees.some((wt) => wt.cwd === managedWt.cwd && !wt.missing), true)

    // Space assignment, open workspace, Kanban issue, bookmark, and long-term memory all point to `repoNew`.
    const finalSpaces = await projectSpaces.getSnapshot()
    assert.equal(finalSpaces.assignments[repoNew], frontendSpaceId)
    assert.equal(finalSpaces.assignments[repoOld], undefined)

    const openState = await loadOpenProjectSessions()
    assert.equal(openState.workspaces.some((w) => w.cwd === repoNew && w.sessionIds.includes(sessionId)), true)

    const issueAfter = await kanban.getByNumber(createdIssue.issue.number)
    assert.equal(issueAfter?.projectCwd, repoNew)
    assert.equal(issueAfter?.linkedSessions[0]?.cwd, repoNew)

    const bms = await bookmarks.list()
    assert.equal(bms.items[0]?.session.cwd, repoNew)
    assert.equal(bms.items[0]?.session.path, newSessionMeta.path)

    const memFiles = await listMemoryFiles()
    const migratedMem = memFiles.find((f) => f.path.startsWith('projects/'))
    assert.ok(migratedMem)
    assert.equal(migratedMem.projectName, '官网重构')

    // Clearing the custom alias falls back to the new folder's basename (`repo-new`).
    const clearedAlias = await renameProjectDirectory(repoNew, '   ')
    assert.equal(clearedAlias.name, 'repo-new')
    assert.equal(clearedAlias.customName, undefined)
  } finally {
    forgetProjectBranches(join(workspaceParent, 'repo-old'))
    forgetProjectBranches(join(workspaceParent, 'repo-new'))
    forgetProjectBranches(join(workspaceParent, 'repo-other'))
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--project-relocate-fixture') {
  await fixture()
} else {
  test('project alias rename, missing folder detection, and full directory relocation migrate sessions, git worktrees, memory, spaces, kanban, and bookmarks', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--project-relocate-fixture'], { timeoutMs: 20_000 })
    assert.equal(exitCode, 0, stderr || stdout)
  }, 25_000)
}

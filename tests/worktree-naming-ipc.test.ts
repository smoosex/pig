/** Naming retries replay persisted tasks, or strictly recover the first legacy user prompt. */
import { mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const modulePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))

async function runFixture(): Promise<void> {
  const { applyLocaleSetting } = await import('../src/main/i18n')
  applyLocaleSetting('zh-CN')
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const retries: { cwd: string; text: string }[] = []
  let namingTask: string | undefined

  mock.module('electron', () => ({
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler)
      }
    }
  }))
  mock.module(modulePath('../src/main/pi/session-registry.ts'), () => ({
    closeSessionsForCwd: async () => {}
  }))
  mock.module(modulePath('../src/main/pi/session-removal.ts'), () => ({
    removeProjectSessions: async () => {}
  }))
  mock.module(modulePath('../src/main/pi/branch-namer.ts'), () => ({
    nameWorktreeBranch: async () => 'feat/named'
  }))
  mock.module(modulePath('../src/main/project-worktrees.ts'), () => ({
    loadWorktreeProject: async () => null,
    requireOpenedProject: async (cwd: string) => cwd,
    worktrees: {
      discover: async (projectCwd: string) =>
        projectCwd === '/project' ? [{ cwd: '/project-worktree' }] : [],
      exclusive: async (_projectCwd: string, fn: () => Promise<unknown>) => fn(),
      namingTask: async () => namingTask,
      retryNaming: async (cwd: string, task: () => Promise<string>) => {
        retries.push({ cwd, text: await task() })
        return { attempt: Promise.resolve() }
      }
    }
  }))
  mock.module(modulePath('../src/main/worktrees.ts'), () => ({
    git: async () => '',
    isGitProject: async () => true
  }))
  mock.module(modulePath('../src/main/chats.ts'), () => ({
    isChatCwd: () => false,
    isChatsRoot: () => false
  }))
  mock.module(modulePath('../src/main/open-project-sessions.ts'), () => ({
    removeOpenProjectWorkspaces: async () => {}
  }))

  const root = await mkdtemp(join(tmpdir(), 'pig-naming-ipc-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  try {
    const { sessionDirForCwd } = await import('../src/main/pi/session-loader')
    const { normalizeSessionPrompt } = await import('../src/main/pi/prompt-input')
    const { createPastedTextDeliveryMetadata, PASTED_TEXT_CUSTOM_TYPE } = await import('../src/shared/pasted-text')
    const { registerWorktreeIpc } = await import('../src/main/ipc/worktrees')
    registerWorktreeIpc()
    const retry = handlers.get('project:retry-worktree-naming')
    assert.ok(retry, 'the retry channel is registered')
    const cwd = '/project-worktree'
    const dir = sessionDirForCwd(cwd)
    const created = '2026-09-22T00:00:00.000Z'
    const user = (content: unknown) => ({ type: 'message', message: { role: 'user', content } })
    const setSessions = async (sessions: { id: string; created: string; cwd?: string; entries: unknown[] }[]) => {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await Promise.all(sessions.map((session) => writeFile(join(dir, `${session.id}.jsonl`), [
        { type: 'session', version: 3, id: session.id, cwd: session.cwd ?? cwd, timestamp: session.created },
        ...session.entries
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')))
    }

    // Replaying a task must not even inspect corrupt session history.
    await setSessions([{ id: 'broken', created, entries: [] }])
    await appendFile(join(dir, 'broken.jsonl'), '{invalid json}\n')
    namingTask = '  the persisted task  '
    await retry({}, '/project', cwd)
    assert.deepEqual(retries.pop(), { cwd, text: namingTask })
    namingTask = undefined

    await setSessions([
      { id: 'newer', created: '2026-09-22T01:00:00.000Z', entries: [user('a later task')] },
      { id: 'earliest', created, entries: [user('  the first task  ')] },
      { id: 'empty', created: '2026-09-21T00:00:00.000Z', entries: [
        { type: 'custom', customType: 'extension.state', data: {} },
        { type: 'message', message: { role: 'bashExecution', output: 'x'.repeat(70 * 1024) } }
      ] },
      { id: 'collision', created: '2026-09-20T00:00:00.000Z', cwd: '/other-cwd', entries: [user('another project')] }
    ])
    await retry({}, '/project', cwd)
    assert.deepEqual(retries, [{ cwd, text: 'the first task' }])

    // The first image-only prompt wins even when a later message supplies the sidebar title.
    const hint = '[Image: original 2992x1868, displayed at 2000x1249. Multiply coordinates by 1.50 to map to original image.]'
    await setSessions([{ id: 'images', created, entries: [
      user([{ type: 'text', text: `\n\n${hint}` }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(70 * 1024) }]),
      user('an unrelated later task')
    ] }])
    await retry({}, '/project', cwd)
    assert.equal(retries.at(-1)?.text, '用户仅发送了图片，未附文字。')

    // Neither the 64KB listing prefix nor the 500-character title can recover this task.
    const attachment = 'pasted context\n'.repeat(6000)
    const task = 'Fix authentication and add regression coverage. '.repeat(30).trim()
    const inline = normalizeSessionPrompt({
      text: attachment + '\n\n' + task,
      textAttachments: [{ id: 'paste', text: attachment, start: 0, end: attachment.length }]
    })
    await setSessions([{ id: 'inline', created, entries: [
      { type: 'custom', customType: PASTED_TEXT_CUSTOM_TYPE, data: inline.metadata },
      user([{ type: 'text', text: inline.modelText }]),
      user('not the original task')
    ] }])
    await retry({}, '/project', cwd)
    assert.equal(retries.at(-1)?.text, task)

    assert.ok(inline.metadata)
    const delivered = 'The input hook replaced the entire prompt'
    await setSessions([{ id: 'transformed', created, entries: [
      { type: 'custom', customType: PASTED_TEXT_CUSTOM_TYPE,
        data: createPastedTextDeliveryMetadata(inline.modelText, inline.metadata, delivered) },
      user(delivered)
    ] }])
    await retry({}, '/project', cwd)
    assert.equal(retries.at(-1)?.text, task)

    for (const body of ['Review deployment', '']) {
      const legacy = normalizeSessionPrompt({ text: body, textAttachments: [{ id: 'legacy', text: attachment }] })
      await setSessions([{ id: 'legacy', created, entries: [
        { type: 'custom', customType: PASTED_TEXT_CUSTOM_TYPE, data: legacy.metadata },
        user(legacy.modelText)
      ] }])
      await retry({}, '/project', cwd)
      assert.equal(retries.at(-1)?.text, body || '粘贴的文本')
    }

    const before = retries.length
    await rm(dir, { recursive: true })
    await assert.rejects(() => Promise.resolve(retry({}, '/project', cwd)), /无法命名/)
    await setSessions([{ id: 'blank', created, entries: [user('   ')] }])
    await assert.rejects(() => Promise.resolve(retry({}, '/project', cwd)), /无法命名/)
    await setSessions([{ id: 'empty', created, entries: [] }])
    await assert.rejects(() => Promise.resolve(retry({}, '/project', cwd)), /无法命名/)

    // Corrupt history is an error, not a reason to silently use a later session.
    await setSessions([
      { id: 'broken', created, entries: [] },
      { id: 'later', created: '2026-09-22T01:00:00.000Z', entries: [user('not a fallback')] }
    ])
    await appendFile(join(dir, 'broken.jsonl'), '{invalid json}\n')
    await assert.rejects(() => Promise.resolve(retry({}, '/project', cwd)), SyntaxError)
    for (const data of [null, { ...inline.metadata, contentHash: 'mismatch' }]) {
      await setSessions([{ id: 'bad-metadata', created, entries: [
        { type: 'custom', customType: PASTED_TEXT_CUSTOM_TYPE, data },
        user(inline.modelText)
      ] }])
      await assert.rejects(() => Promise.resolve(retry({}, '/project', cwd)), Error)
    }
    await rm(dir, { recursive: true })
    await writeFile(dir, 'not a session directory')
    await assert.rejects(() => Promise.resolve(retry({}, '/project', cwd)), (error: unknown) =>
      error instanceof Error && (error.cause as NodeJS.ErrnoException)?.code === 'ENOTDIR')
    assert.equal(retries.length, before)

    // A cwd outside the project's topology never reaches task recovery.
    await assert.rejects(() => Promise.resolve(retry({}, '/project', '/somewhere-else')), /不属于已打开项目/)
    assert.equal(retries.length, before)
    await assert.rejects(() => Promise.resolve(retry({}, '/not-open', cwd)))
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--worktree-naming-ipc-fixture') {
  await runFixture()
} else {
  test('naming retries replay saved tasks and recover legacy first prompts without swallowing errors', async () => {
    const child = Bun.spawn(
      [process.execPath, import.meta.path, '--worktree-naming-ipc-fixture'],
      { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' }
    )
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      assert.equal(code, 0, stderr || stdout)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 15_000)
}

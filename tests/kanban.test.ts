/**
 * Kanban persistence, corruption safety, project/worktree `@` mention scoping,
 * composer serialization, and `pig-kanban` agent authorization tests.
 */
import { describe, expect, mock, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  extractIssueMentionNumbers,
  formatKanbanIssueClipboardText,
  KANBAN_DEFAULT_LABELS,
  kanbanImageUrl,
  parseKanbanImageUrl,
  resolveCanonicalProjectCwd
} from '../src/shared/kanban'
import { serializeComposerDocument } from '../src/renderer/src/components/composer/document'
import { scopedIssueMentions } from '../src/renderer/src/components/composer/issue-mentions'
import { kanbanLabelDotClass } from '../src/renderer/src/components/kanban/kanban-icons'
import { computeDropSortOrder, kanbanCollisionDetection } from '../src/renderer/src/components/kanban/kanban-dnd'
import { runSelf } from './helpers/subprocess.ts'

async function agentFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pig-kanban-agent-'))
  process.env.PIG_DIR = join(root, 'pig')
  const projectA = resolve(join(root, 'repo-a'))
  const worktreeA = resolve(join(root, 'pig', 'worktrees', 'repo-a', 'wt-1'))
  const projectB = resolve(join(root, 'repo-b'))
  const chatDir = resolve(join(root, 'pig', 'chats', 'chat-1'))
  await mkdir(projectA, { recursive: true })
  await mkdir(worktreeA, { recursive: true })
  await mkdir(projectB, { recursive: true })
  await mkdir(chatDir, { recursive: true })

  const liveSessions = new Map<string, { cwd: string }>()
  mock.module('electron', () => ({
    app: { isPackaged: false, getAppPath: () => process.cwd() },
    BrowserWindow: { getAllWindows: () => [] }
  }))
  const realProjectWorktrees = await import('../src/main/project-worktrees')
  mock.module('../src/main/project-worktrees', () => ({
    ...realProjectWorktrees,
    worktrees: {
      discover: async (cwd: string) =>
        cwd === projectA
          ? [
              { cwd: projectA, branch: 'main', isPrimary: true, locked: false, missing: false, managed: false },
              { cwd: worktreeA, branch: 'bot/fix-1', isPrimary: false, locked: false, missing: false, managed: true }
            ]
          : [{ cwd: projectB, branch: 'main', isPrimary: true, locked: false, missing: false, managed: false }]
    }
  }))
  const realRegistry = await import('../src/main/pi/session-registry')
  mock.module('../src/main/pi/session-registry', () => ({
    ...realRegistry,
    getLive: (id: string) => liveSessions.get(id)
  }))

  try {
    const { addOpenedProject } = await import('../src/main/opened-projects')
    await addOpenedProject(projectA)
    await addOpenedProject(projectB)

    const { saveSessionPermission } = await import('../src/main/permissions/store')
    const { setCurrentBotSessionId } = await import('../src/main/bot/lifecycle')
    const { kanban, kanbanImageResponse, KanbanStore } = await import('../src/main/kanban/service')
    const { registerKanbanAgent } = await import('../src/main/kanban/agent-host')
    const { kanbanAgentHost } = await import('../src/main/plugins/pig-kanban-host')

    // 1. KanbanStore persistence, monotonic numbering & corruption protection
    const customFile = join(root, 'custom-kanban.json')
    const isolated = new KanbanStore(() => customFile, () => {})
    const first = await isolated.create({ title: 'First issue', projectCwd: projectA, labels: ['bug', 'Bug', ' ui '] })
    assert.equal(first.issue.number, 1)
    assert.deepEqual(first.issue.labels, ['bug', 'ui'])
    assert.equal(first.issue.completedAt, null)

    const movedDone = await isolated.update({ number: 1, status: 'done' })
    assert.ok(typeof movedDone.issue.completedAt === 'number')
    const reopened = await isolated.update({ number: 1, status: 'in_progress' })
    assert.equal(reopened.issue.completedAt, null)

    await isolated.linkSession([1], { sessionId: 'sess-1', cwd: worktreeA })
    await isolated.linkBotTask([1], 'task-99')
    const reloaded = await new KanbanStore(() => customFile, () => {}).getByNumber(1)
    assert.deepEqual(reloaded?.linkedSessions, [{ sessionId: 'sess-1', cwd: worktreeA }])
    assert.deepEqual(reloaded?.linkedBotTaskIds, ['task-99'])

    // Corrupt JSON must fail fast and never be overwritten by mutations.
    await writeFile(customFile, '{corrupted', 'utf8')
    const brokenStore = new KanbanStore(() => customFile, () => {})
    await assert.rejects(brokenStore.getSnapshot(), /Invalid kanban\.json/)
    await assert.rejects(brokenStore.create({ title: 'Should not clobber' }), /Invalid kanban\.json/)
    assert.equal(await readFile(customFile, 'utf8'), '{corrupted')

    // 2. Agent host scoping & permission boundaries
    registerKanbanAgent()
    const host = kanbanAgentHost()!
    assert.ok(host)

    setCurrentBotSessionId('bot-main')
    await saveSessionPermission('bot-main', 'full-access')
    liveSessions.set('proj-a-wt', { cwd: worktreeA })
    liveSessions.set('proj-b', { cwd: projectB })
    liveSessions.set('chat-1', { cwd: chatDir })
    await saveSessionPermission('proj-a-wt', 'default')
    await saveSessionPermission('proj-b', 'read-only')
    await saveSessionPermission('chat-1', 'default')

    // Bot creates unassigned (#1), repo-a (#2 with pasted PNG), and repo-b (#3) issues
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const inboxIssue = await host.create({ sessionId: 'bot-main' }, { title: 'Global inbox note' })
    const { issue: repoAIssue } = await kanban.create({
      title: 'Fix repo A export',
      projectCwd: projectA,
      labels: ['Bug'],
      images: [{ mimeType: 'image/png', data: onePixelPng, name: 'repro.png' }]
    })
    const repoBIssue = await host.create({ sessionId: 'bot-main' }, { title: 'Fix repo B build', projectCwd: projectB })
    assert.equal(inboxIssue.projectCwd, null)
    assert.equal(repoAIssue.projectCwd, projectA)
    assert.equal(repoAIssue.images.length, 1)
    assert.equal(repoBIssue.projectCwd, projectB)

    // Verify pig-image://kanban/<id> protocol response, .png extension, clipboard formatting & agent imageBlocks return
    const imgId = repoAIssue.images[0].id
    assert.equal(imgId.endsWith('.png'), true)
    const imgResponse = await kanbanImageResponse(kanbanImageUrl(imgId))
    assert.equal(imgResponse.status, 200)
    assert.equal(imgResponse.headers.get('content-type'), 'image/png')
    assert.equal((await imgResponse.arrayBuffer()).byteLength, Buffer.from(onePixelPng, 'base64').length)

    const imgDiskPath = resolve(join(root, 'pig', 'kanban-images', imgId))
    const formattedClip = await kanban.formatIssueForClipboard(repoAIssue.number, '图片')
    assert.equal(formattedClip.includes(`# ${repoAIssue.title}`), true)
    assert.equal(formattedClip.includes(`## 图片\n\n- ${imgDiskPath}`), true)

    const fetchedDetail = await host.get({ sessionId: 'proj-a-wt' }, repoAIssue.number)
    assert.equal(fetchedDetail.issue.number, repoAIssue.number)
    assert.deepEqual(fetchedDetail.imageBlocks, [{ mimeType: 'image/png', data: onePixelPng }])

    // Removing the image via update cleans up its file on disk
    assert.equal(existsSync(imgDiskPath), true)
    await kanban.update({ number: repoAIssue.number, images: [] })
    assert.equal(existsSync(imgDiskPath), false)

    // Worktree session of repo-a strictly sees & mutates ONLY repo-a issues
    const listedInA = await host.list({ sessionId: 'proj-a-wt', cwd: worktreeA }, {})
    assert.deepEqual(listedInA.map((i) => i.number), [repoAIssue.number])
    await assert.rejects(host.get({ sessionId: 'proj-a-wt' }, inboxIssue.number), /does not belong to the current project/)
    await assert.rejects(host.get({ sessionId: 'proj-a-wt' }, repoBIssue.number), /does not belong to the current project/)
    await assert.rejects(
      host.create({ sessionId: 'proj-a-wt' }, { title: 'Cross project', projectCwd: projectB }),
      /only create issues for their own project/
    )
    const createdFromWt = await host.create({ sessionId: 'proj-a-wt' }, { title: 'Created inside worktree' })
    assert.equal(createdFromWt.projectCwd, projectA, 'worktree session automatically binds issue to canonical root project')
    assert.deepEqual(createdFromWt.linkedSessions, [{ sessionId: 'proj-a-wt', cwd: worktreeA }])

    const progressed = await host.update({ sessionId: 'proj-a-wt' }, { number: repoAIssue.number, status: 'in_progress' })
    assert.equal(progressed.status, 'in_progress')

    // Default mode requires interactive confirmation to permanently delete
    await assert.rejects(host.remove({ sessionId: 'proj-a-wt' }, createdFromWt.number), /requires interactive user confirmation/)
    let prompted = false
    await host.remove(
      { sessionId: 'proj-a-wt' },
      createdFromWt.number,
      { confirm: async () => { prompted = true; return true } }
    )
    assert.equal(prompted, true)
    assert.equal(await kanban.getByNumber(createdFromWt.number), null)

    // Read-only mode blocks writes
    await assert.rejects(host.create({ sessionId: 'proj-b' }, { title: 'Blocked write' }), /read-only/)
    await assert.rejects(host.update({ sessionId: 'proj-b' }, { number: repoBIssue.number, status: 'done' }), /read-only/)

    // Standalone Chat sees unassigned + all project issues
    const chatList = await host.list({ sessionId: 'chat-1' }, {})
    assert.deepEqual(
      chatList.map((i) => i.number).sort((a, b) => a - b),
      [inboxIssue.number, repoAIssue.number, repoBIssue.number]
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--kanban-agent-fixture')) {
  await agentFixture()
} else {
  describe('Kanban @ mentions & document serialization', () => {
    const projects = [
      {
        cwd: '/repos/pig',
        name: 'pig',
        worktrees: [
          { cwd: '/repos/pig' },
          { cwd: '/pig-data/worktrees/pig/wt-42' }
        ]
      },
      {
        cwd: '/repos/other',
        name: 'other',
        worktrees: [{ cwd: '/repos/other' }]
      }
    ]

    const sampleIssues = [
      {
        id: '1', number: 1, title: 'Global unassigned idea', description: '',
        status: 'todo' as const, priority: 'medium' as const, projectCwd: null,
        labels: [], images: [], sortOrder: 1000, linkedSessions: [], linkedBotTaskIds: [],
        createdAt: 1, updatedAt: 1, completedAt: null
      },
      {
        id: '2', number: 2, title: 'Optimize export diff', description: '',
        status: 'in_progress' as const, priority: 'high' as const, projectCwd: '/repos/pig',
        labels: ['perf'], images: [], sortOrder: 1000, linkedSessions: [], linkedBotTaskIds: [],
        createdAt: 2, updatedAt: 2, completedAt: null
      },
      {
        id: '3', number: 3, title: 'Other repo task', description: '',
        status: 'todo' as const, priority: 'low' as const, projectCwd: '/repos/other',
        labels: [], images: [], sortOrder: 1000, linkedSessions: [], linkedBotTaskIds: [],
        createdAt: 3, updatedAt: 3, completedAt: null
      },
      {
        id: '4', number: 4, title: 'Completed pig cleanup', description: '',
        status: 'done' as const, priority: 'none' as const, projectCwd: '/repos/pig',
        labels: [], images: [], sortOrder: 1000, linkedSessions: [], linkedBotTaskIds: [],
        createdAt: 4, updatedAt: 4, completedAt: 5
      }
    ]

    test('resolves both primary cwd and isolated worktrees to canonical project root', () => {
      expect(resolveCanonicalProjectCwd('/repos/pig', projects)).toBe('/repos/pig')
      expect(resolveCanonicalProjectCwd('/pig-data/worktrees/pig/wt-42', projects)).toBe('/repos/pig')
      expect(resolveCanonicalProjectCwd('/chats/abc', projects)).toBeNull()
    })

    test('project and worktree sessions strictly show only issues assigned to that project', () => {
      const tabs = [
        { id: 'sess-wt', kind: 'project' as const, cwd: '/pig-data/worktrees/pig/wt-42', title: 'Branch', loadState: 'ready' as const },
        { id: 'sess-chat', kind: 'chat' as const, cwd: '/chats/c1', title: 'Chat', loadState: 'ready' as const }
      ]

      // Empty @ query in worktree session shows only active issues of /repos/pig (#2), never unassigned (#1) or /repos/other (#3)
      const wtDefault = scopedIssueMentions({
        issues: sampleIssues,
        tabs,
        projects,
        currentSessionId: 'sess-wt',
        cwd: '/pig-data/worktrees/pig/wt-42',
        query: '',
        unassignedLabel: 'Unassigned'
      })
      expect(wtDefault.map((i) => i.number)).toEqual([2])

      // Searching #4 in worktree session finds completed issue #4 of /repos/pig, still never #1 or #3
      const wtDoneLookup = scopedIssueMentions({
        issues: sampleIssues,
        tabs,
        projects,
        currentSessionId: 'sess-wt',
        cwd: '/pig-data/worktrees/pig/wt-42',
        query: '4',
        unassignedLabel: 'Unassigned'
      })
      expect(wtDoneLookup.map((i) => i.number)).toEqual([4])

      // Standalone chat shows unassigned + all active project issues (#1, #2, #3)
      const chatDefault = scopedIssueMentions({
        issues: sampleIssues,
        tabs,
        projects,
        currentSessionId: 'sess-chat',
        cwd: '/chats/c1',
        query: '',
        unassignedLabel: 'Unassigned'
      })
      expect(chatDefault.map((i) => i.number)).toEqual([1, 2, 3])
      expect(chatDefault[0].detail).toBe('Unassigned')
      expect(chatDefault[1].detail).toBe('pig · perf')
    })

    test('serializes issueMention nodes to @[issue:N] and extracts issue numbers', () => {
      const serialized = serializeComposerDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Please handle ' },
              { type: 'issueMention', attrs: { number: 12, title: 'Fix bug', status: 'todo' } },
              { type: 'text', text: ' and check @[issue:7]' }
            ]
          }
        ]
      })
      expect(serialized.text).toBe('Please handle @[issue:12] and check @[issue:7]')
      expect(extractIssueMentionNumbers(serialized.text)).toEqual([12, 7])
    })

    test('includes built-in Feature / Bug / Improvement labels with distinct semantic dot colors and validates image URLs', () => {
      expect(KANBAN_DEFAULT_LABELS).toEqual(['Feature', 'Bug', 'Improvement'])
      expect(kanbanLabelDotClass('Feature')).toBe('bg-chart-5')
      expect(kanbanLabelDotClass('Bug')).toBe('bg-chart-1')
      expect(kanbanLabelDotClass('Improvement')).toBe('bg-chart-4')
      expect(parseKanbanImageUrl(kanbanImageUrl('abc-123_45.png'))).toBe('abc-123_45.png')
      expect(parseKanbanImageUrl('pig-image://kanban/../escape')).toBeNull()
      expect(parseKanbanImageUrl('pig-image://session/a/b/0')).toBeNull()

      expect(
        formatKanbanIssueClipboardText({
          title: '修复登录闪退',
          description: '复现步骤：\n1. 点击登录\n2. 界面白屏',
          imagePaths: ['/tmp/.pig/kanban-images/a.png', '/tmp/.pig/kanban-images/b.jpg'],
          imagesHeading: '图片'
        })
      ).toBe(
        [
          '# 修复登录闪退',
          '复现步骤：\n1. 点击登录\n2. 界面白屏',
          '## 图片\n\n- /tmp/.pig/kanban-images/a.png\n- /tmp/.pig/kanban-images/b.jpg'
        ].join('\n\n')
      )
    })

    test('column-first collision detection hits an empty tall column instead of jumping to neighbor cards', () => {
      const rect = (left: number, top: number, width: number, height: number) => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height
      })
      const droppableRects = new Map<string | number, ReturnType<typeof rect>>([
        ['column:backlog', rect(0, 0, 280, 800)],
        ['column:todo', rect(292, 0, 280, 800)],       // Empty tall column!
        ['column:in_progress', rect(584, 0, 280, 800)],
        ['issue:1', rect(8, 50, 264, 90)],
        ['issue:3', rect(592, 50, 264, 90)]
      ])
      const droppableContainers = [
        { id: 'column:backlog', data: { current: { type: 'column', status: 'backlog' } }, disabled: false },
        { id: 'column:todo', data: { current: { type: 'column', status: 'todo' } }, disabled: false },
        { id: 'column:in_progress', data: { current: { type: 'column', status: 'in_progress' } }, disabled: false },
        { id: 'issue:1', data: { current: { type: 'issue', issue: { number: 1, status: 'backlog' } } }, disabled: false },
        { id: 'issue:3', data: { current: { type: 'issue', issue: { number: 3, status: 'in_progress' } } }, disabled: false }
      ] as unknown as Parameters<typeof kanbanCollisionDetection>[0]['droppableContainers']

      // Dragging across the middle (y = 420) of the empty `todo` column must hit `column:todo`, NOT `issue:3`!
      const hitEmpty = kanbanCollisionDetection({
        active: { id: 'issue:1', data: { current: {} }, rect: { current: { initial: null, translated: null } } } as never,
        collisionRect: rect(310, 380, 264, 90),
        droppableRects,
        droppableContainers,
        pointerCoordinates: { x: 430, y: 420 }
      })
      expect(hitEmpty[0]?.id).toBe('column:todo')

      // Dragging over a card inside `in_progress` resolves to `issue:3` for precise sorting
      const hitCard = kanbanCollisionDetection({
        active: { id: 'issue:1', data: { current: {} }, rect: { current: { initial: null, translated: null } } } as never,
        collisionRect: rect(592, 60, 264, 90),
        droppableRects,
        droppableContainers,
        pointerCoordinates: { x: 700, y: 90 }
      })
      expect(hitCard[0]?.id).toBe('issue:3')
    })

    test('computeDropSortOrder handles cross-column drops and same-column upward/downward reordering', () => {
      const col = [
        { ...sampleIssues[0], number: 1, status: 'todo' as const, sortOrder: 1000 },
        { ...sampleIssues[1], number: 2, status: 'todo' as const, sortOrder: 2000 },
        { ...sampleIssues[2], number: 3, status: 'todo' as const, sortOrder: 3000 }
      ]

      // Same-column downward drag: #1 onto #2 places #1 between #2 (2000) and #3 (3000)
      expect(computeDropSortOrder(col, { number: 1, status: 'todo' }, 'todo', 2)).toBe(2500)
      // Same-column downward drag to bottom: #1 onto #3 places #1 after #3 (3000 + 1000)
      expect(computeDropSortOrder(col, { number: 1, status: 'todo' }, 'todo', 3)).toBe(4000)
      // Same-column upward drag to top: #3 onto #1 places #3 before #1 (1000 - 1000)
      expect(computeDropSortOrder(col, { number: 3, status: 'todo' }, 'todo', 1)).toBe(0)
      // Cross-column into empty column
      expect(computeDropSortOrder([], { number: 2, status: 'todo' }, 'backlog', null)).toBe(1000)
      // Cross-column below last card
      expect(computeDropSortOrder(col, { number: 9, status: 'backlog' }, 'todo', null)).toBe(4000)
    })
  })

  test('Kanban store persistence, corruption safety, and agent host authorization', async () => {
    const { exitCode, stdout, stderr } = await runSelf(import.meta.path, ['--kanban-agent-fixture'], { timeoutMs: 25_000 })
    assert.equal(exitCode, 0, stderr || stdout)
  }, 30_000)
}

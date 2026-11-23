import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BOT_MAIN_DISABLED_TOOLS, createBotExtension, type BotToolsHost } from '../src/main/bot/tools'
import type { PermissionMode } from '../src/shared/permissions'
import type { BotTask, BotTaskReceipt, BotTimelineItem } from '../src/shared/bot'
import type { BotTaskManager } from '../src/main/bot/task-manager'

function harness(opts: {
  mode?: PermissionMode
  confirmResult?: boolean
  hasGit?: boolean
  workspaceDir?: string
  soulPath?: string
  activeTools?: string[]
  confirm?: (signal?: AbortSignal) => Promise<boolean>
  stopReceipt?: BotTaskReceipt
  safety?: { branch?: string; dirty: boolean; unmerged: boolean; needsForceConfirm: boolean }
}) {
  let mode: PermissionMode = opts.mode ?? 'full-access'
  let activeTools = [...(opts.activeTools ?? ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls', 'send_message'])]
  const tools = new Map<string, { execute: Function }>()
  const hooks = new Map<string, Function[]>()
  const sent: Array<Extract<BotTimelineItem, { kind: 'assistant' }>> = []
  const sideEffects: string[] = []
  const permissionsChanged = new Set<() => void>()
  const confirms: Array<{ title: string; message: string }> = []
  let cleanedTasks: string[] = []

  const taskManager = {
    delegateTask: async (input: { projectCwd: string; mode: 'read' | 'write' }, permMode: PermissionMode) => {
      if (input.mode === 'write' && permMode === 'read-only') {
        throw new Error('Read-only mode cannot delegate write tasks')
      }
      return { taskId: 't-1', runId: 'r-1', projectCwd: input.projectCwd, mode: input.mode, status: 'starting' as const }
    },
    listTasks: async () => [] as BotTask[],
    getTask: async (id: string) => ({ taskId: id, status: 'completed', workspace: { kind: 'worktree', cwd: '/wt' }, runs: [] } as unknown as BotTask),
    stopTaskFromTool: async (id: string) => ({
      task: { taskId: id, status: 'stopped' } as unknown as BotTask,
      runId: 'r-1',
      receipt: opts.stopReceipt
    }),
    followupTask: async (id: string) => ({ taskId: id, runId: 'r-2', projectCwd: '/repo', mode: 'write', status: 'starting' as const }),
    checkWorktreeCleanupSafety: async () => ({ branch: 'bot/fix-a1b2c3', dirty: false, unmerged: false, needsForceConfirm: false, snapshot: 'a'.repeat(64), ...opts.safety }),
    cleanupWorktree: async (id: string) => { cleanedTasks.push(id); return { cleaned: true, branch: 'bot/fix-a1b2c3' } }
  } as unknown as BotTaskManager

  const host: BotToolsHost = {
    taskManager,
    workspaceDir: opts.workspaceDir,
    soulPath: opts.soulPath,
    getPermissionMode: () => mode,
    onPermissionsChanged: (listener) => {
      permissionsChanged.add(listener)
      return () => permissionsChanged.delete(listener)
    },
    listOpenedProjects: async () => [{ cwd: '/repo/pig', name: 'pig', hasGit: opts.hasGit ?? true }],
    openProject: async (path: string) => ({ cwd: path, name: 'demo' }),
    inspectTaskSession: async () => ({ recentMessages: [{ role: 'assistant', text: 'done' }] }),
    confirmAction: async (title, message, _ctx, signal) => {
      confirms.push({ title, message })
      return opts.confirm ? opts.confirm(signal) : opts.confirmResult ?? true
    },
    onSendMessage: async (item) => { sent.push(item) },
    onSideEffect: (name) => { sideEffects.push(name) }
  }

  const fakePi = {
    registerTool: (def: { name: string; execute: Function }) => { tools.set(def.name, def) },
    getActiveTools: () => [...activeTools],
    setActiveTools: (next: string[]) => { activeTools = [...next] },
    on: (name: string, fn: Function) => {
      const list = hooks.get(name) ?? []
      list.push(fn)
      hooks.set(name, list)
    }
  } as unknown as ExtensionAPI

  createBotExtension(host)(fakePi)
  return {
    tools,
    hooks,
    sent,
    sideEffects,
    confirms,
    cleanedTasks,
    getActiveTools: () => [...activeTools],
    setMode: (next: PermissionMode, notify = true) => {
      mode = next
      if (notify) for (const listener of permissionsChanged) listener()
    }
  }
}

describe('Bot extension tools and §5.5 permission matrix', () => {
  test('send_message strips hidden tags, validates attachments, and records visible assistant item', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pig-bot-att-'))
    const file = join(dir, 'report.txt')
    writeFileSync(file, 'hello')
    try {
      const h = harness({})
      const send = h.tools.get('send_message')!
      await send.execute('c1', {
        type: 'attachment',
        content: '报告发给你啦 <system_reminder>hidden</system_reminder>',
        attachments: [file]
      })
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0].content).toBe('报告发给你啦')
      expect(h.sent[0].attachments?.[0].path).toBe(file)
      expect(h.sideEffects).toContain('send_message')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bot_start_task blocks write tasks under read-only and returns Fast Ack under default/full-access', async () => {
    const h = harness({ mode: 'read-only' })
    const delegate = h.tools.get('bot_start_task')!
    await expect(delegate.execute('c1', {
      projectCwd: '/repo/pig', title: 'Fix', intent: 'Fix bug', mode: 'write'
    })).rejects.toThrow(/Read-only/)

    h.setMode('default')
    const res = await delegate.execute('c2', {
      projectCwd: '/repo/pig', title: 'Fix', intent: 'Fix bug', mode: 'write'
    })
    const parsed = JSON.parse(res.content[0].text)
    expect(parsed.status).toBe('starting')
    expect(h.confirms).toHaveLength(0) // opened Git project skips delegation approval
  })

  test('a downgrade cancels pending approval even if permission is restored before a late reply', async () => {
    let approve!: (accepted: boolean) => void
    let approvalSignal: AbortSignal | undefined
    const h = harness({ mode: 'default', confirm: signal => {
      approvalSignal = signal
      return new Promise(resolve => { approve = resolve })
    } })
    const pending = h.tools.get('bot_open_project')!.execute('call', { path: '/repo/pig' })
    h.setMode('read-only')
    expect(approvalSignal?.aborted).toBe(true)
    h.setMode('default')
    approve(true)
    await expect(pending).rejects.toThrow(/permission mode changed/)
    expect(h.sideEffects).toEqual([])
  })

  test('delegation rechecks the permission ceiling after approval even without a change notification', async () => {
    let approve!: (accepted: boolean) => void
    const h = harness({ hasGit: false, confirm: () => new Promise(resolve => { approve = resolve }) })
    const pending = h.tools.get('bot_start_task')!.execute('call', {
      projectCwd: '/repo/pig', title: 'Fix', intent: 'Fix bug', mode: 'write'
    })
    await Promise.resolve()
    h.setMode('default', false)
    approve(true)
    await expect(pending).rejects.toThrow(/permission mode changed/)
    expect(h.sideEffects).toEqual([])
  })

  test('bot_stop_task reports the settled receipt only when supplied by the manager', async () => {
    const receipt = { summary: 'Stopped (bot).', changedFiles: [], totalAdded: 0, totalRemoved: 0, collectedAt: 123 }
    for (const stopReceipt of [receipt, undefined]) {
      const h = harness({ stopReceipt })
      const result = await h.tools.get('bot_stop_task')!.execute('c1', { taskId: 't-1' })
      expect(JSON.parse(result.content[0].text)).toEqual({
        ok: true, taskId: 't-1', runId: 'r-1', status: 'stopped', ...(stopReceipt && { receipt })
      })
      expect(h.sideEffects).toEqual(['bot_stop_task'])
    }
  })

  test('bot_cleanup_worktree ALWAYS prompts confirmation when dirty/unmerged even in full-access', async () => {
    const h = harness({
      mode: 'full-access',
      confirmResult: false,
      safety: { branch: 'bot/fix-a1b2c3', dirty: true, unmerged: true, needsForceConfirm: true }
    })
    const cleanup = h.tools.get('bot_cleanup_worktree')!
    await expect(cleanup.execute('c1', { taskId: 't-1' })).rejects.toThrow(/declined/)
    expect(h.confirms).toHaveLength(1)
    expect(h.cleanedTasks).toHaveLength(0)
  })

  test('bot_cleanup_worktree cleans directly in full-access when clean+merged, but confirms in default', async () => {
    const cleanFull = harness({
      mode: 'full-access',
      safety: { branch: 'bot/fix-a1b2c3', dirty: false, unmerged: false, needsForceConfirm: false }
    })
    await cleanFull.tools.get('bot_cleanup_worktree')!.execute('c1', { taskId: 't-1' })
    expect(cleanFull.confirms).toHaveLength(0)
    expect(cleanFull.cleanedTasks).toEqual(['t-1'])

    const cleanDefault = harness({
      mode: 'default',
      confirmResult: true,
      safety: { branch: 'bot/fix-a1b2c3', dirty: false, unmerged: false, needsForceConfirm: false }
    })
    await cleanDefault.tools.get('bot_cleanup_worktree')!.execute('c2', { taskId: 't-2' })
    expect(cleanDefault.confirms).toHaveLength(1)
    expect(cleanDefault.cleanedTasks).toEqual(['t-2'])
  })

  test('strips shell and search tools from Bot main session and blocks direct invocations', async () => {
    const h = harness({})
    for (const fn of h.hooks.get('session_start') ?? []) await fn()
    expect(h.getActiveTools()).toEqual(['read', 'edit', 'write', 'send_message'])

    const callTool = async (toolName: string, input: unknown = {}) => {
      for (const fn of h.hooks.get('tool_call') ?? []) {
        const res = await fn({ toolName, input })
        if (res) return res
      }
      return undefined
    }

    for (const disabled of Object.keys(BOT_MAIN_DISABLED_TOOLS)) {
      const res = await callTool(disabled, { command: 'ls' })
      expect(res?.block).toBe(true)
      expect(res?.reason).toMatch(/bot_start_task/)
    }
    expect(h.sideEffects).toEqual([])
  })

  test('allows read anywhere, confines edit/write to Bot workspace and SOUL.md, and blocks symlink/tilde escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pig-bot-guard-'))
    const workspaceDir = join(root, 'bot', 'workspace')
    const personaDir = join(root, 'persona')
    const projectDir = join(root, 'project')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(personaDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    const soulPath = join(personaDir, 'SOUL.md')
    const userPath = join(personaDir, 'USER.md')
    const projectFile = join(projectDir, 'index.ts')
    writeFileSync(soulPath, '# Soul\n')
    writeFileSync(userPath, '# User\n')
    writeFileSync(projectFile, 'export const x = 1\n')
    const escapeLink = join(workspaceDir, 'escape.ts')
    symlinkSync(projectFile, escapeLink)

    try {
      const h = harness({ workspaceDir, soulPath })
      const callTool = async (toolName: string, input: unknown) => {
        for (const fn of h.hooks.get('tool_call') ?? []) {
          const res = await fn({ toolName, input })
          if (res) return res
        }
        return undefined
      }

      // Single-file read stays allowed on project files and SOUL.md without marking side effects
      expect(await callTool('read', { path: projectFile })).toBeUndefined()
      expect(await callTool('read', { path: soulPath })).toBeUndefined()
      expect(h.sideEffects).toEqual([])

      // Scratch workspace relative/absolute paths and SOUL.md are allowed and mark side effects
      expect(await callTool('write', { path: 'notes/draft.md' })).toBeUndefined()
      expect(await callTool('edit', { path: soulPath })).toBeUndefined()
      expect(h.sideEffects).toEqual(['write', 'edit'])

      // Project files, sibling persona files, tilde paths, and symlink escapes inside workspace are blocked
      for (const forbidden of [projectFile, userPath, '~/outside.txt', escapeLink, '../tasks.json']) {
        const res = await callTool('edit', { path: forbidden })
        expect(res?.block).toBe(true)
        expect(res?.reason).toMatch(/bot_start_task/)
      }
      expect(h.sideEffects).toEqual(['write', 'edit'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

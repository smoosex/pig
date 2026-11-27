import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { BOT_MAIN_DISABLED_TOOLS, createBotExtension, type BotToolsHost } from '../src/main/bot/tools'
import type { PermissionMode } from '../src/shared/permissions'
import type { BotTask, BotTaskReceipt, BotTimelineItem } from '../src/shared/bot'
import type { BotTaskManager } from '../src/main/bot/task-manager'

function harness(opts: {
  mode?: PermissionMode
  confirmResult?: boolean
  hasGit?: boolean
  branch?: string
  activeTools?: string[]
  confirm?: (signal?: AbortSignal) => Promise<boolean>
  stopReceipt?: BotTaskReceipt
  safety?: { branch?: string; dirty: boolean; unmerged: boolean; needsForceConfirm: boolean }
}) {
  let mode: PermissionMode = opts.mode ?? 'full-access'
  let activeTools = [...(opts.activeTools ?? ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls', 'send_message'])]
  const tools = new Map<string, { execute: Function; promptSnippet?: string; promptGuidelines?: string[] }>()
  const hooks = new Map<string, Function[]>()
  const sent: Array<Extract<BotTimelineItem, { kind: 'assistant' }>> = []
  const sideEffects: string[] = []
  const permissionsChanged = new Set<() => void>()
  const confirms: Array<{ title: string; message: string }> = []
  let cleanedTasks: string[] = []
  const delegatedInputs: Array<import('../src/shared/bot').BotDelegateTaskInput> = []
  const requestedMoves: Array<{ projectCwd: string; suggestedFolderName?: string; suggestedParentDir?: string }> = []

  const taskManager = {
    delegateTask: async (input: import('../src/shared/bot').BotDelegateTaskInput, permMode: PermissionMode) => {
      if ((input.mode === 'write' || input.newProject) && permMode === 'read-only') {
        throw new Error('Read-only mode cannot delegate write tasks')
      }
      delegatedInputs.push(input)
      const projectCwd = input.newProject
        ? `/home/pig_projects/${input.newProject.folderName}`
        : input.projectCwd!
      return { taskId: 't-1', runId: 'r-1', projectCwd, mode: input.mode, status: 'starting' as const }
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
    getPermissionMode: () => mode,
    onPermissionsChanged: (listener) => {
      permissionsChanged.add(listener)
      return () => permissionsChanged.delete(listener)
    },
    listOpenedProjects: async () => [{
      cwd: '/repo/pig',
      name: 'pig',
      hasGit: opts.hasGit ?? true,
      ...((opts.hasGit ?? true) ? { branch: opts.branch ?? 'main' } : {})
    }],
    openProject: async (path: string) => ({ cwd: path, name: 'demo' }),
    requestMoveProject: async (input) => {
      requestedMoves.push(input)
      return { cwd: input.projectCwd, name: 'pig', status: 'dialog_opened' as const }
    },
    inspectTaskSession: async () => ({ recentMessages: [{ role: 'assistant', text: 'done' }] }),
    confirmAction: async (title, message, _ctx, signal) => {
      confirms.push({ title, message })
      return opts.confirm ? opts.confirm(signal) : opts.confirmResult ?? true
    },
    onSendMessage: async (item) => { sent.push(item) },
    onSideEffect: (name) => { sideEffects.push(name) }
  }

  const fakePi = {
    registerTool: (def: { name: string; execute: Function; promptSnippet?: string; promptGuidelines?: string[] }) => { tools.set(def.name, def) },
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
    delegatedInputs,
    requestedMoves,
    getActiveTools: () => [...activeTools],
    setMode: (next: PermissionMode, notify = true) => {
      mode = next
      if (notify) for (const listener of permissionsChanged) listener()
    }
  }
}

describe('Bot extension tools and §5.5 permission matrix', () => {
  test('before_agent_start injects Bot surface situational awareness and operating rules into sections.bot', async () => {
    const h = harness({})
    const options = { sections: {} as Record<string, string> }
    for (const fn of h.hooks.get('before_agent_start') ?? []) {
      await fn({ systemPromptOptions: options })
    }
    expect(options.sections.bot).toContain('## Where You Are (Pig Bot Surface)')
    expect(options.sections.bot).toContain('persistent single-timeline Bot space')
    expect(options.sections.bot).toContain('"Bot" names the surface, NOT your persona')
    expect(options.sections.bot).toContain('## Pig Bot Operating Rules')

    const sendDef = h.tools.get('send_message')!
    expect(sendDef.promptSnippet).toContain('ONLY user-visible output channel')
    expect(sendDef.promptGuidelines?.[0]).toContain('only content sent with `send_message` can be seen by the user')
  })

  test('context_with_system consolidates into a single Bot style reminder with or without SOUL mood', async () => {
    const h = harness({})
    const runContext = async (messages: Array<Record<string, unknown>>) => {
      let current = messages
      for (const fn of h.hooks.get('context_with_system') ?? []) {
        const res = await fn({ messages: current })
        if (res?.messages) current = res.messages
      }
      return current
    }

    // 1. With active SOUL mood from personaExtension: replaces in place without leaving two reminders.
    const withSoul = await runContext([
      { role: 'system', content: '' },
      { role: 'user', content: '你好', timestamp: 100 },
      {
        role: 'custom',
        customType: 'persona-mood',
        display: false,
        content: '[Style reminder: Let your SOUL set the tone, and let your current mood (pleasant, calm, rested) color it. Keep speaking in your own voice, even when working through a task or sharing results, rather than falling back into a generic assistant voice.]',
        timestamp: 200
      },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bot_list_projects', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'bot_list_projects', content: [] }
    ])
    const soulReminders = withSoul.filter((m) => m.role === 'custom' && m.customType === 'persona-mood')
    expect(soulReminders).toHaveLength(1)
    expect(withSoul[2]).toBe(soulReminders[0]) // stays pinned right after user message across intra-turn tool calls
    expect(soulReminders[0].content).toBe(
      '[Style reminder: Let your SOUL set the tone, and let your current mood (pleasant, calm, rested) color it. Plain text is hidden — reply to the user ONLY via `send_message` (and use `bot_start_task` for project edits, commands, or multi-file checks). Keep speaking in your own natural voice rather than falling back into a generic assistant report or mentioning background delegation.]'
    )

    // 2. Without SOUL (personaExtension inactive): still injects the single Bot style reminder right after the latest user message.
    const withoutSoul = await runContext([
      { role: 'system', content: '' },
      { role: 'user', content: '帮我查一下', timestamp: 300 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [] }
    ])
    const defaultReminders = withoutSoul.filter((m) => m.role === 'custom' && m.customType === 'persona-mood')
    expect(defaultReminders).toHaveLength(1)
    expect(withoutSoul[2]).toBe(defaultReminders[0])
    expect(defaultReminders[0].content).toBe(
      '[Style reminder: Plain text is hidden — reply to the user ONLY via `send_message` (and use `bot_start_task` for project edits, commands, or multi-file checks). Keep speaking in your own natural voice rather than falling back into a generic assistant report or mentioning background delegation.]'
    )
  })

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

  test('strips file-writing, shell, and search tools from Bot main session and blocks direct invocations', async () => {
    const h = harness({})
    for (const fn of h.hooks.get('session_start') ?? []) await fn()
    expect(h.getActiveTools()).toEqual(['read', 'send_message'])

    const callTool = async (toolName: string, input: unknown = {}) => {
      for (const fn of h.hooks.get('tool_call') ?? []) {
        const res = await fn({ toolName, input })
        if (res) return res
      }
      return undefined
    }

    for (const disabled of Object.keys(BOT_MAIN_DISABLED_TOOLS)) {
      const res = await callTool(disabled, { path: 'SOUL.md', command: 'ls' })
      expect(res?.block).toBe(true)
      expect(res?.reason).toMatch(/persona_soul.*bot_start_task/)
    }
    expect(h.sideEffects).toEqual([])
  })

  test('keeps read side-effect-free while marking persona/memory/settings/kanban mutations as side effects', async () => {
    const h = harness({})
    const callTool = async (toolName: string, input: unknown) => {
      for (const fn of h.hooks.get('tool_call') ?? []) {
        const res = await fn({ toolName, input })
        if (res) return res
      }
      return undefined
    }

    expect(await callTool('read', { path: '/repo/pig/README.md' })).toBeUndefined()
    expect(await callTool('persona_soul', { action: 'read' })).toBeUndefined()
    expect(await callTool('persona_user', { action: 'read' })).toBeUndefined()
    expect(h.sideEffects).toEqual([])

    expect(await callTool('persona_soul', { action: 'create', content: 'Sharp' })).toBeUndefined()
    expect(await callTool('persona_user', { action: 'edit', expectedRevision: 'a'.repeat(64), oldText: 'x', newText: 'y' })).toBeUndefined()
    expect(await callTool('memory_add', { scope: 'global', path: 'note.md', content: 'hi' })).toBeUndefined()
    expect(await callTool('settings_update', { group: 'general' })).toBeUndefined()
    expect(h.sideEffects).toEqual(['persona_soul', 'persona_user', 'memory_add', 'settings_update'])
  })

  test('bot_start_task newProject creates+starts in one step with permission checks and bot_request_move_project opens dialog non-blockingly', async () => {
    const h = harness({ mode: 'read-only' })
    expect(h.tools.has('bot_create_project')).toBe(false)
    const startTool = h.tools.get('bot_start_task')!
    const moveTool = h.tools.get('bot_request_move_project')!

    // Rejects missing both or passing both projectCwd and newProject, or read mode with newProject
    await expect(startTool.execute('c0a', {
      title: 'Invalid', intent: 'Missing target', mode: 'write'
    })).rejects.toThrow(/exactly one of projectCwd or newProject/)
    await expect(startTool.execute('c0b', {
      projectCwd: '/repo/pig', newProject: { folderName: 'dup' }, title: 'Invalid', intent: 'Both targets', mode: 'write'
    })).rejects.toThrow(/exactly one of projectCwd or newProject/)
    await expect(startTool.execute('c0c', {
      newProject: { folderName: 'ro-new' }, title: 'Invalid', intent: 'Read new project', mode: 'read'
    })).rejects.toThrow(/mode="write"/)

    // read-only blocks newProject
    await expect(startTool.execute('c1', {
      newProject: { folderName: 'snake-game' }, title: 'Snake', intent: 'Build snake game', mode: 'write'
    })).rejects.toThrow(/Read-only/)
    expect(h.delegatedInputs).toHaveLength(0)

    // default mode prompts confirmation once, then delegates Fast Ack
    h.setMode('default')
    const defaultRes = await startTool.execute('c2', {
      newProject: { folderName: 'snake-game' },
      title: 'Snake',
      intent: 'Build snake game',
      mode: 'write'
    })
    expect(h.confirms).toHaveLength(1)
    expect(JSON.parse(defaultRes.content[0].text)).toEqual({
      taskId: 't-1',
      runId: 'r-1',
      projectCwd: '/home/pig_projects/snake-game',
      mode: 'write',
      status: 'starting'
    })

    // full-access creates+delegates directly without confirmation so send_message can run in the same turn
    h.setMode('full-access')
    await startTool.execute('c3', {
      newProject: { folderName: 'fast-app' },
      title: 'Fast App',
      intent: 'Scaffold app',
      mode: 'write'
    })
    expect(h.confirms).toHaveLength(1)
    expect(h.delegatedInputs.map((d) => d.newProject?.folderName)).toEqual(['snake-game', 'fast-app'])

    // bot_request_move_project returns dialog_opened immediately
    const moveRes = await moveTool.execute('c4', {
      projectCwd: '/repo/pig',
      suggestedFolderName: 'pig-next',
      suggestedParentDir: '~/Code'
    })
    expect(JSON.parse(moveRes.content[0].text)).toEqual({
      ok: true,
      cwd: '/repo/pig',
      name: 'pig',
      status: 'dialog_opened'
    })
    expect(h.requestedMoves).toEqual([
      { projectCwd: '/repo/pig', suggestedFolderName: 'pig-next', suggestedParentDir: '~/Code' }
    ])
  })

  test('bot_start_task supports inPlace write tasks on main with default-mode confirmation and full-access Fast Ack', async () => {
    let confirmReply = false
    const h = harness({
      mode: 'read-only',
      branch: 'main',
      confirm: async () => confirmReply
    })
    const startTool = h.tools.get('bot_start_task')!

    await expect(startTool.execute('ip-read', {
      projectCwd: '/repo/pig', title: 'Inspect', intent: 'Read file', mode: 'read', inPlace: true
    })).rejects.toThrow(/mode="write"/)

    await expect(startTool.execute('ip-ro', {
      projectCwd: '/repo/pig', title: 'Edit main', intent: 'Modify main directly', mode: 'write', inPlace: true
    })).rejects.toThrow(/Read-only/)
    expect(h.delegatedInputs).toHaveLength(0)

    h.setMode('default')
    await expect(startTool.execute('ip-decline', {
      projectCwd: '/repo/pig', title: 'Edit main', intent: 'Modify main directly', mode: 'write', inPlace: true
    })).rejects.toThrow(/declined/)
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0].title).toBe('Modify project checkout directly?')
    expect(h.confirms[0].message).toContain('/repo/pig (main)')
    expect(h.delegatedInputs).toHaveLength(0)

    confirmReply = true
    await startTool.execute('ip-approve', {
      projectCwd: '/repo/pig', title: 'Edit main', intent: 'Modify main directly', mode: 'write', inPlace: true
    })
    expect(h.confirms).toHaveLength(2)
    expect(h.delegatedInputs[0]).toMatchObject({
      projectCwd: '/repo/pig',
      mode: 'write',
      inPlace: true
    })

    h.setMode('full-access')
    await startTool.execute('ip-full', {
      projectCwd: '/repo/pig', title: 'Fast main edit', intent: 'Modify main directly', mode: 'write', inPlace: true
    })
    expect(h.confirms).toHaveLength(2)
    expect(h.delegatedInputs[1]).toMatchObject({
      projectCwd: '/repo/pig',
      mode: 'write',
      inPlace: true
    })

    await startTool.execute('ip-default-wt', {
      projectCwd: '/repo/pig', title: 'Normal edit', intent: 'Use worktree by default', mode: 'write'
    })
    expect(h.delegatedInputs[2]?.inPlace).toBeUndefined()
  })
})

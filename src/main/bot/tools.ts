/**
 * Bot-exclusive tools (`send_message` + 9 `bot_*` orchestration tools) using @earendil-works/pi-schema.
 * Enforces §5.2/§5.5 permission and approval boundaries, including mandatory confirmation for dirty/unmerged
 * worktree cleanup even in `full-access` mode.
 */
import { randomUUID } from 'node:crypto'
import { arr, bool, compile, obj, oneOf, opt, str, type Schema } from '@earendil-works/pi-schema'
import { defineTool, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ThinkingLevel } from '../../shared/api'
import type { PermissionMode } from '../../shared/permissions'
import { restrictPermissionMode } from '../permissions/mode'
import type { BotDelegateTaskInput, BotTask, BotTimelineItem } from '../../shared/bot'
import { BOT_SYSTEM_PROMPT } from './prompt'
import { resolveBotAttachments, stripHiddenBotTags } from './projection'
import type { BotTaskManager } from './task-manager'

export interface BotToolsHost {
  taskManager: BotTaskManager
  getPermissionMode: () => PermissionMode
  onPermissionsChanged?: (listener: () => void) => () => void
  listOpenedProjects: () => Promise<Array<{ cwd: string; name: string; hasGit?: boolean }>>
  openProject: (path: string, check?: () => void) => Promise<{ cwd: string; name: string }>
  inspectTaskSession: (task: BotTask) => Promise<{ recentMessages: Array<{ role: string; text: string }>; diffSummary?: string }>
  confirmAction: (title: string, message: string, ctx?: ExtensionContext, signal?: AbortSignal) => Promise<boolean>
  onSendMessage: (item: Extract<BotTimelineItem, { kind: 'assistant' }>) => Promise<void>
  onSideEffect: (toolName: string) => void
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[]

const sendMessageSchema = obj({
  type: oneOf(['text', 'delivery', 'attachment'] as const),
  content: str({ minLength: 1 }),
  taskIds: opt(arr(str({ minLength: 1 }))),
  attachments: opt(arr(str({ minLength: 1 })))
})

const delegateSchema = obj({
  projectCwd: str({ minLength: 1 }),
  title: str({ minLength: 1 }),
  intent: str({ minLength: 1 }),
  mode: oneOf(['read', 'write'] as const),
  slug: opt(str({ minLength: 1 })),
  capabilities: opt(obj({ browser: opt(bool()) })),
  modelOverride: opt(obj({ provider: str({ minLength: 1 }), id: str({ minLength: 1 }) })),
  thinkingOverride: opt(oneOf(THINKING_LEVELS))
})

const followupSchema = obj({
  taskId: str({ minLength: 1 }),
  instruction: str({ minLength: 1 }),
  modelOverride: opt(obj({ provider: str({ minLength: 1 }), id: str({ minLength: 1 }) })),
  thinkingOverride: opt(oneOf(THINKING_LEVELS))
})

const openProjectSchema = obj({ path: str({ minLength: 1 }) })
const taskIdSchema = obj({ taskId: str({ minLength: 1 }) })
const listTasksSchema = obj({
  status: opt(oneOf(['active', 'all', 'completed', 'failed', 'stopped'] as const))
})
const emptySchema = obj({})

function assertValid<T>(schema: Schema<T>, value: unknown, name: string): T {
  const validator = compile(schema)
  if (!validator.check(value)) {
    throw new Error(`Invalid arguments for ${name}`)
  }
  return value as T
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    details: undefined
  }
}

const BOT_BASH_MAX_TIMEOUT_SEC = 30

function guardPermission(host: BotToolsHost, signal?: AbortSignal) {
  const mode = host.getPermissionMode()
  const downgraded = new AbortController()
  const guardedSignal = AbortSignal.any([downgraded.signal, ...(signal ? [signal] : [])])
  const check = () => {
    guardedSignal.throwIfAborted()
    if (restrictPermissionMode(mode, host.getPermissionMode()) !== mode) {
      throw new Error('Bot permission mode changed; request the operation again')
    }
  }
  const dispose = host.onPermissionsChanged?.(() => {
    try { check() } catch (error) { downgraded.abort(error) }
  })
  return { mode, signal: guardedSignal, check, dispose: () => dispose?.() }
}

export function createBotExtension(host: BotToolsHost) {
  return function botExtension(pi: ExtensionAPI): void {
    pi.on('before_agent_start', (event) => {
      event.systemPromptOptions.sections.bot = BOT_SYSTEM_PROMPT
    })

    // Cap Bot main-session bash timeout so long tasks go through bot_delegate_task instead of hanging chat.
    pi.on('tool_call', (event) => {
      if (event.toolName === 'edit' || event.toolName === 'write' || event.toolName === 'bash') {
        host.onSideEffect(event.toolName)
      }
      if (event.toolName === 'bash' && event.input && typeof event.input === 'object') {
        const input = event.input as { timeout?: number }
        if (typeof input.timeout !== 'number' || input.timeout > BOT_BASH_MAX_TIMEOUT_SEC) {
          input.timeout = BOT_BASH_MAX_TIMEOUT_SEC
        }
      }
      return undefined
    })

    pi.registerTool(defineTool({
      name: 'send_message',
      label: 'Send message to user',
      description: 'Send a visible message bubble to the user in the Bot conversation. Plain assistant text is hidden; this tool is the ONLY user-visible channel.',
      parameters: sendMessageSchema,
      async execute(_id, rawParams) {
        const params = assertValid(sendMessageSchema, rawParams, 'send_message')
        const content = stripHiddenBotTags(params.content)
        if (!content) throw new Error('send_message content cannot be empty')

        let verifiedTaskIds: string[] | undefined
        if (params.taskIds?.length) {
          const allTasks = await host.taskManager.listTasks()
          const known = new Set(allTasks.map((t) => t.taskId))
          for (const tid of params.taskIds) {
            if (!known.has(tid)) throw new Error(`Unknown taskId in send_message: ${tid}`)
          }
          verifiedTaskIds = [...new Set(params.taskIds)]
        }

        let resolvedAttachments: Awaited<ReturnType<typeof resolveBotAttachments>> | undefined
        if (params.type === 'attachment' || params.attachments?.length) {
          if (!params.attachments?.length) {
            throw new Error('attachment messages require at least one local file path')
          }
          resolvedAttachments = await resolveBotAttachments(params.attachments)
        }

        const item: Extract<BotTimelineItem, { kind: 'assistant' }> = {
          id: randomUUID(),
          kind: 'assistant',
          messageType: params.type,
          content,
          ...(verifiedTaskIds ? { taskIds: verifiedTaskIds } : {}),
          ...(resolvedAttachments ? { attachments: resolvedAttachments } : {}),
          createdAt: Date.now()
        }
        host.onSideEffect('send_message')
        await host.onSendMessage(item)
        return jsonResult({ ok: true, messageId: item.id })
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_list_projects',
      label: 'List open projects',
      description: 'List currently opened Pig project directories available for Bot delegation.',
      parameters: emptySchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      async execute() {
        const projects = await host.listOpenedProjects()
        return jsonResult({ projects })
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_open_project',
      label: 'Open existing project directory',
      description: 'Register an existing local directory in Pig’s opened projects list. Never creates directories or clones repositories.',
      parameters: openProjectSchema,
      async execute(_id, rawParams, signal, _update, ctx) {
        const params = assertValid(openProjectSchema, rawParams, 'bot_open_project')
        const guard = guardPermission(host, signal)
        try {
          guard.check()
          if (guard.mode === 'read-only') throw new Error('Read-only mode cannot register new projects')
          if (guard.mode === 'default') {
            const ok = await host.confirmAction(
              'Open project directory?',
              `Allow Bot to register existing directory ${params.path} in Pig?`,
              ctx,
              guard.signal
            )
            guard.check()
            if (!ok) throw new Error('User declined opening project directory')
          }
          host.onSideEffect('bot_open_project')
          const opened = await host.openProject(params.path, guard.check)
          return jsonResult({ ok: true, project: opened })
        } finally {
          guard.dispose()
        }
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_delegate_task',
      label: 'Delegate task asynchronously',
      description: 'Fast Ack (<50ms) async delegation to a background project session (Git write tasks automatically get an isolated bot/<slug>-<shortId> worktree). Returns immediately with status="starting"; do not poll.',
      parameters: delegateSchema,
      async execute(_id, rawParams, signal, _update, ctx) {
        const params = assertValid(delegateSchema, rawParams, 'bot_delegate_task')
        const guard = guardPermission(host, signal)
        try {
          guard.check()
          if (params.mode === 'write' && guard.mode === 'read-only') {
            throw new Error('Read-only mode cannot delegate write tasks')
          }
          const projects = await host.listOpenedProjects()
          guard.check()
          const target = projects.find((p) => p.cwd === params.projectCwd)
          let confirmSharedNonGitWrite = false
          if (target && target.hasGit === false && params.mode === 'write') {
            const ok = await host.confirmAction(
              'Write directly in non-Git directory?',
              `${target.cwd} is not a Git repository. Allow Bot to run a write task directly in this directory?`,
              ctx,
              guard.signal
            )
            guard.check()
            if (!ok) throw new Error('User declined writing in non-Git directory')
            confirmSharedNonGitWrite = true
          }
          host.onSideEffect('bot_delegate_task')
          const input: BotDelegateTaskInput = {
            projectCwd: params.projectCwd,
            title: params.title,
            intent: params.intent,
            mode: params.mode,
            slug: params.slug,
            capabilities: params.capabilities,
            modelOverride: params.modelOverride,
            thinkingOverride: params.thinkingOverride,
            confirmSharedNonGitWrite
          }
          const ack = await host.taskManager.delegateTask(input, guard.mode, guard.check)
          return jsonResult(ack)
        } finally {
          guard.dispose()
        }
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_list_tasks',
      label: 'List Bot tasks',
      description: 'List Bot tasks tracked in the persistent task ledger.',
      parameters: listTasksSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      async execute(_id, rawParams) {
        const params = assertValid(listTasksSchema, rawParams ?? {}, 'bot_list_tasks')
        const all = await host.taskManager.listTasks()
        const filtered = all.filter((t) => {
          if (!params.status || params.status === 'all') return true
          if (params.status === 'active') return t.status === 'starting' || t.status === 'running' || t.status === 'blocked_approval'
          return t.status === params.status
        })
        return jsonResult({ tasks: filtered.slice(0, 50) })
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_get_task',
      label: 'Get Bot task details',
      description: 'Get full ledger state, runs, workspace, and latest receipt for a single Bot task.',
      parameters: taskIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      async execute(_id, rawParams) {
        const params = assertValid(taskIdSchema, rawParams, 'bot_get_task')
        const task = await host.taskManager.getTask(params.taskId)
        if (!task) throw new Error(`Bot task not found: ${params.taskId}`)
        return jsonResult({ task })
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_inspect_task',
      label: 'Inspect Bot task output',
      description: 'Read bounded recent output from an active Bot run, plus a summary of the latest saved diff receipt.',
      parameters: taskIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      async execute(_id, rawParams) {
        const params = assertValid(taskIdSchema, rawParams, 'bot_inspect_task')
        const task = await host.taskManager.getTask(params.taskId)
        if (!task) throw new Error(`Bot task not found: ${params.taskId}`)
        const details = await host.inspectTaskSession(task)
        return jsonResult({ taskId: task.taskId, status: task.status, workspace: task.workspace, ...details })
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_stop_task',
      label: 'Stop Bot task',
      description: 'Stop a running or starting Bot task. If a settled receipt is returned, report it via send_message in this turn; no separate stop notice will follow.',
      parameters: taskIdSchema,
      async execute(_id, rawParams) {
        const params = assertValid(taskIdSchema, rawParams, 'bot_stop_task')
        host.onSideEffect('bot_stop_task')
        const { task, runId, receipt } = await host.taskManager.stopTaskFromTool(params.taskId)
        return jsonResult({ ok: true, taskId: task.taskId, status: task.status, runId, receipt })
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_followup_task',
      label: 'Follow up on Bot task',
      description: 'Start a new run on an existing stopped, failed, interrupted, or completed Bot task using its preserved worktree.',
      parameters: followupSchema,
      async execute(_id, rawParams) {
        const params = assertValid(followupSchema, rawParams, 'bot_followup_task')
        const mode = host.getPermissionMode()
        host.onSideEffect('bot_followup_task')
        const ack = await host.taskManager.followupTask(params.taskId, params.instruction, mode, {
          modelOverride: params.modelOverride,
          thinkingOverride: params.thinkingOverride
        })
        return jsonResult(ack)
      }
    }))

    pi.registerTool(defineTool({
      name: 'bot_cleanup_worktree',
      label: 'Clean up Bot worktree',
      description: 'Delete a finished Bot-owned worktree. Requires explicit user confirmation whenever uncommitted changes or unmerged commits exist, even in full-access mode.',
      parameters: taskIdSchema,
      async execute(_id, rawParams, signal, _update, ctx) {
        const params = assertValid(taskIdSchema, rawParams, 'bot_cleanup_worktree')
        const guard = guardPermission(host, signal)
        try {
        guard.check()
        const mode = guard.mode
        if (mode === 'read-only') throw new Error('Read-only mode cannot delete worktrees')
        const safety = await host.taskManager.checkWorktreeCleanupSafety(params.taskId)
        // Mandatory confirmation whenever dirty or unmerged, even in full-access; default mode always confirms.
        let confirmation: string | undefined
        if (safety.needsForceConfirm || mode === 'default') {
          const reasons: string[] = []
          if (safety.dirty) reasons.push('uncommitted changes')
          if (safety.unmerged) reasons.push('unmerged commits')
          const detail = reasons.length > 0
            ? `Worktree ${safety.branch} still has ${reasons.join(' and ')}. Permanently delete it?`
            : `Delete Bot worktree ${safety.branch}?`
          const ok = await host.confirmAction('Delete Bot worktree?', detail, ctx, guard.signal)
          guard.check()
          if (!ok) throw new Error('User declined deleting Bot worktree')
          if (!safety.snapshot) throw new Error('Worktree confirmation snapshot is unavailable')
          confirmation = safety.snapshot
        }
        guard.check()
        host.onSideEffect('bot_cleanup_worktree')
        const result = await host.taskManager.cleanupWorktree(params.taskId, confirmation, guard.check)
        return jsonResult({ ok: true, ...result })
        } finally {
          guard.dispose()
        }
      }
    }))
  }
}

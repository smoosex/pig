/**
 * Main-process authorization and project-scope enforcement for `pig-kanban` agent tools.
 * - Project sessions (including Git worktrees and Bot-managed project runs) are strictly confined to their root project.
 * - Standalone Chats and the Bot main session have global scope across opened projects and unassigned issues.
 * - `read-only` permission mode blocks all mutations.
 */
import { resolve } from 'node:path'
import type { KanbanAgentCaller } from '../../shared/kanban'
import type { PermissionMode } from '../../shared/permissions'
import { currentBotSessionId } from '../bot/lifecycle'
import { isChatCwd } from '../chats'
import { listOpenedCwds } from '../opened-projects'
import { approvalDelegation } from '../permissions/delegation'
import { restrictPermissionMode } from '../permissions/mode'
import { sessionPermission } from '../permissions/store'
import { getLive } from '../pi/session-registry'
import { registerKanbanAgentHost } from '../plugins/pig-kanban-host'
import { kanban, resolveSessionProjectRoot } from './service'

interface ResolvedCallerScope {
  sessionId: string
  mode: PermissionMode
  /** Non-null when caller is confined to a single project; null when caller has global scope (Bot main or standalone Chat). */
  lockedProjectCwd: string | null
  sessionLink: { sessionId: string; cwd: string } | null
}

async function resolveCallerScope(caller: KanbanAgentCaller): Promise<ResolvedCallerScope> {
  const botId = currentBotSessionId()
  if (caller.isBotMain || (botId && caller.sessionId === botId)) {
    const id = botId ?? caller.sessionId
    return {
      sessionId: id,
      mode: sessionPermission(id).mode,
      lockedProjectCwd: null,
      sessionLink: null
    }
  }

  const live = getLive(caller.sessionId)
  if (!live) {
    throw new Error('The requesting session is no longer open in Pig')
  }

  let mode = sessionPermission(caller.sessionId).mode
  const delegated = approvalDelegation(caller.sessionId)
  if (delegated) {
    mode = restrictPermissionMode(mode, sessionPermission(delegated.controllerId).mode)
  }

  if (isChatCwd(live.cwd)) {
    return {
      sessionId: caller.sessionId,
      mode,
      lockedProjectCwd: null,
      sessionLink: { sessionId: caller.sessionId, cwd: live.cwd }
    }
  }

  const projectRoot = await resolveSessionProjectRoot(live.cwd)
  if (!projectRoot) {
    throw new Error('Current project is not registered in Pig')
  }

  return {
    sessionId: caller.sessionId,
    mode,
    lockedProjectCwd: projectRoot,
    sessionLink: { sessionId: caller.sessionId, cwd: live.cwd }
  }
}

async function normalizeGlobalProjectAssignment(
  projectCwd: string | null | undefined,
  existingProjectCwd?: string | null
): Promise<string | null | undefined> {
  if (projectCwd === undefined) return undefined
  if (projectCwd === null || projectCwd === '') return null
  const normalized = resolve(projectCwd)
  if (existingProjectCwd && resolve(existingProjectCwd) === normalized) return normalized
  const opened = await listOpenedCwds()
  // Also accept a worktree cwd if the model passed one, normalizing it to the opened root project.
  if (opened.includes(normalized)) return normalized
  const fromWorktree = await resolveSessionProjectRoot(normalized)
  if (fromWorktree) return fromWorktree
  throw new Error(`Project is not open in Pig: ${projectCwd}`)
}

function assertWritable(mode: PermissionMode): void {
  if (mode === 'read-only') {
    throw new Error('Kanban write operations are disabled in read-only permission mode')
  }
}

export function registerKanbanAgent(): void {
  registerKanbanAgentHost({
    async get(caller, number) {
      const scope = await resolveCallerScope(caller)
      const issue = await kanban.getByNumber(number)
      if (!issue) throw new Error(`Issue #${number} not found`)
      if (scope.lockedProjectCwd && issue.projectCwd !== scope.lockedProjectCwd) {
        throw new Error(`Issue #${number} does not belong to the current project`)
      }
      const imageBlocks = await kanban.readIssueImageBlocks(issue)
      return {
        issue,
        ...(imageBlocks.length > 0 ? { imageBlocks } : {})
      }
    },

    async list(caller, filter) {
      const scope = await resolveCallerScope(caller)
      if (scope.lockedProjectCwd) {
        if (
          filter.projectCwd !== undefined &&
          filter.projectCwd !== null &&
          resolve(filter.projectCwd) !== scope.lockedProjectCwd
        ) {
          const resolvedFilterRoot = await resolveSessionProjectRoot(filter.projectCwd)
          if (resolvedFilterRoot !== scope.lockedProjectCwd) {
            throw new Error('Project sessions can only list issues belonging to their own project')
          }
        }
        if (filter.projectCwd === null) {
          throw new Error('Project sessions can only list issues belonging to their own project')
        }
        return kanban.list({
          ...filter,
          projectCwd: scope.lockedProjectCwd,
          includeDone: filter.includeDone ?? true
        })
      }

      const resolvedProjectCwd =
        filter.projectCwd === undefined
          ? undefined
          : filter.projectCwd === null
            ? null
            : await normalizeGlobalProjectAssignment(filter.projectCwd)

      return kanban.list({
        ...filter,
        projectCwd: resolvedProjectCwd,
        includeDone: filter.includeDone ?? true
      })
    },

    async create(caller, input) {
      const scope = await resolveCallerScope(caller)
      assertWritable(scope.mode)

      let projectCwd: string | null
      if (scope.lockedProjectCwd) {
        if (input.projectCwd !== undefined && input.projectCwd !== null) {
          const candidate =
            resolve(input.projectCwd) === scope.lockedProjectCwd
              ? scope.lockedProjectCwd
              : await resolveSessionProjectRoot(input.projectCwd)
          if (candidate !== scope.lockedProjectCwd) {
            throw new Error('Project sessions can only create issues for their own project')
          }
        } else if (input.projectCwd === null) {
          throw new Error('Project sessions can only create issues for their own project')
        }
        projectCwd = scope.lockedProjectCwd
      } else {
        projectCwd = (await normalizeGlobalProjectAssignment(input.projectCwd)) ?? null
      }

      const { issue } = await kanban.create({ ...input, projectCwd })
      if (scope.sessionLink) {
        await kanban.linkSession([issue.number], scope.sessionLink)
        return (await kanban.getByNumber(issue.number)) ?? issue
      }
      return issue
    },

    async update(caller, input) {
      const scope = await resolveCallerScope(caller)
      assertWritable(scope.mode)

      const existing = await kanban.getByNumber(input.number)
      if (!existing) throw new Error(`Issue #${input.number} not found`)

      let nextProjectCwd: string | null | undefined
      if (scope.lockedProjectCwd) {
        if (existing.projectCwd !== scope.lockedProjectCwd) {
          throw new Error(`Issue #${input.number} does not belong to the current project`)
        }
        if (input.projectCwd !== undefined) {
          if (input.projectCwd === null) {
            throw new Error('Project sessions cannot unassign an issue from the current project')
          }
          const candidate =
            resolve(input.projectCwd) === scope.lockedProjectCwd
              ? scope.lockedProjectCwd
              : await resolveSessionProjectRoot(input.projectCwd)
          if (candidate !== scope.lockedProjectCwd) {
            throw new Error('Project sessions cannot move an issue to another project')
          }
          nextProjectCwd = scope.lockedProjectCwd
        }
      } else {
        nextProjectCwd = await normalizeGlobalProjectAssignment(input.projectCwd, existing.projectCwd)
      }

      const { issue } = await kanban.update({
        ...input,
        ...(nextProjectCwd !== undefined ? { projectCwd: nextProjectCwd } : {})
      })
      if (scope.sessionLink) {
        await kanban.linkSession([issue.number], scope.sessionLink)
        return (await kanban.getByNumber(issue.number)) ?? issue
      }
      return issue
    },

    async remove(caller, number, options) {
      const scope = await resolveCallerScope(caller)
      assertWritable(scope.mode)

      const existing = await kanban.getByNumber(number)
      if (!existing) throw new Error(`Issue #${number} not found`)
      if (scope.lockedProjectCwd && existing.projectCwd !== scope.lockedProjectCwd) {
        throw new Error(`Issue #${number} does not belong to the current project`)
      }

      if (scope.mode !== 'full-access') {
        if (!options?.confirm) {
          throw new Error('Deleting a Kanban issue requires interactive user confirmation')
        }
        options.signal?.throwIfAborted()
        const approved = await options.confirm(
          `Delete Kanban issue #${existing.number}?`,
          `Permanently delete "#${existing.number} ${existing.title}" from Pig’s Kanban board?`
        )
        options.signal?.throwIfAborted()
        if (!approved) {
          throw new Error('User declined deleting the Kanban issue')
        }
      }

      await kanban.delete(number)
      return { deleted: true, number }
    }
  })
}

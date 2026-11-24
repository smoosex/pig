/**
 * Persona runs in all human conversations (never child agents).
 * Observational memory runs by default in Bot, standalone Chat, and project/worktree conversations;
 * project/worktree conversations can be toggled independently via `enableInProjects`.
 */
import { resolve } from 'node:path'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { isChatCwd } from '../chats'
import { pigPath } from '../pig-dir'
import { loadConfig } from './memory/config'

export function isObservationalMemoryEnabledForCwd(
  cwd: string,
  options?: { isolatedWorkspace?: boolean }
): boolean {
  if (options?.isolatedWorkspace || isChatCwd(cwd) || resolve(cwd) === resolve(pigPath('bot', 'workspace'))) {
    return true
  }
  return loadConfig(cwd).enableInProjects !== false
}

export function conversationFeatureFactories(context?: { cwd: string; isolatedWorkspace?: boolean }): InlineExtension[] {
  return [
    { name: 'pig-persona', factory: async pi => {
      const { default: persona } = await import('./persona')
      persona(pi)
    } },
    { name: 'observational-memory', factory: async pi => {
      if (context && !isObservationalMemoryEnabledForCwd(context.cwd, { isolatedWorkspace: context.isolatedWorkspace })) {
        return
      }
      const { default: memory } = await import('./memory')
      await memory(pi)
    } },
  ]
}

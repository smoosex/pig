import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { FollowUpAction, SlashCommand as SessionSlashCommand } from '../../shared/api'
import { batchQueueUpdates, removePendingUserMessage, updatePendingUserMessageMode } from './event-bridge'

export async function updateFollowUpMessage(
  session: AgentSession,
  index: number,
  action: FollowUpAction
): Promise<string | null> {
  if (!Number.isInteger(index) || index < 0) throw new Error('Invalid follow-up index')
  if (action !== 'steer' && action !== 'edit' && action !== 'dismiss') {
    throw new Error('Invalid follow-up action')
  }
  const queued = [...session.getFollowUpMessages()]
  const target = queued[index]
  if (target === undefined) throw new Error('Follow-up message is no longer queued')
  if (action === 'steer') {
    updatePendingUserMessageMode(session, 'followUp', index, 'steer')
  } else {
    removePendingUserMessage(session, 'followUp', index)
  }
  return batchQueueUpdates(session, async () => {
    const { steering } = session.clearQueue()
    const remaining = queued.filter((_message, queuedIndex) => queuedIndex !== index)
    for (const message of steering) await session.steer(message)
    if (action === 'steer') await session.steer(target)
    for (const message of remaining) await session.followUp(message)
    return action === 'edit' ? target : null
  })
}

const BUILTIN_SLASH_COMMANDS: SessionSlashCommand[] = [
  { name: 'export', description: '导出会话为 HTML 或 JSONL', source: 'builtin' }
]

export async function listSessionCommands(session: AgentSession): Promise<SessionSlashCommand[]> {
  const taken = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name))
  const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description,
    source: 'extension' as const
  }))
  const templates = session.promptTemplates.map((template) => ({
    name: template.name,
    description: template.description,
    source: 'prompt' as const
  }))
  const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: 'skill' as const
  }))
  return [
    ...BUILTIN_SLASH_COMMANDS,
    ...[...extensionCommands, ...templates, ...skills].filter((command) => !taken.has(command.name))
  ]
}

export async function exportSession(session: AgentSession, outputPath?: string): Promise<string> {
  const target = outputPath?.trim()
  if (target?.endsWith('.jsonl')) return session.exportToJsonl(target)
  return session.exportToHtml(target)
}

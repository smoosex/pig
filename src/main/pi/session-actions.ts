import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { FollowUpAction, PromptStreamingBehavior, RestoredSessionPrompt, SlashCommand as SessionSlashCommand } from '../../shared/api'
import { batchQueueUpdates, queuedUserImages, removePendingUserMessage, updatePendingUserMessageMode } from './event-bridge'

const BUILTIN_COMMANDS: SessionSlashCommand[] = [{ name: 'compact', source: 'builtin' }]

export async function updateFollowUpMessage(
  session: AgentSession,
  index: number,
  action: FollowUpAction,
  mode: PromptStreamingBehavior = 'followUp'
): Promise<RestoredSessionPrompt | null> {
  if (!Number.isInteger(index) || index < 0) throw new Error('Invalid follow-up index')
  if (action !== 'steer' && action !== 'edit' && action !== 'dismiss') {
    throw new Error('Invalid follow-up action')
  }
  if (mode !== 'steer' && mode !== 'followUp') throw new Error('Invalid queue mode')
  const queues = { steer: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] }
  const images = { steer: queuedUserImages(session, 'steer'), followUp: queuedUserImages(session, 'followUp') }
  const target = queues[mode][index]
  if (target === undefined) throw new Error('Message is no longer queued')
  if (action === 'steer' && mode === 'steer') return null
  const targetImages = images[mode][index]
  return batchQueueUpdates(session, async () => {
    if (action === 'steer') updatePendingUserMessageMode(session, mode, index, 'steer')
    else removePendingUserMessage(session, mode, index)
    queues[mode].splice(index, 1)
    images[mode].splice(index, 1)
    if (action === 'steer') {
      queues.steer.push(target)
      images.steer.push(targetImages)
    }
    session.clearQueue()
    for (const [i, text] of queues.steer.entries()) await session.steer(text, images.steer[i])
    for (const [i, text] of queues.followUp.entries()) await session.followUp(text, images.followUp[i])
    return action === 'edit' ? {
      text: target,
      images: (targetImages ?? []).map(({ mimeType, data }) => ({ mimeType, data }))
    } : null
  })
}

export async function listSessionCommands(session: AgentSession): Promise<SessionSlashCommand[]> {
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
  return [...BUILTIN_COMMANDS, ...extensionCommands, ...templates, ...skills]
}

export async function exportSession(session: AgentSession, outputPath: string): Promise<string> {
  return outputPath.endsWith('.jsonl') ? session.exportToJsonl(outputPath) : session.exportToHtml(outputPath)
}

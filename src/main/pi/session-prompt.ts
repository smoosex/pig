import { PASTED_TEXT_CUSTOM_TYPE } from '../../shared/pasted-text'
import { worktrees } from '../project-worktrees'
import { runBranchNamer } from './branch-namer'
import { queuePendingUserMessage } from './event-bridge'
import { getDefaultSessionSettings } from './model-settings'
import { normalizeSessionPrompt, type SessionPromptInput } from './prompt-input'
import { activateSession } from './session-registry'

/**
 * Submit a prompt and attach display metadata when Pi accepts its user message.
 * Queued follow-ups must not persist metadata or rename a worktree before delivery.
 */
export async function promptSession(sessionId: string, input: SessionPromptInput): Promise<void> {
  const { cwd, agentSession } = (await activateSession(sessionId)).session
  const prompt = normalizeSessionPrompt(input)
  worktrees.assertAvailable(cwd)
  const streamingBehavior =
    agentSession.isStreaming &&
    (input.streamingBehavior === 'steer' || input.streamingBehavior === 'followUp')
      ? input.streamingBehavior
      : undefined
  const cancelPending = queuePendingUserMessage(
    agentSession,
    prompt.modelText,
    prompt.displayMetadata,
    () => {
      if (prompt.metadata) {
        agentSession.sessionManager.appendCustomEntry(PASTED_TEXT_CUSTOM_TYPE, prompt.metadata)
      }
      void worktrees.nameOnFirstPrompt(cwd, prompt.namingText, async (task, signal) => {
        const settings = await getDefaultSessionSettings()
        return runBranchNamer(task, settings.model, signal)
      }).catch((error) => console.error('Worktree naming failed:', error))
    },
    streamingBehavior
  )
  try {
    await agentSession.prompt(
      prompt.modelText,
      prompt.images.length > 0 || streamingBehavior
        ? {
            ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {})
          }
        : undefined
    )
  } catch (error) {
    cancelPending()
    throw error
  }
}

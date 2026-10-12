import { createPastedTextDeliveryMetadata, PASTED_TEXT_CUSTOM_TYPE } from '../../shared/pasted-text'
import { worktrees } from '../project-worktrees'
import { nameWorktreeBranch } from './branch-namer'
import { queuePendingUserMessage } from './event-bridge'
import { normalizeSessionPrompt, type SessionPromptInput } from './prompt-input'
import { activateSessionInput } from './session-registry'

/**
 * Submit a prompt and attach display metadata when Pi accepts its user message.
 * Queued follow-ups must not persist metadata or rename a worktree before delivery.
 */
export async function promptSession(sessionId: string, input: SessionPromptInput): Promise<void> {
  const {
    session: { cwd, agentSession },
    releaseInput
  } = await activateSessionInput(sessionId)
  try {
    const prompt = normalizeSessionPrompt(input)
    worktrees.assertAvailable(cwd)
    if (agentSession.isBashRunning) throw new Error('Session is running a bash command')
    // Pi decides whether to start or queue after its input hooks; a preflight busy snapshot can be stale.
    const streamingBehavior =
      input.streamingBehavior === 'steer' || input.streamingBehavior === 'followUp'
        ? input.streamingBehavior
        : undefined
    // Extension commands execute directly in Pi; this input never becomes a queued user message.
    const isExtensionCommand =
      prompt.modelText.startsWith('/') &&
      agentSession.extensionRunner.getCommand(prompt.modelText.slice(1).split(' ', 1)[0]) !==
        undefined
    const pending = isExtensionCommand
      ? undefined
      : queuePendingUserMessage(
          agentSession,
          prompt.modelText,
          prompt.displayMetadata,
          (deliveredText) => {
            if (prompt.metadata) {
              agentSession.sessionManager.appendCustomEntry(
                PASTED_TEXT_CUSTOM_TYPE,
                createPastedTextDeliveryMetadata(prompt.modelText, prompt.metadata, deliveredText)
              )
            }
            void worktrees
              .nameOnFirstPrompt(cwd, prompt.namingText, nameWorktreeBranch)
              .catch((error) => console.error('Worktree naming failed:', error))
          },
          streamingBehavior,
          prompt.images
        )
    try {
      const submit = () => agentSession.prompt(prompt.modelText, {
        ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
        preflightResult: (disposition) => {
          if (disposition === 'handled') pending?.cancel()
        }
      })
      await (pending ? pending.submit(submit) : submit())
    } catch (error) {
      pending?.cancel()
      throw error
    }
  } finally {
    releaseInput()
  }
}

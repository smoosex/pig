/* Persona event adapter. Only feedback bookkeeping is session-local; the engine is always rebuilt under the global lock. */
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { MoodEngine } from './mood-engine'
import { personaTransaction, readPersona, type PersonaTransaction, type PersonaView } from './kernel'
import { DEFAULT_EMOTION_CONFIG, type EmotionalEvent } from './types'
import {
  createRepeatedErrorState, detectExplicitUserFeedback, detectFromBashResult,
  detectFromUserMessage, detectImplicitAcceptance, detectLateNight,
  detectRepeatedErrors, resetErrorStreak,
} from './triggers'

function apply(transaction: PersonaTransaction, event: EmotionalEvent): void {
  if (!transaction.engine.persistent.emotionUpdatesEnabled) return
  transaction.engine.processEvent(event)
  transaction.appendHistory()
}

function userText(content: Extract<AgentEndEvent['messages'][number], { role: 'user' }>['content']): string {
  return typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n')
}

function moodMessage(engine: MoodEngine, ctx: ExtensionContext) {
  // Inspect resolved context: navigation, compaction and edits can remove a snapshot.
  const previous = ctx.sessionManager.buildSessionProjection().messages.findLast(
    message => message.role === 'custom' && message.customType === 'persona-mood',
  )
  const content = engine.getEmotionPrompt()
  if (previous?.role === 'custom' && previous.content === content) return
  return { customType: 'persona-mood', content, display: false }
}

export default function personaExtension(pi: ExtensionAPI): void {
  const repeatedErrors = createRepeatedErrorState()
  let pendingImplicitAcceptance = false
  let currentAgentHadNegativeEvent = false
  const reset = (): void => {
    resetErrorStreak(repeatedErrors)
    pendingImplicitAcceptance = false
    currentAgentHadNegativeEvent = false
  }

  pi.on('session_start', async () => { reset() })
  pi.on('session_shutdown', async () => { reset() })
  pi.on('agent_start', async () => { currentAgentHadNegativeEvent = false })

  pi.on('before_agent_start', async (event, ctx) => {
    const inject = ({ active, engine }: PersonaView) => {
      if (!active) { reset(); return }
      return {
        systemPrompt: `${event.systemPrompt}\n\n---\n\n${engine.getPersonaPrompt()}\n\n---`,
        message: moodMessage(engine, ctx),
      }
    }
    if (event.messageType !== 'user' || !pendingImplicitAcceptance) return readPersona(inject)
    pendingImplicitAcceptance = false
    return personaTransaction(transaction => {
      const { active, engine } = transaction
      if (active && !detectExplicitUserFeedback(event.prompt, DEFAULT_EMOTION_CONFIG, engine.soul.traits.agreeableness)) {
        apply(transaction, detectImplicitAcceptance(DEFAULT_EMOTION_CONFIG, engine.soul.traits.agreeableness))
      }
      return inject(transaction)
    })
  })

  pi.on('session_compact', async (event, ctx) => {
    // Recovery/queued continuations skip before_agent_start. Only join an already
    // scheduled continuation; an ordinary compaction must not start a new turn.
    if (!event.willRetry && !ctx.hasPendingMessages()) return
    const message = await readPersona(view => view.active ? moodMessage(view.engine, ctx) : undefined)
    if (message) pi.sendMessage(message, { deliverAs: 'steer' })
  })

  pi.on('tool_result', async event => {
    if (event.toolName !== 'bash') return
    const { active, automatic } = await readPersona(view => ({ active: view.active, automatic: view.engine.persistent.emotionUpdatesEnabled }))
    if (!active) return
    const input = event.input as { command?: string }
    const result = event.structuredContent as { exit_code?: number } | undefined
    const command = input?.command ?? ''
    const exitCode = result?.exit_code
    const failed = !!event.isError || (exitCode !== undefined && exitCode !== 0)
    const emotionalEvent = detectRepeatedErrors(command, failed, DEFAULT_EMOTION_CONFIG, repeatedErrors) ??
      detectFromBashResult(exitCode, !!event.isError, command, DEFAULT_EMOTION_CONFIG)
    if (!emotionalEvent) return
    if (emotionalEvent.valence === 'negative') currentAgentHadNegativeEvent = true
    // The lock is only taken to write; apply re-checks the setting against the locked state.
    if (automatic) await personaTransaction(transaction => { if (transaction.active) apply(transaction, emotionalEvent) })
  })

  pi.on('agent_end', async event => {
    if (!await readPersona(view => view.active)) { reset(); return }
    await personaTransaction(transaction => {
      if (!transaction.active) { reset(); return }
      const { engine } = transaction
      let sawUserMessage = false
      let lastUserEvent: EmotionalEvent | null = null
      for (const message of event.messages) {
        if (message.role !== 'user') continue
        sawUserMessage = true
        const detected = detectFromUserMessage(userText(message.content), DEFAULT_EMOTION_CONFIG, engine.soul.traits.agreeableness)
        if (detected) lastUserEvent = detected
      }
      if (lastUserEvent) {
        apply(transaction, lastUserEvent)
        pendingImplicitAcceptance = false
      } else if (sawUserMessage && !currentAgentHadNegativeEvent) {
        pendingImplicitAcceptance = true
      }
      if (sawUserMessage) {
        const lateEvent = detectLateNight(DEFAULT_EMOTION_CONFIG, engine.soul.traits.extraversion)
        const now = Date.now()
        if (lateEvent && engine.persistent.emotionUpdatesEnabled && now - (engine.persistent.lastLateNightTrigger ?? 0) >= 30 * 60 * 1000) {
          apply(transaction, lateEvent)
          engine.persistent.lastLateNightTrigger = now
        }
      }
      resetErrorStreak(repeatedErrors)
    })
  })
}

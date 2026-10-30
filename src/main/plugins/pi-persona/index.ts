/* Persona identity and bounded expressive state. Observation is background-only and never continues the main agent. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { MoodEngine } from './mood-engine'
import { personaTransaction, readPersona, setActivity, type PersonaView } from './kernel'
import { soulPreamble } from './preamble'
import { personaDir } from './storage'
import { completedMoodRounds } from './conversation'
import { MoodObserver } from './observer'
import { onPersonaControlsChanged } from './controls'
import { appendObserverUsage } from './usage'

function moodMessage(engine: MoodEngine, ctx: ExtensionContext) {
  const previous = ctx.sessionManager.buildSessionProjection().messages.findLast(
    message => message.role === 'custom' && message.customType === 'persona-mood',
  )
  const content = engine.getEmotionPrompt()
  if (previous?.role === 'custom' && previous.content === content) return
  return { customType: 'persona-mood', content, display: false }
}

export default function personaExtension(pi: ExtensionAPI): void {
  const activityId = `pid/${process.pid}/${randomUUID()}`
  let working = false
  let activityTimer: ReturnType<typeof setInterval> | undefined
  let activityOperations = Promise.resolve()
  const updateActivity = (active: boolean) => {
    const task = activityOperations.then(() => setActivity(activityId, active))
    activityOperations = task.catch(() => {})
    return task
  }
  let live = false
  let epoch = 0
  let observer: MoodObserver | undefined
  let observerKey = ''
  let observerRevision = 0
  let baseline = new Set<string>()
  let submitted = new Set<string>()
  let context: ExtensionContext | undefined
  let unsubscribeControls: (() => void) | undefined

  const rounds = (ctx: ExtensionContext) => completedMoodRounds(ctx.sessionManager.buildSessionProjection().entries, ctx.sessionManager)
  const cancelObserver = (discardPending = false) => {
    if (discardPending) for (const id of submitted) baseline.add(id)
    submitted = new Set()
    epoch++
    observer?.dispose()
    observer = undefined
    observerKey = ''
  }
  const stopWorking = async () => {
    if (activityTimer) clearInterval(activityTimer)
    activityTimer = undefined
    if (!working) return
    // Cleared first so a failed release still lets the next agent_start register and renew the lease.
    working = false
    await updateActivity(false)
  }
  const observe = async (ctx: ExtensionContext) => {
    const options = await readPersona(({ active, engine }) => ({
      active, automatic: engine.persistent.emotionUpdatesEnabled, ...engine.persistent.observer,
      controlsRevision: engine.persistent.controlsRevision, persona: engine.soul.systemPrompt,
    }))
    if (!live || !options.active || !options.automatic || !options.enabled || !ctx.model) {
      cancelObserver()
      // Disabled periods are not replayed after re-enabling observation.
      baseline = new Set(rounds(ctx).map(round => round.id))
      return
    }
    const key = JSON.stringify([options.provider ?? ctx.model.provider, options.modelId ?? ctx.model.id,
      options.thinking, options.controlsRevision])
    // Only an explicit control change invalidates queued evidence; model or thinking switches just rebuild the worker.
    if (key !== observerKey) cancelObserver(observer !== undefined && observerRevision !== options.controlsRevision)
    if (!observer) {
      observerKey = key
      observerRevision = options.controlsRevision
      const generation = epoch
      const sessionId = ctx.sessionManager.getSessionId()
      observer = new MoodObserver(async (result, roundIds) => {
        if (!live || generation !== epoch || !context) return
        const currentIds = new Set(rounds(context).map(round => round.id))
        // A navigation that removed any pending evidence invalidates this observer generation.
        if (roundIds.some(id => !currentIds.has(id))) { cancelObserver(); return }
        await personaTransaction(transaction => {
          const { engine, active } = transaction
          const settings = engine.persistent.observer
          if (!live || generation !== epoch || !active || !engine.persistent.emotionUpdatesEnabled || !settings.enabled) return
          if (settings.provider !== options.provider || settings.modelId !== options.modelId || settings.thinking !== options.thinking) return
          if (engine.persistent.controlsRevision !== options.controlsRevision) return
          if (engine.applyObservation(result, 'conversation_observation')) transaction.appendHistory()
        })
      }, () => {
        if (live && generation === epoch) console.warn('[Persona] Background mood observation failed; main task is unaffected.')
      },
      ids => { for (const id of ids) baseline.add(id) },
      // Usage is analytics only: a failed write never affects mood or retries the batch.
      ({ usage, ...record }) => void appendObserverUsage({
        v: 1, at: Date.now(), sessionId, ...record,
        usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, reasoning: usage.reasoning ?? 0 } : null,
        cost: usage ? usage.cost.total : null,
      }).catch(error => console.warn('[Persona] Could not record mood observer usage.', error)))
    }
    const fresh = rounds(ctx).filter(round => !baseline.has(round.id))
    for (const round of fresh) submitted.add(round.id)
    // Do not pass ctx.signal: it belongs to the already completed foreground turn.
    const requestEpoch = epoch
    void observer.observe({ rounds: fresh, model: ctx.model, modelRegistry: {
      streamSimple: (model, request, settings) => ctx.modelRegistry.streamSimple(model, request, settings),
      find: ctx.modelRegistry.find.bind(ctx.modelRegistry),
      getApiKeyAndHeaders: ctx.modelRegistry.getApiKeyAndHeaders.bind(ctx.modelRegistry),
    },
      provider: options.provider, modelId: options.modelId, thinking: options.thinking, persona: options.persona,
    }).catch(() => {
      if (live && requestEpoch === epoch) console.warn('[Persona] Background mood observation failed; main task is unaffected.')
    })
  }

  pi.on('session_start', async (_event, ctx) => {
    cancelObserver()
    live = true
    unsubscribeControls?.()
    unsubscribeControls = onPersonaControlsChanged(() => cancelObserver(true))
    context = ctx
    baseline = new Set(rounds(ctx).map(round => round.id))
  })
  pi.on('session_shutdown', async () => {
    live = false
    unsubscribeControls?.()
    unsubscribeControls = undefined
    cancelObserver()
    context = undefined
    await stopWorking()
  })
  pi.on('session_tree', async (_event, ctx) => {
    cancelObserver()
    context = ctx
    baseline = new Set(rounds(ctx).map(round => round.id))
  })
  pi.on('agent_start', async (_event, ctx) => {
    context = ctx
    const active = await readPersona(view => view.active)
    if (!active || working) return
    await updateActivity(true)
    working = true
    activityTimer = setInterval(() => {
      if (live && working) void updateActivity(true).catch(() => {
        console.warn('[Persona] Could not renew activity state.')
      })
    }, 30 * 60_000)
    activityTimer.unref?.()
  })
  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx
    return readPersona(({ active, engine }: PersonaView) => {
      if (!active) { cancelObserver(); return }
      if (!engine.persistent.emotionUpdatesEnabled || !engine.persistent.observer.enabled) cancelObserver(true)
      if (!event.systemPromptOptions.customPrompt) {
        event.systemPromptOptions.sections.preamble = soulPreamble(engine.soul, join(personaDir(), 'SOUL.md'), new Date())
      }
      return { message: moodMessage(engine, ctx) }
    })
  })
  pi.on('session_compact', async (event, ctx) => {
    if (!event.willRetry && !ctx.hasPendingMessages()) return
    const message = await readPersona(view => view.active ? moodMessage(view.engine, ctx) : undefined)
    if (message) pi.sendMessage(message, { deliverAs: 'steer' })
  })
  pi.on('agent_end', async () => { await stopWorking() })
  pi.on('agent_settled', async (_event, ctx) => {
    context = ctx
    await stopWorking()
    await observe(ctx)
  })
}

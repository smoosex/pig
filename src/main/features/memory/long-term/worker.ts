/** Shared tool-free transport and aggregated usage for learning, integration and relevance. */
import { clampThinkingLevel, type Context, type Model } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { LongTermSettings } from '../../../../shared/long-term-memory'
import { resolveWorkerStreamSimple, type StreamableModelRegistry } from '../agents/worker-stream'
import { Runtime } from '../runtime'
import { workerHeadersFor, workerThinkingLevel } from '../hooks/worker-options'
import { MemoryReviewError, providerFailure, reviewPhase } from './review-errors'
import { LongTermMemoryStore } from './store'
import { longTermMemoryPath } from '../paths'

export async function memoryWorker(ctx: ExtensionContext, settings: LongTermSettings, systemPrompt: string,
  signal: AbortSignal, onModel?: (model: { provider: string; id: string }) => void,
  stage: 'extraction' | 'integration' | 'relevance' = 'relevance') {
  const runtime = new Runtime()
  await reviewPhase('configuration', () => runtime.ensureConfig(ctx.cwd))
  signal.throwIfAborted()
  if (settings.model) {
    if (!ctx.modelRegistry.find(settings.model.provider, settings.model.id)) throw new MemoryReviewError('model', 'Long-term memory model unavailable')
    runtime.config.model = settings.model
    runtime.config.fallbackModel = undefined
  }
  const resolved = await reviewPhase('authentication', () => runtime.resolveModel({ ...ctx, signal }))
  signal.throwIfAborted()
  if (!resolved.ok) throw new MemoryReviewError('authentication', 'Long-term memory model authentication unavailable')
  const worker = workerHeadersFor(ctx, resolved)
  const model = worker.model as Model<any>
  onModel?.({ provider: model.provider, id: model.id })
  if (settings.model && (model.id !== settings.model.id || model.provider !== settings.model.provider)) {
    throw new MemoryReviewError('model', 'Long-term memory model changed during resolution')
  }
  const thinking = clampThinkingLevel(model, settings.model?.thinking ?? (settings.model ? 'off' : workerThinkingLevel(runtime, worker)))
  const maxTokens = Math.min(thinking === 'off' ? 4096 : 8192, model.maxTokens, Math.floor(model.contextWindow / 3))
  const budget = Math.min(32_000, model.contextWindow) - maxTokens - Buffer.byteLength(systemPrompt)
  const requestModel = worker.baseUrl ? { ...model, baseUrl: worker.baseUrl } : model
  return {
    budget,
    async complete(payload: string): Promise<string> {
      signal.throwIfAborted()
      if (Buffer.byteLength(payload) > budget) throw new MemoryReviewError('budget', 'Long-term memory request exceeds model context budget')
      const context: Context = { systemPrompt, messages: [{ role: 'user', content: payload, timestamp: 0 }] }
      const result = await reviewPhase('request', async () => {
        const stream = resolveWorkerStreamSimple(requestModel, ctx.modelRegistry as unknown as StreamableModelRegistry)(requestModel, context, {
          apiKey: worker.apiKey, headers: worker.headers, env: worker.env, signal, maxTokens,
          ...(thinking === 'off' ? {} : { reasoning: thinking }), cacheRetention: 'short',
        })
        for await (const _event of stream) signal.throwIfAborted()
        const result = await stream.result()
        try {
          const store = new LongTermMemoryStore(longTermMemoryPath())
          try { store.recordUsage(stage, { input: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
            output: result.usage.output, cost: result.usage.cost.total }) } finally { store.close() }
        } catch { console.warn('[long-term-memory] usage persistence failed') }
        return result
      })
      signal.throwIfAborted()
      if (result.stopReason === 'error' || result.stopReason === 'aborted') throw providerFailure(result.errorMessage)
      if (result.stopReason !== 'stop' || result.content.some(block => block.type === 'toolCall')) {
        throw new MemoryReviewError('truncated', 'Long-term memory request did not complete')
      }
      return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    },
  }
}

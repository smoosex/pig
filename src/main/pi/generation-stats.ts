/**
 * Samples one assistant stream with a monotonic clock. Reasoning tokens and their time are excluded
 * together when timing an answer; delivery bursts are rejected rather than mistaken for decoding.
 * Only byte counts and millisecond marks are retained, never the streamed content.
 */
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { MAX_REALISTIC_TPS, MIN_GENERATION_DURATION_MS, type GenerationStats } from '../../shared/api'

type DeltaKind = 'text_delta' | 'thinking_delta' | 'toolcall_delta'
type Sample = Pick<GenerationStats, 'outputTokens' | 'durationMs'>
type FlowMark = { at: number; bytes: number }

const MAX_FLOW_MARKS = 65_536
const HELD_SHARE = 4
const THINK_PACE = 20

export class GenerationSampler {
  private firstOutputAt?: number
  private firstKind?: DeltaKind
  private firstTextAt?: number
  private firstThinkingAt?: number
  private lastThinkingAt?: number
  private thinkingAfterText = false
  private bodyBeforeText = false
  private textByteOffset = 0
  private bytes = 0
  private flow: FlowMark[] | undefined = []

  record(kind: DeltaKind, delta: string, at: number): void {
    if (!delta.length) return
    if (this.firstOutputAt === undefined) {
      this.firstOutputAt = at
      this.firstKind = kind
    }
    if (kind === 'thinking_delta') {
      this.thinkingAfterText ||= this.firstTextAt !== undefined
      this.firstThinkingAt ??= at
      this.lastThinkingAt = at
    } else if (kind === 'text_delta' && this.firstTextAt === undefined) {
      this.firstTextAt = at
      this.textByteOffset = this.bytes
    } else if (kind === 'toolcall_delta' && this.firstTextAt === undefined) {
      this.bodyBeforeText = true
    }
    if (!this.flow) return
    this.bytes += Buffer.byteLength(delta, 'utf8')
    const ms = Math.floor(at)
    const last = this.flow.at(-1)
    if (last?.at === ms) {
      last.bytes = this.bytes
    } else if (this.flow.length < MAX_FLOW_MARKS) {
      this.flow.push({ at: ms, bytes: this.bytes })
    } else {
      this.flow = undefined
    }
  }

  finish(message: AssistantMessage, endedAt: number | undefined): GenerationStats {
    const sample = this.sample(message, endedAt)
    return {
      outputTokens: sample?.outputTokens ?? 0,
      durationMs: sample?.durationMs ?? 0,
      measuredCalls: sample ? 1 : 0,
      totalCalls: 1,
      models: sample ? [`${message.provider}/${message.model}`] : []
    }
  }

  private sample(message: AssistantMessage, endedAt: number | undefined): Sample | undefined {
    if (
      this.firstOutputAt === undefined || endedAt === undefined || this.thinkingAfterText ||
      !['stop', 'length', 'toolUse'].includes(message.stopReason)
    ) return
    // Hidden reasoning may have no deltas; its final block still invalidates an answer-only window.
    let textSeen = false
    for (const block of message.content) {
      if (block.type === 'text' && block.text.length > 0) textSeen = true
      else if (block.type === 'thinking' && textSeen) return
    }
    let outputTokens = message.usage.output
    const reasoning = message.usage.reasoning ?? 0
    if (
      !Number.isFinite(outputTokens) || outputTokens <= 0 ||
      !Number.isFinite(reasoning) || reasoning < 0 || reasoning > outputTokens
    ) return

    let startedAt = this.firstOutputAt
    let byteOffset = 0
    const thinking = message.content.filter((block) => block.type === 'thinking')
    if (reasoning > 0 || this.firstThinkingAt !== undefined || thinking.length > 0) {
      if (this.firstTextAt !== undefined) {
        // A missing breakdown or arguments written before the text cannot be separated from it.
        if (reasoning <= 0 || this.bodyBeforeText) return
        outputTokens -= reasoning
        startedAt = this.firstTextAt
        byteOffset = this.textByteOffset
      } else {
        // Responses/Gemini thinking deltas may be summaries, not the reasoning that was billed.
        const visible = message.api === 'openai-completions' || message.api === 'anthropic-messages'
        if (
          !visible || thinking.some((block) => block.redacted) ||
          this.firstKind !== 'thinking_delta' || this.firstThinkingAt === undefined ||
          this.lastThinkingAt === undefined ||
          this.lastThinkingAt - this.firstThinkingAt < MIN_GENERATION_DURATION_MS ||
          message.content.some((block) => block.type === 'text' && block.text.length > 0)
        ) return
        startedAt = this.firstThinkingAt
      }
    }

    const durationMs = endedAt - startedAt
    const tps = outputTokens / (durationMs / 1_000)
    if (
      outputTokens <= 0 || durationMs < MIN_GENERATION_DURATION_MS ||
      !Number.isFinite(tps) || tps <= 0 || tps > MAX_REALISTIC_TPS
    ) return
    const flowMs = this.flowMs(byteOffset)
    if (flowMs === undefined || flowMs * HELD_SHARE < durationMs) return
    if (
      reasoning > 0 && this.firstTextAt !== undefined &&
      outputTokens * (this.firstTextAt - this.firstOutputAt) > THINK_PACE * reasoning * durationMs
    ) return
    return { outputTokens, durationMs }
  }

  /** Middle 80% of delta bytes, scaled to the whole; a sparse early word cannot mask a late burst. */
  private flowMs(byteOffset: number): number | undefined {
    if (!this.flow?.length) return
    const bytes = this.bytes - byteOffset
    const tenth = byteOffset + bytes * 0.1
    const nineTenths = byteOffset + bytes * 0.9
    let first: number | undefined
    for (const mark of this.flow) {
      if (first === undefined && mark.bytes >= tenth) first = mark.at
      if (mark.bytes >= nineTenths) return Math.max((mark.at - first!) / 0.8, 1)
    }
    return undefined
  }
}

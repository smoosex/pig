/**
 * Non-blocking Bot conversation dispatcher:
 * - Immediate bubble-landing on send (zero queued-message bar)
 * - Side-effect-free thinking preemption + context merge on rapid follow-ups
 * - Automatic `steer` injection once a side effect (send_message / delegation / write) has occurred
 * - Grok-Bot-style 3-layer send_message safeguard: unified per-request style reminder + tool rule,
 *   at most 1 reprompt on zero-message completion, and final system fallback card / delivery card without re-running tasks.
 */
import { randomUUID } from 'node:crypto'
import type { PromptStreamingBehavior } from '../../shared/api'
import type { BotImageAttachment, BotNotice, BotTextAttachment, BotTimelineItem } from '../../shared/bot'
import { BOT_REPROMPT_NO_MESSAGE, formatNoticesPrompt } from './prompt'

export interface BotPromptRequest {
  text: string
  images?: BotImageAttachment[]
  textAttachments?: BotTextAttachment[]
  streamingBehavior?: PromptStreamingBehavior
}

export interface BotDispatcherDeps {
  sendPrompt: (req: BotPromptRequest) => Promise<void>
  abortCurrent: () => Promise<void>
  appendTimeline: (item: BotTimelineItem) => Promise<void>
  onStreamingChanged: (streaming: boolean) => void
  onUserIdle: () => void
  onDeliveryState?: (taskId: string, runId: string, state: 'delivered' | 'fallback' | 'failed', noticeId?: string, error?: string) => Promise<void>
}

interface ActiveTurn {
  id: number
  kind: 'user' | 'notice'
  /** Original user texts in this merged burst so preemption can re-send them together cleanly. */
  userTexts: string[]
  images: BotImageAttachment[]
  textAttachments: BotTextAttachment[]
  notices: BotNotice[]
  hasSideEffect: boolean
  sentMessageCount: number
  repliedSinceLastInput: boolean
  preempted: boolean
}

const TERMINAL_NOTICE_KINDS = new Set<BotNotice['kind']>([
  'task_completed',
  'task_failed',
  'task_start_failed',
  'task_stopped',
  'task_stopped_by_user',
  'task_taken_over',
  'task_interrupted'
])

function formatUserInputText(
  text: string,
  projectMentions?: string[],
  issueMentions?: number[]
): string {
  const prefixes: string[] = []
  if (projectMentions?.length) {
    const uniqueProjects = [...new Set(projectMentions.filter(Boolean))]
    if (uniqueProjects.length > 0) {
      prefixes.push(`[Referenced projects: ${uniqueProjects.join(', ')}]`)
    }
  }
  if (issueMentions?.length) {
    const uniqueIssues = [...new Set(issueMentions.filter((n) => Number.isSafeInteger(n) && n >= 1))]
    if (uniqueIssues.length > 0) {
      prefixes.push(`[Referenced issues: ${uniqueIssues.map((n) => `@[issue:${n}]`).join(', ')}]`)
    }
  }
  if (prefixes.length === 0) return text
  const header = prefixes.join('\n')
  return text ? `${header}\n${text}` : header
}

export class BotDispatcher {
  private activeTurn: ActiveTurn | null = null
  private visibleStreaming = false
  private turnSeq = 0
  private pendingPreemptInputs: Array<{
    text: string
    images?: BotImageAttachment[]
    textAttachments?: BotTextAttachment[]
  }> = []
  private runPromise: Promise<void> | null = null
  private noticePromise: Promise<unknown> | null = null

  constructor(private readonly deps: BotDispatcherDeps) {}

  private setVisibleStreaming(next: boolean): void {
    if (this.visibleStreaming === next) return
    this.visibleStreaming = next
    this.deps.onStreamingChanged(next)
  }

  isUserBusy(): boolean {
    return (this.activeTurn !== null && this.activeTurn.kind === 'user') || this.pendingPreemptInputs.length > 0
  }

  isStreaming(): boolean {
    return this.visibleStreaming
  }

  /** Called by Bot tools whenever a visible message, delegation, or write tool executes. */
  markSideEffect(toolName: string): void {
    if (!this.activeTurn) return
    this.activeTurn.hasSideEffect = true
    if (toolName === 'send_message') {
      this.activeTurn.sentMessageCount++
      this.activeTurn.repliedSinceLastInput = true
      // Once the user-visible reply lands, hide the thinking indicator immediately so post-tool
      // end-of-turn wind-down never flashes a ghost "Thinking…" state below the reply.
      this.setVisibleStreaming(false)
    }
  }

  isTakeoverOnlyTurn(): boolean {
    return Boolean(
      this.activeTurn?.kind === 'notice' &&
      this.activeTurn.notices.length > 0 &&
      this.activeTurn.notices.every((n) => n.kind === 'task_taken_over')
    )
  }

  singleNoticeTaskId(): string | undefined {
    if (this.activeTurn?.kind !== 'notice') return undefined
    const ids = [...new Set(this.activeTurn.notices.map((n) => n.taskId))]
    return ids.length === 1 ? ids[0] : undefined
  }

  /**
   * Called when the Bot main session begins executing a tool. Re-shows the thinking indicator only
   * if the model genuinely starts substantive post-reply tool work (not send_message or fast-ack delegation).
   */
  markToolActivity(toolName: string): void {
    if (!this.activeTurn || this.activeTurn.preempted) return
    if (toolName === 'send_message' || toolName === 'bot_start_task' || toolName === 'bot_followup_task') return
    this.setVisibleStreaming(true)
  }

  /**
   * Handle a user message from the Bot page:
   * 1. Immediately lands as a formal user bubble in the timeline.
   * 2. If idle: starts a new turn.
   * 3. If thinking with NO side effects: preemptively aborts and merges the burst into a fresh turn.
   * 4. If a side effect already occurred: injects via `streamingBehavior: 'steer'` without restarting.
   */
  async handleUserMessage(input: {
    text: string
    images?: BotImageAttachment[]
    textAttachments?: BotTextAttachment[]
    projectMentions?: string[]
    issueMentions?: number[]
  }): Promise<BotTimelineItem> {
    const cleanText = input.text.trim()
    if (!cleanText && !input.images?.length && !input.textAttachments?.length && !input.issueMentions?.length) {
      throw new Error('Message cannot be empty')
    }

    const userItem: Extract<BotTimelineItem, { kind: 'user' }> = {
      id: randomUUID(),
      kind: 'user',
      text: cleanText,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.textAttachments?.length ? { textAttachments: input.textAttachments } : {}),
      ...(input.projectMentions?.length ? { projectMentions: input.projectMentions } : {}),
      ...(input.issueMentions?.length ? { issueMentions: input.issueMentions } : {}),
      createdAt: Date.now()
    }
    await this.deps.appendTimeline(userItem)
    const promptText = formatUserInputText(cleanText, input.projectMentions, input.issueMentions)

    if (this.activeTurn) {
      if (this.activeTurn.kind === 'user' && !this.activeTurn.hasSideEffect) {
        // Side-effect-free thinking preemption: abort silently and merge user burst into one clean run.
        this.activeTurn.preempted = true
        this.pendingPreemptInputs.push({
          text: promptText,
          images: input.images,
          textAttachments: input.textAttachments
        })
        void this.deps.abortCurrent().catch(() => {})
        return userItem
      }
      if (this.activeTurn.kind === 'user' && this.activeTurn.hasSideEffect) {
        // Side effect already landed: steer seamlessly without duplicating tool calls or bubbles.
        this.activeTurn.repliedSinceLastInput = false
        this.setVisibleStreaming(true)
        void this.deps.sendPrompt({
          text: promptText,
          images: input.images,
          textAttachments: input.textAttachments,
          streamingBehavior: 'steer'
        }).catch((error) => {
          console.error('Bot steer prompt failed; queueing follow-up burst:', error)
          const fallbackInput = {
            text: promptText,
            images: input.images,
            textAttachments: input.textAttachments
          }
          if (this.activeTurn) {
            this.pendingPreemptInputs.push(fallbackInput)
          } else {
            this.runPromise = this.runUserBurst(
              [fallbackInput.text],
              fallbackInput.images ? [...fallbackInput.images] : [],
              fallbackInput.textAttachments ? [...fallbackInput.textAttachments] : []
            )
          }
        })
        return userItem
      }
      // Active notice turn already wrote <host_notice> into session history: let its fast send_message finish
      // rather than aborting into a duplicate/half-baked context, then run the user burst immediately after.
      this.setVisibleStreaming(true)
      this.pendingPreemptInputs.push({
        text: promptText,
        images: input.images,
        textAttachments: input.textAttachments
      })
      return userItem
    }

    const work = this.runUserBurst(
      [promptText],
      input.images ? [...input.images] : [],
      input.textAttachments ? [...input.textAttachments] : []
    )
    this.runPromise = work
    return userItem
  }

  /** Wait until current active turn (and any merged preemption follow-up) finishes (useful in tests). */
  async waitForIdle(): Promise<void> {
    while (this.noticePromise || this.runPromise) {
      await (this.noticePromise ?? this.runPromise)
    }
  }

  async abortActiveTurn(): Promise<void> {
    if (!this.activeTurn) return
    this.activeTurn.preempted = true
    this.pendingPreemptInputs = []
    await this.deps.abortCurrent().catch(() => {})
  }

  private async runUserBurst(
    texts: string[],
    images: BotImageAttachment[],
    textAttachments: BotTextAttachment[]
  ): Promise<void> {
    let currentTexts = [...texts]
    let currentImages = [...images]
    let currentAttachments = [...textAttachments]

    this.setVisibleStreaming(true)
    try {
      while (true) {
        const turn: ActiveTurn = {
          id: ++this.turnSeq,
          kind: 'user',
          userTexts: currentTexts,
          images: currentImages,
          textAttachments: currentAttachments,
          notices: [],
          hasSideEffect: false,
          sentMessageCount: 0,
          repliedSinceLastInput: false,
          preempted: false
        }
        this.activeTurn = turn
        this.setVisibleStreaming(true)
        const mergedText = currentTexts.filter(Boolean).join('\n\n')

        let runError: string | null = null
        try {
          await this.deps.sendPrompt({
            text: mergedText,
            images: currentImages.length ? currentImages : undefined,
            textAttachments: currentAttachments.length ? currentAttachments : undefined
          })
        } catch (error) {
          if (!turn.preempted) {
            runError = error instanceof Error ? error.message : String(error)
          }
        }

        // If user sent follow-ups while thinking with zero side effects, merge and re-run cleanly.
        if (turn.preempted && this.pendingPreemptInputs.length > 0) {
          const drained = this.pendingPreemptInputs.splice(0)
          currentTexts = [...currentTexts, ...drained.map((d) => d.text)]
          for (const d of drained) {
            if (d.images?.length) currentImages.push(...d.images)
            if (d.textAttachments?.length) currentAttachments.push(...d.textAttachments)
          }
          continue
        }

        if (turn.preempted) break

        // Layer 2 safeguard: at most 1 internal reprompt if model finished without sending a visible reply.
        if (!runError && !turn.repliedSinceLastInput) {
          this.setVisibleStreaming(true)
          try {
            await this.deps.sendPrompt({ text: BOT_REPROMPT_NO_MESSAGE })
          } catch (error) {
            runError = error instanceof Error ? error.message : String(error)
          }
        }

        // Check if another user input arrived during reprompt with no side effects.
        if (turn.preempted && this.pendingPreemptInputs.length > 0) {
          const drained = this.pendingPreemptInputs.splice(0)
          for (const input of drained) {
            currentTexts.push(input.text)
            currentImages.push(...(input.images ?? []))
            currentAttachments.push(...(input.textAttachments ?? []))
          }
          continue
        }

        // Layer 3 safeguard: explicit system fallback card — never leak raw internal reasoning.
        if (!turn.preempted && !turn.repliedSinceLastInput) {
          const fallback: Extract<BotTimelineItem, { kind: 'system_fallback' }> = {
            id: randomUUID(),
            kind: 'system_fallback',
            reason: runError ? 'error' : 'no_message',
            text: runError
              ? `Model request failed: ${runError}`
              : 'Bot completed this turn without sending a visible reply.',
            retryable: true,
            createdAt: Date.now()
          }
          await this.deps.appendTimeline(fallback)
        }

        // Drain any follow-up user messages queued after a side-effected turn.
        if (this.pendingPreemptInputs.length > 0) {
          const drained = this.pendingPreemptInputs.splice(0)
          currentTexts = drained.map((d) => d.text)
          currentImages = drained.flatMap((d) => d.images ?? [])
          currentAttachments = drained.flatMap((d) => d.textAttachments ?? [])
          continue
        }
        break
      }
    } finally {
      this.activeTurn = null
      this.runPromise = null
      this.setVisibleStreaming(false)
      this.deps.onUserIdle()
    }
  }

  /**
   * Deliver a batch of background task notices to the Bot session.
   * Applies the same 3-layer send_message safeguard and emits a lightweight system delivery card
   * (delivery.state = 'fallback') for terminal notices if the model fails or stays silent — never re-running tasks.
   */
  async deliverNotices(notices: BotNotice[]): Promise<{ state: 'delivered' | 'fallback' | 'failed' | 'deferred'; error?: string }> {
    if (notices.length === 0) return { state: 'delivered' }
    if (this.activeTurn) {
      return { state: 'deferred' }
    }

    const turn: ActiveTurn = {
      id: ++this.turnSeq,
      kind: 'notice',
      userTexts: [],
      images: [],
      textAttachments: [],
      notices,
      hasSideEffect: false,
      sentMessageCount: 0,
      repliedSinceLastInput: false,
      preempted: false
    }
    this.activeTurn = turn
    this.setVisibleStreaming(true)

    let runError: string | null = null
    const work = (async (): Promise<{ state: 'delivered' | 'fallback' | 'failed' | 'deferred'; error?: string }> => {
      try {
        await this.deps.sendPrompt({ text: formatNoticesPrompt(notices) })

        if (!turn.preempted && turn.sentMessageCount === 0) {
          this.setVisibleStreaming(true)
          try {
            await this.deps.sendPrompt({ text: BOT_REPROMPT_NO_MESSAGE })
          } catch (error) {
            if (!turn.preempted) {
              runError = error instanceof Error ? error.message : String(error)
            }
          }
        }
      } catch (error) {
        if (!turn.preempted) {
          runError = error instanceof Error ? error.message : String(error)
        }
      } finally {
        this.activeTurn = null
        if (this.pendingPreemptInputs.length === 0) {
          this.setVisibleStreaming(false)
        }
      }

      // If user sent messages during notice handling, kick off the queued user burst immediately.
      if (this.pendingPreemptInputs.length > 0) {
        const drained = this.pendingPreemptInputs.splice(0)
        this.runPromise = this.runUserBurst(
          drained.map((d) => d.text),
          drained.flatMap((d) => d.images ?? []),
          drained.flatMap((d) => d.textAttachments ?? [])
        )
      }

      if (turn.sentMessageCount > 0) {
        for (const notice of notices) {
          await this.deps.onDeliveryState?.(notice.taskId, notice.runId, 'delivered', notice.noticeId)
        }
        return { state: 'delivered' }
      }

      // Never mistake an explicit stop/reset abort (`turn.preempted`) for model silence — defer back to queue.
      if (turn.preempted) {
        return { state: 'deferred' }
      }

      // Layer 3 final fallback for terminal notices: emit lightweight system delivery card without retrying background task.
      const terminal = notices.filter((n) => TERMINAL_NOTICE_KINDS.has(n.kind))
      if (terminal.length > 0) {
        const summaryLines = terminal.map((n) => {
          const label =
            n.kind === 'task_completed' ? 'Completed'
              : n.kind === 'task_stopped_by_user' ? 'Stopped by user'
                : n.kind === 'task_stopped' ? 'Stopped'
                  : n.kind === 'task_taken_over' ? 'Taken over'
                    : n.kind === 'task_interrupted' ? 'Interrupted'
                      : 'Failed'
          return `[${label}] ${n.summary || n.taskId}`
        })
        const joinedSummary = summaryLines.join('\n\n')
        const fallbackCard: Extract<BotTimelineItem, { kind: 'system_fallback' }> = {
          id: randomUUID(),
          kind: 'system_fallback',
          reason: 'delivery_fallback',
          text: runError
            ? `${joinedSummary}\n\n(Bot reply error: ${runError})`
            : joinedSummary,
          taskIds: [...new Set(terminal.map((n) => n.taskId))],
          createdAt: Date.now()
        }
        await this.deps.appendTimeline(fallbackCard)
        for (const notice of notices) {
          await this.deps.onDeliveryState?.(notice.taskId, notice.runId, 'fallback', notice.noticeId, runError ?? undefined)
        }
        return { state: 'fallback', error: runError ?? undefined }
      }

      for (const notice of notices) {
        await this.deps.onDeliveryState?.(notice.taskId, notice.runId, runError ? 'failed' : 'delivered', notice.noticeId, runError ?? undefined)
      }
      return runError ? { state: 'failed', error: runError } : { state: 'delivered' }
    })()

    const tracked = work.finally(() => {
      if (this.noticePromise === tracked) this.noticePromise = null
    })
    this.noticePromise = tracked
    return work
  }
}

import { describe, expect, test } from 'bun:test'
import { BotDispatcher, type BotPromptRequest } from '../src/main/bot/dispatcher'
import { stripHiddenBotTags, projectTimelineItemToPeek } from '../src/main/bot/projection'
import type { BotNotice, BotTimelineItem } from '../src/shared/bot'

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('BotDispatcher', () => {
  test('lands user bubble immediately with clean prompt text and skips reprompt when send_message is called', async () => {
    const timeline: BotTimelineItem[] = []
    const prompts: BotPromptRequest[] = []
    let streamingEvents: boolean[] = []
    let idleCount = 0

    let dispatcher!: BotDispatcher
    dispatcher = new BotDispatcher({
      sendPrompt: async (req) => {
        prompts.push(req)
        dispatcher.markSideEffect('send_message')
      },
      abortCurrent: async () => {},
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: (s) => { streamingEvents.push(s) },
      onUserIdle: () => { idleCount++ }
    })

    const landed = await dispatcher.handleUserMessage({ text: '帮我看看测试' })
    expect(landed.kind).toBe('user')
    expect(timeline).toHaveLength(1)
    await dispatcher.waitForIdle()

    expect(prompts).toHaveLength(1)
    expect(prompts[0].text).toBe('帮我看看测试')
    expect(streamingEvents).toEqual([true, false])
    expect(idleCount).toBe(1)
    // No fallback card created
    expect(timeline.filter((i) => i.kind === 'system_fallback')).toHaveLength(0)
  })

  test('preempts side-effect-free thinking and merges burst user inputs cleanly', async () => {
    const timeline: BotTimelineItem[] = []
    const prompts: BotPromptRequest[] = []
    let abortCount = 0
    const firstTurn = deferred()
    let callIdx = 0

    let dispatcher!: BotDispatcher
    dispatcher = new BotDispatcher({
      sendPrompt: async (req) => {
        prompts.push(req)
        callIdx++
        if (callIdx === 1) {
          await firstTurn.promise
          return
        }
        dispatcher.markSideEffect('send_message')
      },
      abortCurrent: async () => {
        abortCount++
        firstTurn.resolve()
      },
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })

    await dispatcher.handleUserMessage({ text: '第一句' })
    // Rapid follow-up while Bot is still thinking with NO side effects
    await dispatcher.handleUserMessage({ text: '对了再加个条件' })
    await dispatcher.waitForIdle()

    expect(abortCount).toBe(1)
    expect(timeline.filter((i) => i.kind === 'user')).toHaveLength(2)
    expect(prompts).toHaveLength(2)
    expect(prompts[1].text).toContain('第一句')
    expect(prompts[1].text).toContain('对了再加个条件')
  })

  test('uses steer injection instead of preempting once a side effect has occurred', async () => {
    const prompts: BotPromptRequest[] = []
    let abortCount = 0
    const turn = deferred()

    let dispatcher!: BotDispatcher
    dispatcher = new BotDispatcher({
      sendPrompt: async (req) => {
        prompts.push(req)
        if (!req.streamingBehavior) {
          dispatcher.markSideEffect('bot_start_task')
          dispatcher.markSideEffect('send_message')
          await turn.promise
        }
      },
      abortCurrent: async () => { abortCount++ },
      appendTimeline: async () => {},
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })

    await dispatcher.handleUserMessage({ text: '修一下导出' })
    await dispatcher.handleUserMessage({ text: '顺便看下日志' })
    turn.resolve()
    await dispatcher.waitForIdle()

    expect(abortCount).toBe(0)
    expect(prompts.some((p) => p.streamingBehavior === 'steer' && p.text.includes('顺便看下日志'))).toBe(true)
  })

  test('runs at most 1 reprompt on zero-message turn and falls back to system card if still silent', async () => {
    const timeline: BotTimelineItem[] = []
    const prompts: BotPromptRequest[] = []

    const dispatcher = new BotDispatcher({
      sendPrompt: async (req) => {
        prompts.push(req)
        // Deliberately never calls markSideEffect('send_message')
      },
      abortCurrent: async () => {},
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })

    await dispatcher.handleUserMessage({ text: '在吗' })
    await dispatcher.waitForIdle()

    expect(prompts).toHaveLength(2) // initial + 1 reprompt
    const fallback = timeline.find((i) => i.kind === 'system_fallback')
    expect(fallback).toBeDefined()
    expect(fallback?.kind === 'system_fallback' && fallback.reason).toBe('no_message')
  })

  test('a user message during correction keeps both kinds of attachments in the merged prompt', async () => {
    const correcting = deferred()
    const resume = deferred()
    const prompts: BotPromptRequest[] = []
    const dispatcher = new BotDispatcher({
      sendPrompt: async (prompt) => {
        prompts.push(prompt)
        if (prompts.length === 2) {
          correcting.resolve()
          await resume.promise
        }
        if (prompts.length === 3) dispatcher.markSideEffect('send_message')
      },
      abortCurrent: async () => { resume.resolve() },
      appendTimeline: async () => {},
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })
    await dispatcher.handleUserMessage({ text: 'first' })
    await correcting.promise
    const images = [{ type: 'image' as const, data: 'YQ==', mimeType: 'image/png' }]
    const textAttachments = [{ id: 'a', text: 'attachment' }] as NonNullable<BotPromptRequest['textAttachments']>
    await dispatcher.handleUserMessage({ text: 'second', images, textAttachments })
    await dispatcher.waitForIdle()
    expect(prompts[2].images).toEqual(images)
    expect(prompts[2].textAttachments).toEqual(textAttachments)
    expect(prompts[2].text).toContain('first\n\nsecond')
  })

  test('emits delivery fallback card for terminal notices without re-running tasks when Bot errors or stays silent', async () => {
    const timeline: BotTimelineItem[] = []
    const states: Array<{ taskId: string; runId: string; state: string }> = []

    const dispatcher = new BotDispatcher({
      sendPrompt: async () => { throw new Error('model offline') },
      abortCurrent: async () => {},
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: () => {},
      onUserIdle: () => {},
      onDeliveryState: async (taskId, runId, state) => { states.push({ taskId, runId, state }) }
    })

    const notice: BotNotice = {
      noticeId: 'n-1',
      kind: 'task_stopped_by_user',
      taskId: 'task-1',
      runId: 'run-1',
      projectCwd: '/repo/pig',
      stopOrigin: 'user',
      summary: 'Stopped midway after editing 2 files',
      createdAt: Date.now(),
      state: 'pending'
    }

    const res = await dispatcher.deliverNotices([notice])
    expect(res.state).toBe('fallback')
    expect(states).toEqual([{ taskId: 'task-1', runId: 'run-1', state: 'fallback' }])
    const fallback = timeline.find((i) => i.kind === 'system_fallback')
    expect(fallback?.kind === 'system_fallback' && fallback.reason).toBe('delivery_fallback')
    expect(fallback?.kind === 'system_fallback' && fallback.text).toContain('Stopped by user')
  })

  test('stripHiddenBotTags removes hidden reminder/notice blocks and peek projects clean text', () => {
    const raw = '搞定啦！\n<system_reminder>secret prompt</system_reminder>\n<host_notice>internal</host_notice>'
    expect(stripHiddenBotTags(raw)).toBe('搞定啦！')

    const peek = projectTimelineItemToPeek({
      id: 'm1',
      kind: 'assistant',
      messageType: 'delivery',
      content: raw,
      createdAt: 123
    }, { statusBadge: 'completed', projectName: 'pig', taskId: 't1' })
    expect(peek.text).toBe('搞定啦！')
    expect(peek.kind).toBe('delivery')
    expect(peek.projectName).toBe('pig')
  })

  test('hides thinking indicator immediately after send_message lands and stays quiet during post-reply wind-down', async () => {
    const streamingEvents: boolean[] = []
    const windDown = deferred()

    let dispatcher!: BotDispatcher
    dispatcher = new BotDispatcher({
      sendPrompt: async () => {
        dispatcher.markSideEffect('bot_start_task')
        dispatcher.markSideEffect('send_message')
        // Simulate LLM taking extra time to emit its empty end-of-turn completion after send_message
        expect(dispatcher.isStreaming()).toBe(false)
        await windDown.promise
      },
      abortCurrent: async () => {},
      appendTimeline: async () => {},
      onStreamingChanged: (s) => { streamingEvents.push(s) },
      onUserIdle: () => {}
    })

    await dispatcher.handleUserMessage({ text: '派一个只读任务' })
    expect(streamingEvents).toEqual([true, false])
    expect(dispatcher.isStreaming()).toBe(false)
    // Fast-ack delegation does not flicker thinking back on; substantive tool activity does.
    dispatcher.markToolActivity('bot_start_task')
    expect(dispatcher.isStreaming()).toBe(false)
    dispatcher.markToolActivity('read')
    expect(dispatcher.isStreaming()).toBe(true)
    windDown.resolve()
    await dispatcher.waitForIdle()
    expect(streamingEvents).toEqual([true, false, true, false])
  })

  test('includes @project mentions in prompts sent to the Bot model and distinguishes bot-stopped fallback cards', async () => {
    const prompts: BotPromptRequest[] = []
    const timeline: BotTimelineItem[] = []
    let dispatcher!: BotDispatcher
    dispatcher = new BotDispatcher({
      sendPrompt: async (req) => {
        prompts.push(req)
        if (req.text.includes('看看状态')) dispatcher.markSideEffect('send_message')
      },
      abortCurrent: async () => {},
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })

    await dispatcher.handleUserMessage({
      text: '看看状态',
      projectMentions: ['/repo/lumina']
    })
    await dispatcher.waitForIdle()
    expect(prompts[0].text).toContain('[Referenced projects: /repo/lumina]')

    const botStoppedNotice: BotNotice = {
      noticeId: 'n-bot-stop',
      kind: 'task_stopped',
      taskId: 't-bot',
      runId: 'r-bot',
      projectCwd: '/repo/lumina',
      stopOrigin: 'bot',
      summary: 'Stopped by bot',
      createdAt: Date.now(),
      state: 'pending'
    }
    const res = await dispatcher.deliverNotices([botStoppedNotice])
    expect(res.state).toBe('fallback')
    const card = timeline.find((i) => i.kind === 'system_fallback')
    expect(card?.kind === 'system_fallback' && card.text).toContain('[Stopped] Stopped by bot')
    expect(card?.kind === 'system_fallback' && card.text).not.toContain('Stopped by user')

    const takeover = await dispatcher.deliverNotices([{
      ...botStoppedNotice, noticeId: 'n-takeover', kind: 'task_taken_over', stopOrigin: 'takeover', summary: 'Partial work'
    }])
    expect(takeover.state).toBe('fallback')
    const takeoverCard = timeline.at(-1)
    expect(takeoverCard?.kind === 'system_fallback' && takeoverCard.text).toContain('[Taken over] Partial work')
  })

  test('sending a user message during an in-flight notice turn lets the notice reply finish without triggering delivery_fallback, then runs the user turn', async () => {
    const timeline: BotTimelineItem[] = []
    const prompts: BotPromptRequest[] = []
    let abortCount = 0
    const noticeStarted = deferred()
    const releaseNotice = deferred()

    let dispatcher!: BotDispatcher
    dispatcher = new BotDispatcher({
      sendPrompt: async (req) => {
        prompts.push(req)
        if (req.text.includes('<host_notice>')) {
          noticeStarted.resolve()
          await releaseNotice.promise
          dispatcher.markSideEffect('send_message')
          await timeline.push({
            id: 'bot-lumina-reply',
            kind: 'assistant',
            messageType: 'delivery',
            content: 'lumina 梳理完啦！',
            taskIds: ['task-lumina'],
            createdAt: Date.now()
          })
          return
        }
        if (req.text.includes('matheme')) {
          dispatcher.markSideEffect('bot_start_task')
          dispatcher.markSideEffect('send_message')
          timeline.push({
            id: 'bot-matheme-reply',
            kind: 'assistant',
            messageType: 'text',
            content: '我去翻一下 matheme！',
            createdAt: Date.now()
          })
        }
      },
      abortCurrent: async () => { abortCount++ },
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })

    const notice: BotNotice = {
      noticeId: 'n-lumina',
      kind: 'task_completed',
      taskId: 'task-lumina',
      runId: 'run-lumina',
      projectCwd: '/repo/lumina',
      summary: '## 1. 一句话定位 **Lumina 是一个个人数字花园**',
      createdAt: Date.now(),
      state: 'pending'
    }

    const deliveryPromise = dispatcher.deliverNotices([notice])
    await noticeStarted.promise

    // User sends a new message right while Bot is digesting lumina's completion notice before send_message!
    const userItem = await dispatcher.handleUserMessage({
      text: '这个项目做了什么工作',
      projectMentions: ['/repo/matheme']
    })
    expect(userItem.kind).toBe('user')
    // User bubble lands immediately without aborting the notice turn
    expect(abortCount).toBe(0)
    expect(timeline.some((i) => i.kind === 'user')).toBe(true)

    releaseNotice.resolve()
    const noticeResult = await deliveryPromise
    await dispatcher.waitForIdle()

    expect(noticeResult.state).toBe('delivered')
    expect(timeline.filter((i) => i.kind === 'system_fallback')).toHaveLength(0)
    expect(prompts).toHaveLength(2)
    expect(prompts[0].text).toContain('<host_notice>')
    expect(prompts[1].text).toContain('/repo/matheme')
    expect(timeline.map((i) => i.id)).toContain('bot-lumina-reply')
    expect(timeline.map((i) => i.id)).toContain('bot-matheme-reply')
  })

  test('explicitly aborting an in-flight notice turn defers the notice instead of emitting a false delivery_fallback card', async () => {
    const timeline: BotTimelineItem[] = []
    const noticeStarted = deferred()
    const releaseAbortedPrompt = deferred()

    const dispatcher = new BotDispatcher({
      sendPrompt: async () => {
        noticeStarted.resolve()
        await releaseAbortedPrompt.promise
      },
      abortCurrent: async () => {
        releaseAbortedPrompt.resolve()
      },
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })

    const deliveryPromise = dispatcher.deliverNotices([{
      noticeId: 'n-abort',
      kind: 'task_completed',
      taskId: 'task-1',
      runId: 'run-1',
      projectCwd: '/repo/lumina',
      summary: 'Completed work',
      createdAt: Date.now(),
      state: 'pending'
    }])
    await noticeStarted.promise
    await dispatcher.abortActiveTurn()
    const res = await deliveryPromise

    expect(res.state).toBe('deferred')
    expect(timeline.filter((i) => i.kind === 'system_fallback')).toHaveLength(0)
  })

  test('preserves inline pasted-text and file-mention ranges on user timeline item without duplicating inline text in prompt', async () => {
    const timeline: BotTimelineItem[] = []
    const prompts: BotPromptRequest[] = []

    let dispatcher!: BotDispatcher
    dispatcher = new BotDispatcher({
      sendPrompt: async (req) => {
        prompts.push(req)
        dispatcher.markSideEffect('send_message')
      },
      abortCurrent: async () => {},
      appendTimeline: async (item) => { timeline.push(item) },
      onStreamingChanged: () => {},
      onUserIdle: () => {}
    })

    const longBlock = Array.from({ length: 22 }, (_, i) => `line ${i + 1}`).join('\n')
    const text = `看下 @/outside/spec.md 和日志 ${longBlock}`
    const fileStart = text.indexOf('@/outside/spec.md')
    const pasteStart = text.indexOf(longBlock)
    const landed = await dispatcher.handleUserMessage({
      text,
      textAttachments: [{ id: 'paste-1', text: longBlock, byteSize: longBlock.length, start: pasteStart, end: pasteStart + longBlock.length }],
      fileMentions: [{ path: '/outside/spec.md', start: fileStart, end: fileStart + '@/outside/spec.md'.length }],
      projectMentions: ['/repo/pig']
    })
    await dispatcher.waitForIdle()

    expect(landed.kind).toBe('user')
    if (landed.kind === 'user') {
      expect(landed.text).toBe(text)
      expect(landed.textAttachments).toHaveLength(1)
      expect(landed.fileMentions).toEqual([{ path: '/outside/spec.md', start: fileStart, end: fileStart + '@/outside/spec.md'.length }])
    }
    expect(prompts).toHaveLength(1)
    expect(prompts[0].text).toBe(`[Referenced projects: /repo/pig]\n${text}`)
    expect(prompts[0].textAttachments).toBeUndefined()
  })
})

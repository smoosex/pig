/**
 * Owns every subagent of every parent session: queueing, limits, lifecycle, delivery and persistence.
 *
 * Lifecycle: a child is `queued` until a slot frees (background only; foreground starts at once and
 * does not count against the limit), `running` while its runner works, then one terminal status.
 * Aborts record their reason first and let the runner settle, so the partial report survives.
 *
 * Delivery: finished background children are batched for `coalesceMs` and handed to the deliverer
 * the parent's extension attached. Without one (a resource reload is in progress) the batch waits
 * for the next attach. Closing the parent interrupts its children and drops undelivered results.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { SubagentInfo, SubagentSettings, SubagentStatus, SubagentTurn, ThinkingLevel, TurnUsage } from '../../shared/api'
import { addUsage, type UsageCounts } from '../../shared/turn-usage'
import type { SpawnOutcome, SpawnRequest, SubagentDelivery, SubagentHost } from '../plugins/pig-subagent-host'
import { backgroundAck, combineReports, formatReport } from './result'
import { chooseSubagentAppearance } from './appearance'
import type { ModelChoice, RunEvent, RunSpec, SubagentRun, SubagentRunner } from './runner'
import type { SubagentStore } from './store'

interface Entry {
  info: SubagentInfo
  spec: RunSpec
  timeoutMinutes: number
  lifetime: AbortController
  run?: SubagentRun
  /** Kept after the run is disposed, until the transcript file can take over. */
  messages?: unknown[]
  abortReason?: SubagentStatus
  timer?: ReturnType<typeof setTimeout>
  onProgress?: (activity: string) => void
  finished: Promise<void>
  resolve: () => void
}

interface Parent {
  entries: Map<string, Entry>
  deliver?: (delivery: SubagentDelivery) => void
  pending: SubagentInfo[]
  flushTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

export interface ManagerDeps {
  runner: SubagentRunner
  store: SubagentStore
  settings: () => Promise<SubagentSettings>
  chooseModel: (
    settings: SubagentSettings,
    parent: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }
  ) => Promise<ModelChoice>
  onChange: (parentSessionId: string) => void
  /** UI error boundary for asynchronous jobs (tool callers receive failures in their report too). */
  onError: (parentSessionId: string, error: unknown) => void
  coalesceMs?: number
  now?: () => number
}

/** One turn per assistant message, as the live events count them. */
export function timelineFromMessages(messages: readonly unknown[]): SubagentTurn[] {
  const turns: SubagentTurn[] = []
  for (const message of messages) {
    const { role, content } = message as { role?: unknown; content?: unknown }
    if (role !== 'assistant' || !Array.isArray(content)) continue
    const blocks = content as { type?: unknown; name?: unknown }[]
    turns.push({
      tools: blocks.filter((block) => block.type === 'toolCall' && typeof block.name === 'string').map((block) => block.name as string),
      thinking: blocks.some((block) => block.type === 'thinking')
    })
  }
  return turns
}

/** Usage and cost over the transcript's assistant messages, summed as the live events add them. */
export function usageFromMessages(messages: readonly unknown[]): { usage?: TurnUsage; cost: number } {
  let usage: TurnUsage | undefined
  let cost = 0
  for (const message of messages) {
    const value = message as { role?: unknown; usage?: UsageCounts & { cost?: { total?: number } } }
    if (value.role !== 'assistant') continue
    usage = addUsage(usage, value.usage)
    cost += value.usage?.cost?.total ?? 0
  }
  return { usage, cost }
}

/**
 * The index is written only on status changes, so a crash leaves an interrupted child without its
 * progress, and earlier builds stored the timeline in other shapes. Either way the transcript has it.
 */
function needsTimeline(info: SubagentInfo): boolean {
  if (!info.sessionFile) return false
  if (info.status === 'interrupted' && info.turns === 0) return true
  const recorded = info.turnTools.reduce((sum, turn) => sum + turn.tools.length, 0)
  const counted = Object.values(info.toolCounts).reduce((sum, n) => sum + n, 0)
  return info.turnTools.length !== info.turns || recorded !== counted
}

/** Applies `change` to the turn in progress; events before the first turn_start open one. */
function withCurrentTurn(turns: SubagentTurn[], change: (turn: SubagentTurn) => SubagentTurn): SubagentTurn[] {
  const next = turns.length ? [...turns] : [{ tools: [], thinking: false }]
  next[next.length - 1] = change(next[next.length - 1])
  return next
}

const TERMINAL = new Set<SubagentStatus>(['completed', 'failed', 'timeout', 'turn_limit', 'aborted', 'interrupted'])

export function isFinished(status: SubagentStatus): boolean {
  return TERMINAL.has(status)
}

function oneLine(value: unknown, max = 80): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value ?? '')).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function describeTool(name: string, args: Record<string, unknown>): string {
  const subject = args.path ?? args.command ?? args.pattern ?? args.query ?? args.url
  return subject === undefined ? name : `${name} ${oneLine(subject)}`
}

export class SubagentManager implements SubagentHost {
  private readonly parents = new Map<string, Parent>()
  private readonly loading = new Map<string, Promise<Parent>>()
  private maxConcurrent = 4
  private readonly coalesceMs: number
  private readonly now: () => number

  constructor(private readonly deps: ManagerDeps) {
    this.coalesceMs = deps.coalesceMs ?? 2000
    this.now = deps.now ?? Date.now
  }

  async spawn(request: SpawnRequest): Promise<SpawnOutcome> {
    const title = request.title.trim() || 'Subagent'
    const prompt = request.prompt.trim()
    if (!prompt) throw new Error('spawn requires a non-empty prompt')
    const parent = await this.parent(request.parentSessionId)
    if (parent.closed) throw new Error('The parent session is closing')
    const settings = await this.deps.settings()
    this.maxConcurrent = settings.maxConcurrent
    const choice = await this.deps.chooseModel(settings, { model: request.parentModel, thinkingLevel: request.parentThinkingLevel })

    if (parent.closed) throw new Error('The parent session is closing')
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    let resolve!: () => void
    const finished = new Promise<void>((done) => { resolve = done })
    const used = [...parent.entries.values()].flatMap(({ info }) =>
      info.parentTurnId === request.parentTurnId && info.appearance ? [info.appearance] : [])
    const lifetime = new AbortController()
    const entry: Entry = {
      info: {
        id,
        parentTurnId: request.parentTurnId,
        appearance: chooseSubagentAppearance(used),
        parentSessionId: request.parentSessionId,
        parentSessionFile: request.parentSessionFile,
        toolCallId: request.toolCallId,
        title,
        prompt,
        background: request.background,
        status: 'queued',
        ...(choice.model ? { model: { ...choice.model, ...(choice.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {}) } } : {}),
        ...(choice.fallbackReason ? { fallbackReason: choice.fallbackReason } : {}),
        createdAt: this.now(),
        turns: 0,
        maxTurns: settings.maxTurns,
        turnTools: [],
        toolCounts: {},
        editedFiles: [],
        cost: 0
      },
      spec: {
        id,
        parentSessionId: request.parentSessionId,
        title,
        signal: lifetime.signal,
        cwd: request.cwd,
        prompt,
        model: choice.model,
        thinkingLevel: choice.thinkingLevel,
        sessionDir: this.deps.store.dir(request.parentSessionId)
      },
      timeoutMinutes: settings.timeoutMinutes,
      lifetime,
      onProgress: request.onProgress,
      finished,
      resolve
    }
    parent.entries.set(id, entry)
    try {
      await this.persist(request.parentSessionId)
    } catch (error) {
      // No child has started: reject the tool call rather than acknowledge an unsaved task.
      parent.entries.delete(id)
      entry.resolve()
      throw error
    }
    if (parent.closed || isFinished(entry.info.status)) throw new Error('The parent session is closing')

    if (!request.background) {
      const signal = request.signal
      const onAbort = () => this.abortEntry(request.parentSessionId, entry, 'aborted')
      if (signal?.aborted) onAbort()
      else {
        signal?.addEventListener('abort', onAbort, { once: true })
        this.launch(request.parentSessionId, entry)
      }
      await finished
      signal?.removeEventListener('abort', onAbort)
      return { id, text: formatReport(entry.info), isError: entry.info.status !== 'completed' }
    }

    this.pump(request.parentSessionId)
    const position = this.queuedBackground(parent).indexOf(entry) + 1
    return { id, text: backgroundAck(entry.info, position), isError: false }
  }

  attach(parentSessionId: string, deliver: (delivery: SubagentDelivery) => void): void {
    void this.parent(parentSessionId).then((parent) => {
      if (parent.closed) return
      parent.deliver = deliver
      if (parent.pending.length && !parent.flushTimer) this.flush(parentSessionId)
    }).catch((error) => this.deps.onError(parentSessionId, error))
  }

  detach(parentSessionId: string, deliver: (delivery: SubagentDelivery) => void): void {
    const parent = this.parents.get(parentSessionId)
    if (parent?.deliver === deliver) parent.deliver = undefined
  }

  async list(parentSessionId: string): Promise<SubagentInfo[]> {
    const parent = await this.parent(parentSessionId)
    return [...parent.entries.values()].map((entry) => entry.info)
  }

  /** Foreground children are part of their parent's running turn, so only background ones count. */
  runningBackgroundCount(): number {
    let count = 0
    for (const parent of this.parents.values()) {
      for (const { info } of parent.entries.values()) if (info.background && !isFinished(info.status)) count++
    }
    return count
  }

  snapshot(parentSessionId: string): SubagentInfo[] {
    return [...(this.parents.get(parentSessionId)?.entries.values() ?? [])].map((entry) => entry.info)
  }

  abort(parentSessionId: string, id: string): void {
    const entry = this.parents.get(parentSessionId)?.entries.get(id)
    if (entry) this.abortEntry(parentSessionId, entry, 'aborted')
  }

  abortAll(parentSessionId: string): void {
    for (const entry of this.parents.get(parentSessionId)?.entries.values() ?? []) {
      this.abortEntry(parentSessionId, entry, 'aborted')
    }
  }

  async clearFinished(parentSessionId: string): Promise<void> {
    const parent = this.parents.get(parentSessionId)
    if (!parent) return
    for (const entry of parent.entries.values()) {
      if (isFinished(entry.info.status)) entry.info = { ...entry.info, cleared: true }
    }
    await this.persist(parentSessionId)
  }

  async transcript(parentSessionId: string, id: string): Promise<unknown[]> {
    const entry = (await this.parent(parentSessionId)).entries.get(id)
    if (!entry) throw new Error(`Subagent not found: ${id}`)
    if (entry.run) return entry.run.messages()
    if (entry.messages) return entry.messages
    return entry.info.sessionFile ? this.deps.runner.readTranscript(entry.info.sessionFile) : []
  }

  /** The parent session is going away: interrupt every child and wait for them to settle. */
  async closeParent(parentSessionId: string): Promise<void> {
    const parent = this.parents.get(parentSessionId) ?? await this.loading.get(parentSessionId)
    if (!parent) return
    parent.closed = true
    parent.deliver = undefined
    parent.pending = []
    if (parent.flushTimer) clearTimeout(parent.flushTimer)
    parent.flushTimer = undefined
    const unfinished = [...parent.entries.values()].filter((entry) => !isFinished(entry.info.status))
    for (const entry of unfinished) this.abortEntry(parentSessionId, entry, 'interrupted')
    // Terminal status can be visible while its final write is still in flight.
    await Promise.all([...parent.entries.values()].map((entry) => entry.finished))
    // Serialized behind every earlier save: teardown must not finish while a write can recreate files.
    try {
      await this.deps.store.save(parentSessionId, this.snapshot(parentSessionId))
    } finally {
      this.parents.delete(parentSessionId)
    }
  }

  async removeParent(parentSessionId: string): Promise<void> {
    await this.closeParent(parentSessionId)
    await this.deps.store.remove(parentSessionId)
  }

  private async parent(parentSessionId: string): Promise<Parent> {
    const existing = this.parents.get(parentSessionId)
    if (existing) return existing
    let loading = this.loading.get(parentSessionId)
    if (!loading) {
      loading = (async () => {
        const items = await this.deps.store.load(parentSessionId)
        let repaired = false
        for (const [index, stored] of items.entries()) {
          // Earlier builds kept `tokens` with cache traffic folded into input, which cannot be split again.
          const { tokens, ...info } = stored as SubagentInfo & { tokens?: unknown }
          const stale = needsTimeline(info)
          if (!stale && tokens === undefined) continue
          let next: SubagentInfo = info
          // Stale timelines mean the index missed live progress, usage included.
          const messages = info.sessionFile ? await this.deps.runner.readTranscript(info.sessionFile) : []
          const { usage, cost } = usageFromMessages(messages)
          if (usage) next = { ...next, usage, cost }
          const turnTools = stale ? timelineFromMessages(messages) : []
          if (turnTools.length) {
            const toolCounts: Record<string, number> = {}
            for (const name of turnTools.flatMap((turn) => turn.tools)) toolCounts[name] = (toolCounts[name] ?? 0) + 1
            next = { ...next, turns: turnTools.length, turnTools, toolCounts }
          }
          if (next === info && tokens === undefined) continue
          items[index] = next
          repaired = true
        }
        if (repaired) await this.deps.store.save(parentSessionId, items)
        const parent: Parent = { entries: new Map(), pending: [], closed: false }
        for (const info of items) {
          parent.entries.set(info.id, {
            info,
            spec: { id: info.id, parentSessionId, title: info.title, cwd: '', prompt: info.prompt, sessionDir: '' },
            timeoutMinutes: 0,
            lifetime: new AbortController(),
            finished: Promise.resolve(),
            resolve: () => {}
          })
        }
        this.parents.set(parentSessionId, parent)
        return parent
      })().finally(() => this.loading.delete(parentSessionId))
      this.loading.set(parentSessionId, loading)
    }
    return loading
  }

  private queuedBackground(parent: Parent): Entry[] {
    return [...parent.entries.values()]
      .filter((entry) => entry.info.background && entry.info.status === 'queued')
      .sort((a, b) => a.info.createdAt - b.info.createdAt)
  }

  private pump(parentSessionId: string): void {
    const parent = this.parents.get(parentSessionId)
    if (!parent || parent.closed) return
    let running = [...parent.entries.values()]
      .filter((entry) => entry.info.background && entry.info.status === 'running').length
    for (const entry of this.queuedBackground(parent)) {
      if (running >= this.maxConcurrent) break
      running++
      this.launch(parentSessionId, entry)
    }
  }

  private update(parentSessionId: string, entry: Entry, patch: Partial<SubagentInfo>): void {
    entry.info = { ...entry.info, ...patch }
    this.deps.onChange(parentSessionId)
  }

  private persist(parentSessionId: string): Promise<void> {
    this.deps.onChange(parentSessionId)
    return this.deps.store.save(parentSessionId, this.snapshot(parentSessionId))
  }

  private launch(parentSessionId: string, entry: Entry): void {
    // No invoke caller awaits background execution. Stop the child and surface IO failures in the UI.
    void this.start(parentSessionId, entry).catch((error) => this.failJob(parentSessionId, entry, error))
  }

  private async failJob(parentSessionId: string, entry: Entry, error: unknown): Promise<void> {
    if (entry.timer) clearTimeout(entry.timer)
    entry.lifetime.abort(error)
    entry.onProgress = undefined
    if (entry.run) {
      entry.run.abort()
      await entry.run.done
      entry.run = undefined
    }
    this.update(parentSessionId, entry, {
      status: 'failed', endedAt: this.now(), activity: undefined,
      error: error instanceof Error ? error.message : String(error)
    })
    entry.resolve()
    this.deps.onError(parentSessionId, error)
    this.pump(parentSessionId)
  }

  private async start(parentSessionId: string, entry: Entry): Promise<void> {
    this.update(parentSessionId, entry, { status: 'running', startedAt: this.now() })
    await this.persist(parentSessionId)
    if (entry.abortReason) {
      await this.finish(parentSessionId, entry)
      return
    }
    if (entry.timeoutMinutes > 0) {
      entry.timer = setTimeout(() => this.abortEntry(parentSessionId, entry, 'timeout'), entry.timeoutMinutes * 60_000)
    }
    let run: SubagentRun
    try {
      run = await this.deps.runner.start(entry.spec, (event) => this.onEvent(parentSessionId, entry, event))
    } catch (error) {
      await this.finish(parentSessionId, entry, error instanceof Error ? error.message : String(error))
      return
    }
    entry.run = run
    if (run.sessionFile) {
      this.update(parentSessionId, entry, { sessionFile: run.sessionFile })
      await this.persist(parentSessionId)
    }
    if (entry.abortReason) run.abort()
    const result = await run.done
    // Disk-backed transcripts are read on demand, not retained for the lifetime of the parent tab.
    entry.messages = run.sessionFile && existsSync(run.sessionFile) ? undefined : run.messages()
    entry.run = undefined
    await this.finish(parentSessionId, entry, result.error)
  }

  private onEvent(parentSessionId: string, entry: Entry, event: RunEvent): void {
    const info = entry.info
    if (event.type === 'turn_start') {
      if (info.maxTurns > 0 && info.turns >= info.maxTurns) {
        this.abortEntry(parentSessionId, entry, 'turn_limit')
        return
      }
      this.update(parentSessionId, entry, { turns: info.turns + 1, turnTools: [...info.turnTools, { tools: [], thinking: false }] })
      return
    }
    if (event.type === 'tool') {
      const activity = describeTool(event.name, event.args)
      const turnTools = withCurrentTurn(info.turnTools, (turn) => ({ ...turn, tools: [...turn.tools, event.name] }))
      const path = typeof event.args.path === 'string' ? event.args.path : undefined
      const edited = (event.name === 'edit' || event.name === 'write') && path && !info.editedFiles.includes(path)
      this.update(parentSessionId, entry, {
        activity,
        turnTools,
        toolCounts: { ...info.toolCounts, [event.name]: (info.toolCounts[event.name] ?? 0) + 1 },
        ...(edited ? { editedFiles: [...info.editedFiles, path] } : {})
      })
      entry.onProgress?.(activity)
      return
    }
    this.update(parentSessionId, entry, {
      ...(event.thinking ? { turnTools: withCurrentTurn(info.turnTools, (turn) => ({ ...turn, thinking: true })) } : {}),
      usage: addUsage(info.usage, event.usage),
      cost: info.cost + event.cost,
      ...(event.text.trim() ? { output: event.text } : {})
    })
  }

  private abortEntry(parentSessionId: string, entry: Entry, reason: SubagentStatus): void {
    if (isFinished(entry.info.status)) return
    entry.abortReason ??= reason
    entry.lifetime.abort(new Error(`Subagent ${entry.abortReason}`))
    if (entry.info.status === 'queued') {
      void this.finish(parentSessionId, entry).catch((error) => this.failJob(parentSessionId, entry, error))
      return
    }
    entry.run?.abort()
  }

  private async finish(parentSessionId: string, entry: Entry, error?: string): Promise<void> {
    if (isFinished(entry.info.status)) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.lifetime.abort(new Error('Subagent finished'))
    entry.onProgress = undefined
    const status: SubagentStatus = entry.abortReason ?? (error ? 'failed' : 'completed')
    this.update(parentSessionId, entry, {
      status,
      endedAt: this.now(),
      activity: undefined,
      ...(error && status === 'failed' ? { error } : {}),
      ...(status === 'timeout' ? { error: `Stopped after ${entry.timeoutMinutes} minutes` } : {}),
      ...(status === 'turn_limit' ? { error: `Stopped after ${entry.info.maxTurns} turns` } : {})
    })
    await this.persist(parentSessionId)
    entry.resolve()
    const parent = this.parents.get(parentSessionId)
    if (parent && !parent.closed && entry.info.background && status !== 'interrupted') {
      parent.pending.push(entry.info)
      parent.flushTimer ??= setTimeout(() => this.flush(parentSessionId), this.coalesceMs)
    }
    this.pump(parentSessionId)
  }

  private flush(parentSessionId: string): void {
    const parent = this.parents.get(parentSessionId)
    if (!parent) return
    if (parent.flushTimer) clearTimeout(parent.flushTimer)
    parent.flushTimer = undefined
    if (!parent.deliver || !parent.pending.length) return
    const items = parent.pending
    parent.pending = []
    parent.deliver({
      text: combineReports(items),
      details: { subagents: items.map((item) => ({ id: item.id, title: item.title, status: item.status })) }
    })
  }
}

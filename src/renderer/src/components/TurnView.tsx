import { memo, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { formatElapsed, renderKeyForTurn, type CompactionItem, type ProcessItem, type Turn } from '../chat/turns'
import { MIN_GENERATION_DURATION_MS, MAX_REALISTIC_TPS } from '../../../shared/api'
import type { Translate } from '../../../shared/i18n'
import type { DisplayBranchSummary } from '../../../shared/api'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Marker, MarkerContent } from './ui/marker'
import { Answer, UserBubble } from './turn/TurnMessages'
import { BashTurn } from './turn/BashTurn'
import { CompactionNotice } from './turn/CompactionNotice'
import { BranchSummaryNotice } from './turn/BranchSummaryNotice'
import { ProcessList, ProcessOutline } from './turn/TurnProcess'
import { useWorkBlockMs } from './turn/useWorkBlockMs'

/**
 * A mid-turn compaction splits the process: the work either side of it is rendered as its own block,
 * with the marker between them. Each block carries the work time the turn had reached when it ended,
 * so the clock the summary stopped carries on where it left off. Compactions that arrived after the
 * turn's answer are handed back separately, because they belong below the answer rather than inside
 * the work block.
 */
type SummarySegment =
  | { kind: 'compaction'; item: CompactionItem }
  | { kind: 'branchSummary'; item: DisplayBranchSummary }

type ProcessSegment = { kind: 'work'; items: ProcessItem[]; block: number } | SummarySegment

function segmentProcess(items: ProcessItem[]): ProcessSegment[] {
  const segments: ProcessSegment[] = []
  let work: ProcessItem[] = []
  let block = 0
  const flush = () => {
    if (work.length === 0) return
    segments.push({ kind: 'work', items: work, block })
    work = []
  }
  for (const item of items) {
    if (item.kind === 'compaction') {
      flush()
      segments.push({ kind: 'compaction', item })
      block++
      continue
    }
    work.push(item)
  }
  flush()
  return segments
}

function projectedSegments(landmarks: CompactionItem[], workBlocks: boolean[]): ProcessSegment[] {
  const segments: ProcessSegment[] = []
  workBlocks.forEach((hasWork, block) => {
    if (hasWork) segments.push({ kind: 'work', items: [], block })
    if (landmarks[block]) segments.push({ kind: 'compaction', item: landmarks[block] })
  })
  return segments
}

function turnTps(turn: Turn): string | null {
  const generation = turn.generation
  if (!generation || generation.measuredCalls === 0 || generation.outputTokens < 8 || generation.durationMs < MIN_GENERATION_DURATION_MS) return null
  const tps = generation.outputTokens / (generation.durationMs / 1_000)
  return Number.isFinite(tps) && tps > 0 && tps <= MAX_REALISTIC_TPS ? tps.toFixed(1) : null
}

/**
 * Tooltip for a turn's speed. A turn whose samples came from more than one model measures their
 * blend, so the legend names them instead of presenting the figure as one model's decode rate.
 */
function tpsTooltip(t: Translate, turn: Turn): string {
  const description = t('turn.tpsDescription')
  const models = turn.generation?.models ?? []
  return models.length > 1
    ? `${description} · ${t('turn.tpsMixedModels', { models: models.join(' / ') })}`
    : description
}

function WorkedLabel({ turn, landmarks, block, sessionId }: {
  sessionId?: string
  turn: Turn
  landmarks: CompactionItem[]
  block: number
}) {
  const t = useT()
  // The clock lives in the label so a ticking timer re-renders this row and not the work below it.
  const workedMs = useWorkBlockMs(turn, landmarks, sessionId)
  const tps = block === landmarks.length ? turnTps(turn) : null
  const generation = turn.generation
  return (
    <span className="flex items-center gap-1">
      <span>{t(turn.streaming ? 'turn.worked' : 'turn.workedFor', { duration: formatElapsed(workedMs[block] ?? 0, t) })}</span>
      {tps && generation ? (
        <span className="tabular-nums" title={tpsTooltip(t, turn)}>
          · {t('turn.tps', { value: tps })} · {t('turn.tpsSamples', {
            measured: generation.measuredCalls,
            total: generation.totalCalls
          })}
        </span>
      ) : null}
    </span>
  )
}

/** Coordinates lazy process loading and the transition from live work to an answer. */
function AgentTurnView({
  turn,
  sessionId,
  onNeedProcess
}: {
  sessionId?: string
  turn: Turn
  onNeedProcess?: (turnId: string) => Promise<void>
}) {
  const trailing: SummarySegment[] = []
  const trailingCompactions: CompactionItem[] = []
  const inline: ProcessItem[] = []
  // Pi keeps a compaction in the same stream as the work, so a loaded process owns its landmarks and
  // has their exact position. The projection's copies stand in while the process is unread — a
  // landmark the reader has to open a block to find is one they may never see — and also when the
  // process on hand is a partial one, such as the command row a finished run leaves behind.
  const loaded = turn.process.some((item) => item.kind === 'compaction') ? [] : turn.compactions ?? []
  for (const item of [...turn.process, ...loaded]) {
    if (item.kind === 'compaction' && item.afterAnswer) {
      trailingCompactions.push(item)
      trailing.push({ kind: 'compaction', item })
    } else inline.push(item)
  }
  const landmarks = inline.filter((item): item is CompactionItem => item.kind === 'compaction')
  // History already knows which intervals contain work; reading a body must not create its header.
  const blocks = turn.process.length === 0 && turn.workBlocks
    ? projectedSegments(landmarks, turn.workBlocks)
    : segmentProcess(inline)
  // Handoffs occupy compaction intervals without creating new timed work blocks. Source offsets
  // keep their order even when history bodies are unread or multiple entries share a timestamp.
  for (const item of turn.branchSummaries ?? []) {
    const target = item.afterAnswer ? trailing : blocks
    const nextCompaction = item.afterAnswer
      ? trailingCompactions[item.compactionsBefore - landmarks.length]
      : landmarks[item.compactionsBefore]
    const index = nextCompaction
      ? target.findIndex((segment) => segment.kind === 'compaction' && segment.item === nextCompaction)
      : target.length
    target.splice(index, 0, { kind: 'branchSummary', item })
  }
  const hasWork = blocks.some((segment) => segment.kind === 'work')
  const showHeader = hasWork || turn.streaming || (!turn.workBlocks && Boolean(turn.hasProcess) && turn.process.length === 0)
  const showBody = showHeader || blocks.length > 0
  const modelActive = turn.streaming && !turn.errorMessage &&
    !landmarks.some((item) => item.live?.status === 'running')
  let activeWorkIndex = -1
  if (modelActive) {
    // An empty current interval still owns the live clock; never resume work before a landmark.
    const last = blocks[blocks.length - 1]
    if (last?.kind !== 'work' || last.block !== landmarks.length) {
      blocks.push({ kind: 'work', items: [], block: landmarks.length })
    }
    activeWorkIndex = blocks.length - 1
  } else if (showHeader && !hasWork && blocks.length === 0) {
    blocks.push({ kind: 'work', items: [], block: 0 })
  }
  const needsTrailingTps = Boolean(turnTps(turn)) && !blocks.some(
    (segment) => segment.kind === 'work' && segment.block === landmarks.length
  )
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [liveOutline, setLiveOutline] = useState(turn.streaming)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const request = useRef(0)

  const identity = renderKeyForTurn(turn, turn.startedAt)
  // Every block of work carries the total the turn had reached when it ended; a running turn keeps
  // counting in its last one, and the blocks before a compaction keep the value it froze them at.
  // Empty intervals still advance the clock, so identity and timing use the compaction interval.
  const openAt = (block: number) => open[block] ?? turn.streaming

  useEffect(() => {
    request.current++
    setLoading(false)
    setLoadError(null)
    return () => { request.current++ }
  }, [identity, turn.streaming])

  useEffect(() => {
    // Blocks start open while the turn is running and collapsed once it is done.
    setOpen({})
    if (turn.streaming) {
      setLiveOutline(true)
      return
    }
    const id = window.setTimeout(() => setLiveOutline(false), 300)
    return () => window.clearTimeout(id)
  }, [identity, turn.streaming])

  async function toggleProcess(index: number, next: boolean): Promise<void> {
    if (turn.streaming) return
    const setBlockOpen = (value: boolean) => setOpen((current) => ({ ...current, [index]: value }))
    if (!next) {
      request.current++
      setBlockOpen(false)
      return
    }
    if (turn.process.length === 0 && onNeedProcess && turn.id && !turn.id.startsWith('live:')) {
      const token = ++request.current
      setLoading(true)
      setLoadError(null)
      try {
        await onNeedProcess(turn.id)
        if (request.current !== token) return
      } catch (error) {
        // UI boundary for lazy-history IPC/read failures: keep the block closed and show the error.
        if (request.current === token) setLoadError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        if (request.current === token) setLoading(false)
      }
    }
    setOpen((current) => ({ ...current, [index]: true }))
  }

  const trailingTps = needsTrailingTps ? (
    <Marker variant="separator" className="text-xs text-muted-foreground">
      <MarkerContent>
        <WorkedLabel sessionId={sessionId} turn={turn} landmarks={landmarks} block={landmarks.length} />
      </MarkerContent>
    </Marker>
  ) : null

  return (
    <div className="mb-4">
      {turn.user ? <UserBubble message={turn.user} sessionId={sessionId} turnId={turn.id} /> : null}
      {showBody ? (
        <div className="mb-3">
          {blocks.map((block, index) =>
            block.kind === 'branchSummary' ? (
              <BranchSummaryNotice key={`branch-${index}`} text={block.item.text} />
            ) : block.kind === 'compaction' ? (
              <CompactionNotice key={`compaction-${index}`} item={block.item} />
            ) : (
              // One Collapsible per work block, each with its own header: they open independently,
              // and each gets its own content id (a single root reuses one id for every content).
              <Collapsible
                key={`work-${block.block}`}
                open={openAt(block.block)}
                onOpenChange={(next) => void toggleProcess(block.block, next)}
              >
                <Marker variant="separator" asChild>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={loading}
                      className={cn(
                        'h-7 w-full justify-start gap-2 rounded-none px-0 text-xs font-normal text-muted-foreground before:min-w-4 after:min-w-4 hover:bg-transparent hover:text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-transparent dark:hover:bg-transparent dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-transparent solid:hover:bg-transparent solid:hover:text-muted-foreground solid:aria-expanded:bg-transparent solid:aria-expanded:text-muted-foreground solid:hover:aria-expanded:bg-transparent solid:dark:hover:bg-transparent solid:dark:aria-expanded:bg-transparent solid:dark:hover:aria-expanded:bg-transparent',
                        turn.streaming && 'pointer-events-none'
                      )}
                    >
                      <MarkerContent className="flex shrink-0 items-center gap-1">
                        <WorkedLabel sessionId={sessionId} turn={turn} landmarks={landmarks} block={block.block} />
                        <ChevronRight
                          className={cn('size-3.5 transition-transform duration-150', openAt(block.block) && 'rotate-90')}
                        />
                      </MarkerContent>
                    </Button>
                  </CollapsibleTrigger>
                </Marker>
                <CollapsibleContent className="duration-300">
                  {liveOutline ? (
                    <ProcessOutline
                      items={block.items}
                      streaming={index === activeWorkIndex}
                      waitingForModel={index === activeWorkIndex && turn.waitingForModel}
                    />
                  ) : (
                    <ProcessList items={block.items} />
                  )}
                </CollapsibleContent>
              </Collapsible>
            )
          )}
          {trailingTps}
          {loadError ? <p role="alert" className="py-1 text-xs text-destructive">{loadError}</p> : null}
        </div>
      ) : trailingTps ? <div className="mb-3">{trailingTps}</div> : null}
      {turn.streaming ? null : <Answer blocks={turn.answer} errorMessage={turn.errorMessage} />}
      {trailing.map((segment, index) => segment.kind === 'compaction'
        ? <CompactionNotice key={`trailing-${index}`} item={segment.item} />
        : <BranchSummaryNotice key={`trailing-${index}`} text={segment.item.text} />)}
    </div>
  )
}

// A command can head a turn that still carries summaries, answers, or errors: the card renders
// the command, so the leftovers are projected onto a turn without command metadata.
function withoutCommand(turn: Turn): Turn | null {
  const process = turn.process.filter((item) => item.kind !== 'bash')
  if (process.length === 0 && turn.answer.length === 0 && !turn.errorMessage &&
    (turn.compactions?.length ?? 0) === 0 && (turn.branchSummaries?.length ?? 0) === 0) return null
  return { ...turn, process, bash: undefined, hasProcess: process.length > 0 }
}

export const TurnView = memo(function TurnView({
  turn,
  sessionId,
  onNeedProcess,
  onAbortBash
}: {
  sessionId?: string
  turn: Turn
  onNeedProcess?: (turnId: string) => Promise<void>
  onAbortBash?: () => Promise<void>
}) {
  if (!turn.bash) return <AgentTurnView sessionId={sessionId} turn={turn} onNeedProcess={onNeedProcess} />
  const rest = withoutCommand(turn)
  return (
    <>
      <BashTurn turn={turn} onNeedProcess={onNeedProcess} onAbortBash={onAbortBash} />
      {rest ? <AgentTurnView sessionId={sessionId} turn={rest} onNeedProcess={onNeedProcess} /> : null}
    </>
  )
})

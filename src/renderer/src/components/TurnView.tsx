import { memo, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { formatElapsed, renderKeyForTurn, type CompactionItem, type ProcessItem, type Turn } from '../chat/turns'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Marker, MarkerContent } from './ui/marker'
import { Answer, UserBubble } from './turn/TurnMessages'
import { BashTurn } from './turn/BashTurn'
import { CompactionNotice } from './turn/CompactionNotice'
import { ProcessList, ProcessOutline } from './turn/TurnProcess'
import { useWorkBlockMs } from './turn/useWorkBlockMs'

/**
 * A mid-turn compaction splits the process: the work either side of it is rendered as its own block,
 * with the marker between them. Each block carries the work time the turn had reached when it ended,
 * so the clock the summary stopped carries on where it left off. Compactions that arrived after the
 * turn's answer are handed back separately, because they belong below the answer rather than inside
 * the work block.
 */
type ProcessSegment =
  | { kind: 'work'; items: ProcessItem[] }
  | { kind: 'compaction'; item: Extract<ProcessItem, { kind: 'compaction' }> }

function segmentProcess(items: ProcessItem[]): ProcessSegment[] {
  const segments: ProcessSegment[] = []
  let work: ProcessItem[] = []
  const flush = () => {
    if (work.length === 0) return
    segments.push({ kind: 'work', items: work })
    work = []
  }
  for (const item of items) {
    if (item.kind === 'compaction') {
      flush()
      segments.push({ kind: 'compaction', item })
      continue
    }
    work.push(item)
  }
  flush()
  return segments
}

function WorkedLabel({ turn, landmarks, block }: {
  turn: Turn
  landmarks: CompactionItem[]
  block: number
}) {
  const t = useT()
  // The clock lives in the label so a ticking timer re-renders this row and not the work below it.
  const workedMs = useWorkBlockMs(turn, landmarks)
  return (
    <>{t(turn.streaming ? 'turn.worked' : 'turn.workedFor', { duration: formatElapsed(workedMs[block] ?? 0, t) })}</>
  )
}

/** Coordinates lazy process loading and the transition from live work to an answer. */
function AgentTurnView({
  turn,
  onNeedProcess
}: {
  turn: Turn
  onNeedProcess?: (turnId: string) => Promise<void>
}) {
  const trailing: Extract<ProcessItem, { kind: 'compaction' }>[] = []
  const inline: ProcessItem[] = []
  // Pi keeps a compaction in the same stream as the work, so a loaded process owns its landmarks and
  // has their exact position. The projection's copies stand in while the process is unread — a
  // landmark the reader has to open a block to find is one they may never see — and also when the
  // process on hand is a partial one, such as the command row a finished run leaves behind.
  const loaded = turn.process.some((item) => item.kind === 'compaction') ? [] : turn.compactions ?? []
  for (const item of [...turn.process, ...loaded]) {
    if (item.kind === 'compaction' && item.afterAnswer) trailing.push(item)
    else inline.push(item)
  }
  const segments = segmentProcess(inline)
  const landmarks = inline.filter((item): item is CompactionItem => item.kind === 'compaction')
  const hasWork = segments.some((segment) => segment.kind === 'work')
  // A turn whose process is still on disk only knows that it has one: the header stands in for it.
  const showHeader = hasWork || turn.streaming || (Boolean(turn.hasProcess) && turn.process.length === 0)
  const showBody = showHeader || segments.length > 0
  // An empty process still renders the body: while streaming it holds the waiting line, and the
  // header needs a block to live in when a compaction is the only thing the turn carries.
  const blocks: ProcessSegment[] = [...segments]
  if (showHeader && !hasWork) blocks.unshift({ kind: 'work', items: [] })
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [liveOutline, setLiveOutline] = useState(turn.streaming)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const request = useRef(0)

  const identity = renderKeyForTurn(turn, turn.startedAt)
  // Every block of work carries the total the turn had reached when it ended; a running turn keeps
  // counting in its last one, and the blocks before a compaction keep the value it froze them at.
  let ordinal = -1
  const blockOrdinals = blocks.map((block) => (block.kind === 'work' ? ++ordinal : -1))
  const openAt = (index: number) => open[index] ?? turn.streaming

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
        if (request.current === token) setLoadError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        if (request.current === token) setLoading(false)
      }
    }
    setOpen((current) => ({ ...current, [index]: true }))
  }

  return (
    <div className="mb-4">
      {turn.user ? <UserBubble message={turn.user} /> : null}
      {showBody ? (
        <div className="mb-3">
          {blocks.map((block, index) =>
            block.kind === 'compaction' ? (
              <CompactionNotice key={`compaction-${index}`} item={block.item} />
            ) : (
              // One Collapsible per work block, each with its own header: they open independently,
              // and each gets its own content id (a single root reuses one id for every content).
              <Collapsible
                key={`work-${index}`}
                open={openAt(index)}
                onOpenChange={(next) => void toggleProcess(index, next)}
              >
                <Marker variant="separator" asChild>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={loading}
                      className={cn(
                        'h-7 w-full justify-start gap-2 rounded-none px-0 text-xs font-normal text-muted-foreground before:min-w-4 after:min-w-4 hover:bg-transparent hover:text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-transparent dark:hover:bg-transparent dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-transparent',
                        turn.streaming && 'pointer-events-none'
                      )}
                    >
                      <MarkerContent className="flex shrink-0 items-center gap-1">
                        <WorkedLabel turn={turn} landmarks={landmarks} block={blockOrdinals[index]} />
                        <ChevronRight
                          className={cn('size-3.5 transition-transform duration-150', openAt(index) && 'rotate-90')}
                        />
                      </MarkerContent>
                    </Button>
                  </CollapsibleTrigger>
                </Marker>
                <CollapsibleContent className="duration-300">
                  {liveOutline ? (
                    <ProcessOutline items={block.items} streaming={turn.streaming && !turn.errorMessage} />
                  ) : (
                    <ProcessList items={block.items} />
                  )}
                </CollapsibleContent>
              </Collapsible>
            )
          )}
          {loadError ? <p role="alert" className="py-1 text-xs text-destructive">{loadError}</p> : null}
        </div>
      ) : null}
      {turn.streaming ? null : <Answer blocks={turn.answer} errorMessage={turn.errorMessage} />}
      {trailing.map((item, index) => <CompactionNotice key={`trailing-${index}`} item={item} />)}
    </div>
  )
}

// A command can head a turn that still carries summaries, answers, or errors: the card renders
// the command, so the leftovers are projected onto a turn without command metadata.
function withoutCommand(turn: Turn): Turn | null {
  const process = turn.process.filter((item) => item.kind !== 'bash')
  if (process.length === 0 && turn.answer.length === 0 && !turn.errorMessage && (turn.compactions?.length ?? 0) === 0) return null
  return { ...turn, process, bash: undefined, hasProcess: process.length > 0 }
}

export const TurnView = memo(function TurnView({
  turn,
  onNeedProcess,
  onAbortBash
}: {
  turn: Turn
  onNeedProcess?: (turnId: string) => Promise<void>
  onAbortBash?: () => Promise<void>
}) {
  if (!turn.bash) return <AgentTurnView turn={turn} onNeedProcess={onNeedProcess} />
  const rest = withoutCommand(turn)
  return (
    <>
      <BashTurn turn={turn} onNeedProcess={onNeedProcess} onAbortBash={onAbortBash} />
      {rest ? <AgentTurnView turn={rest} onNeedProcess={onNeedProcess} /> : null}
    </>
  )
})

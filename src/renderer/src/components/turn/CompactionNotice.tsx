/**
 * A compaction is a session landmark rather than work: the model's visible context was summarized,
 * so everything before it stops counting towards the window. It is rendered outside the collapsed
 * work block, keeping the summary one click away — and while Pi is still writing that summary the
 * same row reports the compaction itself, because there is nothing to expand yet.
 */
import { useEffect, useState } from 'react'
import { Archive } from 'lucide-react'
import { compactionReasonKey } from '../../chat/compactions'
import { formatElapsed, type CompactionItem } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { formatTokens } from '../../lib/format'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Marker, MarkerContent } from '../ui/marker'
import { Chevron } from './ProcessChrome'
import { SummaryText } from './SummaryText'

const landmarkRow = 'flex shrink-0 items-center gap-1.5'

/** A running compaction counts up: it is work the reader is waiting on, just not the turn's own. */
function useRunningMs(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [startedAt])
  return startedAt == null ? 0 : Math.max(0, now - startedAt)
}

export function CompactionNotice({ item }: { item: CompactionItem }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const running = item.live?.status === 'running' ? item.live : undefined
  const runningMs = useRunningMs(running?.startedAt ?? null)
  if (running) {
    return (
      <Marker variant="separator" className="text-xs">
        <MarkerContent className={landmarkRow}>
          <Archive className="size-3.5" />
          <span className="shimmer">{t(compactionReasonKey(running.reason))}</span>
          <span className="text-muted-foreground/70">{formatElapsed(runningMs, t)}</span>
        </MarkerContent>
      </Marker>
    )
  }
  const text = item.live?.summary ?? item.text
  const tokensBefore = item.live?.tokensBefore ?? item.tokensBefore
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <Marker variant="separator" asChild>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 justify-center gap-2 rounded-none px-0 text-xs font-normal text-muted-foreground before:min-w-4 after:min-w-4 hover:bg-transparent hover:text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-transparent dark:hover:bg-transparent dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-transparent solid:hover:bg-transparent solid:hover:text-muted-foreground solid:aria-expanded:bg-transparent solid:aria-expanded:text-muted-foreground solid:hover:aria-expanded:bg-transparent solid:dark:hover:bg-transparent solid:dark:aria-expanded:bg-transparent solid:dark:hover:aria-expanded:bg-transparent"
          >
            <MarkerContent className={landmarkRow}>
              <Archive className="size-3.5" />
              <span>{t('chat.compacted')}</span>
              <span className="text-muted-foreground/70">
                {t('chat.compactedFrom', { tokens: formatTokens(tokensBefore) })}
              </span>
              <Chevron open={open} />
            </MarkerContent>
          </Button>
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent className="duration-300">
        <SummaryText text={text} />
      </CollapsibleContent>
    </Collapsible>
  )
}

import { memo, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { formatElapsed, renderKeyForTurn, type Turn } from '../chat/turns'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { Marker, MarkerContent } from './ui/marker'
import { Answer, UserBubble } from './turn/TurnMessages'
import { ProcessList, ProcessOutline } from './turn/TurnProcess'
import { useWorkedMs } from './turn/useWorkedMs'

function WorkedLabel({ turn }: { turn: Turn }) {
  const t = useT()
  const workedMs = useWorkedMs(turn)
  return <>{t(turn.streaming ? 'turn.worked' : 'turn.workedFor', { duration: formatElapsed(workedMs, t) })}</>
}

/** Coordinates lazy process loading and the transition from live work to an answer. */
export const TurnView = memo(function TurnView({
  turn,
  onNeedProcess
}: {
  turn: Turn
  onNeedProcess?: (turnId: string) => Promise<void>
}) {
  const hasProcess = Boolean(turn.hasProcess) || turn.process.length > 0 || turn.streaming
  const [open, setOpen] = useState(turn.streaming)
  const [liveOutline, setLiveOutline] = useState(turn.streaming)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const request = useRef(0)

  const identity = renderKeyForTurn(turn, turn.startedAt)

  useEffect(() => {
    request.current++
    setLoading(false)
    setLoadError(null)
    return () => { request.current++ }
  }, [identity, turn.streaming])

  useEffect(() => {
    if (turn.streaming) {
      setLiveOutline(true)
      setOpen(true)
      return
    }
    setOpen(false)
    const id = window.setTimeout(() => setLiveOutline(false), 300)
    return () => window.clearTimeout(id)
  }, [identity, turn.streaming])

  async function toggleProcess(next: boolean): Promise<void> {
    if (turn.streaming) return
    if (!next) {
      request.current++
      setOpen(false)
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
    setOpen(true)
  }

  return (
    <div className="mb-4">
      {turn.user ? <UserBubble message={turn.user} /> : null}
      {hasProcess ? (
        <Collapsible
          open={open}
          onOpenChange={(next) => void toggleProcess(next)}
          className="mb-3"
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
                  <WorkedLabel turn={turn} />
                  <ChevronRight className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />
                </MarkerContent>
              </Button>
            </CollapsibleTrigger>
          </Marker>
          {loadError ? <p role="alert" className="py-1 text-xs text-destructive">{loadError}</p> : null}
          <CollapsibleContent className="duration-300">
            {liveOutline ? (
              <ProcessOutline items={turn.process} streaming={turn.streaming && !turn.errorMessage} />
            ) : (
              <ProcessList items={turn.process} />
            )}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {turn.streaming ? null : <Answer blocks={turn.answer} errorMessage={turn.errorMessage} />}
    </div>
  )
})

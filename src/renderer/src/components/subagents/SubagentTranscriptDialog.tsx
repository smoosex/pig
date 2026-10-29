/** Read-only full conversation of one subagent, refetched as the child makes progress. */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../ipc/api'
import type { PiMessage } from '../../pi/types'
import { groupTurns } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { isSubagentActive, useSessionSubagents, useSubagentStore } from '../../stores/subagents'
import { TurnView } from '../TurnView'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SubagentAvatar, SubagentMeta, useNow } from './subagent-view'

export function SubagentTranscriptDialog() {
  const t = useT()
  const target = useSubagentStore((state) => state.transcript)
  const close = useSubagentStore((state) => state.closeTranscript)
  const items = useSessionSubagents(target?.sessionId ?? null)
  const item = items.find((candidate) => candidate.id === target?.id)
  const active = !!item && isSubagentActive(item)
  const now = useNow(active)
  const [messages, setMessages] = useState<PiMessage[] | null>(null)
  const [failed, setFailed] = useState(false)
  // Each finished turn, tool call or status change is a reason to read the transcript again.
  const revision = item ? `${item.status}:${item.turns}:${Object.values(item.toolCounts).reduce((a, b) => a + b, 0)}:${item.usage?.calls ?? 0}` : ''

  useEffect(() => {
    if (!target) {
      setMessages(null)
      setFailed(false)
      return
    }
    let current = true
    void api.getSubagentTranscript(target.sessionId, target.id).then(
      (next) => { if (current) { setMessages(next as PiMessage[]); setFailed(false) } },
      () => { if (current) setFailed(true) }
    )
    return () => { current = false }
  }, [target, revision])

  const turns = useMemo(() => groupTurns(messages ?? [], active), [messages, active])

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 flex-row items-center gap-2.5 border-b border-border px-4 py-3 pr-12">
          {item ? <SubagentAvatar item={item} /> : null}
          <div className="flex min-w-0 flex-col">
            <DialogTitle className="truncate text-sm">{item?.title ?? t('subagents.transcript')}</DialogTitle>
            <DialogDescription asChild>
              {item ? <SubagentMeta item={item} now={now} /> : <span>{t('subagents.transcript')}</span>}
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-4', hideScroll)}>
          {failed ? (
            <p className="text-sm text-destructive">{t('subagents.transcriptFailed')}</p>
          ) : turns.length ? (
            <div className="flex flex-col gap-6">
              {turns.map((turn, index) => <TurnView key={turn.renderKey ?? index} turn={turn} />)}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('subagents.transcriptEmpty')}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import { Bot, Check, Clock3, LoaderCircle, Square, X } from 'lucide-react'
import type { SubagentInfo } from '../../ipc/api'
import { formatElapsed } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { isSubagentActive, isSubagentProblem, subagentColor } from '../../stores/subagents'

/** Re-renders every second while `active`, for elapsed times of running subagents. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return active ? now : Date.now()
}

export function subagentElapsed(item: SubagentInfo, now: number): number {
  if (item.startedAt === undefined) return 0
  return (item.endedAt ?? now) - item.startedAt
}

function StatusMark({ item }: { item: SubagentInfo }) {
  const mark = 'absolute -right-0.5 -bottom-0.5 size-3 rounded-full p-px ring-2 ring-popover'
  if (item.status === 'running') return <LoaderCircle aria-hidden="true" className={cn(mark, 'animate-spin bg-popover text-foreground')} />
  if (item.status === 'queued') return <Clock3 aria-hidden="true" className={cn(mark, 'bg-popover text-muted-foreground')} />
  if (item.status === 'completed') return <Check aria-hidden="true" className={cn(mark, 'bg-success text-background')} />
  if (item.status === 'aborted') return <Square aria-hidden="true" className={cn(mark, 'bg-muted-foreground fill-current p-0.5 text-background')} />
  return <X aria-hidden="true" className={cn(mark, 'bg-destructive text-background')} />
}

export function SubagentAvatar({ item, className }: { item: SubagentInfo; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-primary-foreground', subagentColor(item.id), className)}>
      <Bot aria-hidden="true" className="size-3.5" />
      <StatusMark item={item} />
    </span>
  )
}

/** "Done · 16 s · 3 turns · Edited 2 files" */
export function SubagentMeta({ item, now, className }: { item: SubagentInfo; now: number; className?: string }) {
  const t = useT()
  const parts = [t(`subagents.status.${item.status}`)]
  if (item.startedAt !== undefined) parts.push(formatElapsed(subagentElapsed(item, now), t))
  if (item.turns) parts.push(t('subagents.turns', { n: item.turns }))
  if (!isSubagentActive(item)) {
    parts.push(item.editedFiles.length ? t('subagents.edited', { n: item.editedFiles.length }) : t('subagents.editedNone'))
  }
  return (
    <span className={cn('truncate text-xs text-muted-foreground', isSubagentProblem(item) && 'text-destructive', className)}>
      {parts.join(' · ')}
    </span>
  )
}

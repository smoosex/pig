import { useEffect, useState } from 'react'
import { Bird, Cat, Check, CircleStop, Clock3, Dog, Fish, LoaderCircle, Panda, PiggyBank, Rabbit, Rat, Shrimp, Snail, Squirrel, Turtle, X, type LucideIcon } from 'lucide-react'
import type { SubagentInfo } from '../../ipc/api'
import { formatElapsed } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { isSubagentActive, isSubagentProblem, subagentAppearance, subagentColor } from '../../stores/subagents'
import type { SubagentAppearance } from '../../../../shared/subagent-appearance'

const ANIMALS: Record<SubagentAppearance['animal'], LucideIcon> = {
  panda: Panda, cat: Cat, turtle: Turtle, rat: Rat, squirrel: Squirrel, dog: Dog,
  fish: Fish, rabbit: Rabbit, bird: Bird, snail: Snail, shrimp: Shrimp, 'piggy-bank': PiggyBank
}

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

function StatusMark({ item, size }: { item: SubagentInfo; size: 6 | 8 }) {
  const mark = cn('absolute right-0 bottom-0 rounded-full p-px', size === 6 ? 'size-1.5' : 'size-2')
  if (item.status === 'running') return <LoaderCircle aria-hidden="true" className={cn(mark, 'animate-spin bg-popover text-foreground')} />
  if (item.status === 'queued') return <Clock3 aria-hidden="true" className={cn(mark, 'bg-popover text-muted-foreground')} />
  if (item.status === 'completed') return <Check aria-hidden="true" strokeWidth={3} className={cn(mark, 'bg-subagent-completed-background text-subagent-completed-foreground')} />
  if (item.status === 'aborted') return <CircleStop aria-hidden="true" strokeWidth={3} className={cn(mark, 'bg-popover text-muted-foreground')} />
  return <X aria-hidden="true" strokeWidth={3} className={cn(mark, 'bg-subagent-failed-background text-subagent-failed-foreground')} />
}

export function SubagentAvatar({ item, className, statusSize = 8 }: { item: SubagentInfo; className?: string; statusSize?: 6 | 8 }) {
  const Animal = ANIMALS[subagentAppearance(item).animal]
  return (
    <span className={cn('relative inline-flex size-5 shrink-0 items-center justify-center', subagentColor(item, true), className)}>
      <Animal aria-hidden="true" className="size-full" />
      <StatusMark item={item} size={statusSize} />
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

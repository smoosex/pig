/** Semantic status, priority, and colored-dot label indicators for Kanban cards, pills, and mentions. */
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  Eye,
  MoreHorizontal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  XCircle
} from 'lucide-react'
import type { KanbanPriority, KanbanStatus } from '../../../../shared/kanban'
import { cn } from '../../lib/utils'

const CUSTOM_LABEL_DOTS = [
  'bg-chart-3',
  'bg-chart-2',
  'bg-chart-6',
  'bg-chart-7'
] as const

/**
 * Maps built-in Linear-style labels (`Feature`, `Bug`, `Improvement`) to dedicated semantic chart
 * tokens (purple / red / blue) and hashes custom labels deterministically across the remaining palette.
 */
export function kanbanLabelDotClass(label: string): string {
  const key = label.trim().toLowerCase()
  if (key === 'feature') return 'bg-chart-5'
  if (key === 'bug') return 'bg-chart-1'
  if (key === 'improvement') return 'bg-chart-4'
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }
  return CUSTOM_LABEL_DOTS[hash % CUSTOM_LABEL_DOTS.length]
}

export function KanbanLabelDot({
  label,
  className
}: {
  label: string
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 shrink-0 rounded-full', kanbanLabelDotClass(label), className)}
    />
  )
}

export function KanbanStackedLabelDots({
  labels,
  className
}: {
  labels: readonly string[]
  className?: string
}) {
  return (
    <span aria-hidden="true" className={cn('inline-flex items-center -space-x-1', className)}>
      {labels.slice(0, 3).map((label) => (
        <span
          key={label}
          className={cn(
            'size-2.5 shrink-0 rounded-full ring-[1.5px] ring-glass-popover-background solid:ring-popover',
            kanbanLabelDotClass(label)
          )}
        />
      ))}
    </span>
  )
}

export function KanbanStatusIcon({
  status,
  className
}: {
  status: KanbanStatus
  className?: string
}) {
  switch (status) {
    case 'backlog':
      return <CircleDashed className={cn('size-3.5 shrink-0 text-muted-foreground', className)} aria-hidden="true" />
    case 'todo':
      return <Circle className={cn('size-3.5 shrink-0 text-muted-foreground', className)} aria-hidden="true" />
    case 'in_progress':
      return <CircleDot className={cn('size-3.5 shrink-0 text-warning', className)} aria-hidden="true" />
    case 'in_review':
      return <Eye className={cn('size-3.5 shrink-0 text-info', className)} aria-hidden="true" />
    case 'done':
      return <CheckCircle2 className={cn('size-3.5 shrink-0 text-info', className)} aria-hidden="true" />
    case 'canceled':
      return <XCircle className={cn('size-3.5 shrink-0 text-muted-foreground/70', className)} aria-hidden="true" />
  }
}

export function KanbanPriorityIcon({
  priority,
  className
}: {
  priority: KanbanPriority
  className?: string
}) {
  switch (priority) {
    case 'urgent':
      return <AlertTriangle className={cn('size-3.5 shrink-0 text-destructive', className)} aria-hidden="true" />
    case 'high':
      return <SignalHigh className={cn('size-3.5 shrink-0 text-warning', className)} aria-hidden="true" />
    case 'medium':
      return <SignalMedium className={cn('size-3.5 shrink-0 text-foreground/80', className)} aria-hidden="true" />
    case 'low':
      return <SignalLow className={cn('size-3.5 shrink-0 text-muted-foreground', className)} aria-hidden="true" />
    case 'none':
      return <MoreHorizontal className={cn('size-3.5 shrink-0 text-muted-foreground/70', className)} aria-hidden="true" />
  }
}

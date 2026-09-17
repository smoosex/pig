import { cn } from '../lib/utils'

const turnThresholds = [1, 2, 3, 5, 9, 17, 25, 33]

export function SessionTurnDots({
  turnCount,
  className
}: {
  turnCount: number
  className?: string
}) {
  return (
    <span
      className={cn('flex items-center gap-0.5', className)}
      role="img"
      aria-label={`已扫描到 ${turnCount} 轮对话`}
      title={`已扫描到 ${turnCount} 轮对话`}
    >
      {turnThresholds.map((threshold) => (
        <span
          key={threshold}
          className={cn(
            'size-1 rounded-full',
            threshold <= turnCount ? 'bg-primary' : 'bg-muted-foreground/25'
          )}
        />
      ))}
    </span>
  )
}

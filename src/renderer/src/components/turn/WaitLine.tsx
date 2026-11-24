/** Rotating playful waiting lines shared between workspace model-wait rows and Bot's thinking hint. */
import { useEffect, useState } from 'react'
import type { MessageKey } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'

export const WAIT_LINE_KEYS: readonly MessageKey[] = [
  'turn.placeholder1',
  'turn.placeholder2',
  'turn.placeholder3',
  'turn.placeholder4',
  'turn.placeholder5',
  'turn.placeholder6'
]

export function WaitLine({
  streaming,
  intervalMs = 2800,
  className
}: {
  streaming: boolean
  intervalMs?: number
  className?: string
}) {
  const t = useT()
  const [index, setIndex] = useState(() => Math.floor(Math.random() * WAIT_LINE_KEYS.length))
  useEffect(() => {
    if (!streaming) return
    const id = window.setInterval(() => {
      setIndex((current) => {
        if (WAIT_LINE_KEYS.length < 2) return current
        let next = current
        while (next === current) next = Math.floor(Math.random() * WAIT_LINE_KEYS.length)
        return next
      })
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [streaming, intervalMs])
  return (
    <span data-wait-line className={cn(streaming && 'shimmer', className)}>
      {t(WAIT_LINE_KEYS[index] ?? WAIT_LINE_KEYS[0])}
    </span>
  )
}

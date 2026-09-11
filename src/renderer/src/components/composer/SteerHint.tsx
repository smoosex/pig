import { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'

export function SteerHint({ visible }: { visible: boolean }) {
  const [mounted, setMounted] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (visible) {
      setMounted(true)
      setLeaving(false)
      return
    }
    if (!mounted) return
    setLeaving(true)
    const timeout = window.setTimeout(() => {
      setMounted(false)
      setLeaving(false)
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [visible, mounted])

  if (!mounted) return null
  return (
    <div className={cn(
      'pointer-events-none absolute right-3 bottom-full z-0 rounded-t-md bg-primary px-2 py-0.5 text-xs text-primary-foreground shadow-sm',
      leaving ? 'steer-hint-exit' : 'steer-hint-enter'
    )}>
      Tab 转为引导
    </div>
  )
}

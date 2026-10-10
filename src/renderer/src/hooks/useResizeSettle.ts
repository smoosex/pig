/**
 * Triggers a subtle settle animation on window resize end (debounced).
 * During active dragging, no animation is applied to preserve 1:1 direct manipulation.
 */
import { useCallback, useEffect, useRef, useState, type AnimationEvent } from 'react'

export function useResizeSettle(debounceMs = 150) {
  const [settling, setSettling] = useState(false)
  const timer = useRef<number>(undefined)
  const lastSize = useRef<{ w: number; h: number }>({
    w: typeof window !== 'undefined' ? window.innerWidth : 0,
    h: typeof window !== 'undefined' ? window.innerHeight : 0
  })

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      if (Math.abs(w - lastSize.current.w) < 4 && Math.abs(h - lastSize.current.h) < 4) {
        return
      }
      lastSize.current = { w, h }

      setSettling(false)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        setSettling(true)
      }, debounceMs)
    }

    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(timer.current)
    }
  }, [debounceMs])

  const handleAnimationEnd = useCallback((e: AnimationEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setSettling(false)
    }
  }, [])

  return { settling, handleAnimationEnd }
}

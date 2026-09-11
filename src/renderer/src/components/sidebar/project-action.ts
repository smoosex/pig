import { useEffect, useRef, useState } from 'react'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type RunProjectAction = (action: string, run: () => Promise<unknown>) => Promise<void>

export function useProjectAction() {
  const pendingRef = useRef(false)
  const mounted = useRef(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const runAction: RunProjectAction = async (action, run) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(action)
    setError(null)
    try {
      await run()
    } catch (error) {
      if (mounted.current) setError(errorMessage(error))
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(null)
    }
  }
  return { pending, error, runAction }
}

/** Copy buttons flip to a confirmed state after the clipboard write lands, then reset. */
import { useCallback, useEffect, useRef, useState } from 'react'

export function useCopyFeedback(text: string, resetMs = 1500) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(async (value = text) => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), resetMs)
  }, [text, resetMs])

  return { copied, copy }
}

/**
 * Sticky-bottom auto-scroll hook shared by live thinking blocks and streaming tool input/output panels:
 * follows new content at the bottom while `enabled` is true, pauses if the reader scrolls up (>= 24px),
 * and resumes when they scroll back down or re-open the disclosure.
 */
import { useCallback, useEffect, useRef, type RefObject, type UIEvent } from 'react'

export const FOLLOW_SCROLL_THRESHOLD_PX = 24

export function useFollowScroll<T extends HTMLElement>(
  enabled: boolean,
  watchKey: unknown,
  externalRef?: RefObject<T | null>
) {
  const internalRef = useRef<T | null>(null)
  const ref = externalRef ?? internalRef
  const following = useRef(true)
  const prevEnabled = useRef(false)

  if (enabled && !prevEnabled.current) {
    following.current = true
  }
  prevEnabled.current = enabled

  useEffect(() => {
    if (!enabled || !following.current) return
    const node = ref.current
    if (node) node.scrollTop = node.scrollHeight
  }, [enabled, watchKey])

  const onScroll = useCallback((event: UIEvent<T>) => {
    const node = event.currentTarget
    following.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_SCROLL_THRESHOLD_PX
  }, [])

  return { ref, onScroll }
}

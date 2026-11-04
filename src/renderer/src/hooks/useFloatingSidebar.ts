/** Hover previews dismiss on leave; explicit opens stay until the user dismisses them. */
import { useCallback, useEffect, useReducer, useRef, type MouseEvent as ReactMouseEvent } from 'react'

type Side = 'left' | 'right'
type FloatingSidebar = { side: Side; pinned: boolean } | null
type Action = { type: 'hover' | 'leave' | 'toggle'; side: Side } | { type: 'close' }

export function floatingSidebarReducer(state: FloatingSidebar, action: Action): FloatingSidebar {
  switch (action.type) {
    case 'hover': return state?.pinned ? state : { side: action.side, pinned: false }
    case 'leave': return state?.side === action.side && !state.pinned ? null : state
    case 'toggle': return state?.side === action.side && state.pinned ? null : { side: action.side, pinned: true }
    case 'close': return null
  }
}

export function useFloatingSidebar() {
  const [state, dispatch] = useReducer(floatingSidebarReducer, null)
  const hover = useCallback((side: Side) => dispatch({ type: 'hover', side }), [])
  const leave = useCallback((side: Side) => dispatch({ type: 'leave', side }), [])
  const toggle = useCallback((side: Side) => dispatch({ type: 'toggle', side }), [])
  const close = useCallback(() => dispatch({ type: 'close' }), [])

  const insideMove = useRef<{ event: MouseEvent; side: Side } | null>(null)
  const trackPointer = useCallback((side: Side, event: ReactMouseEvent) => {
    insideMove.current = { event: event.nativeEvent, side }
  }, [])

  const previewSide = state && !state.pinned ? state.side : null
  useEffect(() => {
    if (!previewSide) return
    const dismiss = () => leave(previewSide)
    // Native window transitions can miss the sidebar's React mouseleave event.
    const checkPointer = (event: MouseEvent) => {
      // Radix modal menus disable body hit testing. The resulting background
      // events do not describe the pointer's position relative to the sidebar.
      if (document.body.style.pointerEvents === 'none' &&
        (event.target === document.body || event.target === document.documentElement)) return
      // React capture includes sidebar-owned Portals, unlike DOM ancestry checks.
      const inside = insideMove.current
      if (inside?.event !== event || inside.side !== previewSide) dismiss()
    }
    document.addEventListener('mousemove', checkPointer)
    document.addEventListener('mouseleave', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('mousemove', checkPointer)
      document.removeEventListener('mouseleave', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [previewSide, leave])

  return { side: state?.side ?? null, hover, leave, toggle, close, trackPointer }
}

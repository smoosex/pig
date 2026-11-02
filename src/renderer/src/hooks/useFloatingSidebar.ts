/** Hover previews dismiss on leave; explicit opens stay until the user dismisses them. */
import { useCallback, useReducer } from 'react'

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

  return { side: state?.side ?? null, hover, leave, toggle, close }
}

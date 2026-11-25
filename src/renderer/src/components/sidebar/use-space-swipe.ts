/**
 * Horizontal wheel / trackpad two-finger swipe gesture for stepping between Project Spaces.
 * Locks after one trigger per physical flick so macOS trackpad momentum tails never skip multiple spaces,
 * while immediately allowing a reverse flick or a fresh gesture after pause/decay.
 */
import { useCallback, useRef, type WheelEvent } from 'react'
import { useProjectSpacesStore } from '../../stores/project-spaces'

const SWIPE_THRESHOLD_PX = 42
const GESTURE_IDLE_MS = 140
const MOMENTUM_DECAY_MS = 260

interface SwipeGestureState {
  accumX: number
  lastEventAt: number
  lockedDirection: -1 | 0 | 1
  lockedAt: number
  sawDecay: boolean
}

export function useSpaceWheelSwipe({ allowVertical = false }: { allowVertical?: boolean } = {}) {
  const gestureRef = useRef<SwipeGestureState>({
    accumX: 0,
    lastEventAt: 0,
    lockedDirection: 0,
    lockedAt: 0,
    sawDecay: false
  })

  return useCallback(
    (event: WheelEvent<HTMLElement>) => {
      const { spaces, activeSpaceId, dialog, selectSpace } = useProjectSpacesStore.getState()
      if (spaces.length <= 1 || dialog) return
      if (
        document.querySelector(
          '[data-slot=dialog-content], [data-slot=alert-dialog-content], [data-slot=context-menu-content][data-state=open], [data-slot=dropdown-menu-content][data-state=open], [data-slot=popover-content][data-state=open]'
        )
      ) {
        return
      }

      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
      const rawX = event.deltaX * unit
      const rawY = event.deltaY * unit

      let dx = 0
      if (Math.abs(rawX) > Math.abs(rawY) * 1.15) {
        dx = rawX
      } else if (event.shiftKey && Math.abs(rawY) > 0) {
        dx = rawY
      } else if (allowVertical && Math.abs(rawY) > 0) {
        dx = rawY
      }
      if (dx === 0) return

      const now = performance.now()
      const state = gestureRef.current
      const idleElapsed = now - state.lastEventAt
      state.lastEventAt = now

      if (idleElapsed > GESTURE_IDLE_MS) {
        state.accumX = 0
        state.lockedDirection = 0
        state.sawDecay = false
      }

      const direction: -1 | 1 = dx > 0 ? 1 : -1

      if (state.lockedDirection !== 0) {
        if (direction !== state.lockedDirection && Math.abs(dx) > 4) {
          // Immediate swipe in the opposite direction unlocks right away.
          state.lockedDirection = 0
          state.accumX = 0
          state.sawDecay = false
        } else {
          if (Math.abs(dx) < 3) {
            state.sawDecay = true
          } else if (state.sawDecay && now - state.lockedAt > MOMENTUM_DECAY_MS && Math.abs(dx) > 12) {
            // Momentum nearly stopped and a fresh fast flick started.
            state.lockedDirection = 0
            state.accumX = 0
            state.sawDecay = false
          } else {
            return
          }
        }
      }

      state.accumX += dx
      if (Math.abs(state.accumX) < SWIPE_THRESHOLD_PX) return

      const step = state.accumX > 0 ? 1 : -1
      state.accumX = 0
      state.lockedDirection = step
      state.lockedAt = now
      state.sawDecay = false

      const currentIndex = spaces.findIndex((space) => space.id === activeSpaceId)
      if (currentIndex === -1) return
      const nextIndex = Math.max(0, Math.min(spaces.length - 1, currentIndex + step))
      if (nextIndex !== currentIndex) {
        void selectSpace(spaces[nextIndex]!.id)
      }
    },
    [allowVertical]
  )
}

import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let observer: MutationObserver | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = undefined
    }
  }
}

export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'), () => false)
}

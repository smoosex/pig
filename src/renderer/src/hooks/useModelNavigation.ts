import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

export function useModelNavigation<T>(items: T[], open: boolean, onSelect: (item: T) => void) {
  const [index, setIndex] = useState(-1)
  const activeRef = useRef<HTMLButtonElement>(null)
  const keyboard = useRef(false)

  useEffect(() => {
    setIndex(-1)
    keyboard.current = false
  }, [items, open])

  useEffect(() => {
    if (open && keyboard.current) {
      activeRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [index, open])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!items.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      keyboard.current = true
      setIndex((current) => event.key === 'ArrowDown'
        ? (current + 1) % items.length
        : (current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length))
    } else if (event.key === 'Enter' && index >= 0 && items[index]) {
      event.preventDefault()
      event.stopPropagation()
      onSelect(items[index])
    }
  }

  const hover = (next: number) => {
    keyboard.current = false
    setIndex(next)
  }

  return { index, activeRef, onKeyDown, hover }
}

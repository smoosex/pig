import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type SlashCommand } from '../../ipc/api'
import { filterSlashCommands, slashQuery } from './commands'

export function useSlashCommands(
  sessionId: string | null,
  text: string,
  onSelect: (command: SlashCommand) => void,
  disabled = false
) {
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const request = useRef<{ sessionId: string } | null>(null)
  const query = slashQuery(text)

  useEffect(() => {
    request.current = null
    setCommands([])
    return () => { request.current = null }
  }, [sessionId])

  useEffect(() => { setDismissed(false) }, [sessionId, text])

  useEffect(() => {
    if (!sessionId || query === null || request.current?.sessionId === sessionId) return
    const pending = { sessionId }
    request.current = pending
    void api.getCommands(sessionId).then(
      (list) => {
        if (request.current === pending) setCommands(list)
      },
      () => {
        if (request.current !== pending) return
        request.current = null
        setCommands([])
      }
    )
  }, [sessionId, query])

  const filtered = useMemo(() => filterSlashCommands(commands, query), [commands, query])
  useEffect(() => { setIndex(0) }, [query, commands])
  const open = !disabled && query !== null && !dismissed && filtered.length > 0
  const selectedIndex = Math.min(index, Math.max(0, filtered.length - 1))

  const select = (command: SlashCommand) => {
    onSelect(command)
    setDismissed(true)
  }

  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setIndex((current) => (current + direction + filtered.length) % filtered.length)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(true)
      return true
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      select(filtered[selectedIndex])
      return true
    }
    return false
  }

  return { open, filtered, index: selectedIndex, setIndex, select, dismiss: () => setDismissed(true), handleKeyDown }
}

export type SlashCommands = ReturnType<typeof useSlashCommands>

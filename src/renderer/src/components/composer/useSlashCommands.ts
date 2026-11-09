import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { api, type SlashCommand } from '../../ipc/api'
import { filterSlashCommands, slashQuery } from './commands'

/** Only plain text from the document start to the caret belongs to the command query. */
function readSlashTarget(editor: Editor) {
  const { selection } = editor.state
  const { $from } = selection
  if (!selection.empty || $from.depth !== 1 || $from.start() !== 1 || !$from.parent.isTextblock) return null
  let plainText = true
  $from.parent.nodesBetween(0, $from.parentOffset, (node) => {
    if (!node.isText) plainText = false
  })
  if (!plainText) return null
  const query = slashQuery($from.parent.textBetween(0, $from.parentOffset))
  return query === null ? null : { from: 1, to: selection.from, query }
}

export function useSlashCommands(
  sessionId: string | null,
  editor: Editor | null,
  disabled = false
) {
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [generation, setGeneration] = useState(0)
  const request = useRef<{ sessionId: string } | null>(null)
  const [target, setTarget] = useState<ReturnType<typeof readSlashTarget>>(null)
  const query = target?.query ?? null

  useEffect(() => {
    if (!editor) {
      setTarget(null)
      return
    }
    const recompute = () => setTarget(disabled ? null : readSlashTarget(editor))
    recompute()
    // Silent draft restoration can change the query without changing the selection.
    editor.on('transaction', recompute)
    return () => {
      editor.off('transaction', recompute)
    }
  }, [editor, disabled])

  useEffect(() => {
    request.current = null
    setCommands([])
    return () => { request.current = null }
  }, [sessionId])

  useEffect(() => { setDismissed(false) }, [sessionId, query])
  useEffect(() => api.onPluginsChanged(() => {
    request.current = null
    setCommands([])
    setGeneration((value) => value + 1)
  }), [])

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
  }, [sessionId, query, generation])

  const filtered = useMemo(() => filterSlashCommands(commands, query), [commands, query])
  useEffect(() => { setIndex(0) }, [query, commands])
  const open = !disabled && query !== null && !dismissed && filtered.length > 0
  const selectedIndex = Math.min(index, Math.max(0, filtered.length - 1))

  const select = (command: SlashCommand) => {
    const live = editor && !disabled ? readSlashTarget(editor) : null
    if (editor && live) {
      editor.chain().focus().insertContentAt(
        { from: live.from, to: live.to },
        { type: 'text', text: `/${command.name} ` }
      ).run()
    }
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

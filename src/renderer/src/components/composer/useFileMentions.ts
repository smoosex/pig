import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { api, type FileSuggestion } from '../../ipc/api'
import { atMentionToken, mentionValue } from './mentions'

/**
 * `@` path completion for the composer, mirroring the slash-command hook's contract: a debounced
 * lookup per query, arrow/Tab/Enter/Escape handling, and a popover row list. The differences are all
 * positional — the token lives at the caret, not at the start of the text, so the hook reads the live
 * editor instead of the serialized draft, and completing a directory keeps the menu open to descend.
 */
const FETCH_DEBOUNCE_MS = 120

interface MentionTarget {
  from: number
  to: number
  query: string
  quoted: boolean
}

interface Segment {
  text: string
  textFrom: number
  docFrom: number
  splittable: boolean
}

function pieceText(node: { isText: boolean; text?: string | null; type: { name: string }; attrs: Record<string, unknown> }): string {
  if (node.isText) return node.text ?? ''
  if (node.type.name === 'hardBreak') return '\n'
  if (node.type.name === 'pastedText') return String(node.attrs.text ?? '')
  return ''
}

/**
 * The `@` token at the caret as a document range. Text offsets and document positions only agree
 * inside plain text: a pasted-text node holds N characters in 1 document position, so a token that
 * touches one is left alone rather than split open.
 */
function readMentionTarget(editor: Editor): MentionTarget | null {
  const { selection } = editor.state
  if (!selection.empty) return null
  const $from = selection.$from
  const parent = $from.parent
  if (!parent.isTextblock) return null
  const blockStart = $from.start()

  const segments: Segment[] = []
  let length = 0
  parent.forEach((node, offset) => {
    const text = pieceText(node)
    segments.push({ text, textFrom: length, docFrom: blockStart + offset, splittable: node.isText })
    length += text.length
  })

  let caretText = length
  for (const segment of segments) {
    const docTo = segment.docFrom + (segment.splittable ? segment.text.length : 1)
    if (selection.from <= docTo) {
      caretText = segment.splittable
        ? segment.textFrom + Math.max(0, selection.from - segment.docFrom)
        : selection.from === segment.docFrom
          ? segment.textFrom
          : segment.textFrom + segment.text.length
      break
    }
  }
  const before = segments.map((segment) => segment.text).join('').slice(0, caretText)
  const token = atMentionToken(before)
  if (!token) return null
  if (segments.some((segment) => !segment.splittable && segment.textFrom < caretText && segment.textFrom + segment.text.length > token.start)) {
    return null
  }
  const holder = [...segments].reverse().find((segment) => segment.textFrom <= token.start)
  const from = holder ? holder.docFrom + (token.start - holder.textFrom) : blockStart
  return { from, to: selection.from, query: token.query, quoted: token.quoted }
}

export function useFileMentions({
  resetKey,
  cwd,
  editor,
  disabled
}: {
  resetKey: string | null
  cwd: string | null
  editor: Editor | null
  disabled: boolean
}) {
  const [target, setTarget] = useState<MentionTarget | null>(null)
  const [items, setItems] = useState<FileSuggestion[]>([])
  const [itemsFor, setItemsFor] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const request = useRef(0)
  // Enter or Tab while a fetch is in flight: the index to complete once the fresh rows land.
  const pendingSelect = useRef<number | null>(null)
  const query = target?.query ?? null

  useEffect(() => {
    if (!editor) return
    const recompute = () => setTarget(disabled ? null : readMentionTarget(editor))
    recompute()
    editor.on('update', recompute)
    editor.on('selectionUpdate', recompute)
    return () => {
      editor.off('update', recompute)
      editor.off('selectionUpdate', recompute)
    }
  }, [editor, disabled])

  useEffect(() => {
    request.current += 1
    pendingSelect.current = null
    setItems([])
    setItemsFor(null)
    setIndex(0)
    setDismissed(false)
  }, [resetKey, cwd])

  // A completed or escaped menu stays shut for its own query only: the next keystroke reopens it.
  // Typing on cancels a queued Enter for the older query rather than completing a stale row.
  useEffect(() => {
    pendingSelect.current = null
    setIndex(0)
    setDismissed(false)
  }, [query])

  const select = useCallback((item: FileSuggestion) => {
    const live = editor ? readMentionTarget(editor) : null
    if (!editor || !live) {
      setDismissed(true)
      return
    }
    const value = mentionValue(item.path, live.quoted) + (item.isDirectory ? '' : ' ')
    editor.chain().focus().deleteRange({ from: live.from, to: live.to }).insertContent(value).run()
    if (item.isDirectory && value.endsWith('"')) {
      // The value carries its closing quote — from the token or from whitespace in the path — so park
      // the caret inside it to keep descending.
      editor.commands.setTextSelection(live.from + value.length - 1)
    }
    if (!item.isDirectory) setDismissed(true)
  }, [editor])

  useEffect(() => {
    if (!cwd || query === null) {
      setItems([])
      setItemsFor(null)
      return
    }
    const pending = ++request.current
    const timer = setTimeout(() => {
      void api.suggestFiles(cwd, query).then(
        (list) => {
          if (request.current !== pending) return
          setItems(list)
          setItemsFor(query)
          setIndex(0)
          const queued = pendingSelect.current
          pendingSelect.current = null
          if (queued !== null && list.length > 0) select(list[Math.min(queued, list.length - 1)])
        },
        () => {
          if (request.current !== pending) return
          pendingSelect.current = null
          setItems([])
          setItemsFor(query)
        }
      )
    }, FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [cwd, query, select])

  // Stale rows stay up while the fresh fetch is in flight: closing per keystroke is what flickers.
  // itemsFor only marks the loading state now, so Enter can queue behind it instead of misfiring.
  const loading = itemsFor !== query
  const open = !disabled && query !== null && !dismissed && items.length > 0
  const selectedIndex = Math.min(index, Math.max(0, items.length - 1))

  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setIndex((current) => (current + direction + items.length) % items.length)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      pendingSelect.current = null
      setDismissed(true)
      return true
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      // Loading rows are stale: queue the key behind the fresh fetch instead of completing one.
      if (loading) pendingSelect.current = selectedIndex
      else select(items[selectedIndex])
      return true
    }
    return false
  }

  return { open, items, index: selectedIndex, setIndex, select, dismiss: () => setDismissed(true), handleKeyDown }
}

export type FileMentions = ReturnType<typeof useFileMentions>

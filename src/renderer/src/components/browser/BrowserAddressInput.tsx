/**
 * Address field with history suggestions. Nothing is highlighted by default, so Enter opens what the
 * field shows; an inline completion, selected after the caret, counts as part of that.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { BrowserHistoryEntry } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Input } from '../ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { HistoryIcon } from './HistoryIcon'
import { inlineCompletion, type InlineCompletion } from './inline-completion'

const QUERY_DELAY_MS = 120

interface BrowserAddressInputProps {
  value: string
  onValueChange: (value: string) => void
  /**
   * A suggestion was clicked (`clicked`: the field gives up focus, so the page should take it) or an
   * inline completion accepted; other keyboard choices go through the form's own submit.
   */
  onPick: (url: string, clicked: boolean) => void
  composing: RefObject<boolean>
}

export function BrowserAddressInput({ value, onValueChange, onPick, composing }: BrowserAddressInputProps) {
  const t = useT()
  const listId = useId()
  // What the user typed; null while the field mirrors the page URL.
  const [query, setQuery] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<BrowserHistoryEntry[]>([])
  const [highlight, setHighlight] = useState(-1)
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const inline = useRef<InlineCompletion | null>(null)
  // Only typing at the end of the field asks for completion; deleting, pasting or editing mid-text does not.
  const wantsInline = useRef(false)
  const selection = useRef<[number, number] | null>(null)
  const queryRevision = useRef(0)
  // The value arrives through the parent, so the selection waits for the committed DOM.
  useLayoutEffect(() => {
    if (!selection.current || !input.current) return
    input.current.setSelectionRange(...selection.current)
    selection.current = null
  })

  const complete = (typed: string, next: InlineCompletion | null) => {
    inline.current = next
    onValueChange(next?.text ?? typed)
    if (next) selection.current = [typed.length, next.text.length]
  }

  useEffect(() => {
    if (query === null || !query.trim()) {
      setSuggestions([])
      setHighlight(-1)
      return
    }
    let stale = false
    const revision = queryRevision.current
    const timer = setTimeout(() => {
      if (revision !== queryRevision.current) return
      void api.browser.queryHistory(query).then((entries) => {
        if (stale || revision !== queryRevision.current) return
        const field = input.current
        // Still at the typed text, possibly with the previous completion selected after it.
        const atEnd = !!field && field.selectionStart === query.length && field.selectionEnd === field.value.length && field.value.startsWith(query)
        const next = wantsInline.current && atEnd && !composing.current ? inlineCompletion(query, entries) : null
        if (wantsInline.current && atEnd) complete(query, next)
        setSuggestions(next ? [next.entry, ...entries.filter((entry) => entry !== next.entry)] : entries)
        setHighlight(-1)
      }).catch((error) => console.error('Browser history query failed:', error))
    }, QUERY_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query])

  const dismiss = () => {
    queryRevision.current++
    inline.current = null
    wantsInline.current = false
    setQuery(null)
    setSuggestions([])
    setHighlight(-1)
  }
  const move = (next: number) => {
    inline.current = null
    setHighlight(next)
    onValueChange(next === -1 ? query ?? '' : suggestions[next]!.url)
  }
  const remove = (index: number) => {
    const entry = suggestions[index]!
    const rest = suggestions.filter((_, i) => i !== index)
    setSuggestions(rest)
    const next = Math.min(index, rest.length - 1)
    setHighlight(next)
    onValueChange(next === -1 ? query ?? '' : rest[next]!.url)
    void api.browser.removeHistory(entry.url).catch((error) => console.error('Browser history removal failed:', error))
  }

  const open = focused && suggestions.length > 0
  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <Input ref={input} aria-label={t('browser.address')} placeholder={t('browser.address')} value={value}
          role="combobox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-autocomplete="list"
          aria-activedescendant={open && highlight >= 0 ? `${listId}-${highlight}` : undefined}
          onChange={(event) => {
            const typed = event.target.value
            const atEnd = event.target.selectionStart === typed.length
            wantsInline.current = atEnd && (event.nativeEvent as InputEvent).inputType === 'insertText' && !composing.current
            const previous = inline.current
            // Typing what the completion already shows keeps it in place instead of waiting for the next query.
            const kept = wantsInline.current && previous && previous.text.length > typed.length && previous.text.toLowerCase().startsWith(typed.toLowerCase())
              ? { ...previous, text: typed + previous.text.slice(typed.length) } : null
            complete(typed, kept)
            setQuery(typed)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            if (inline.current && query !== null) onValueChange(query)
            dismiss()
          }}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === 'Enter') event.preventDefault()
              return
            }
            if (event.key === 'Enter') {
              const accepted = inline.current && inline.current.text === value ? inline.current.url : null
              dismiss()
              if (accepted) {
                event.preventDefault()
                onValueChange(accepted)
                onPick(accepted, false)
              }
              return
            }
            if (event.key === 'Escape') {
              // Invalidate both the debounce and in-flight results before React runs effect cleanup.
              queryRevision.current++
              wantsInline.current = false
              if (inline.current && query !== null) {
                event.preventDefault()
                complete(query, null)
                return
              }
            }
            if (!open) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              // -1 is the typed text itself, one step before the first suggestion.
              move((highlight + 1 + step + suggestions.length + 1) % (suggestions.length + 1) - 1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onValueChange(query ?? value)
              setSuggestions([])
              setHighlight(-1)
            } else if (event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace') && highlight >= 0) {
              event.preventDefault()
              remove(highlight)
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md px-2 text-xs md:text-xs border-glass-card-border bg-glass-prompt-foreground/4! solid:border-input solid:bg-background! solid:dark:bg-input/30!" />
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={4} className="w-(--radix-popover-trigger-width) gap-0 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
        <div id={listId} role="listbox" aria-label={t('browser.history')}>
          {suggestions.map((entry, index) => (
            <div key={entry.url} id={`${listId}-${index}`} role="option" aria-selected={index === highlight}
              className={cn('flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-xs select-none hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent solid:hover:text-accent-foreground',
                index === highlight && 'bg-glass-prompt-foreground/8 solid:bg-accent solid:text-accent-foreground')}
              // Keep focus in the field: a blur would dismiss the list before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                dismiss()
                onValueChange(entry.url)
                onPick(entry.url, true)
                input.current?.blur()
              }}>
              <HistoryIcon icon={entry.icon} />
              <span className="min-w-0 truncate">{entry.title || entry.url}</span>
              {entry.title ? <span className="min-w-0 flex-1 truncate opacity-60">{entry.url}</span> : null}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

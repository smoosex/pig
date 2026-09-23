/**
 * The in-place rename field: the title of a row or a tab becomes an input while the reader edits it.
 * The row that hosts it decides where it sits; this module owns the editing state, the keys that end
 * it, and the store call that writes the name.
 */
import { useRef, useState } from 'react'
import { useSessionsStore } from '../stores/sessions'
import { Input } from './ui/input'
import { cn } from '../lib/utils'
import { useT } from '../hooks/useT'

export function useSessionRename(sessionId: string, path?: string) {
  const renameSession = useSessionsStore((state) => state.renameSession)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return {
    editing,
    error,
    start: () => {
      setError(null)
      // A menu holds its focus trap until a tick after it closes. The field has to mount behind that,
      // or the trap pulls the caret back out of it and the field sits there unable to be typed into.
      setTimeout(() => setEditing(true), 0)
    },
    cancel: () => setEditing(false),
    commit: (name: string) => {
      setEditing(false)
      void renameSession(sessionId, name, path).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    }
  }
}

export function SessionRenameField({
  value,
  onCommit,
  onCancel,
  className,
  ariaLabel
}: {
  value: string
  onCommit: (name: string) => void
  onCancel: () => void
  className?: string
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(value)
  const done = useRef(false)
  const t = useT()

  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(draft)
    else onCancel()
  }

  return (
    <Input
      // The row under it is clickable, and a click in the field belongs to the field.
      onClick={(event) => event.stopPropagation()}
      value={draft}
      autoFocus
      aria-label={ariaLabel ?? t('sessions.nameLabel')}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      }}
      className={cn('h-6 min-w-0 rounded-sm px-1 py-0 text-xs md:text-xs', className)}
    />
  )
}

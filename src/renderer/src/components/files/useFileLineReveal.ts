import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Editor } from '@pierre/diffs/edit'
import type { FileDocument } from '../../stores/files'
import { useFilesStore } from '../../stores/files'

/** What the surface has to hold before an editor can be told a line about it. */
function readable(document: FileDocument | undefined): boolean {
  return document?.status === 'ready' && document.preview === 'text'
}

/**
 * Lands a file tab on the line a diff row was followed to.
 *
 * The changes tab asks for a file and a line at once, but a tab that was just opened has neither bytes
 * nor an editor yet, so the request waits in the store and is honoured here. Background refreshes update
 * the mounted surface in place while explicit reloads unmount it during `loading`; clearing the cached
 * editor when `onDetach` runs ensures a reveal arriving mid-reload waits for the replacement editor.
 */
export function useFileLineReveal(
  cwd: string,
  path: string,
  document: FileDocument | undefined
): {
  editorOptions: { onAttach: (editor: Editor<'file', undefined, undefined>) => void }
  onDetach: () => void
} {
  const [editor, setEditor] = useState<Editor<'file', undefined, undefined> | null>(null)
  // Only this tab's request is of any interest here, and a selector that answers null for everyone
  // else's keeps a follow in one worktree from re-rendering every other open file tab.
  const reveal = useFilesStore((state) =>
    state.reveal?.cwd === cwd && state.reveal?.path === path ? state.reveal : null
  )
  const clearReveal = useFilesStore((state) => state.clearReveal)

  const onAttach = useCallback(
    (next: Editor<'file', undefined, undefined>) => setEditor(next),
    []
  )
  const onDetach = useCallback(() => setEditor(null), [])
  const editorOptions = useMemo(() => ({ onAttach }), [onAttach])

  useEffect(() => {
    if (!reveal) return
    if (document?.status === 'ready' && !readable(document)) {
      clearReveal()
      return
    }
    if (!editor || !readable(document)) return
    editor.focus({ lineNumber: reveal.line })
    clearReveal()
  }, [reveal, document, editor, clearReveal])

  return { editorOptions, onDetach }
}

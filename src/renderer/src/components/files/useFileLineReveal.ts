import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Editor } from '@pierre/diffs/edit'
import type { FileDocument } from '../../stores/files'
import { useFilesStore } from '../../stores/files'

/** What the surface has to hold before an editor can be told a line about it. */
function readable(document: FileDocument | undefined): boolean {
  return document?.status === 'ready' && document.preview === 'text'
}

/** The editor a surface is holding, and the revision of the bytes it was created for. */
interface Surface {
  editor: Editor<'file', undefined, undefined>
  revision: number | undefined
}

/**
 * Lands a file tab on the line a diff row was followed to.
 *
 * The changes tab asks for a file and a line at once, but a tab that was just opened has neither bytes
 * nor an editor yet, so the request waits in the store and is honoured here. The editor the surface
 * creates is handed over through `onAttach` — once the library has it rendering — together with the
 * revision it was created for: a revision bump replaces the surface and the editor with it, and an
 * editor the library has already cleaned up cannot be told anything, so a reveal that arrives while a
 * surface is being replaced stays in the store until the replacement reports in.
 *
 * The reveal leaves the store only once an editor has been told, which is what keeps leaving the tab and
 * coming back from replaying it. A document that settled into something an editor cannot hold — it is
 * gone, or it is a link — can never be landed on, so its request is dropped rather than left to surprise
 * the next reader of that tab.
 */
export function useFileLineReveal(
  cwd: string,
  path: string,
  document: FileDocument | undefined
): { editorOptions: { onAttach: (editor: Editor<'file', undefined, undefined>) => void } } {
  const [surface, setSurface] = useState<Surface | null>(null)
  // Only this tab's request is of any interest here, and a selector that answers null for everyone
  // else's keeps a follow in one worktree from re-rendering every other open file tab.
  const reveal = useFilesStore((state) =>
    state.reveal?.cwd === cwd && state.reveal?.path === path ? state.reveal : null
  )
  const clearReveal = useFilesStore((state) => state.clearReveal)

  // The revision is read at editor-creation time rather than from a closure over an older render: the
  // factory option is handed to the library once per surface, so it has to name the revision that
  // surface was built for.
  const onAttach = useCallback(
    (editor: Editor<'file', undefined, undefined>) => setSurface({ editor, revision: document?.revision }),
    [document?.revision]
  )
  const editorOptions = useMemo(() => ({ onAttach }), [onAttach])

  useEffect(() => {
    if (!reveal) return
    if (document?.status === 'ready' && !readable(document)) {
      clearReveal()
      return
    }
    // An editor from an earlier revision belongs to a surface that is gone.
    if (!surface || surface.revision !== document?.revision || !readable(document)) return
    surface.editor.focus({ lineNumber: reveal.line })
    clearReveal()
  }, [reveal, document, surface, clearReveal])

  return { editorOptions }
}

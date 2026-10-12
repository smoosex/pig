/**
 * The name a tree is asking for, and what committing it does.
 *
 * The draft is one value for the whole app rather than one per column, because the thing being named is
 * a single row: two fields open at once could not both be the row the reader is on.
 */
import { useCallback } from 'react'
import { toast } from 'sonner'
import { api } from '../../ipc/api'
import { useFilesStore, isDirty, type TreeDraft } from '../../stores/files'
import { isUnder } from '../../lib/worktree-paths'
import { useSessionsStore } from '../../stores/sessions'
import { fileTabId } from '../../stores/sessions/tabs-slice'
import { splitPath } from '../diff/file-entry'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'

export interface TreeDrafts {
  /** The open field in this worktree, or null when this worktree's tree names nothing. */
  draft: TreeDraft | null
  startNew: (kind: 'file' | 'folder', directory: string) => void
  startRename: (path: string) => void
  commit: (name: string, unchanged: boolean) => void
  cancel: () => void
  moveToTrash: (path: string) => void
  copyPath: (path: string) => void
  reveal: (path: string) => Promise<void>
}

/** The path a document key was made from, or null when it belongs to another worktree. */
function pathOfKey(key: string, cwd: string): string | null {
  return key.endsWith(`\u0000${cwd}`) ? key.slice(0, key.length - cwd.length - 1) : null
}

export function useTreeDrafts(cwd: string): TreeDrafts {
  const t = useT()
  const draft = useFilesStore((state) => (state.naming?.cwd === cwd ? state.naming : null))
  const setNaming = useFilesStore((state) => state.setNaming)

  const complain = useCallback(
    (
      key: 'file.renameFailed' | 'file.createFailed' | 'file.trashFailed' | 'file.copyFailed' | 'file.revealFailed',
      failure: unknown
    ) => {
      toast.error(t(key), { description: failureMessage(failure) })
    },
    [t]
  )

  /**
   * The field is mounted a tick after the menu item was chosen, not during it.
   *
   * A menu holds its focus trap until a tick after it closes, and a field that appears inside that window
   * has the caret pulled straight back out of it. Mounting late is what lets the field keep the keyboard,
   * which is what a reader who just asked to name something expects to be typing into.
   */
  const defer = useCallback((request: TreeDraft) => {
    setTimeout(() => useFilesStore.getState().setNaming(request), 0)
  }, [])

  const startNew = useCallback(
    (kind: 'file' | 'folder', directory: string) => defer({ cwd, kind, directory }),
    [cwd, defer]
  )

  /**
   * A rename refuses a row with an unsaved draft and says so, and a folder counts the drafts under it as
   * its own. Moving the bytes is easy; what is not easy is the draft, which describes bytes that no
   * longer sit where the reader left them — and a folder carries everything inside it, so a draft three
   * levels down is a draft this rename would strand just the same. The reader is asked to save first
   * rather than have any of it carried across without them knowing.
   */
  const startRename = useCallback(
    (path: string) => {
      const documents = useFilesStore.getState().documents
      const stranded = Object.entries(documents).some(([key, document]) => {
        const at = pathOfKey(key, cwd)
        if (at === null || !isDirty(document)) return false
        return at === path || isUnder(at, path)
      })
      if (stranded) {
        toast.error(t('file.dirtyRename'))
        return
      }
      defer({ cwd, kind: 'rename', path })
    },
    [cwd, defer, t]
  )

  const commit = useCallback(
    (name: string, unchanged: boolean) => {
      const request = useFilesStore.getState().naming
      if (!request || request.cwd !== cwd) return
      setNaming(null)
      // The name it already had is not a rename: the field closes and nothing is moved.
      if (unchanged) return
      const files = useFilesStore.getState()
      if (request.kind === 'rename') {
        const { path } = request
        void api.renameEntry(cwd, path, name).then(
          (renamed) => {
            // The document and the tab both answer to the path, so both follow the row.
            files.moveDocument(cwd, path, renamed.path)
            useSessionsStore.getState().moveFileTab(cwd, path, renamed.path)
            // The row on disk is still the old name until the level is read again, and a rename that
            // does not show up is a rename the reader will try a second time.
            void files.loadDirectory(cwd, splitPath(renamed.path).directory)
          },
          (failure: unknown) => complain('file.renameFailed', failure)
        )
        return
      }
      const path = request.directory ? `${request.directory}/${name}` : name
      const creating = request.kind === 'file' ? api.createFile(cwd, path) : api.createDirectory(cwd, path)
      void creating.then(
        (created) => {
          // The level has to be read again for the new row to exist at all: nothing else tells the tree
          // that a name it never asked about has appeared, and the change event that would is a moment
          // away at best.
          void files.loadDirectory(cwd, splitPath(created.path).directory)
          // A folder is opened so the reader can carry on inside it; a file opens in its own tab.
          if (request.kind === 'folder') files.toggleDirectory(cwd, created.path)
          else void useSessionsStore.getState().openFileTab(cwd, created.path)
        },
        (failure: unknown) => complain('file.createFailed', failure)
      )
    },
    [complain, cwd, setNaming]
  )

  const cancel = useCallback(() => setNaming(null), [setNaming])

  const moveToTrash = useCallback(
    (path: string) => {
      void api.trashEntry(cwd, path).then(
        () => {
          // The row is gone, so nothing may keep reading or editing what stood there.
          useFilesStore.getState().forgetDocument(cwd, path)
          useSessionsStore.getState().closeTab(fileTabId(cwd, path))
          // And the level it was in is read again, so the row stops being on screen.
          void useFilesStore.getState().loadDirectory(cwd, splitPath(path).directory)
        },
        (failure: unknown) => complain('file.trashFailed', failure)
      )
    },
    [complain, cwd]
  )

  const copyPath = useCallback(
    (path: string) => {
      // The absolute path, resolved in main: what a reader pastes into a terminal or another app.
      void api.copyPath(cwd, path).catch((failure: unknown) => complain('file.copyFailed', failure))
    },
    [complain, cwd]
  )

  const reveal = useCallback(
    (path: string) =>
      api.revealFileExternally(cwd, path).catch((failure: unknown) => {
        complain('file.revealFailed', failure)
      }),
    [complain, cwd]
  )

  return { draft, startNew, startRename, commit, cancel, moveToTrash, copyPath, reveal }
}

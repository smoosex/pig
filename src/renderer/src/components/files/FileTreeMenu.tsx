/**
 * What the file column offers when it — or the space below its last row — is right-clicked.
 *
 * The menu only starts things. Nothing is named here, and nothing is asked for here: an action either
 * happens outright or it hands the tree a field to type a name into, which is why this component holds no
 * state and a new file, a new folder and a rename all end up in the same place — a row of the tree that
 * is waiting for a name.
 *
 * The two rows that cannot be moved or renamed are the ones the tree will not read through: a link. Its
 * name is not pig's to change, because renaming one moves the link itself, and that is the one way
 * something leaves the worktree without ever being read.
 */
import { Copy, FilePlus2, FolderPlus, FolderOpen, PenLine, Trash2 } from 'lucide-react'
import { splitPath } from '../diff/file-entry'
import { useT } from '../../hooks/useT'
import type { TreeDrafts } from './useTreeDrafts'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'

/** The row a menu was opened on, or null for the empty space below the tree. */
type Target = { path: string; kind: 'file' | 'directory' | 'link' } | null

/**
 * The directory a new entry opened from this row belongs in: a folder holds its own children, and a file
 * shares the directory it sits in. Nothing was right-clicked — the space below the last row — means the
 * worktree's own root, which is the empty directory `splitPath` answers with.
 */
function directoryOf(target: Target): string {
  if (!target) return ''
  return target.kind === 'directory' ? target.path : splitPath(target.path).directory
}

export function FileTreeMenu({
  target,
  drafts,
  children
}: {
  target: Target
  drafts: TreeDrafts
  children: React.ReactNode
}) {
  const t = useT()
  const movable = target !== null && target.kind !== 'link'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => drafts.startNew('file', directoryOf(target))}
        >
          <FilePlus2 data-icon="inline-start" />
          {t('file.newFile')}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => drafts.startNew('folder', directoryOf(target))}
        >
          <FolderPlus data-icon="inline-start" />
          {t('file.newFolder')}
        </ContextMenuItem>
        {target ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => drafts.copyPath(target.path)}>
              <Copy data-icon="inline-start" />
              {t('file.copyPath')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void drafts.reveal(target.path)}>
              <FolderOpen data-icon="inline-start" />
              {t('file.openFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!movable}
              onSelect={() => {
                if (movable) drafts.startRename(target.path)
              }}
            >
              <PenLine data-icon="inline-start" />
              {t('file.rename')}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!movable}
              onSelect={() => {
                if (movable) drafts.moveToTrash(target.path)
              }}
            >
              <Trash2 data-icon="inline-start" />
              {t('file.moveToTrash')}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

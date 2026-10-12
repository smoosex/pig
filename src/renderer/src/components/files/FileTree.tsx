/**
 * The file column: one worktree's files, read one level at a time as the reader opens them. A directory
 * opens in place, a file opens — or comes back to — its own tab, and the file a tab is showing is marked
 * here so the column and the strip agree about what is being read.
 *
 * Rows carry the rail's hover markers, so the sidebar's single sliding highlight follows the pointer
 * through them like it does through every other list in that column. What git ignores is dimmed, and the
 * footer's toggle hides those rows outright, which is what makes a directory like `node_modules` bearable
 * without hiding the fact that it is there.
 *
 * Right-clicking a row — or the space below the last one — offers what the tree can be asked to do to it.
 * A new entry and a rename both become a row with a field in it, so the name is typed where the thing
 * will be rather than in a box over it; the rows below are the tree's own, the field included.
 */
import { useEffect, useMemo } from 'react'
import { ChevronRight, Eye, EyeOff, File, Folder, FolderOpen } from 'lucide-react'
import { watchWorktreeFiles, useFilesStore } from '../../stores/files'
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { FileTypeIcon } from './FileTypeIcon'
import { FileTreeMenu } from './FileTreeMenu'
import { TreeNameField } from './TreeNameField'
import { useTreeDrafts } from './useTreeDrafts'
import { treeRows } from './tree-rows'

export function FileTree({ cwd }: { cwd: string }) {
  const t = useT()
  const trees = useFilesStore((state) => state.trees[cwd])
  const expanded = useFilesStore((state) => state.expanded[cwd])
  const hideIgnored = useFilesStore((state) => state.hideIgnored)
  const loadDirectory = useFilesStore((state) => state.loadDirectory)
  const toggleDirectory = useFilesStore((state) => state.toggleDirectory)
  const setHideIgnored = useFilesStore((state) => state.setHideIgnored)
  const openFileTab = useSessionsStore((state) => state.openFileTab)
  const drafts = useTreeDrafts(cwd)
  const shownPath = useSessionsStore((state) => {
    const tab = state.openTabs.find((item) => item.id === state.activeTabId)
    return tab?.kind === 'file' && tab.cwd === cwd ? tab.path ?? null : null
  })

  useEffect(() => {
    watchWorktreeFiles()
    void loadDirectory(cwd, '')
  }, [cwd, loadDirectory])

  // A new entry is made inside a level that has to be open for its field to be on screen at all.
  const draft = drafts.draft
  useEffect(() => {
    if (draft?.kind !== 'rename' && draft?.directory) useFilesStore.getState().ensureDirectory(cwd, draft.directory)
  }, [cwd, draft])

  const rows = useMemo(
    () => treeRows(trees ?? {}, expanded ?? {}, hideIgnored, draft),
    [trees, expanded, hideIgnored, draft]
  )
  const root = trees?.['']
  const notice = root?.status === 'error'
    ? root.error
    : root?.status === 'loading'
      ? t('file.loading')
      : rows.length === 0
        ? t('file.emptyTree')
        : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-h-full flex-col gap-0.5 px-1">
          {notice && !draft ? <p className="px-3 py-2 text-xs text-muted-foreground">{notice}</p> : null}
          {rows.map(({ entry, depth, draft: naming }) => {
            const open = entry.kind === 'directory' && expanded?.[entry.path] === true
            if (naming) {
              return (
                <TreeNameField
                  key={`naming\u0000${naming}\u0000${entry.path}`}
                  depth={depth}
                  // A rename keeps the kind of the row it is naming; a new entry is what was asked for.
                  directory={entry.kind === 'directory'}
                  initial={naming === 'rename' ? entry.name : ''}
                  path={entry.path || undefined}
                  onCommit={drafts.commit}
                  onCancel={drafts.cancel}
                />
              )
            }
            return (
              <FileTreeMenu key={entry.path} target={entry} drafts={drafts}>
                <button
                  type="button"
                  data-sidebar-hover-row
                  title={entry.path}
                  // The indent is the row's own, not a nested container's: a row has to keep the column's
                  // full width for the hover background to reach both edges.
                  style={{ paddingInlineStart: `${4 + depth * 12}px` }}
                  onClick={() =>
                    entry.kind === 'directory'
                      ? toggleDirectory(cwd, entry.path)
                      : void openFileTab(cwd, entry.path)
                  }
                  className={cn(
                    'relative flex w-full items-center gap-1.5 rounded-sm py-1 pr-1 text-left text-xs',
                    entry.ignored && 'text-muted-foreground',
                    shownPath === entry.path && 'bg-sidebar-accent text-sidebar-accent-foreground'
                  )}
                >
                  {entry.kind === 'directory' ? (
                    <ChevronRight
                      className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
                    />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  {entry.kind === 'directory' ? (
                    open ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      : <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileTypeIcon path={entry.path} className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
              </FileTreeMenu>
            )
          })}
          {/*
           * The space left over answers for the worktree itself, so a file or folder can be made at the
           * root without having to right-click a folder first. It is a row's sibling rather than its
           * wrapper: two context menus nested would both open on the same click.
           */}
          <FileTreeMenu target={null} drafts={drafts}>
            <div className="min-h-8 flex-1" />
          </FileTreeMenu>
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 px-3 pt-1.5 pb-2">
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={t('panel.newFileAria')}
          onClick={() => drafts.startNew('file', '')}
        >
          <File />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-pressed={hideIgnored}
          aria-label={hideIgnored ? t('file.showIgnored') : t('file.hideIgnored')}
          onClick={() => setHideIgnored(!hideIgnored)}
        >
          {hideIgnored ? <EyeOff /> : <Eye />}
        </Button>
      </footer>
    </div>
  )
}

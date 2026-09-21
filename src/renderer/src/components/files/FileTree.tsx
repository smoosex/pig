/**
 * The file column: one worktree's files, read one level at a time as the reader opens them. A directory
 * opens in place, a file opens — or comes back to — its own tab, and the file a tab is showing is marked
 * here so the column and the strip agree about what is being read.
 *
 * Rows carry the rail's hover markers, so the sidebar's single sliding highlight follows the pointer
 * through them like it does through every other list in that column. What git ignores is dimmed, and the
 * footer's toggle hides those rows outright, which is what makes a directory like `node_modules` bearable
 * without hiding the fact that it is there.
 */
import { useEffect, useMemo } from 'react'
import { ChevronRight, Eye, EyeOff, Folder, FolderOpen } from 'lucide-react'
import { watchWorktreeFiles, useFilesStore } from '../../stores/files'
import { useSessionsStore } from '../../stores/sessions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { fileIcon } from '../diff/file-entry'
import { treeRows } from './tree-rows'

export function FileTree({ cwd }: { cwd: string }) {
  const trees = useFilesStore((state) => state.trees[cwd])
  const expanded = useFilesStore((state) => state.expanded[cwd])
  const hideIgnored = useFilesStore((state) => state.hideIgnored)
  const loadDirectory = useFilesStore((state) => state.loadDirectory)
  const toggleDirectory = useFilesStore((state) => state.toggleDirectory)
  const setHideIgnored = useFilesStore((state) => state.setHideIgnored)
  const openFileTab = useSessionsStore((state) => state.openFileTab)
  const shownPath = useSessionsStore((state) => {
    const tab = state.openTabs.find((item) => item.id === state.activeTabId)
    return tab?.kind === 'file' && tab.cwd === cwd ? tab.path ?? null : null
  })

  useEffect(() => {
    watchWorktreeFiles()
    void loadDirectory(cwd, '')
  }, [cwd, loadDirectory])

  const rows = useMemo(
    () => treeRows(trees ?? {}, expanded ?? {}, hideIgnored),
    [trees, expanded, hideIgnored]
  )
  const root = trees?.['']
  const notice = root?.status === 'error'
    ? root.error
    : root?.status === 'loading'
      ? '正在读取文件…'
      : rows.length === 0
        ? '这个工作区是空的'
        : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {notice ? <p className="px-3 py-2 text-xs text-muted-foreground">{notice}</p> : null}
        <div className="flex flex-col gap-0.5 px-1">
          {rows.map(({ entry, depth }) => {
            const open = entry.kind === 'directory' && expanded?.[entry.path] === true
            const Icon = entry.kind === 'directory'
              ? open ? FolderOpen : Folder
              : fileIcon(entry.path)
            return (
              <button
                key={entry.path}
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
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 px-3 pt-1.5 pb-2">
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-pressed={hideIgnored}
          aria-label={hideIgnored ? '显示 Git 忽略的文件' : '隐藏 Git 忽略的文件'}
          onClick={() => setHideIgnored(!hideIgnored)}
        >
          {hideIgnored ? <EyeOff /> : <Eye />}
        </Button>
      </footer>
    </div>
  )
}

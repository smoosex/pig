/**
 * The file column: one worktree's files, read one level at a time as the reader opens them. A directory
 * opens in place, a file opens — or comes back to — its own tab, and the file a tab is showing is marked
 * here so the column and the strip agree about what is being read.
 *
 * What git ignores is dimmed, and the toolbar's toggle hides those rows outright, which makes a directory
 * like `node_modules` bearable without hiding the fact that it is there.
 *
 * Right-clicking a row — or the space below the last one — offers what the tree can be asked to do to it.
 * A new entry and a rename both become a row with a field in it, so the name is typed where the thing
 * will be rather than in a box over it; the rows below are the tree's own, the field included.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { ChevronRight, ChevronsDownUp, Crosshair, Eye, EyeOff, Folder, FolderOpen } from 'lucide-react'
import { watchWorktreeFiles, useFilesStore } from '../../stores/files'
import { useSessionsStore } from '../../stores/sessions'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { sidebarRowSurface, sidebarSurfaceToggle } from '../sidebar/sidebar-surface'
import { SidebarHoverHighlight } from '../sidebar/SidebarHoverHighlight'
import { FileTypeIcon } from './FileTypeIcon'
import { FileTreeMenu } from './FileTreeMenu'
import { TreeNameField } from './TreeNameField'
import { useTreeDrafts } from './useTreeDrafts'
import { treeRows, type TreeRow } from './tree-rows'
import { useFileFilter } from './useFileFilter'
import { WorkspaceFilter } from '../panel/WorkspaceFilter'
import { fileDragProps } from '../composer/file-drag'

export function FileTree({ cwd }: { cwd: string }) {
  const t = useT()
  const reduced = useReducedMotion()
  const [query, setQuery] = useState('')
  const [locate, setLocate] = useState<string | null>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const trees = useFilesStore((state) => state.trees[cwd])
  const expanded = useFilesStore((state) => state.expanded[cwd])
  const hideIgnored = useFilesStore((state) => state.hideIgnored)
  const loadDirectory = useFilesStore((state) => state.loadDirectory)
  const toggleDirectory = useFilesStore((state) => state.toggleDirectory)
  const setHideIgnored = useFilesStore((state) => state.setHideIgnored)
  const collapseDirectories = useFilesStore(state => state.collapseDirectories)
  const filter = useFileFilter(cwd, query, hideIgnored, trees)
  const filtering = !!query.trim()
  const openFileTab = useSessionsStore((state) => state.openFileTab)
  const drafts = useTreeDrafts(cwd)
  const shownPath = useSessionsStore((state) => {
    const tab = state.openTabs.find((item) => item.id === state.activeTabId)
    return tab?.kind === 'file' && tab.cwd === cwd ? tab.path ?? null : null
  })

  useEffect(() => {
    watchWorktreeFiles()
    setQuery(''); setLocate(null)
    void loadDirectory(cwd, '')
  }, [cwd, loadDirectory])

  // Search hits may have no loaded ancestors; naming must reveal the parent chain too.
  const draft = drafts.draft
  useEffect(() => {
    if (!draft) return
    const directory = draft.kind === 'rename' ? draft.path.split('/').slice(0, -1).join('/') : draft.directory
    if (directory) useFilesStore.getState().ensureDirectory(cwd, directory)
    setQuery('')
  }, [cwd, draft])

  const tree = useMemo(
    () => treeRows(trees ?? {}, expanded ?? {}, hideIgnored, draft),
    [trees, expanded, hideIgnored, draft]
  )
  const rows: TreeRow[] = filtering ? filter.entries.map(entry => ({ entry, depth: 0 })) : tree
  useEffect(() => {
    if (!locate || filtering) return
    if (locate !== shownPath) { setLocate(null); return }
    if (hideIgnored && Object.values(trees ?? {}).some(level => level.entries?.some(entry => entry.ignored && (locate === entry.path || locate.startsWith(entry.path + '/'))))) {
      setHideIgnored(false)
      return
    }
    const row = [...(scrollArea.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])].find(element => element.dataset.filePath === locate)
    if (row) { row.scrollIntoView({ block: 'nearest', behavior: reduced ? 'instant' : 'smooth' }); setLocate(null) }
  }, [locate, shownPath, filtering, trees, expanded, hideIgnored, setHideIgnored, reduced])
  const root = trees?.['']
  const notice = filtering ? (filter.error ?? (filter.loading ? t('file.searching') : rows.length === 0 ? t('file.noMatch') : null)) : root?.status === 'error'
    ? root.error
    : root?.status === 'loading'
      ? t('file.loading')
      : rows.length === 0
        ? t('file.emptyTree')
        : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceFilter label={t('panel.filterFiles')} value={query} onChange={setQuery} disabled={!!draft}>
        <Button variant="ghost" size="icon-xs" className={cn('shrink-0 text-muted-foreground', sidebarSurfaceToggle)} aria-pressed={hideIgnored}
          aria-label={hideIgnored ? t('file.showIgnored') : t('file.hideIgnored')} title={hideIgnored ? t('file.showIgnored') : t('file.hideIgnored')} onClick={() => setHideIgnored(!hideIgnored)}>
          {hideIgnored ? <EyeOff /> : <Eye />}
        </Button>
        <Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" disabled={!shownPath || !!draft} aria-label={t('file.locateCurrent')} title={t('file.locateCurrent')}
          onClick={() => { if (!shownPath) return; setQuery(''); useFilesStore.getState().ensureDirectory(cwd, shownPath.split('/').slice(0, -1).join('/')); setLocate(shownPath) }}><Crosshair /></Button>
        <Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" disabled={!!draft} aria-label={t('file.collapseAll')} title={t('file.collapseAll')}
          onClick={() => { setQuery(''); setLocate(null); collapseDirectories(cwd) }}><ChevronsDownUp /></Button>
      </WorkspaceFilter>
      <div ref={scrollArea} className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SidebarHoverHighlight className="flex min-h-full flex-col gap-0.5 px-1">
          {notice && !draft ? <p role={filtering && filter.error ? 'alert' : undefined} className="px-3 py-2 text-xs text-muted-foreground">{notice}</p> : null}
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
                  data-sidebar-selected={shownPath === entry.path || undefined}
                  title={entry.path}
                  data-file-path={entry.path}
                  {...fileDragProps({ cwd, path: entry.path, isDirectory: entry.kind === 'directory' })}
                  // The indent is the row's own, not a nested container's: a row has to keep the column's
                  // full width for the hover background to reach both edges.
                  style={{ paddingInlineStart: `${4 + depth * 12}px` }}
                  onClick={() =>
                    entry.kind === 'directory'
                      ? filtering ? (setQuery(''), useFilesStore.getState().ensureDirectory(cwd, entry.path)) : toggleDirectory(cwd, entry.path)
                      : void openFileTab(cwd, entry.path)
                  }
                  className={cn(
                    'relative flex w-full items-center gap-1.5 rounded-sm py-1 pr-1 text-left text-xs',
                    sidebarRowSurface(shownPath === entry.path),
                    entry.ignored && 'text-muted-foreground',
                    shownPath === entry.path && 'text-sidebar-accent-foreground'
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
                  <span className="truncate">{filtering ? entry.path : entry.name}</span>
                </button>
              </FileTreeMenu>
            )
          })}
          {filtering && filter.truncated ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t('file.searchTruncated')}</p> : null}
          {/*
           * The space left over answers for the worktree itself, so a file or folder can be made at the
           * root without having to right-click a folder first. It is a row's sibling rather than its
           * wrapper: two context menus nested would both open on the same click.
           */}
          <FileTreeMenu target={null} drafts={drafts}>
            <div className="min-h-8 flex-1" />
          </FileTreeMenu>
        </SidebarHoverHighlight>
      </div>

    </div>
  )
}

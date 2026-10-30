import { useState, type ReactNode } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff, Files, SquareArrowOutUpRight } from 'lucide-react'
import { Virtualizer } from '@pierre/diffs/react'
import { baseName } from '../../../../shared/paths'
import type { FileChangeSummary } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { useSessionFileChanges, useTurnFileChanges, type TurnFileChangesState } from '../../stores/file-changes'
import { useSessionsStore } from '../../stores/sessions'
import { FileOperationDiffs } from '../diff/FileOperationDiffs'
import { FileTypeIcon } from '../files/FileTypeIcon'
import { glassCodeSurface } from '../HighlightedCode'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

type Counts = Pick<FileChangeSummary, 'added' | 'removed' | 'unknownOperations'>

/** Counts only when every operation had a diff to count: a partial sum would read as the whole change. */
export function FileChangeCounts({ file, className }: { file: Counts; className?: string }) {
  if (file.unknownOperations > 0 || (!file.added && !file.removed)) return null
  return (
    <span className={cn('flex shrink-0 gap-1.5 tabular-nums', className)}>
      {file.added ? <span className="text-success">+{file.added}</span> : null}
      {file.removed ? <span className="text-destructive">−{file.removed}</span> : null}
    </span>
  )
}

export function totalChanges(files: Counts[]): Counts {
  return files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed, unknownOperations: sum.unknownOperations + file.unknownOperations }),
    { added: 0, removed: 0, unknownOperations: 0 }
  )
}

function IconBox({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/6 text-muted-foreground [&_svg]:size-3.5">
      {children}
    </span>
  )
}

/**
 * The files a finished turn's edit/write calls changed, as the session recorded them. The header opens
 * the whole turn in a diff pane beside the conversation; each row unfolds its own diff in place. The
 * operations are only read once a row is unfolded.
 */
export function TurnFileChanges({ sessionId, turnId }: { sessionId: string; turnId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const files = useSessionFileChanges(sessionId)?.summary?.turns[turnId]
  const single = files?.length === 1 ? files[0]! : null
  const details = useTurnFileChanges(sessionId, turnId, expanded.size > 0 || (single !== null && open))
  const projectCwd = useSessionsStore((state) => {
    const tab = state.openTabs.find((item) => item.id === sessionId)
    return tab?.kind === 'project' ? tab.cwd : null
  })
  if (!files?.length) return null
  const singleShown = single ? single.relativePath ?? single.path : null
  const title = singleShown ? baseName(singleShown) : t('turnChanges.title', { n: files.length })
  const allExpanded = files.every((file) => expanded.has(file.path))
  const toggle = (path: string) => setExpanded((current) => {
    const next = new Set(current)
    if (!next.delete(path)) next.add(path)
    return next
  })

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-4 rounded-xl border border-glass-card-border bg-glass-composer-background/60 shadow-glass-card-edge solid:border-border solid:bg-card solid:shadow-none">
      <div className="group/row relative flex h-12 items-center gap-2.5 px-2.5 text-xs">
        <CollapsibleTrigger asChild>
          <button type="button" aria-label={singleShown ?? title} title={singleShown ?? undefined} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
        </CollapsibleTrigger>
        <IconBox>{singleShown ? <FileTypeIcon path={singleShown} className="size-3.5" /> : <Files />}</IconBox>
        <span className="pointer-events-none min-w-0 flex-1 truncate">{title}</span>
        {single ? <OpenFileButton file={single} cwd={projectCwd} /> : null}
        <FileChangeCounts file={totalChanges(files)} className="pointer-events-none" />
        {open && !single ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="relative text-muted-foreground"
            aria-label={t(allExpanded ? 'turnChanges.collapseAll' : 'turnChanges.expandAll')}
            title={t(allExpanded ? 'turnChanges.collapseAll' : 'turnChanges.expandAll')}
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(files.map((file) => file.path)))}
          >
            {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="relative rounded-full"
          onClick={() => void useSessionsStore.getState().openTurnDiffTab(sessionId, turnId)}
        >
          <FileDiff data-icon="inline-start" />
          {t('turnChanges.openDiff')}
        </Button>
        <ChevronRight className={cn('pointer-events-none size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </div>
      <CollapsibleContent>
        {single && singleShown ? (
          // One file needs no list: the card is that file's row.
          <div className="px-2.5 pb-2.5"><InlineFileDiff path={single.path} shown={singleShown} details={details} /></div>
        ) : (
          <ul className="flex flex-col px-1.5 pb-1.5">
            {files.map((file) => (
              <TurnFileRow
                key={file.path}
                file={file}
                cwd={projectCwd}
                expanded={expanded.has(file.path)}
                details={details}
                onToggle={() => toggle(file.path)}
              />
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function TurnFileRow({ file, cwd, expanded, details, onToggle }: {
  file: FileChangeSummary
  /** The project worktree the file can be opened from; null in chats or for paths outside it. */
  cwd: string | null
  expanded: boolean
  details: TurnFileChangesState
  onToggle: () => void
}) {
  const shown = file.relativePath ?? file.path
  return (
    <li className="not-first:border-t not-first:border-glass-card-border/60 solid:not-first:border-border/60">
      <div className="group/row relative flex h-11 items-center gap-2.5 rounded-lg px-1 text-xs hover:bg-foreground/5">
        <button type="button" aria-expanded={expanded} aria-label={shown} title={shown} onClick={onToggle} className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
        <IconBox><FileTypeIcon path={shown} className="size-3.5" /></IconBox>
        <span className="pointer-events-none min-w-0 flex-1 truncate">{baseName(shown)}</span>
        <OpenFileButton file={file} cwd={cwd} />
        <FileChangeCounts file={file} className="pointer-events-none" />
        <ChevronRight className={cn('pointer-events-none size-4 shrink-0 text-muted-foreground opacity-0 transition-transform group-hover/row:opacity-100', expanded && 'rotate-90 opacity-100')} />
      </div>
      {expanded ? <div className="px-1 pt-1 pb-2"><InlineFileDiff path={file.path} shown={shown} details={details} /></div> : null}
    </li>
  )
}

/** Shown on row hover; only a project file has a tab to open. */
function OpenFileButton({ file, cwd }: { file: FileChangeSummary; cwd: string | null }) {
  const t = useT()
  if (cwd === null || file.relativePath === null) return null
  const path = file.relativePath
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="relative text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      aria-label={t('turnChanges.openFile')}
      title={t('turnChanges.openFile')}
      onClick={() => void useSessionsStore.getState().openFileTab(cwd, path)}
    >
      <SquareArrowOutUpRight />
    </Button>
  )
}

function InlineFileDiff({ path, shown, details }: { path: string; shown: string; details: TurnFileChangesState }) {
  const t = useT()
  if (details.status === 'loading') return <p className="px-2 text-xs text-muted-foreground">{t('turnChanges.loading')}</p>
  if (details.status === 'error') return <p role="alert" className="px-2 text-xs text-destructive">{details.message}</p>
  const file = details.files.find((item) => item.path === path)
  if (!file) return <p className="px-2 text-xs text-muted-foreground">{t('turnChanges.notOnBranch')}</p>
  return (
    <div className={cn('glass-code-surface overflow-hidden [--diffs-gap-block:0px]', glassCodeSurface)}>
      <Virtualizer className="max-h-80 overflow-auto">
        <FileOperationDiffs path={shown} operations={file.operations} />
      </Virtualizer>
    </div>
  )
}

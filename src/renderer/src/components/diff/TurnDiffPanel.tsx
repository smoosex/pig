import { useState } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, Rows3 } from 'lucide-react'
import type { TurnFileChange } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { useDiffStore } from '../../stores/diff'
import { useTurnFileChanges } from '../../stores/file-changes'
import type { OpenTab } from '../../stores/sessions/types'
import { FileTypeIcon } from '../files/FileTypeIcon'
import { FileChangeCounts } from '../turn/TurnFileChanges'
import { Button } from '../ui/button'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { splitPath } from './file-entry'
import { FileOperationDiffs } from './FileOperationDiffs'

/**
 * Every file one turn changed, laid out like the changes tab — toolbar, one collapsible card per file,
 * the same unified/split preference — but read from the session's records instead of Git. The read
 * follows the source session's branch tip, so a pane never shows another branch's turn. Bodies do not
 * follow lines into the file tab: a recorded line number belongs to the file as it was then.
 */
export function TurnDiffPanel({ tab }: { tab: OpenTab }) {
  const t = useT()
  const target = tab.turnDiff!
  const state = useTurnFileChanges(target.sessionId, target.turnId, true)
  const files = state.status === 'ready' ? state.files : []
  const diffStyle = useDiffStore((s) => s.diffStyle)
  const setDiffStyle = useDiffStore((s) => s.setDiffStyle)
  // Paths folded by hand; a turn holds few files, so they start open.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const anyExpanded = files.some((file) => !folded.has(file.path))

  return (
    <div className="glass-code-surface flex min-h-0 flex-1 flex-col [--diffs-gap-block:0px]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-glass-border pl-3 pr-2 solid:border-border">
        <span className="text-xs font-medium">{t('turnChanges.tabTitle')}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{t('diff.changeCount', { count: files.length })}</span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={anyExpanded ? t('diff.collapseAll') : t('diff.expandAll')}
          disabled={!files.length}
          onClick={() => setFolded(anyExpanded ? new Set(files.map((file) => file.path)) : new Set())}
        >
          {anyExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0.5}
          size="xs"
          value={diffStyle}
          onValueChange={(value) => value && setDiffStyle(value as 'unified' | 'split')}
          aria-label={t('diff.layout')}
        >
          <ToggleGroupItem value="unified" aria-label={t('diff.unified')}>
            <Rows3 />
          </ToggleGroupItem>
          <ToggleGroupItem value="split" aria-label={t('diff.sideBySide')}>
            <Columns2 />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-transparent p-3 solid:bg-chat-background',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        )}
      >
        {state.status === 'loading' ? (
          <Notice>{t('turnChanges.loading')}</Notice>
        ) : state.status === 'error' ? (
          <Notice>{state.message}</Notice>
        ) : !files.length ? (
          <Notice>{t('turnChanges.notOnBranch')}</Notice>
        ) : (
          files.map((file) => (
            <FileCard
              key={file.path}
              file={file}
              open={!folded.has(file.path)}
              onToggle={() => setFolded((current) => {
                const next = new Set(current)
                if (!next.delete(file.path)) next.add(file.path)
                return next
              })}
            />
          ))
        )}
      </div>
    </div>
  )
}

function FileCard({ file, open, onToggle }: { file: TurnFileChange; open: boolean; onToggle: () => void }) {
  const diffStyle = useDiffStore((s) => s.diffStyle)
  const shown = file.relativePath ?? file.path
  const { name, directory } = splitPath(shown)
  return (
    <section className="shrink-0 overflow-hidden rounded-lg [clip-path:inset(0_round_var(--radius-lg))] border border-glass-border bg-glass-composer-background/60 shadow-sm transition-[background-color,border-color] duration-200 ease-in-out motion-reduce:transition-none solid:border-border solid:bg-popover">
      <button
        type="button"
        title={shown}
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent/60"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <FileTypeIcon path={shown} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 truncate font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="rtl">
          {directory}
        </span>
        <FileChangeCounts file={file} />
      </button>
      {open ? (
        <div className="border-t border-glass-border text-xs solid:border-border">
          <FileOperationDiffs path={shown} operations={file.operations} style={diffStyle} />
        </div>
      ) : null}
    </section>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="px-1 py-2 text-xs text-muted-foreground">{children}</div>
}

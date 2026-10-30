import { useMemo } from 'react'
import { getSingularPatch, type FileDiffMetadata } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import type { FileChangeOperation } from '../../ipc/api'
import type { DiffStyle } from '../../stores/diff'
import { useT } from '../../hooks/useT'
import { useDarkMode } from '../../lib/useDarkMode'
import { cn } from '../../lib/utils'
import { FileChangeCounts } from '../turn/TurnFileChanges'
import { fileDiffOptions } from './diff-options'

function parsePatch(patch: string): FileDiffMetadata | null {
  try {
    return getSingularPatch(patch)
  } catch {
    return null
  }
}

/**
 * One file's recorded operations in one turn, each its own diff in the order the session holds them:
 * they are history, so nothing here reads the file as it is now or asks Git. Callers supply the
 * scroll container (and its Virtualizer).
 */
export function FileOperationDiffs({ path, operations, style = 'unified' }: { path: string; operations: FileChangeOperation[]; style?: DiffStyle }) {
  return operations.map((operation, index) => (
    <OperationDiff key={operation.id} path={path} operation={operation} index={index} count={operations.length} style={style} />
  ))
}

function OperationDiff({ path, operation, index, count, style }: { path: string; operation: FileChangeOperation; index: number; count: number; style: DiffStyle }) {
  const t = useT()
  const dark = useDarkMode()
  const options = useMemo(() => fileDiffOptions(dark, style), [dark, style])
  const fileDiff = useMemo(() => {
    const parsed = operation.patch ? parsePatch(operation.patch) : null
    return parsed ? { ...parsed, name: path } : null
  }, [operation.patch, path])

  return (
    <section>
      {count > 1 ? (
        <div className={cn(index > 0 && 'border-t', 'flex items-center gap-2 border-b border-glass-card-border px-3 py-1.5 font-mono text-xs text-muted-foreground solid:border-code-border')}>
          <span>{t('turnChanges.operation', { n: index + 1, total: count, tool: operation.tool })}</span>
          <FileChangeCounts file={{ ...operation, unknownOperations: Number(operation.unknown) }} className="ml-auto" />
        </div>
      ) : null}
      {fileDiff ? (
        <FileDiff fileDiff={fileDiff} options={options} />
      ) : operation.patch ?? operation.diff ? (
        // A patch the parser rejects and the old numbered display diff are still the recorded change.
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs whitespace-pre text-code-foreground">{operation.patch ?? operation.diff}</pre>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t(operation.tool === 'write' ? 'turnChanges.writeUnavailable' : 'turnChanges.unavailable')}
        </p>
      )}
    </section>
  )
}

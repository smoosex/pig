/** Known line totals stay visible even when some files cannot contribute counts. */
import type { DiffFileEntry } from '../../ipc/api'
import { sumCounts } from './file-entry'

export function DiffCounts({ entries }: { entries: DiffFileEntry[] }) {
  const counts = sumCounts(entries)
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
      <span className="text-success">+{counts.additions}</span>
      <span className="text-destructive">-{counts.deletions}</span>
    </span>
  )
}

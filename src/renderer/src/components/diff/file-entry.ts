/**
 * Presentation shared by the review panel and a diff tab: the status letter and path split have to
 * look the same in both, so they live here instead of in either component.
 */
import type { MessageKey } from '../../../../shared/i18n'
import type { DiffFileEntry, DiffFileStatus } from '../../ipc/api'

export const STATUS_META: Record<
  DiffFileStatus,
  { letter: string; className: string; labelKey: MessageKey }
> = {
  added: { letter: 'A', className: 'text-success', labelKey: 'diff.statusAdded' },
  modified: { letter: 'M', className: 'text-warning', labelKey: 'diff.statusModified' },
  deleted: { letter: 'D', className: 'text-destructive', labelKey: 'diff.statusDeleted' },
  renamed: { letter: 'R', className: 'text-info', labelKey: 'diff.statusRenamed' },
  untracked: { letter: 'U', className: 'text-muted-foreground', labelKey: 'diff.statusUntracked' },
  conflicted: { letter: '!', className: 'text-destructive', labelKey: 'diff.statusConflicted' }
}

export function splitPath(path: string): { name: string; directory: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1
    ? { name: path, directory: '' }
    : { name: path.slice(cut + 1), directory: path.slice(0, cut) }
}

/** Line totals for a group header, where a count can be unknown for binary files. */
export function sumCounts(entries: DiffFileEntry[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const entry of entries) {
    additions += entry.additions ?? 0
    deletions += entry.deletions ?? 0
  }
  return { additions, deletions }
}

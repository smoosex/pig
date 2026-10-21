/** The icon that identifies a tab's kind, shared by the tab strip and split pane headers. */
import { FileDiff, Globe, SquareDashedText, SquareTerminal } from 'lucide-react'
import type { OpenTab } from '../stores/sessions'
import { FileTypeIcon } from './files/FileTypeIcon'
import { cn } from '../lib/utils'

export function TabKindIcon({ kind, path, className }: { kind: OpenTab['kind']; path?: string; className?: string }) {
  const classes = cn('size-3.5 shrink-0', className)
  if (kind === 'file') return <FileTypeIcon path={path ?? ''} className={classes} />
  const Icon = kind === 'browser' ? Globe : kind === 'terminal' ? SquareTerminal : kind === 'diff' ? FileDiff : SquareDashedText
  return <Icon className={classes} aria-hidden />
}

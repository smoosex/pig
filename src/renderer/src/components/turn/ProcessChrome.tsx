import type { ReactNode } from 'react'
import { Brain, ChevronRight, FileText, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react'
import { cn, hideScroll } from '../../lib/utils'
import type { IconKind } from './process-model'

export const pre = `mt-2 max-h-60 overflow-auto font-mono text-xs leading-snug break-words whitespace-pre-wrap ${hideScroll}`
export const statusMarker = 'pointer-events-none h-7 min-w-0 gap-1.5 px-1 text-xs font-normal'
export const disclosureButton =
  'h-7 w-full min-w-0 justify-start gap-1.5 rounded-md px-1 text-xs font-normal text-muted-foreground aria-expanded:bg-transparent hover:aria-expanded:bg-muted dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-muted'

export function VerbLabel({ text, failed, active }: { text: string; failed?: boolean; active?: boolean }) {
  return (
    <span className={cn('min-w-0 flex-1 truncate text-left', failed && 'text-destructive')}>
      <span className={cn(!failed && 'text-foreground')}>{text.slice(0, 2)}</span>
      <span className={cn(active && !failed && 'shimmer')}>{text.slice(2)}</span>
    </span>
  )
}

export function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')} />
}

const ICONS: Record<IconKind, LucideIcon> = {
  thinking: Brain,
  bash: SquareTerminal,
  file: FileText,
  tool: Wrench
}

export function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute inset-y-0 left-3.5 w-px -translate-x-1/2 bg-border" />
      <div className="min-w-0 py-1 pl-6">{children}</div>
    </div>
  )
}

export function StackedIcons({ kinds }: { kinds: IconKind[] }) {
  return (
    <span className="flex shrink-0 items-center">
      {kinds.map((kind, i) => {
        const Icon = ICONS[kind]
        return (
          <span
            key={`${kind}-${i}`}
            className={cn(
              'relative flex size-5 items-center justify-center rounded-full border border-border bg-card',
              i > 0 && '-ml-1.5'
            )}
            style={{ zIndex: i }}
          >
            <Icon className="size-2.5" />
          </span>
        )
      })}
    </span>
  )
}

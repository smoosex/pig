import { useEffect, useState } from 'react'
import { Paperclip } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import type { ComposerDragKind } from './file-drag'

/**
 * Stacked top tray that slides out from behind the composer's top edge while draggable files, tabs,
 * or text hover over the input box. Clipped at `bottom-full` so translucent composer surfaces never
 * show a doubled layer underneath.
 */
export function ComposerDropHint({ kind }: { kind: ComposerDragKind | null }) {
  const t = useT()
  const [renderedKind, setRenderedKind] = useState<ComposerDragKind | null>(kind)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (kind) {
      setRenderedKind(kind)
      setLeaving(false)
      return
    }
    if (!renderedKind) return
    setLeaving(true)
    const timeout = window.setTimeout(() => {
      setRenderedKind(null)
      setLeaving(false)
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [kind, renderedKind])

  if (!renderedKind) return null

  const label =
    renderedKind === 'tab'
      ? t('composer.dropTabHint')
      : renderedKind === 'text'
        ? t('composer.dropTextHint')
        : t('composer.dropFilesHint')

  return (
    <div
      data-composer-drop-hint={renderedKind}
      aria-hidden={leaving || undefined}
      className="pointer-events-none absolute inset-x-0 bottom-full z-0 overflow-hidden px-3 pt-1"
    >
      <div
        className={cn(
          'flex h-7.5 items-center gap-1.5 rounded-t-xl border border-b-0 border-primary/30 bg-glass-popover-background bg-[linear-gradient(0deg,color-mix(in_srgb,var(--primary)_10%,transparent),color-mix(in_srgb,var(--primary)_10%,transparent))] px-3 text-xs font-medium text-primary solid:bg-popover',
          leaving ? 'composer-drop-hint-exit' : 'composer-drop-hint-enter'
        )}
      >
        <Paperclip className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
    </div>
  )
}

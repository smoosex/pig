/**
 * A compaction is a session landmark rather than work: the model's visible context was summarized,
 * so everything before it stops counting towards the window. It is rendered outside the collapsed
 * work block, keeping the summary one click away.
 */
import { useState } from 'react'
import { Archive } from 'lucide-react'
import type { CompactionItem } from '../../chat/turns'
import { useT } from '../../hooks/useT'
import { formatTokens } from '../../lib/format'
import { cn, hideScroll } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Marker, MarkerContent } from '../ui/marker'
import { MarkdownText } from '../MarkdownText'
import { Chevron } from './ProcessChrome'

export function CompactionNotice({ item }: { item: CompactionItem }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <Marker variant="separator" asChild>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 justify-center gap-2 rounded-none px-0 text-xs font-normal text-muted-foreground before:min-w-4 after:min-w-4 hover:bg-transparent hover:text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-transparent dark:hover:bg-transparent dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-transparent"
          >
            <MarkerContent className="flex shrink-0 items-center gap-1.5">
              <Archive className="size-3.5" />
              <span>{t('chat.compacted')}</span>
              <span className="text-muted-foreground/70">
                {t('chat.compactedFrom', { tokens: formatTokens(item.tokensBefore) })}
              </span>
              <Chevron open={open} />
            </MarkerContent>
          </Button>
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent className="duration-300">
        <div className={cn('mt-2 max-h-80 overflow-auto', hideScroll)}>
          <MarkdownText className="text-xs text-muted-foreground" text={item.text} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

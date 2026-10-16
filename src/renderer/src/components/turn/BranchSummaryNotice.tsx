/** Review handoffs are conversation notes, independent of the turn's collapsed work. */
import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Marker, MarkerContent } from '../ui/marker'
import { MarkdownText } from '../MarkdownText'
import { Chevron } from './ProcessChrome'

export function BranchSummaryNotice({ text }: { text: string }) {
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
            className="h-7 justify-center gap-2 rounded-none px-0 text-xs font-normal text-muted-foreground before:min-w-4 after:min-w-4 hover:bg-transparent hover:text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:aria-expanded:bg-transparent dark:hover:bg-transparent dark:aria-expanded:bg-transparent dark:hover:aria-expanded:bg-transparent solid:hover:bg-transparent solid:hover:text-muted-foreground solid:aria-expanded:bg-transparent solid:aria-expanded:text-muted-foreground solid:hover:aria-expanded:bg-transparent solid:dark:hover:bg-transparent solid:dark:aria-expanded:bg-transparent solid:dark:hover:aria-expanded:bg-transparent"
          >
            <MarkerContent className="flex shrink-0 items-center gap-1.5">
              <GitBranch data-icon="inline-start" />
              <span>{t('chat.branchSummary')}</span>
              <Chevron open={open} />
            </MarkerContent>
          </Button>
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent className="duration-300">
        <div className={cn('mt-2 max-h-80 overflow-auto', hideScroll)}>
          <MarkdownText className="text-xs text-muted-foreground" text={text} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

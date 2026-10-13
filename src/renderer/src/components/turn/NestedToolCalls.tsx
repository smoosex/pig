import { useState, type ReactNode } from 'react'
import type { LiveNestedCalls } from '../../chat/nested-tools'
import { useT } from '../../hooks/useT'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Chevron } from './ProcessChrome'

export function NestedToolCalls({ record, children }: { record: LiveNestedCalls; children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2 min-w-0">
      <CollapsibleTrigger asChild>
        <Button size="sm" variant="ghost" className="w-full justify-between">
          <span>{t('mcp.nested', { n: record.calls.length })}</span>
          <Chevron open={open} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col px-1 pt-1">
        {!record.complete ? (
          <p className="text-xs text-muted-foreground">{t('mcp.incomplete')}</p>
        ) : null}
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

import { useState } from 'react'
import type { LiveNestedCalls } from '../../chat/nested-tools'
import { useT } from '../../hooks/useT'
import { HighlightedCode } from '../HighlightedCode'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Chevron } from './ProcessChrome'

export function NestedToolCalls({ record }: { record: LiveNestedCalls }) {
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
      <CollapsibleContent className="flex flex-col gap-3 px-2 pt-2">
        {!record.complete ? (
          <p className="text-xs text-muted-foreground">{t('mcp.incomplete')}</p>
        ) : null}
        {record.calls.map((call) => (
          <div
            key={call.id}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={call.name}>
                {call.name}
              </span>
              <Badge variant={call.status === 'error' ? 'destructive' : 'secondary'}>
                {t(call.status === 'ok' ? 'mcp.success' : `mcp.${call.status}`)}
              </Badge>
              {call.durationMs !== undefined ? (
                <span className="text-xs text-muted-foreground">
                  {t('mcp.duration', { ms: Math.round(call.durationMs) })}
                </span>
              ) : null}
            </div>
            {call.arguments ? (
              <HighlightedCode lang="json" code={JSON.stringify(call.arguments, null, 2)} />
            ) : call.argumentsBytes !== undefined ? (
              <p className="text-xs text-muted-foreground">
                {t('mcp.argumentsOmitted', { n: call.argumentsBytes })}
              </p>
            ) : null}
            {call.error ? (
              <p className="whitespace-pre-wrap break-words text-xs text-destructive">
                {call.error}
              </p>
            ) : null}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

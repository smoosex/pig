/** Host recall diagnostics are separate from model reasoning and render only plain historical text. */
import { memo, useState } from 'react'
import { DatabaseSearch, LoaderCircle } from 'lucide-react'
import type { LongTermRetrievalTrace } from '../../../../shared/long-term-memory'
import { useT } from '../../hooks/useT'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Chevron, disclosureButton, Rail } from './ProcessChrome'

export const MemoryRetrieval = memo(function MemoryRetrieval({ trace }: { trace: LongTermRetrievalTrace }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const running = trace.status === 'running'
  const label = trace.status === 'done'
    ? trace.memories.length ? t('longTerm.recallFound', { n: trace.memories.length }) : t('longTerm.recallEmpty')
    : t(trace.status === 'error' ? 'longTerm.recallError' : trace.status === 'cancelled' ? 'longTerm.recallCancelled' : 'longTerm.recalling')
  return <Collapsible open={open} onOpenChange={setOpen} className="min-w-0" data-memory-retrieval={trace.status}>
    <CollapsibleTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className={disclosureButton} aria-busy={running}>
        {running ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <DatabaseSearch data-icon="inline-start" />}
        <span className="min-w-0 flex-1 truncate text-left">{label}{trace.error ? ` [${trace.error.code}]` : null}</span>
        {trace.durationMs !== undefined ? <span className="shrink-0 text-muted-foreground">{t('longTerm.recallDuration', { ms: trace.durationMs })}</span> : null}
        <Chevron open={open} />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <Rail>
        <div className="flex flex-col gap-2 py-1 text-xs">
          <p className="text-muted-foreground" role={trace.status === 'error' ? 'alert' : undefined}>
            {t(trace.status === 'error' ? 'longTerm.recallErrorHint' : 'longTerm.recallHint')}
          </p>
          {trace.error ? <p className="text-muted-foreground">{t('longTerm.recallFailureDetails', {
            stage: trace.error.stage, code: trace.error.code, http: trace.error.httpStatus !== undefined ? ` · HTTP ${trace.error.httpStatus}` : '',
          })}</p> : null}
          {trace.cached ? <p className="text-muted-foreground">{t('longTerm.recallCached')}</p> : null}
          {trace.memories.map(memory => <div key={memory.id} className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline">{t(`longTerm.${memory.scope}`)}</Badge>
              {memory.status === 'disputed' ? <Badge variant="secondary">{t('longTerm.disputed')}</Badge> : null}
            </div>
            <p className="whitespace-pre-wrap break-words">{memory.content}</p>
          </div>)}
        </div>
      </Rail>
    </CollapsibleContent>
  </Collapsible>
})

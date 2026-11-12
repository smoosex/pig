/** Read-only Dream receipts, using the same searchable chooser as AddProviderDialog. */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Moon, Plus, RotateCw, X } from 'lucide-react'
import type { DreamRecordSummary } from '../../../../shared/dream'
import { useT } from '../../hooks/useT'
import { cn, hideScroll } from '../../lib/utils'
import { useDreamMonitor, useDreamStore } from '../../stores/dream'
import { useSettingsStore } from '../../stores/settings'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '../ui/command'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'

export function DreamHistoryDialog({ enabled, onClose }: { enabled: boolean; onClose: () => void }) {
  const t = useT()
  const locale = useSettingsStore(state => state.locale)
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useDreamMonitor()
  const { records, status, historyBusy, historyError, nextOffset, busy, loadHistory, readRecord, openDialog, newTopic } = useDreamStore()
  const running = status?.state === 'running'
  const live = status?.id && status.state !== 'idle' && !records.some(record => record.id === status.id) ? status : undefined
  // Search includes older pages, not just the first page already visible in the chooser.
  useEffect(() => {
    if (query.trim() && nextOffset !== undefined && !historyBusy && !historyError) void loadHistory(true)
  }, [query, nextOffset, historyBusy, historyError, loadHistory])
  const row = (record: DreamRecordSummary | NonNullable<typeof live>, current = false) => <CommandItem
    key={record.id} value={record.id} keywords={[record.topic ?? '', t(record.repair ? 'longTerm.repair' : 'dream.dreamKind'), t(record.repair ? 'dream.repairKind' : 'dream.dreamKind'), record.state !== 'idle' ? t(`dream.${record.state}`) : '']}
    className="py-3 data-selected:bg-transparent!" data-hover-highlight-row data-dream-record={record.id}
    onSelect={() => { if (current) openDialog(enabled); else void readRecord(record.id!) }}>
    <Moon className="text-muted-foreground" />
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{record.repair ? t('longTerm.repair') : record.topic}</span>
        <Badge variant="outline" className="shrink-0">{t(record.repair ? 'dream.repairKind' : 'dream.dreamKind')}</Badge>
      </div>
      {'endedAt' in record ? <span className="text-xs text-muted-foreground tabular-nums" title={new Date(record.endedAt).toLocaleString(locale)}>
        {new Date(record.endedAt).toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
      </span> : null}
    </div>
    <span data-slot="command-shortcut" className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      {record.state !== 'idle' ? <span className={cn(record.state === 'error' && 'text-destructive')}>{t(`dream.${record.state}`)}</span> : null}
      <ChevronRight />
    </span>
  </CommandItem>
  return <Dialog open onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent showCloseButton={false} className="flex max-h-4/5 flex-col overflow-hidden sm:max-w-lg"
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}>
      <DialogHeader className="shrink-0 pr-24">
        <DialogTitle>{t('dream.history')}</DialogTitle>
        <DialogDescription className="sr-only">{t('dream.historyHint')}</DialogDescription>
      </DialogHeader>
      <Tooltip>
        <TooltipTrigger asChild><span className="absolute top-4 right-20 inline-flex">
          <Button variant="ghost" size="icon-sm" aria-label={t('longTerm.refresh')} disabled={historyBusy} onClick={() => void loadHistory()}><RotateCw /></Button>
        </span></TooltipTrigger>
        <TooltipContent>{t('longTerm.refresh')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild><span className="absolute top-4 right-12 inline-flex">
          <Button variant="ghost" size="icon-sm" aria-label={t('dream.add')} disabled={!enabled || busy || running} onClick={newTopic}><Plus /></Button>
        </span></TooltipTrigger>
        <TooltipContent>{t('dream.add')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild><DialogClose asChild>
          <Button variant="ghost" size="icon-sm" className="absolute top-4 right-4" data-slot="dialog-close" aria-label={t('dream.close')}><X /></Button>
        </DialogClose></TooltipTrigger>
        <TooltipContent>{t('dream.close')}</TooltipContent>
      </Tooltip>
      {historyError ? <p role="alert" className="text-sm text-destructive">{historyError}</p> : null}
      <Command loop defaultValue=" " className="min-h-0" data-dream-history onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
      }}>
        <CommandInput ref={input} aria-label={t('dream.search')} placeholder={t('dream.search')} value={query} onValueChange={setQuery} />
        <CommandList className={cn('max-h-80', hideScroll)}>
          <SmoothHoverHighlight activeSelector="[data-selected='true']" activeAttribute="data-selected"
            highlightClassName="bg-glass-prompt-foreground/8 solid:bg-accent" data-dream-history-list>
            {!historyBusy && !historyError && (!query.trim() || nextOffset === undefined) ? <CommandEmpty>{t(query.trim() ? 'dream.noMatch' : 'dream.historyEmpty')}</CommandEmpty> : null}
            <CommandGroup>
              {live ? row(live, true) : null}
              {records.map(record => row(record))}
            </CommandGroup>
          </SmoothHoverHighlight>
          {historyBusy ? <p role="status" className="p-3 text-sm text-muted-foreground">{t('dream.historyLoading')}</p> : null}
          {nextOffset !== undefined && !query.trim() ? <Button variant="ghost" disabled={historyBusy} onClick={() => void loadHistory(true)}>{t('dream.more')}</Button> : null}
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>
}

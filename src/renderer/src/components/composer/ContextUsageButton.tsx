import { useEffect, useState } from 'react'
import { Activity, ScrollText } from 'lucide-react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { ScrollArea } from '../ui/scroll-area'
import { api } from '../../ipc/api'
import type { SessionContextUsage, SessionTokenStats } from '../../ipc/api'
import { cn } from '../../lib/utils'
import { useT } from '../../hooks/useT'
import { InputGroupButton } from '../ui/input-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '../ui/popover'
import { Progress } from '../ui/progress'
import { Separator } from '../ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { formatTokens } from '../../lib/format'

function StatRow({
  label,
  value,
  muted = true
}: {
  label: string
  value: string
  muted?: boolean
}) {
  return (
    <div className={cn('flex items-center justify-between text-xs', muted && 'text-muted-foreground')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function ContextUsageButton({
  sessionId,
  memoryAvailable,
  usage,
  tokens,
  error,
  onOpen,
  disabled
}: {
  sessionId: string | null
  memoryAvailable: boolean
  usage: SessionContextUsage | null
  tokens: SessionTokenStats | null
  error?: string | null
  onOpen: () => void
  disabled?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<'status' | 'view' | null>(null)
  const [full, setFull] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!memoryAvailable) setDetail(null)
  }, [memoryAvailable])
  useEffect(() => {
    if (!detail || !sessionId) return
    let active = true
    setText(null)
    setDetailError(null)
    setCopied(false)
    void api.getMemoryDetail(sessionId, detail, detail === 'view' && full).then((value) => {
      if (active) setText(value)
    }, (failure) => {
      if (active) setDetailError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { active = false }
  }, [detail, full, sessionId])
  const showDetail = (kind: 'status' | 'view') => {
    setFull(false)
    setDetail(kind)
    setOpen(false)
  }
  const used = usage?.tokens ?? null
  const windowSize = usage?.contextWindow ?? 0
  const percent = usage?.percent ?? null
  const hover = t('context.usage')

  return (
    <>
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen()
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <InputGroupButton
              className="size-8 rounded-full p-0 text-muted-foreground"
              aria-label={t('context.window')}
              disabled={disabled}
            >
              <ContextMeter percent={percent} />
            </InputGroupButton>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open ? <TooltipContent>{hover}</TooltipContent> : null}
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-72" onOpenAutoFocus={(event) => event.preventDefault()}>
        <PopoverHeader className="flex-row items-center justify-between">
          <PopoverTitle className="text-xs">{t('context.title')}</PopoverTitle>
          {memoryAvailable ? <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('context.memoryStatus')} onClick={() => showDetail('status')}><Activity /></Button>
              </TooltipTrigger>
              <TooltipContent>{t('context.memoryStatus')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('context.memoryView')} onClick={() => showDetail('view')}><ScrollText /></Button>
              </TooltipTrigger>
              <TooltipContent>{t('context.memoryView')}</TooltipContent>
            </Tooltip>
          </div> : null}
        </PopoverHeader>
        <div className="flex flex-col gap-2">
          <div className="text-sm tabular-nums">
            <span className="font-medium">{used == null ? '–' : formatTokens(used)}</span>
            <span className="text-muted-foreground">
              {' / '}{windowSize > 0 ? formatTokens(windowSize) : '–'}
            </span>
          </div>
          <Progress value={percent ?? 0} />
          {error ? (
            <p role="alert" className="text-xs text-destructive">{t('context.loadFailed', { error })}</p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <StatRow label={t('context.snapshot')} value={percent == null ? '–' : `${Math.round(percent)}%`} />
            <StatRow label={t('context.input')} value={formatTokens(tokens?.input ?? null)} />
            <StatRow label={t('context.cacheRead')} value={formatTokens(tokens?.cacheRead ?? null)} />
            <StatRow label={t('context.cacheWrite')} value={formatTokens(tokens?.cacheWrite ?? null)} />
            <StatRow label={t('context.output')} value={formatTokens(tokens?.output ?? null)} />
          </div>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <StatRow label={t('context.total')} value={formatTokens(tokens?.total ?? null)} muted={false} />
            <StatRow
              label={t('context.effectiveInput')}
              value={formatTokens(tokens ? tokens.input + tokens.cacheRead : null)}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
    <Dialog open={detail !== null} onOpenChange={(next) => { if (!next) setDetail(null) }}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t(detail === 'status' ? 'context.memoryStatus' : 'context.memoryView')}</DialogTitle></DialogHeader>
        {detail === 'view' ? <div className="flex items-center gap-2">
          <Button size="sm" variant={full ? 'ghost' : 'secondary'} onClick={() => setFull(false)}>{t('context.memoryVisible')}</Button>
          <Button size="sm" variant={full ? 'secondary' : 'ghost'} onClick={() => setFull(true)}>{t('context.memoryFull')}</Button>
        </div> : null}
        {detailError ? <p role="alert" className="text-sm text-destructive">{t('context.memoryFailed', { error: detailError })}</p> : null}
        {!text && !detailError ? <p className="text-sm text-muted-foreground">{t('context.memoryLoading')}</p> : null}
        {text ? <>
          <ScrollArea className="h-[min(60vh,32rem)] rounded-md border border-code-border bg-code-background">
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs text-code-foreground">{text}</pre>
          </ScrollArea>
          <Button variant="outline" size="sm" className="self-end" onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true), (failure) => setDetailError(String(failure)))
          }}>{t(copied ? 'context.memoryCopied' : 'context.memoryCopy')}</Button>
        </> : null}
      </DialogContent>
    </Dialog>
    </>
  )
}

function ContextMeter({ percent }: { percent: number | null }) {
  const value = Math.max(0, Math.min(100, percent ?? 0))
  const r = 11
  const c = 2 * Math.PI * r
  return (
    <span className="relative inline-flex size-8 items-center justify-center">
      <svg viewBox="0 0 32 32" className="size-8 -rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" className="stroke-border" strokeWidth="2.25" />
        <circle
          cx="16"
          cy="16"
          r={r}
          fill="none"
          className="stroke-primary"
          strokeWidth="2.25"
          strokeDasharray={`${(value / 100) * c} ${c}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[9px] tabular-nums text-muted-foreground">
        {percent == null ? '–' : `${Math.round(value)}%`}
      </span>
    </span>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Activity, ChevronDown, FoldVertical, LoaderCircle, ScrollText } from 'lucide-react'
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
import { Textarea } from '../ui/textarea'
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
  compactBlock,
  disabled
}: {
  sessionId: string | null
  memoryAvailable: boolean
  usage: SessionContextUsage | null
  tokens: SessionTokenStats | null
  error?: string | null
  onOpen: () => void
  /** Why the session cannot compact right now; `compacting` covers automatic runs too. */
  compactBlock: 'running' | 'navigating' | 'compacting' | null
  disabled?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<'status' | 'view' | null>(null)
  const [full, setFull] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  useEffect(() => {
    if (!memoryAvailable) setDetail(null)
  }, [memoryAvailable])
  useEffect(() => {
    if (!detail || !sessionId) return
    let active = true
    setText(null)
    setDetailError(null)
    void api.getMemoryDetail(sessionId, detail, detail === 'view' && full).then((value) => {
      if (active) setText(value)
    }, (failure) => {
      if (active) setDetailError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { active = false }
  }, [detail, full, sessionId])
  // Keyed by session: the toolbar outlives a tab switch, and a late reply must not land on another tab.
  const [compacting, setCompacting] = useState<ReadonlySet<string>>(() => new Set())
  const [compactError, setCompactError] = useState<{ sessionId: string; message: string } | null>(null)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [instructions, setInstructions] = useState('')
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  useEffect(() => {
    setInstructionsOpen(false)
    setInstructions('')
  }, [sessionId])
  const compact = (custom?: string) => {
    if (!sessionId || compacting.has(sessionId)) return
    const target = sessionId
    setCompacting((current) => new Set(current).add(target))
    setCompactError(null)
    // Pi reports a failed summary through compaction events in the transcript; this rejection is
    // only the IPC refusing to start (branch navigation, session preparation).
    void api.compactSession(target, custom).then(() => {
      if (currentSession.current !== target) return
      setInstructionsOpen(false)
      setInstructions('')
    }, (failure: unknown) => {
      setCompactError({ sessionId: target, message: failure instanceof Error ? failure.message : String(failure) })
    }).finally(() => setCompacting((current) => {
      const next = new Set(current)
      next.delete(target)
      return next
    }))
  }
  const showDetail = (kind: 'status' | 'view') => {
    setFull(false)
    setDetail(kind)
    setOpen(false)
  }
  const used = usage?.tokens ?? null
  const windowSize = usage?.contextWindow ?? 0
  const percent = usage?.percent ?? null
  const hover = t('context.usage')
  const autoAt = usage?.autoCompactAt ?? null
  const autoPercent = autoAt != null && windowSize > 0 ? Math.min(100, (autoAt / windowSize) * 100) : null
  const busy = (sessionId !== null && compacting.has(sessionId)) || compactBlock === 'compacting'
  const blockedKey = compactBlock === 'running'
    ? 'context.compactRunning'
    : compactBlock === 'navigating'
      ? 'context.compactNavigating'
      : !used
        ? 'context.compactEmpty'
        : null
  const compactDisabled = !sessionId || busy || blockedKey !== null

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
              size="icon-xs"
              variant="outline"
              className="rounded-full"
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
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm tabular-nums">
              <span className="font-medium">{used == null ? '–' : formatTokens(used)}</span>
              <span className="text-muted-foreground">
                {' / '}{windowSize > 0 ? formatTokens(windowSize) : '–'}
              </span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button swallows pointer events, so the wrapper carries the reason. */}
                <span className="flex">
                  <Button
                    size="xs"
                    variant="outline"
                    className="rounded-r-none"
                    disabled={compactDisabled}
                    aria-busy={busy}
                    onClick={() => compact()}
                  >
                    {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <FoldVertical data-icon="inline-start" />}
                    {t(busy ? 'context.compacting' : 'context.compact')}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="outline"
                    className="-ml-px rounded-l-none"
                    disabled={compactDisabled}
                    aria-label={t('context.compactInstructionsToggle')}
                    aria-expanded={instructionsOpen}
                    onClick={() => setInstructionsOpen((value) => !value)}
                  >
                    <ChevronDown className={cn('transition-transform', instructionsOpen && 'rotate-180')} />
                  </Button>
                </span>
              </TooltipTrigger>
              {blockedKey ? <TooltipContent>{t(blockedKey)}</TooltipContent> : null}
            </Tooltip>
          </div>
          {instructionsOpen && !compactDisabled ? (
            <div className="flex flex-col gap-1.5">
              <Textarea
                aria-label={t('context.compactInstructions')}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder={t('context.compactPlaceholder')}
                className="min-h-16 text-xs md:text-xs"
                autoFocus
              />
              <div className="flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" onClick={() => setInstructionsOpen(false)}>{t('common.cancel')}</Button>
                <Button size="xs" disabled={!instructions.trim()} onClick={() => compact(instructions.trim())}>
                  {t('context.compactWithInstructions')}
                </Button>
              </div>
            </div>
          ) : null}
          {compactError?.sessionId === sessionId ? (
            <p role="alert" className="text-xs text-destructive">{t('context.compactFailed', { error: compactError.message })}</p>
          ) : null}
          <div className="relative">
            <Progress value={percent ?? 0} />
            {autoPercent != null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-auto-compact-marker
                    aria-label={t('context.autoCompactAt', { tokens: formatTokens(autoAt), percent: Math.round(autoPercent) })}
                    className="absolute top-1/2 flex h-4 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                    style={{ left: `${autoPercent}%` }}
                  >
                    <span className="h-2 w-px bg-foreground/40" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t('context.autoCompactAt', { tokens: formatTokens(autoAt), percent: Math.round(autoPercent) })}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
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
          <ScrollArea className="h-[min(60vh,32rem)] rounded-md border border-glass-card-border bg-glass-composer-background/60 text-glass-prompt-foreground shadow-glass-card-edge transition-[background-color,box-shadow] duration-200 ease-in-out motion-reduce:transition-none solid:border-code-border solid:bg-code-background solid:text-code-foreground solid:shadow-none">
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs">{text}</pre>
          </ScrollArea>
        </> : null}
      </DialogContent>
    </Dialog>
    </>
  )
}

function ContextMeter({ percent }: { percent: number | null }) {
  const value = Math.max(0, Math.min(100, percent ?? 0))
  const filled = Math.round(value / 5)
  return (
    <span className="relative inline-flex size-6 shrink-0 items-center justify-center">
      <span aria-hidden="true" className="pointer-events-none absolute inset-0.5">
        {Array.from({ length: 20 }, (_, index) => (
          <span key={index} className="absolute inset-0" style={{ transform: `rotate(${index * 18}deg)` }}>
            <span className={cn(
              'absolute left-1/2 top-0 h-0.75 w-px -translate-x-1/2 rounded-full transition-colors',
              index < filled ? 'bg-primary' : 'bg-glass-prompt-foreground/20 solid:bg-foreground/20'
            )} />
          </span>
        ))}
      </span>
      <span className="flex size-4 items-center justify-center rounded-full bg-glass-button-background bg-(image:--glass-badge-sheen) text-[7px] leading-none tabular-nums tracking-tight text-glass-prompt-foreground shadow-glass-card-edge solid:bg-background solid:bg-none solid:text-foreground solid:shadow-none">
        {percent == null ? '–' : `${Math.round(value)}%`}
      </span>
    </span>
  )
}

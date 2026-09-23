import { useState } from 'react'
import type { SessionContextUsage, SessionTokenStats } from '../../ipc/api'
import { cn } from '../../lib/utils'
import { useT } from '../../hooks/useT'
import { InputGroupButton } from '../ui/input-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '../ui/popover'
import { Progress } from '../ui/progress'
import { Separator } from '../ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

function formatTokens(value: number | null): string {
  if (value == null) return '–'
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const scaled = value / 1000
    return `${scaled >= 100 && Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}k`
  }
  const scaled = value / 1_000_000
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}M`
}

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
  usage,
  tokens,
  error,
  onOpen,
  disabled
}: {
  usage: SessionContextUsage | null
  tokens: SessionTokenStats | null
  error?: string | null
  onOpen: () => void
  disabled?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const used = usage?.tokens ?? null
  const windowSize = usage?.contextWindow ?? 0
  const percent = usage?.percent ?? null
  const hover = t('context.usage')

  return (
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
      <PopoverContent align="end" side="top" className="w-72">
        <PopoverHeader>
          <PopoverTitle className="text-xs">{t('context.title')}</PopoverTitle>
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

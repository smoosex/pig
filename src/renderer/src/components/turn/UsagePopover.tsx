/** The token breakdown behind a chart button, shared by reply footers and subagent cards. */
import { useMemo, type ReactNode } from 'react'
import { ChartColumn } from 'lucide-react'
import type { TurnUsage } from '../../../../shared/api'
import { cacheHitRate } from '../../../../shared/turn-usage'
import { useT } from '../../hooks/useT'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function useUsageFormat() {
  const locale = useSettingsStore((state) => state.locale)
  return useMemo(() => ({
    numbers: new Intl.NumberFormat(locale),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  }), [locale])
}

export function UsageRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
      {rows.map(([label, value], index) => (
        <div key={`${index}:${label}`} className="contents">
          <dt className="min-w-0 truncate text-muted-foreground">{label}</dt>
          <dd className="text-right font-mono tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function UsagePopover({
  usage, tps, open, onOpenChange, side = 'top', align = 'end', size = 'icon-xs', className, children
}: {
  usage?: TurnUsage
  tps?: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  size?: 'icon-xs' | 'icon-sm'
  className?: string
  /** Extra sections below the breakdown; mounted only while the popover is open. */
  children?: ReactNode
}) {
  const t = useT()
  const { numbers, percent } = useUsageFormat()
  const hitRate = usage ? cacheHitRate(usage) : null
  const rows: Array<[string, string]> = usage
    ? [
        [t('turn.usageInput'), numbers.format(usage.input)],
        [t('turn.usageOutput'), numbers.format(usage.output)],
        [t('turn.usageCacheRead'), numbers.format(usage.cacheRead)],
        [t('turn.usageCacheWrite'), numbers.format(usage.cacheWrite)],
        ...(hitRate === null ? [] : [[t('turn.usageCacheHitRate'), percent.format(hitRate)] as [string, string]]),
        [t('turn.usageTotal'), numbers.format(usage.total)],
        [t('turn.usageCalls'), t('turn.usageCallCount', { count: usage.calls })],
        ...(tps ? [[t('turn.usageSpeed'), tps] as [string, string]] : [])
      ]
    : []

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size={size} className={className} aria-label={t('turn.usage')} disabled={!usage}>
              <ChartColumn />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>{t('turn.usage')}</TooltipContent>
      </Tooltip>
      <PopoverContent align={align} side={side} className="max-h-(--radix-popover-content-available-height) w-64 gap-1.5 overflow-y-auto p-3 text-xs">
        <p className="font-medium text-muted-foreground">{t('turn.usage')}</p>
        <UsageRows rows={rows} />
        {children}
      </PopoverContent>
    </Popover>
  )
}

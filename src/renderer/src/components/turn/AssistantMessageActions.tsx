/** Reply toolbar: regenerating resends the turn's prompt in place, forking keeps the whole turn. */
import { useMemo, useState } from 'react'
import { ChartColumn, Check, Copy, GitFork, MoreHorizontal, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { cacheHitRate } from '../../../../shared/turn-usage'
import type { Turn } from '../../chat/turns'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { markdownToPlainText } from '../../lib/markdown-plain-text'
import { useSessionsStore } from '../../stores/sessions'
import { useSettingsStore } from '../../stores/settings'
import { Button } from '../ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

export function answerText(turn: Turn): string {
  return turn.answer.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n\n').trim()
}

export function AssistantMessageActions({
  turn, sessionId, tps
}: {
  turn: Turn
  sessionId?: string
  tps: string | null
}) {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const timestampFormat = useMemo(() => new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }), [locale])
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const percent = useMemo(() => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }), [locale])
  const text = answerText(turn)
  const { copied, copy } = useCopyFeedback(text)
  const [menuOpen, setMenuOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const busy = useSessionsStore((state) => {
    const runtime = sessionId ? state.runtime[sessionId] : undefined
    return Boolean(runtime?.isStreaming || runtime?.bashExecution || runtime?.isNavigatingBranch)
  })
  const persisted = Boolean(sessionId && turn.id && !turn.id.startsWith('live:') && turn.lastEntryId)
  const canChange = persisted && !busy && !pending
  const canRegenerate = canChange && Boolean(turn.user)
  const fullTimestamp = timestampFormat.format(turn.endedAt)
  const usage = turn.usage

  async function copyAnswer(format: 'markdown' | 'plain' = 'markdown'): Promise<void> {
    try {
      await copy(format === 'plain' ? markdownToPlainText(text) : text)
    } catch (error) {
      toast.error(t('turn.messageActionFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async function change(action: 'retry' | 'fork'): Promise<void> {
    if (!sessionId || !turn.id || !turn.lastEntryId || !canChange) return
    setPending(true)
    try {
      const store = useSessionsStore.getState()
      if (action === 'fork') await store.forkSession(sessionId, turn.lastEntryId, 'at')
      else await store.retryUserMessage(sessionId, turn.id)
    } catch (error) {
      toast.error(t(action === 'fork' ? 'turn.forkFailed' : 'turn.messageActionFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setPending(false)
    }
  }

  const hitRate = usage ? cacheHitRate(usage) : null
  const usageRows: Array<[string, string]> = usage
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
    <div
      data-slot="assistant-message-actions"
      className={cn(
        'flex items-center gap-0.5 opacity-0 transition-opacity group-hover/agent-reply:opacity-100 group-focus-within/agent-reply:opacity-100',
        (menuOpen || usageOpen) && 'opacity-100'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs"
            aria-label={t(copied ? 'common.copied' : 'common.copy')}
            disabled={!text} onClick={() => void copyAnswer()}>
            {copied ? <Check /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t(copied ? 'common.copied' : 'common.copy')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* aria-disabled instead of disabled: the tooltip has to explain a prompt-less turn. */}
          <Button type="button" variant="ghost" size="icon-xs"
            aria-label={t('turn.retryMessage')} aria-disabled={!canRegenerate}
            className="aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
            onClick={() => { if (canRegenerate) void change('retry') }}>
            <RotateCcw />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t(turn.user ? 'turn.retryMessage' : 'turn.regenerateNoPrompt')}
        </TooltipContent>
      </Tooltip>
      <Popover open={usageOpen} onOpenChange={setUsageOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t('turn.usage')} disabled={!usage}>
                <ChartColumn />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>{t('turn.usage')}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" side="top" className="w-64 gap-1.5 p-3 text-xs">
          <p className="font-medium text-muted-foreground">{t('turn.usage')}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
            {usageRows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-mono tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </PopoverContent>
      </Popover>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={t('turn.moreActions')}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>{t('turn.moreActions')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" side="bottom">
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!text} onSelect={() => void copyAnswer('markdown')}>
              <Copy />
              {t('turn.copyMarkdown')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!text} onSelect={() => void copyAnswer('plain')}>
              <Copy />
              {t('turn.copyPlainText')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canChange} onSelect={() => void change('fork')}>
              <GitFork />
              {t('turn.createFork')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={new Date(turn.endedAt).toISOString()}
            tabIndex={0}
            aria-label={fullTimestamp}
            className="ml-2 rounded-sm text-xs tabular-nums outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring"
          >
            {clock.format(turn.endedAt)}
          </time>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-none whitespace-nowrap">
          {fullTimestamp}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

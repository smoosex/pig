/**
 * Circular rainbow-ring medallion button placed in the top-left header toolbar to enter/exit Bot.
 * Houses Pig's pixel-pig silhouette on a deep recessed disc framed by an iridescent conic ring
 * (which smoothly spins while tasks run or Bot is streaming) and preserves priority status badges.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isBotTaskActive } from '../../../../shared/bot'
import { useT } from '../../hooks/useT'
import { registerBotOrbAnchor, useBotStore } from '../../stores/bot'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { ShortcutKbd } from '../ShortcutKbd'
import { BotPigIcon } from './BotPigIcon'

export function BotOrbButton({
  registerAnchor = true,
  className
}: {
  registerAnchor?: boolean
  className?: string
}) {
  const t = useT()

  const open = useBotStore((s) => s.open)
  const tasks = useBotStore((s) => s.tasks)
  const approvals = useBotStore((s) => s.approvals)
  const unreadCount = useBotStore((s) => s.unreadCount)
  const streaming = useBotStore((s) => s.streaming)
  const toggleBot = useBotStore((s) => s.toggleBot)

  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [pulseKey, setPulseKey] = useState(0)
  const prevUnreadRef = useRef(unreadCount)

  useEffect(() => {
    if (unreadCount > prevUnreadRef.current && !open) {
      setPulseKey((k) => k + 1)
    }
    prevUnreadRef.current = unreadCount
  }, [unreadCount, open])

  const setRef = useCallback((el: HTMLButtonElement | null) => {
    buttonRef.current = el
    if (registerAnchor) registerBotOrbAnchor(el)
  }, [registerAnchor])

  const activeCount = useMemo(() => tasks.filter((item) => isBotTaskActive(item.status)).length, [tasks])
  const failedCount = useMemo(() => tasks.filter((item) => item.status === 'failed' && item.delivery.state !== 'delivered').length, [tasks])
  const approvalCount = approvals.length

  const statusKind: 'approval' | 'attention' | 'running' | 'unread' | 'idle' =
    approvalCount > 0 ? 'approval'
      : failedCount > 0 ? 'attention'
        : activeCount > 0 ? 'running'
          : unreadCount > 0 && !open ? 'unread'
            : 'idle'

  const spinning = statusKind === 'running' || streaming

  const ariaLabel =
    approvalCount > 0 ? t('bot.orbAriaApproval', { count: approvalCount })
      : activeCount > 0 ? t('bot.orbAriaRunning', { count: activeCount })
        : unreadCount > 0 && !open ? t('bot.orbAriaUnread', { count: unreadCount })
          : t('bot.orbAriaIdle')

  const tooltipTitle = open ? t('bot.backToWorkspace') : t('bot.enter')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          key={pulseKey > 0 ? `orb-${pulseKey}` : 'orb'}
          ref={setRef}
          type="button"
          data-bot-orb-button
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={() => toggleBot(buttonRef.current)}
          className={cn(
            'no-drag group relative inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-transform duration-150 hover:scale-[1.04] active:scale-95 focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none',
            pulseKey > 0 && 'bot-orb-bounce motion-reduce:animate-none',
            className
          )}
        >
          {/* Layer 1: Outer Status Aura (non-layout) */}
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute -inset-0.5 rounded-full transition-shadow duration-200',
              statusKind === 'approval' && 'ring-2 ring-warning/85 shadow-[0_0_12px_var(--warning)] bot-orb-pulse motion-reduce:animate-none',
              statusKind === 'attention' && 'ring-2 ring-destructive/85',
              statusKind === 'unread' && 'shadow-[0_0_10px_var(--bot-orb-glow)]',
              statusKind === 'idle' && (open ? 'shadow-[0_0_10px_var(--bot-orb-glow)]' : 'group-hover:shadow-[0_0_10px_var(--bot-orb-glow)]')
            )}
          />
          {/* Layer 2: Outer Dark Metallic Bezel */}
          <span className="relative flex size-full items-center justify-center rounded-full bg-bot-orb-bezel p-[1.5px] shadow-bot-orb-bezel">
            {/* Layer 3: Iridescent Conic Rainbow Ring */}
            <span className="relative flex size-full items-center justify-center overflow-hidden rounded-full p-[2px]">
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute inset-0 rounded-full bg-(image:--bot-orb-rainbow) transition-[filter] duration-200 group-hover:brightness-110',
                  spinning && 'bot-orb-spin motion-reduce:animate-none'
                )}
              />
              {/* Layer 4: Deep Recessed Radial Disc & Pixel Pig Mark */}
              <span className="relative flex size-full items-center justify-center rounded-full bg-(image:--bot-orb-disc) shadow-bot-orb-disc">
                <BotPigIcon className="h-[11px] w-[14px] text-bot-orb-glyph" />
              </span>
            </span>
          </span>
          {/* Layer 5: Corner Status Micro-Badge */}
          {statusKind !== 'idle' ? (
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background',
                statusKind === 'approval' && 'bg-warning',
                statusKind === 'attention' && 'bg-destructive',
                (statusKind === 'running' || statusKind === 'unread') && 'bg-primary'
              )}
            />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <span>{tooltipTitle}</span>
        {activeCount > 0 ? <span className="ml-1.5 text-muted-foreground">· {t('bot.tasksButton', { count: activeCount })}</span> : null}
        <span className="ml-1.5 inline-flex"><ShortcutKbd action="bot.toggle" /></span>
      </TooltipContent>
    </Tooltip>
  )
}

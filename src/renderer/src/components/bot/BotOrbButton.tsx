/**
 * Top-left header entry button shared by Workspace and Bot mode to toggle Bot.
 * Renders the animated `bot-avatars` clover avatar scaled to the 28px hit target
 * (leaving its 1.5x overscan unclipped inside the 40px header) with priority status cues.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BotAvatar } from 'bot-avatars'

import { DEFAULT_BOT_AVATAR, isBotTaskActive } from '../../../../shared/bot'
import { useT } from '../../hooks/useT'
import { registerBotOrbAnchor, useBotStore } from '../../stores/bot'
import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { ShortcutKbd } from '../ShortcutKbd'

export function BotOrbButton({
  registerAnchor = true,
  className
}: {
  registerAnchor?: boolean
  className?: string
}) {
  const t = useT()

  const open = useBotStore((s) => s.open)
  const avatar = useBotStore((s) => s.state?.avatar ?? DEFAULT_BOT_AVATAR)
  const tasks = useBotStore((s) => s.tasks)
  const approvals = useBotStore((s) => s.approvals)
  const unreadCount = useBotStore((s) => s.unreadCount)
  const streaming = useBotStore((s) => s.streaming)
  const toggleBot = useBotStore((s) => s.toggleBot)

  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [bouncing, setBouncing] = useState(false)
  const prevUnreadRef = useRef(unreadCount)

  useEffect(() => {
    const grew = unreadCount > prevUnreadRef.current && !open
    prevUnreadRef.current = unreadCount
    if (!grew) return
    setBouncing(true)
    const timer = window.setTimeout(() => setBouncing(false), 360)
    return () => window.clearTimeout(timer)
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

  const avatarState = statusKind === 'running' || streaming ? 'working' : 'default'

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
          ref={setRef}
          type="button"
          data-bot-orb-button
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={() => toggleBot(buttonRef.current)}
          className={cn(
            'no-drag group relative inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-transform duration-150 hover:scale-[1.04] active:scale-95 focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none',
            bouncing && 'bot-orb-bounce motion-reduce:animate-none',
            className
          )}
        >
          {/* Outer status aura (non-layout, never clips the avatar overscan) */}
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute -inset-0.5 rounded-full transition-shadow duration-200',
              statusKind === 'approval' && 'ring-2 ring-warning/85 shadow-[0_0_12px_var(--warning)] bot-orb-pulse motion-reduce:animate-none',
              statusKind === 'attention' && 'ring-2 ring-destructive/85',
              statusKind === 'unread' && 'shadow-[0_0_10px_var(--bot-orb-glow)]',
              statusKind === 'idle' && 'group-hover:shadow-[0_0_10px_var(--bot-orb-glow)]'
            )}
          />
          {/* Animated Bot avatar: 22px body with 1.5x overscan (33px canvas) stays unclipped inside the 40px header */}
          <BotAvatar
            type={avatar}
            size={22}
            state={avatarState}
            paused={!registerAnchor}
            aria-hidden="true"
            className="pointer-events-none"
          />
          {/* Corner status micro-badge */}
          {statusKind !== 'idle' ? (
            <span
              aria-hidden="true"
              data-bot-orb-badge={statusKind}
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

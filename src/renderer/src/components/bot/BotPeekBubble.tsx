/**
 * Non-intrusive 2-line peek bubble anchored under BotOrbButton whenever Bot sends a message
 * or a background task needs approval while the user is working in the Workspace view.
 * Tagged with data-bot-overlay so native WebContentsView snapshots freeze smoothly underneath.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { X } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { getBotOrbAnchor, useBotStore } from '../../stores/bot'
import { cn } from '../../lib/utils'

const AUTO_DISMISS_MS = 6_000
const BUBBLE_WIDTH = 304

export function BotPeekBubble() {
  const t = useT()
  const prefersReduced = useReducedMotion()
  const open = useBotStore((s) => s.open)
  const peek = useBotStore((s) => s.peek)
  const openBot = useBotStore((s) => s.openBot)
  const dismissPeek = useBotStore((s) => s.dismissPeek)

  const [paused, setPaused] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; caretLeft: number }>({
    left: 16,
    top: 46,
    caretLeft: 24
  })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const visible = !open && peek !== null
  const isApproval = peek?.message.kind === 'approval'

  // Anchor below the BotOrbButton with viewport clamping
  useLayoutEffect(() => {
    if (!visible) return
    const update = () => {
      const anchor = getBotOrbAnchor() ?? document.querySelector<HTMLElement>('[data-bot-orb-button]')
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const maxLeft = Math.max(12, window.innerWidth - BUBBLE_WIDTH - 12)
      const left = Math.min(Math.max(12, rect.left - 8), maxLeft)
      const caretLeft = Math.min(BUBBLE_WIDTH - 20, Math.max(16, rect.left + rect.width / 2 - left))
      setPos({ left, top: rect.bottom + 8, caretLeft })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [visible, peek?.message.id])

  // Auto-dismiss normal messages after 6s; approvals never auto-dismiss.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!visible || isApproval || paused) return
    timerRef.current = setTimeout(() => {
      dismissPeek()
    }, AUTO_DISMISS_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [visible, isApproval, paused, peek?.message.id, peek?.extraCount, dismissPeek])

  if (typeof document === 'undefined') return null

  const badgeText = isApproval
    ? t('bot.peek.approvalNeeded')
    : peek?.message.statusBadge
      ? t(`bot.taskStatus.${peek.message.statusBadge}` as Parameters<typeof t>[0])
      : null

  return createPortal(
    <AnimatePresence>
      {visible && peek ? (
        <motion.div
          key={peek.message.id}
          data-bot-overlay
          data-bot-peek-bubble
          role={isApproval ? 'alert' : 'status'}
          aria-live={isApproval ? 'assertive' : 'polite'}
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            width: BUBBLE_WIDTH,
            transformOrigin: `${pos.caretLeft}px -6px`
          }}
          initial={prefersReduced ? { opacity: 0 } : { opacity: 0, scale: 0.88, y: -6 }}
          animate={prefersReduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={prefersReduced ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -4 }}
          transition={{ type: 'spring', stiffness: 440, damping: 30 }}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
          className={cn(
            'z-50 rounded-xl p-3 text-left text-xs text-popover-foreground select-none',
            'bg-glass-popover-background bg-(image:--glass-popover-sheen) shadow-glass-popover ring-1 ring-glass-content-border',
            'solid:bg-popover solid:bg-none solid:border solid:border-border solid:shadow-lg solid:ring-0',
            isApproval && 'ring-warning/60 solid:border-warning/70'
          )}
        >
          {/* Caret pointing to the orb */}
          <span
            aria-hidden="true"
            style={{ left: pos.caretLeft - 5 }}
            className="pointer-events-none absolute -top-1.5 size-2.5 rotate-45 border-t border-l border-glass-content-border bg-glass-popover-background solid:border-border solid:bg-popover"
          />
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={() => openBot()}
              className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
            >
              {(badgeText || peek.message.projectName) ? (
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium">
                  <span
                    className={cn(
                      'inline-block size-1.5 shrink-0 rounded-full',
                      isApproval ? 'bg-warning' : 'bg-primary'
                    )}
                  />
                  {badgeText ? (
                    <span className={cn(isApproval ? 'text-warning' : 'text-foreground')}>
                      {badgeText}
                    </span>
                  ) : null}
                  {peek.message.projectName ? (
                    <span className="truncate text-muted-foreground">· {peek.message.projectName}</span>
                  ) : null}
                </div>
              ) : null}
              <p className="line-clamp-2 leading-relaxed text-foreground/95 break-words">
                {peek.message.text}
              </p>
              {peek.extraCount > 0 ? (
                <div className="mt-1 text-right text-[11px] font-medium text-primary">
                  {t('bot.peek.unreadMore', { count: peek.extraCount })}
                </div>
              ) : null}
            </button>
            <button
              type="button"
              aria-label={t('bot.actions.dismiss')}
              onClick={(e) => {
                e.stopPropagation()
                dismissPeek()
              }}
              className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  )
}

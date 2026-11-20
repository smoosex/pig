/**
 * On-demand slide-over task ledger drawer inside BotPage (360px wide).
 * Supports Active / All filtering, Esc dismissal, and direct actions on every BotTask.
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { X } from 'lucide-react'
import { isBotTaskActive } from '../../../../shared/bot'
import { useT } from '../../hooks/useT'
import { cn } from '../../lib/utils'
import { useBotStore } from '../../stores/bot'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import { BotTaskCard, type BotTaskNavigation } from './BotTaskCard'

export function BotTaskDrawer({ navigation }: { navigation: BotTaskNavigation }) {
  const t = useT()
  const prefersReduced = useReducedMotion()
  const drawerOpen = useBotStore((s) => s.drawerOpen)
  const focusedTaskId = useBotStore((s) => s.focusedTaskId)
  const tasks = useBotStore((s) => s.tasks)
  const setDrawerOpen = useBotStore((s) => s.setDrawerOpen)

  const [filter, setFilter] = useState<'active' | 'all'>('all')

  const activeCount = useMemo(() => tasks.filter((item) => isBotTaskActive(item.status)).length, [tasks])
  const filtered = useMemo(() => {
    const base = filter === 'active' ? tasks.filter((item) => isBotTaskActive(item.status)) : tasks
    return [...base].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [tasks, filter])

  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [drawerOpen, setDrawerOpen])

  return (
    <AnimatePresence>
      {drawerOpen ? (
        <motion.aside
          data-bot-overlay
          data-bot-task-drawer
          role="dialog"
          aria-label={t('bot.tasksDrawerTitle')}
          initial={prefersReduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={prefersReduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
          exit={prefersReduced ? { opacity: 0 } : { opacity: 0, x: 24 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            'absolute top-2 right-2 bottom-2 z-30 flex w-90 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-xl',
            'bg-glass-popover-background bg-(image:--glass-popover-sheen) shadow-glass-popover ring-1 ring-glass-content-border',
            'solid:border solid:border-border solid:bg-popover solid:bg-none solid:shadow-xl solid:ring-0'
          )}
        >
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 px-3">
            <span className="text-xs font-semibold text-foreground">{t('bot.tasksDrawerTitle')}</span>
            <div className="flex items-center gap-1">
              <div className="inline-flex rounded-md bg-foreground/6 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setFilter('active')}
                  className={cn(
                    'rounded-sm px-2 py-0.5 transition-colors',
                    filter === 'active' ? 'bg-background font-medium text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('bot.tasksFilterActive')} ({activeCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className={cn(
                    'rounded-sm px-2 py-0.5 transition-colors',
                    filter === 'all' ? 'bg-background font-medium text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('bot.tasksFilterAll')} ({tasks.length})
                </button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('bot.actions.dismiss')}
                onClick={() => setDrawerOpen(false)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-3">
              {filtered.length === 0 ? (
                <p className="py-12 text-center text-xs text-muted-foreground">{t('bot.tasksEmpty')}</p>
              ) : (
                filtered.map((task) => (
                  <BotTaskCard
                    key={task.taskId}
                    task={task}
                    highlighted={task.taskId === focusedTaskId}
                    navigation={navigation}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}

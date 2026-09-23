import { useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useIsPresent, usePresenceData, useReducedMotion } from 'motion/react'
import { Clock3, CornerDownRight, Trash2 } from 'lucide-react'
import { followUpRowsMatch, reconcileFollowUpRows, type FollowUpRow } from '../chat/follow-ups'
import type { FollowUpAction } from '../ipc/api'
import { useSessionsStore } from '../stores/sessions'
import { useT } from '../hooks/useT'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'

const EMPTY_MESSAGES: string[] = []
const EASE = [0.22, 1, 0.36, 1] as const
const MAX_LIST_HEIGHT = 3 * 32 + 2 * 4
const ROW_BACKGROUNDS = [
  'bg-chart-1/8 hover:bg-chart-1/16 focus-within:bg-chart-1/16',
  'bg-chart-2/8 hover:bg-chart-2/16 focus-within:bg-chart-2/16',
  'bg-chart-3/8 hover:bg-chart-3/16 focus-within:bg-chart-3/16',
  'bg-chart-4/8 hover:bg-chart-4/16 focus-within:bg-chart-4/16',
  'bg-chart-5/8 hover:bg-chart-5/16 focus-within:bg-chart-5/16'
] as const

function QueueRow({
  row,
  colorIndex,
  busy,
  error,
  onAction,
  onExitComplete
}: {
  row: FollowUpRow
  colorIndex: number
  busy: boolean
  error?: string
  onAction: (row: FollowUpRow, action: FollowUpAction) => void
  onExitComplete: () => void
}) {
  const t = useT()
  const present = useIsPresent()
  const reducedMotion = useReducedMotion()
  const dismissedRows = usePresenceData() as ReadonlySet<string> | undefined

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: 0, y: reducedMotion ? 0 : 12 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      variants={{
        exit: {
          opacity: 0,
          x: reducedMotion ? 0 : dismissedRows?.has(row.id) ? '-100%' : '100%',
          y: 0,
          transition: { duration: reducedMotion ? 0 : 0.2, ease: 'easeIn' }
        }
      }}
      exit="exit"
      onAnimationComplete={(definition) => {
        if (definition === 'exit') onExitComplete()
      }}
      transition={{ duration: reducedMotion ? 0 : 0.24, ease: EASE }}
      inert={!present}
      aria-hidden={!present}
      className={cn(
        'group flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors duration-150 motion-reduce:transition-none',
        ROW_BACKGROUNDS[colorIndex % ROW_BACKGROUNDS.length]
      )}
    >
      <span className="relative flex size-6 shrink-0 items-center justify-center">
        <Clock3
          className="size-3.5 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <span className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="font-normal"
            aria-label={t('followUp.deleteAria')}
            title={t('common.delete')}
            disabled={busy || !present}
            onClick={() => onAction(row, 'dismiss')}
          >
            <Trash2 />
          </Button>
        </span>
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        title={error ?? row.text}
        role={error ? 'alert' : undefined}
      >
        {error ?? (row.text || t('common.image'))}
      </span>
      <div className="pointer-events-none flex max-w-0 shrink-0 items-center overflow-hidden opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:max-w-full group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:max-w-full group-focus-within:opacity-100 motion-reduce:transition-none">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="px-1.5 font-normal"
          disabled={busy || !present}
          onClick={() => onAction(row, 'edit')}
        >
          {t('followUp.edit')}
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="px-1.5 font-normal"
        disabled={busy || !present}
        onClick={() => onAction(row, 'steer')}
      >
        <CornerDownRight data-icon="inline-start" />
        {t('followUp.steer')}
      </Button>
    </motion.li>
  )
}

export function FollowUpQueue({ sessionId }: { sessionId: string | null }) {
  const messages = useSessionsStore((state) =>
    sessionId ? (state.runtime[sessionId]?.followUpMessages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const queueAction = useSessionsStore((state) => state.queueFollowUpAction)
  const nextId = useRef(0)
  const removedId = useRef<string | undefined>(undefined)
  const dismissedRows = useRef(new Set<string>())
  const actionInFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  const [rows, setRows] = useState<FollowUpRow[]>([])
  const listRef = useRef<HTMLUListElement>(null)
  const [listHeight, setListHeight] = useState(0)
  const reducedMotion = useReducedMotion()
  const t = useT()

  useLayoutEffect(() => {
    if (busy || followUpRowsMatch(rows, messages)) return
    const discardedId = removedId.current
    removedId.current = undefined
    setRows((previous) => reconcileFollowUpRows(
      previous,
      messages,
      () => `follow-up-${++nextId.current}`,
      discardedId
    ))
  }, [messages, busy, rows])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => setListHeight(Math.min(MAX_LIST_HEIGHT, list.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  const runAction = async (row: FollowUpRow, action: FollowUpAction) => {
    if (!sessionId || actionInFlight.current) return
    const current = useSessionsStore.getState().runtime[sessionId]?.followUpMessages ?? EMPTY_MESSAGES
    const index = rows.findIndex((item) => item.id === row.id)
    if (index < 0 || !followUpRowsMatch(rows, current)) return

    actionInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await queueAction(sessionId, index, action)
      if (action === 'dismiss') dismissedRows.current.add(row.id)
      removedId.current = row.id
    } catch (reason) {
      setError({ id: row.id, message: reason instanceof Error ? reason.message : t('followUp.failed') })
    } finally {
      actionInFlight.current = false
      setBusy(false)
    }
  }

  const visible = listHeight > 0

  return (
    <motion.div
      className="relative w-1/2 shrink-0"
      initial={{ height: 0 }}
      animate={{ height: visible ? listHeight + 22 : 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.26, ease: EASE }}
      aria-hidden={!visible}
      inert={!visible}
      data-slot="follow-up-queue"
    >
      <motion.div
        className="absolute inset-x-0 top-0 bottom-2 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-sm"
        initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
        animate={{ opacity: visible ? 1 : 0, y: visible || reducedMotion ? 0 : 12 }}
        transition={{ duration: reducedMotion ? 0 : 0.22, ease: EASE }}
      >
        <ScrollArea layoutScroll className="h-full min-h-0 [&_[data-slot=scroll-area-scrollbar]]:hidden [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
          <ul ref={listRef} aria-label={t('followUp.list')} className="relative flex flex-col gap-1">
            <AnimatePresence mode="sync" custom={dismissedRows.current}>
              {rows.map((row, index) => (
                <QueueRow
                  key={row.id}
                  row={row}
                  colorIndex={index}
                  busy={busy}
                  error={error?.id === row.id ? error.message : undefined}
                  onAction={(item, action) => void runAction(item, action)}
                  onExitComplete={() => {
                    dismissedRows.current.delete(row.id)
                  }}
                />
              ))}
            </AnimatePresence>
          </ul>
        </ScrollArea>
      </motion.div>
    </motion.div>
  )
}

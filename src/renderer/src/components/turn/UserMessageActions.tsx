/** User-message toolbar; Pi tree navigation edits/retries in place, forks create a separate session. */
import { useMemo, useState } from 'react'
import { Check, Copy, GitFork, MoreHorizontal, Pencil, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

export function UserMessageActions({
  text, timestamp, sessionId, turnId
}: {
  text: string
  timestamp: number
  sessionId?: string
  turnId?: string
}) {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const timestampFormat = useMemo(() => new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }), [locale])
  const fullTimestamp = timestampFormat.format(timestamp)
  const { copied, copy } = useCopyFeedback(text)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const busy = useSessionsStore((state) => sessionId
    ? Boolean(state.runtime[sessionId]?.isStreaming || state.runtime[sessionId]?.bashExecution)
    : false)
  const canChange = Boolean(sessionId && turnId && !turnId.startsWith('live:') && !busy && !pending)

  async function copyMessage(format: 'markdown' | 'plain' = 'markdown'): Promise<void> {
    try {
      await copy(format === 'plain' ? markdownToPlainText(text) : text)
    } catch (error) {
      toast.error(t('turn.messageActionFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async function change(action: 'edit' | 'retry' | 'fork'): Promise<void> {
    if (!sessionId || !turnId || !canChange) return
    setPending(true)
    try {
      const store = useSessionsStore.getState()
      if (action === 'fork') await store.forkSession(sessionId, turnId)
      else if (action === 'retry') await store.retryUserMessage(sessionId, turnId)
      else await store.viewBranch(sessionId, turnId, { restoreUserInput: true })
    } catch (error) {
      toast.error(t(action === 'fork' ? 'turn.forkFailed' : 'turn.messageActionFailed'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      data-slot="user-message-actions"
      className={cn(
        'flex h-7 items-center justify-end gap-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/user-message:opacity-100 group-focus-within/user-message:opacity-100',
        menuOpen && 'opacity-100'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={new Date(timestamp).toISOString()}
            tabIndex={0}
            aria-label={fullTimestamp}
            className="mr-2 rounded-sm text-xs tabular-nums outline-none focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring"
          >
            {clock.format(timestamp)}
          </time>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-none whitespace-nowrap">
          {fullTimestamp}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs"
            aria-label={t(copied ? 'common.copied' : 'common.copy')}
            disabled={!text} onClick={() => void copyMessage()}>
            {copied ? <Check /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t(copied ? 'common.copied' : 'common.copy')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs"
            aria-label={t('turn.retryMessage')} disabled={!canChange} onClick={() => void change('retry')}>
            <RotateCcw />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>{t('turn.retryMessage')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs"
            aria-label={t('turn.editMessage')} disabled={!canChange} onClick={() => void change('edit')}>
            <Pencil />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>{t('turn.editMessage')}</TooltipContent>
      </Tooltip>
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
            <DropdownMenuItem disabled={!text} onSelect={() => void copyMessage('markdown')}>
              <Copy />
              {t('turn.copyMarkdown')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!text} onSelect={() => void copyMessage('plain')}>
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
    </div>
  )
}

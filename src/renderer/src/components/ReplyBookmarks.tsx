/** Global reply library, grouped by conversation; jumps reuse branch navigation and the chat scroller. */
import { useEffect, useRef, useState } from 'react'
import { Bookmark, ChevronRight, Copy, MessageSquare, RotateCcw, X } from 'lucide-react'
import type { ReplyBookmark } from '../../../shared/bookmarks'
import { api } from '../ipc/api'
import { useT } from '../hooks/useT'
import { useBookmarksStore } from '../stores/bookmarks'
import { selectActiveSessionId, useSessionsStore } from '../stores/sessions'
import { failureMessage } from '../lib/ipc-error'
import { cn, hideScroll } from '../lib/utils'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from './ui/empty'
import { sidebarButtonSurface, sidebarRowSurface, sidebarSurfaceToggle } from './sidebar/sidebar-surface'
import { SidebarHoverHighlight } from './sidebar/SidebarHoverHighlight'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'

export function ReplyBookmarks({ onNavigate }: {
  onNavigate: (kind: 'project' | 'chat') => void
}) {
  const t = useT()
  const sessionId = useSessionsStore(selectActiveSessionId)
  const { items, ready, error, refresh, remove, pending } = useBookmarksStore()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const visitRequest = useRef(0)
  useEffect(() => () => { visitRequest.current++ }, [])
  useEffect(() => {
    void refresh()
    return api.bookmarks.onChanged(() => void refresh())
  }, [refresh])

  async function visit(item: ReplyBookmark): Promise<void> {
    if (busy) return
    const request = ++visitRequest.current
    const current = () => request === visitRequest.current && useSessionsStore.getState().activeTabId === item.session.id
    setBusy(item.id)
    setActionError(null)
    try {
      await useSessionsStore.getState().openExisting(item.session, item.kind)
      if (!current()) return
      const opened = useSessionsStore.getState().openTabs.find(tab => tab.id === item.session.id)
      if (opened?.loadState !== 'ready') throw new Error(opened?.loadError ?? t('bookmarks.unavailable'))
      onNavigate(item.kind)
      let location = await api.bookmarks.locate(item.id)
      if (!current()) return
      if (location.turnIndex === null) {
        const runtime = useSessionsStore.getState().runtime[item.session.id]
        if (runtime?.isStreaming || runtime?.bashExecution || runtime?.isNavigatingBranch) throw new Error(t('bookmarks.busy'))
        if (!await useSessionsStore.getState().viewBranch(item.session.id, item.entryId)) throw new Error(t('bookmarks.unavailable'))
        if (!current()) return
        location = await api.bookmarks.locate(item.id)
      }
      if (!current()) return
      if (location.turnIndex === null) throw new Error(t('bookmarks.unavailable'))
      useBookmarksStore.getState().requestJump(item, location.turnIndex)
      setOpen(false)
    } catch (error) { if (request === visitRequest.current) setActionError(failureMessage(error)) }
    finally { setBusy(null) }
  }

  const groups = new Map<string, ReplyBookmark[]>()
  for (const item of items) {
    const group = groups.get(item.session.id) ?? []
    group.push(item)
    groups.set(item.session.id, group)
  }
  const ordered = [...groups].sort(([a], [b]) => Number(b === sessionId) - Number(a === sessionId))
  return (
    <Popover open={open} onOpenChange={next => {
      setOpen(next)
      if (next) { setActionError(null); void refresh() }
      else visitRequest.current++
    }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t('bookmarks.title')}
              className={cn('no-drag translate-y-px text-muted-foreground', sidebarSurfaceToggle)}>
              <Bookmark className={cn(open && 'fill-current')} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('bookmarks.title')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" collisionPadding={8} aria-label={t('bookmarks.title')}
        className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(32rem,calc(100vw-2rem))] flex-col gap-2 p-2">
        {error || actionError ? (
          <div className="flex items-center gap-2 px-2">
            <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">{actionError ?? error}</p>
            {error ? <Button variant="ghost" size="xs" onClick={() => void refresh()}>{t('common.retry')}</Button> : null}
          </div>
        ) : null}
        {!ready && !error ? <p className="p-4 text-center text-sm text-muted-foreground">{t('bookmarks.loading')}</p> : null}
        {ready && items.length === 0 ? (
          <Empty className="px-4 py-3">
            <EmptyMedia aria-hidden="true" data-bookmark-preview
              className="pointer-events-none mb-1 w-full max-w-sm select-none">
              <div className="w-full rounded-xl border border-border bg-muted/40 p-5 shadow-sm">
                <div className="flex flex-col gap-2">
                  <span className="h-2.5 w-full rounded-full bg-foreground/10" />
                  <span className="h-2.5 w-4/5 rounded-full bg-foreground/10" />
                  <span className="h-2.5 w-1/2 rounded-full bg-foreground/10" />
                </div>
                <div className="mt-5 flex items-center gap-4">
                  <Bookmark className="size-4 fill-current text-foreground" />
                  <Copy className="size-4 text-muted-foreground/50" />
                  <RotateCcw className="size-4 text-muted-foreground/50" />
                </div>
              </div>
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{t('bookmarks.empty')}</EmptyTitle>
              <EmptyDescription className="text-xs/relaxed">{t('bookmarks.emptyHint')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className={cn('min-h-0 overflow-y-auto', hideScroll)}>
            <SidebarHoverHighlight>
              {ordered.map(([id, rows]) => (
                <Collapsible key={`${id}:${id === sessionId}`} defaultOpen={id === sessionId}
                  className="group/bookmark-section mb-2 last:mb-0">
                  <h3 data-sidebar-hover-row className={cn('relative rounded-md', sidebarRowSurface(false))}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="xs"
                        className={cn('h-7 w-full min-w-0 justify-start gap-1.5 px-2 text-[0.7rem] font-normal text-muted-foreground hover:text-foreground focus-visible:text-foreground', sidebarButtonSurface)}>
                        <ChevronRight className="transition-transform duration-150 motion-reduce:transition-none group-data-[state=open]/bookmark-section:rotate-90" />
                        <span className="truncate">
                          {id === sessionId ? t('bookmarks.thisChat') : rows[0].session.name || rows[0].session.firstMessage || t('tabBar.newSession')}
                        </span>
                      </Button>
                    </CollapsibleTrigger>
                  </h3>
                  <CollapsibleContent>
                    {rows.map(item => (
                      <div key={item.id} data-sidebar-hover-row
                        className={cn('group/bookmark relative flex min-w-0 items-center gap-1 rounded-md px-1', sidebarRowSurface(false))}>
                        <Button variant="ghost" size="xs"
                          className={cn('h-9 min-w-0 flex-1 justify-start gap-2 px-1 text-left font-normal text-muted-foreground hover:text-foreground focus-visible:text-foreground', sidebarButtonSurface)}
                          disabled={busy !== null} onClick={() => void visit(item)} title={item.preview}>
                          <MessageSquare />
                          <span className="min-w-0 flex-1 truncate">{item.preview || t('bookmarks.imageReply')}</span>
                        </Button>
                        <Button variant="ghost" size="icon-xs"
                          className={cn('shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground', sidebarButtonSurface)}
                          disabled={busy !== null || pending[item.id]} aria-label={t('bookmarks.remove')}
                          onClick={() => { void remove(item.id).catch(error => setActionError(failureMessage(error))) }}>
                          <X />
                        </Button>
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </SidebarHoverHighlight>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

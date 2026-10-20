/** Native preview with guest-owned comments and explicit batch delivery to real Pi sessions. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft, ArrowRight, Camera, Check, ChevronDown, Copy, Crosshair, ExternalLink, LoaderCircle, MousePointer2, RotateCw, Send, Trash2 } from 'lucide-react'
import type { BrowserState } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { cn } from '../../lib/utils'
import { useComposerDraftsStore } from '../../stores/composer-drafts'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { useSessionsStore } from '../../stores/sessions'
import { addBrowserAnnotationsToDraft, browserPickerOptions } from './browser-annotations'
import { Alert, AlertDescription } from '../ui/alert'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { appendBrowserScreenshotDraft } from './browser-draft'
import { useBrowserBounds } from './useBrowserBounds'
import { decodeBrowserFrame, waitForBrowserPaint } from './browser-frame'

interface BrowserPanelProps {
  browserId: string
  targetSessionId: string | null
  active?: boolean
  onFocus?: () => void
}

export function BrowserPanel({ browserId, ...props }: BrowserPanelProps) {
  return <IndependentBrowserPanel key={browserId} browserId={browserId} {...props} />
}

function IndependentBrowserPanel({ browserId, targetSessionId, active = true, onFocus }: BrowserPanelProps) {
  const t = useT()
  const [state, setState] = useState<BrowserState | null>(null)
  const [address, setAddress] = useState('')
  const tabs = useSessionsStore((store) => store.openTabs)
  const browserCwd = tabs.find((tab) => tab.id === browserId)?.cwd || null
  // Inside a project only the browser's own worktree is a sensible target; chat-home browsers keep every session.
  const destinations = tabs.filter((tab) => browserCwd ? tab.kind === 'project' && tab.cwd === browserCwd : tab.kind === 'project' || tab.kind === 'chat')
  const [frozen, setFrozen] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const latest = useRef<BrowserState | null>(null)
  const alive = useRef(true)
  const enabled = useRef(active)
  enabled.current = active
  const focus = useRef(onFocus)
  focus.current = onFocus
  const composing = useRef(false)
  // Invalidate captures even if the target switches away and back before capture completes.
  const target = useRef({ id: targetSessionId, revision: 0 })
  if (target.current.id !== targetSessionId) target.current = { id: targetSessionId, revision: target.current.revision + 1 }
  const generation = useRef(0)
  const report = useCallback((reason: unknown) => {
    if (alive.current) setError(failureMessage(reason))
    else console.error('Browser preview:', reason)
  }, [])
  const invalidateCapture = useCallback(() => {
    generation.current++
  }, [])

  useEffect(() => {
    alive.current = true
    let pushed = false
    let disposed = false
    const accept = (next: BrowserState) => {
      if (next.browserId !== browserId) return
      const previous = latest.current
      if (previous && (previous.documentId !== next.documentId || previous.url !== next.url || (!previous.loading && next.loading))) invalidateCapture()
      latest.current = next
      setState(next)
      if (!previous || previous.url !== next.url) setAddress(next.url)
    }
    const offState = api.browser.onState((next) => {
      if (next.browserId !== browserId || disposed) return
      pushed = true
      if (next.focused && enabled.current) focus.current?.()
      accept(next)
    })
    void api.browser.getState(browserId).then((next) => {
      if (!disposed && !pushed) accept(next)
    }).catch(report)
    return () => {
      disposed = true
      alive.current = false
      generation.current++
      offState()
    }
  }, [browserId, invalidateCapture, report])

  useEffect(() => {
    if (!active) invalidateCapture()
  }, [active, invalidateCapture])
  const freeze = useCallback(async (frame: string | null, signal: AbortSignal) => {
    if (frame !== null) await decodeBrowserFrame(frame, signal)
    if (!alive.current || signal.aborted) return
    // Commit the decoded placeholder before its paint barrier; setState alone is not a DOM handoff.
    flushSync(() => setFrozen(frame))
    if (frame !== null) await waitForBrowserPaint(signal)
  }, [])
  useBrowserBounds(browserId, active && !!state?.url, viewport, report, freeze)

  const pickerOptions = useCallback(() => browserPickerOptions({
    comment: t('browser.commentPlaceholder'), add: t('browser.addMark'),
    cancel: t('browser.cancel'), remove: t('browser.removeMark'), update: t('browser.updateMark')
  }), [t])
  useEffect(() => {
    const sync = () => {
      if (!alive.current || !latest.current?.url) return
      // Theme changes interrupt picking just like a material reveal, but keep saved markers.
      void api.browser.setSelecting(browserId, false, pickerOptions()).catch(report)
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-palette', 'data-surface-style'] })
    sync()
    return () => observer.disconnect()
  }, [browserId, state?.documentId, pickerOptions, report])

  const run = (operation: () => Promise<void>) => {
    setError(null)
    setBusy(true)
    void operation().catch(report).finally(() => { if (alive.current) setBusy(false) })
  }
  const navigate = (operation: () => Promise<void>) => {
    invalidateCapture()
    run(operation)
  }
  const annotations = state?.annotations ?? []
  const selectedDestination = destinations.find((tab) => tab.id === targetSessionId)
  const [menuOpen, setMenuOpen] = useState(false)
  const addToDraft = (sessionId: string) => {
    if (sending || !annotations.length) return
    const batch = [...annotations]
    setSending(true)
    setError(null)
    void addBrowserAnnotationsToDraft(browserId, sessionId, batch).catch(report).finally(() => { if (alive.current) setSending(false) })
  }
  const addToNewChat = () => {
    const cwd = browserCwd
    if (sending || !annotations.length) return
    const batch = [...annotations]
    setSending(true)
    setError(null)
    void (async () => {
      const store = useSessionsStore.getState()
      const created = cwd ? await store.newSession(cwd) : await store.newChat()
      if (!created) throw new Error(t('browser.noSessions'))
      useSessionsStore.getState().setBrowserTarget(browserId, created)
      await addBrowserAnnotationsToDraft(browserId, created, batch)
    })().catch(report).finally(() => { if (alive.current) setSending(false) })
  }
  const capture = () => run(async () => {
    const destination = target.current
    if (!destination.id) return
    const documentId = latest.current?.documentId
    const started = generation.current
    const screenshot = await api.browser.capture(browserId)
    if (!alive.current || !enabled.current || target.current !== destination || generation.current !== started || latest.current?.documentId !== documentId) return
    const drafts = useComposerDraftsStore.getState()
    drafts.restoreDraft(destination.id, appendBrowserScreenshotDraft(drafts.drafts[destination.id], screenshot))
  })
  const iconButton = (label: string, icon: ReactNode, action: () => void, disabled = false, pressed?: boolean, hint = label) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-pressed={pressed} className={cn('[&_svg]:size-3.5!', pressed && 'bg-glass-prompt-foreground/12 text-glass-prompt-foreground solid:bg-accent solid:text-accent-foreground')} disabled={busy || disabled} onClick={action}>{icon}</Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('tabBar.newBrowser')} hidden={!active}>
      <form className="flex shrink-0 items-center gap-0.5 border-b border-glass-card-border bg-glass-card-background px-2 py-1.5 text-xs text-glass-prompt-foreground solid:border-border solid:bg-muted/50 solid:text-foreground" onSubmit={(event) => {
        event.preventDefault()
        if (address.trim() && !busy && !composing.current) navigate(() => api.browser.navigate(browserId, address.trim()))
      }}>
        {iconButton(t('browser.back'), <ArrowLeft />, () => navigate(() => api.browser.back(browserId)), !state?.canGoBack)}
        {iconButton(t('browser.forward'), <ArrowRight />, () => navigate(() => api.browser.forward(browserId)), !state?.canGoForward)}
        {iconButton(t('browser.reload'), <RotateCw className={busy || state?.loading ? 'animate-spin' : undefined} />, () => navigate(() => api.browser.reload(browserId)), !state?.url)}
        {iconButton(t('browser.select'), <MousePointer2 />, () => run(() => api.browser.setSelecting(browserId, !state?.selecting, pickerOptions())), !state?.url || state.loading || !!state.error, state?.selecting ?? false)}
        {iconButton(t('browser.screenshot'), <Camera />, capture, !targetSessionId || !state?.url || state.loading || !!state.error, undefined, t(targetSessionId ? 'browser.screenshot' : 'browser.noTarget'))}
        {state?.annotations.length ? <>
          <Badge variant="secondary" className="h-5 min-w-5 px-1.5 text-xs" aria-label={t('browser.marksCount', { n: state.annotations.length })}>{state.annotations.length}</Badge>
          {iconButton(t('browser.sendMarks'), sending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Send />,
            () => selectedDestination ? addToDraft(selectedDestination.id) : setMenuOpen(true), sending, undefined,
            selectedDestination ? t('browser.sendMarksTo', { title: selectedDestination.title }) : t('browser.chooseSession'))}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <Tooltip open={menuOpen ? false : undefined}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t('browser.chooseSession')} disabled={sending}><ChevronDown className="size-3.5" /></Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('browser.chooseSession')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{t('browser.currentChat')}</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="w-64" sideOffset={8}>
                    {destinations.length ? destinations.map((tab) => <DropdownMenuItem key={tab.id} onSelect={() => useSessionsStore.getState().setBrowserTarget(browserId, tab.id)}>
                      {tab.id === selectedDestination?.id ? <Check /> : null}<span className="min-w-0 truncate">{tab.title}</span>
                    </DropdownMenuItem>) : <DropdownMenuItem disabled>{t('browser.noSessions')}</DropdownMenuItem>}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={addToNewChat}>{t('browser.newChat')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {iconButton(t('browser.clearMarks'), <Trash2 />, () => run(() => api.browser.removeAnnotations(browserId, state.annotations.map((mark) => mark.id))))}
        </> : null}
        <Input aria-label={t('browser.address')} placeholder={t('browser.address')} value={address} onChange={(event) => setAddress(event.target.value)}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
          }}
          className="h-7 min-w-0 flex-1 rounded-md px-2 text-xs md:text-xs border-glass-card-border bg-glass-prompt-foreground/4! solid:border-input solid:bg-background! solid:dark:bg-input/30!" />
        <div className="flex shrink-0 items-center gap-1">
          {iconButton(t('browser.copyUrl'), <Copy />, () => run(() => api.browser.copyUrl(browserId)), !state?.url)}
          {iconButton(t('browser.openExternal'), <ExternalLink />, () => run(() => api.browser.openExternal(browserId)), !state?.url)}
          {iconButton(t('browser.inspect'), <Crosshair />, () => run(() => api.browser.inspect(browserId)), !state?.url, state?.devtools ?? false)}
        </div>
        <span className="sr-only" role="status">{busy || state?.loading || (!state && !error) ? t('browser.loading') : state?.title}</span>
      </form>
      {error || state?.error ? <Alert variant="destructive" className="mx-2 mt-2 w-auto text-xs"><AlertDescription>{error || state?.error}</AlertDescription></Alert> : null}
      <div ref={viewport} data-browser-viewport className="min-h-0 flex-1 overflow-hidden">
        {frozen && state?.url ? <img src={frozen} alt="" draggable={false} className="pointer-events-none size-full object-contain object-top select-none" /> : null}
        {!state?.url ? <p className="p-4 text-xs text-muted-foreground">{t('browser.empty')}</p> : null}
      </div>
    </section>
  )
}

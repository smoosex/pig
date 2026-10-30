/** Global browser history, newest first by day. Main owns the list; this dialog only reads pages of it. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { BrowserHistoryCursor, BrowserHistoryEntry } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { useSettingsStore } from '../../stores/settings'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { HistoryIcon } from './HistoryIcon'

const PAGE_SIZE = 50
/** Re-reads after a change cover what is already shown, up to the host's page limit. */
const MAX_PAGE = 100
const SEARCH_DELAY_MS = 150

export interface BrowserHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenUrl: (url: string) => void
}

export function BrowserHistoryDialog(props: BrowserHistoryDialogProps) {
  return props.open ? <BrowserHistorySession {...props} /> : null
}

function startOfDay(time: number): number {
  const day = new Date(time)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}

function BrowserHistorySession({ onOpenChange, onOpenUrl }: BrowserHistoryDialogProps) {
  const t = useT()
  const locale = useSettingsStore((state) => state.locale)
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<BrowserHistoryEntry[]>([])
  const [next, setNext] = useState<BrowserHistoryCursor | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState<boolean | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  // Each read supersedes earlier ones, so a slow page cannot land over newer results.
  const generation = useRef(0)
  const shown = useRef(0)
  shown.current = entries.length

  useEffect(() => {
    const timer = setTimeout(() => setSearch(text), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text])

  const read = useCallback((limit: number) => {
    const current = ++generation.current
    setLoading(true)
    void api.browser.listHistory(search, null, limit).then((page) => {
      if (current !== generation.current) return
      setEntries(page.entries)
      setNext(page.next)
      setError(null)
    }).catch((reason) => {
      if (current === generation.current) setError(failureMessage(reason))
    }).finally(() => {
      if (current === generation.current) setLoading(false)
    })
  }, [search])

  useEffect(() => { read(PAGE_SIZE) }, [read])
  useEffect(() => {
    const readRecording = () => {
      void api.browser.getHistoryRecording().then(setRecording).catch((reason) => setError(failureMessage(reason)))
    }
    readRecording()
    // Other tabs keep browsing while this is open; refresh what is shown rather than appending blindly.
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.browser.onHistoryChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        readRecording()
        read(Math.min(MAX_PAGE, Math.max(PAGE_SIZE, shown.current)))
      }, SEARCH_DELAY_MS)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [read])

  const more = () => {
    if (!next || loading) return
    const current = ++generation.current
    setLoading(true)
    void api.browser.listHistory(search, next, PAGE_SIZE).then((page) => {
      if (current !== generation.current) return
      setEntries((previous) => [...previous, ...page.entries])
      setNext(page.next)
    }).catch((reason) => {
      if (current === generation.current) setError(failureMessage(reason))
    }).finally(() => {
      if (current === generation.current) setLoading(false)
    })
  }

  const act = (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    void operation().catch((reason) => setError(failureMessage(reason))).finally(() => setBusy(false))
  }
  const remove = (url: string) => {
    setEntries((previous) => previous.filter((entry) => entry.url !== url))
    act(async () => {
      try { await api.browser.removeHistory(url) } catch (reason) {
        read(Math.min(MAX_PAGE, Math.max(PAGE_SIZE, shown.current + 1)))
        throw reason
      }
    })
  }

  const groups = useMemo(() => {
    const today = startOfDay(Date.now())
    const dayFormat = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    const result: { day: number; label: string; entries: BrowserHistoryEntry[] }[] = []
    for (const entry of entries) {
      const day = startOfDay(entry.lastVisitAt)
      let group = result.at(-1)
      if (group?.day !== day) {
        const label = day === today ? t('browser.historyToday') : day === startOfDay(today - 1) ? t('browser.historyYesterday') : dayFormat.format(day)
        group = { day, label, entries: [] }
        result.push(group)
      }
      group.entries.push(entry)
    }
    return result
  }, [entries, locale, t])
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), [locale])

  return <Dialog open onOpenChange={(open) => { if (!busy) onOpenChange(open) }}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{t(confirmClear ? 'browser.historyConfirmClear' : 'browser.history')}</DialogTitle>
        <DialogDescription>{t(confirmClear ? 'browser.historyClearWarning' : 'browser.historyDescription')}</DialogDescription>
      </DialogHeader>
      {confirmClear ? <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => setConfirmClear(false)}>{t('browser.cancel')}</Button>
        <Button variant="destructive" disabled={busy} onClick={() => act(async () => {
          await api.browser.clearHistory()
          setConfirmClear(false)
        })}>{busy ? <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" /> : null}{t('browser.historyClear')}</Button>
      </DialogFooter> : <>
        <div className="flex items-center gap-3">
          <Input autoFocus aria-label={t('browser.historySearch')} placeholder={t('browser.historySearch')} value={text}
            onChange={(event) => setText(event.target.value)} className="h-8 min-w-0 flex-1 text-xs md:text-xs" />
          <div className="flex shrink-0 items-center gap-2">
            <Switch id="browser-history-recording" size="sm" checked={recording ?? false} disabled={recording === null || busy}
              onCheckedChange={(enabled) => act(async () => {
                await api.browser.setHistoryRecording(enabled)
                setRecording(enabled)
              })} />
            <Label htmlFor="browser-history-recording" className="text-xs font-normal">{t('browser.historyRecording')}</Label>
          </div>
        </div>
        {recording === false ? <p className="text-xs text-muted-foreground">{t('browser.historyPaused')}</p> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="-mx-2 min-h-40 flex-1 overflow-y-auto px-2" aria-busy={loading}>
          {groups.map((group) => <section key={group.day} aria-label={group.label} className="pb-2">
            <h3 className="py-1 text-xs font-medium text-muted-foreground">{group.label}</h3>
            <ul>
              {group.entries.map((entry) => <li key={entry.url} className="group/history flex items-center gap-1 rounded-md hover:bg-glass-prompt-foreground/8 solid:hover:bg-accent solid:hover:text-accent-foreground">
                <button type="button" title={entry.url} className="flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-hidden focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-focus-ring"
                  onClick={() => {
                    onOpenUrl(entry.url)
                    onOpenChange(false)
                  }}>
                  <span className="w-10 shrink-0 text-muted-foreground tabular-nums">{clock.format(entry.lastVisitAt)}</span>
                  <HistoryIcon icon={entry.icon} />
                  <span className="min-w-0 truncate">{entry.title || entry.url}</span>
                  <span className="min-w-0 shrink-[2] truncate opacity-60">{hostOf(entry.url)}</span>
                </button>
                <Button variant="ghost" size="icon-xs" aria-label={t('browser.historyRemove')} title={t('browser.historyRemove')} disabled={busy}
                  className="opacity-0 group-hover/history:opacity-100 focus-visible:opacity-100" onClick={() => remove(entry.url)}><X /></Button>
              </li>)}
            </ul>
          </section>)}
          {!loading && !entries.length ? <p className="py-8 text-center text-xs text-muted-foreground">{t(search.trim() ? 'browser.historyNoMatches' : 'browser.historyEmpty')}</p> : null}
          {loading ? <p role="status" className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{t('browser.loading')}</p> : null}
          {next && !loading ? <div className="flex justify-center py-2"><Button variant="ghost" size="sm" onClick={more}>{t('browser.historyMore')}</Button></div> : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={busy || (!entries.length && !search.trim())} onClick={() => setConfirmClear(true)}>{t('browser.historyClear')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t('browser.cookieClose')}</Button>
        </DialogFooter>
      </>}
    </DialogContent>
  </Dialog>
}

/** Cookie metadata only: each open owns its requests; mutations and refresh failures remain separate. */
import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RotateCw } from 'lucide-react'
import type { BrowserCookiePreview, BrowserCookieScope, BrowserCookieSources } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { cn } from '../../lib/utils'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

export interface CookieImportDialogProps {
  browserId: string
  url: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Reject on refresh failure; the dialog reports it separately from a successful mutation. */
  onChanged: () => Promise<void>
}

export function CookieImportDialog(props: CookieImportDialogProps) {
  return props.open ? <CookieImportSession key={props.browserId} {...props} /> : null
}

function CookieImportSession({ browserId, url, onOpenChange, onChanged }: CookieImportDialogProps) {
  const t = useT()
  const [sources, setSources] = useState<{ url: string; data: BrowserCookieSources } | null>(null)
  const [source, setSource] = useState('')
  const [scope, setScope] = useState<BrowserCookieScope>('site')
  const [preview, setPreview] = useState<{ url: string; source: string; scope: BrowserCookieScope; data: BrowserCookiePreview } | null>(null)
  const [listing, setListing] = useState(true)
  const [reading, setReading] = useState(false)
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [result, setResult] = useState<{ partial: boolean; text: string } | null>(null)
  const [confirm, setConfirm] = useState<'all' | 'clear' | null>(null)
  const [busy, setBusy] = useState<'import' | 'clear' | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    let current = true
    setListing(true)
    setSources(null)
    setPreview(null)
    setConfirm(null)
    setError(null)
    void api.browser.listCookieSources(browserId).then((data) => {
      if (!current) return
      setSources({ url, data })
      setSource((previous) => data.sources.some((item) => item.id === previous) ? previous : data.sources[0]?.id ?? '')
    }).catch((reason) => { if (current) setError(failureMessage(reason)) })
      .finally(() => { if (current) setListing(false) })
    return () => { current = false }
  }, [browserId, url, retry])

  const listingData = sources?.url === url ? sources.data : null
  const site = listingData?.site ?? null
  useEffect(() => {
    let current = true
    setPreview(null)
    setConfirm(null)
    setReading(false)
    if (!listingData?.supported || !source || (scope === 'site' && !site)) return
    setError(null)
    setReading(true)
    void api.browser.previewCookies(browserId, source, scope).then((data) => {
      if (current) setPreview({ url, source, scope, data })
    }).catch((reason) => { if (current) setError(failureMessage(reason)) })
      .finally(() => { if (current) setReading(false) })
    return () => { current = false }
  }, [browserId, url, source, scope, listingData, site])

  const valid = preview?.url === url && preview.source === source && preview.scope === scope
    && (scope === 'all' || (!!site && preview.data.site === site)) ? preview.data : null
  const canImport = !!valid && valid.count > 0 && !listing && !reading && !busy
  const mutate = async (kind: 'import' | 'clear') => {
    if (locked.current || (kind === 'import' ? !canImport : !site || listing)) return
    locked.current = true
    setBusy(kind)
    setConfirm(null)
    setError(null)
    setRefreshError(null)
    setResult(null)
    try {
      let changed = 0
      if (kind === 'import' && valid) {
        const next = await api.browser.importCookies(browserId, source, scope, valid.site)
        changed = next.imported
        if (alive.current) setResult({ partial: next.failed > 0, text: t('browser.cookieImportResult', { imported: next.imported, failed: next.failed, ...next.skipped }) })
      } else if (kind === 'clear' && site) {
        const next = await api.browser.clearSiteCookies(browserId, site)
        changed = next.removed
        if (alive.current) setResult({ partial: next.failed > 0, text: t('browser.cookieClearResult', { removed: next.removed, failed: next.failed }) })
      }
      if (changed > 0) {
        try { await onChanged() } catch (reason) {
          if (alive.current) setRefreshError(failureMessage(reason))
        }
      }
    } catch (reason) {
      if (alive.current) setError(failureMessage(reason))
    } finally {
      locked.current = false
      if (alive.current) { setBusy(null); setPreview(null) }
    }
  }
  const changeScope = (value: string) => {
    if (value !== 'site' && value !== 'all') return
    setPreview(null)
    setResult(null)
    setScope(value)
  }
  const loading = listing || reading
  const skipped = valid ? valid.skipped.expired + valid.skipped.partitioned + valid.skipped.unsupported : 0
  const status = busy === 'import' ? 'browser.cookieImporting' : busy === 'clear' ? 'browser.cookieClearing' : loading ? 'browser.cookieReading' : null
  return <Dialog open onOpenChange={(open) => { if (!locked.current) onOpenChange(open) }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md" showCloseButton={!busy} onEscapeKeyDown={(event) => { if (locked.current) event.preventDefault() }} onInteractOutside={(event) => { if (locked.current) event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle>{t(confirm === 'all' ? 'browser.cookieConfirmAll' : confirm === 'clear' ? 'browser.cookieConfirmClear' : 'browser.cookieImport')}</DialogTitle>
        <DialogDescription>{t(confirm === 'all' ? 'browser.cookieAllWarning' : confirm === 'clear' ? 'browser.cookieClearWarning' : 'browser.cookieDescription', { site: site ?? '' })}</DialogDescription>
      </DialogHeader>
      {confirm ? <DialogFooter>
        <Button variant="outline" onClick={() => setConfirm(null)}>{t('browser.cancel')}</Button>
        <Button variant={confirm === 'clear' ? 'destructive' : 'default'} disabled={confirm === 'all' ? !canImport : !site || !!busy} onClick={() => void mutate(confirm === 'clear' ? 'clear' : 'import')}>{t('browser.cookieConfirm')}</Button>
      </DialogFooter> : <>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Select value={source} disabled={!!busy || listing || !listingData?.supported} onValueChange={(value) => { setPreview(null); setResult(null); setSource(value) }}>
              <SelectTrigger size="sm" aria-label={t('browser.cookieSource')} className="min-w-0 flex-1"><SelectValue placeholder={t('browser.cookieSource')} /></SelectTrigger>
              <SelectContent>{listingData?.sources.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="ghost" size="icon-sm" title={t('browser.cookieRetry')} disabled={!!busy || loading} onClick={() => setRetry((value) => value + 1)}>
              <RotateCw className={cn(loading && 'animate-spin motion-reduce:animate-none')} /><span className="sr-only">{t('browser.cookieRetry')}</span>
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <ToggleGroup type="single" variant="outline" size="sm" value={scope} disabled={!!busy} aria-label={t('browser.cookieScope')} onValueChange={changeScope}>
              <ToggleGroupItem value="site" disabled={!site}>{t('browser.cookieSite')}</ToggleGroupItem>
              <ToggleGroupItem value="all">{t('browser.cookieAll')}</ToggleGroupItem>
            </ToggleGroup>
            {!site && !listing ? <p className="min-w-0 text-xs text-muted-foreground">{t('browser.cookieNoSite')}</p> : site ? <p className="min-w-0 truncate text-xs text-muted-foreground" title={site}>{site}</p> : null}
          </div>
        </div>
        {listingData && (!listingData.supported || !listingData.sources.length) ? <Alert><AlertDescription>{t(listingData.supported ? 'browser.cookieNoSources' : 'browser.cookieUnsupported')}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {status || valid ? <section aria-label={t('browser.cookiePreview')} className="flex flex-col overflow-hidden rounded-lg border border-glass-border text-xs solid:border-border">
          <div className="flex items-center justify-between gap-2 border-b border-glass-border px-3 py-2 solid:border-border">
            {status ? <p role="status" className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{t(status)}</p>
              : valid ? <p className="font-medium">{t('browser.cookieCount', { n: valid.count })}</p> : null}
            {valid && !status && skipped > 0 ? <span className="text-muted-foreground" title={t('browser.cookieSkipped', { ...valid.skipped })}>{t('browser.cookieSkippedShort', { n: skipped })}</span> : null}
          </div>
          {valid && !status && valid.domains.length ? <ul className="max-h-44 overflow-y-auto py-1">{valid.domains.map((item) => <li key={item.domain} className="flex justify-between gap-4 px-3 py-1"><span className="min-w-0 truncate" title={item.domain}>{item.domain}</span><span className="text-muted-foreground tabular-nums">{item.count}</span></li>)}</ul> : null}
        </section> : null}
        {result ? <Alert variant={result.partial ? 'destructive' : 'default'}><AlertTitle>{t(result.partial ? 'browser.cookiePartial' : 'browser.cookieDone')}</AlertTitle><AlertDescription>{result.text}</AlertDescription></Alert> : null}
        {refreshError ? <Alert variant="destructive"><AlertTitle>{t('browser.cookieRefreshFailed')}</AlertTitle><AlertDescription>{refreshError}</AlertDescription></Alert> : null}
        <p className="text-xs text-muted-foreground">{t('browser.cookiePermissions')}</p>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={!site || listing || !!busy} onClick={() => setConfirm('clear')}>{t('browser.cookieClear')}</Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" disabled={!!busy} onClick={() => onOpenChange(false)}>{t('browser.cookieClose')}</Button>
            <Button disabled={!canImport} onClick={() => scope === 'all' ? setConfirm('all') : void mutate('import')}>{t('browser.cookieImportAction')}</Button>
          </div>
        </DialogFooter>
      </>}
    </DialogContent>
  </Dialog>
}

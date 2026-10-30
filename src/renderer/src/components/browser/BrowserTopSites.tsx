/** Most visited sites on a blank tab; main ranks them, this only lays them out and follows changes. */
import { useEffect, useState } from 'react'
import type { BrowserHistoryEntry } from '../../../../shared/browser'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { Button } from '../ui/button'
import { HistoryIcon } from './HistoryIcon'

const REFRESH_DELAY_MS = 300

function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return url }
}

export function BrowserTopSites({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const t = useT()
  const [sites, setSites] = useState<BrowserHistoryEntry[]>([])

  useEffect(() => {
    let current = true
    const read = () => {
      void api.browser.topSites(8).then((next) => { if (current) setSites(next) })
        .catch((error) => console.error('Browser top sites failed:', error))
    }
    read()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.browser.onHistoryChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(read, REFRESH_DELAY_MS)
    })
    return () => {
      current = false
      clearTimeout(timer)
      off()
    }
  }, [])

  // The hint only teaches an empty browser; once there are sites the tiles say enough.
  if (!sites.length) return <p className="p-4 text-xs text-muted-foreground">{t('browser.empty')}</p>
  return <div className="flex size-full flex-col items-center overflow-y-auto p-6 pt-[12vh]">
    <div className="w-full max-w-lg">
      <section aria-label={t('browser.topSites')} className="grid grid-cols-4 gap-1">
        {sites.map((site) => <Button key={site.url} type="button" variant="ghost" title={site.url}
          className="h-auto min-w-0 flex-col gap-1.5 px-1 py-2.5 text-xs font-normal" onClick={() => onOpenUrl(site.url)}>
          <span className="flex size-9 items-center justify-center rounded-lg border border-glass-card-border bg-glass-prompt-foreground/4 solid:border-border solid:bg-muted">
            <HistoryIcon icon={site.icon} className="size-4.5" />
          </span>
          <span className="w-full truncate">{site.title || hostOf(site.url)}</span>
        </Button>)}
      </section>
    </div>
  </div>
}

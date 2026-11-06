/** Long-term admission has its own model selector and a paged, UI-only inspector. */
import { useEffect, useRef, useState } from 'react'
import type { LongTermEvidence, LongTermPage, LongTermSettings } from '../../../../shared/long-term-memory'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { Badge } from '../ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { ModelThinkingPicker, supportedThinking } from './ModelThinkingPicker'

export function LongTermMemorySettings({ onBusyChange }: {
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<LongTermSettings>()
  const current = useRef<LongTermSettings>(undefined)
  const confirmed = useRef<LongTermSettings>(undefined)
  const writes = useRef(Promise.resolve())
  const revision = useRef(0)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const models = useModelCatalogStore(state => state.models)
  const model = models.find(item => item.provider === draft?.model?.provider && item.id === draft?.model?.id) ?? null
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => {
    let cancelled = false
    mounted.current = true
    void api.getMemorySettings().then(settings => {
      if (cancelled) return
      const value = settings.longTerm ?? { enabled: false }
      current.current = confirmed.current = value
      setDraft(value)
    }, failure => { if (!cancelled) setError(failureMessage(failure)) })
    return () => { cancelled = true; mounted.current = false }
  }, [])
  const change = (update: (value: LongTermSettings) => LongTermSettings) => {
    if (!current.current) return
    const next = update(current.current)
    if (JSON.stringify(next) === JSON.stringify(current.current)) return
    const request = ++revision.current
    current.current = next
    setDraft(next); setBusy(true); setError(undefined)
    // Model and thinking selections can overlap. Serialize full snapshots, and never let an
    // earlier reply replace a newer selection; failures re-read storage because applying the
    // configuration can fail after the write has already succeeded.
    writes.current = writes.current.then(async () => {
      try {
        const settings = await api.setMemorySettings({ longTerm: next })
        confirmed.current = settings.longTerm ?? { enabled: false }
        if (request === revision.current) {
          current.current = confirmed.current
          if (mounted.current) setDraft(confirmed.current)
        }
      } catch (failure) {
        let message = failureMessage(failure)
        try {
          confirmed.current = (await api.getMemorySettings()).longTerm ?? { enabled: false }
        } catch (readFailure) {
          message += `\n${failureMessage(readFailure)}`
        }
        if (request === revision.current) {
          current.current = confirmed.current
          if (mounted.current) { setDraft(confirmed.current); setError(message) }
        }
      } finally {
        if (mounted.current && request === revision.current) setBusy(false)
      }
    })
  }
  return <div className="flex flex-col gap-3">
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <SettingsCard>
      <SettingsRow title={t('longTerm.enabled')} description={t('longTerm.enabledHint')}>
        <Switch aria-label={t('longTerm.enabled')} disabled={!draft} checked={draft?.enabled ?? false}
          onCheckedChange={enabled => change(value => ({ ...value, enabled }))} />
      </SettingsRow>
      <SettingsRow title={t('longTerm.model')} description={t('longTerm.modelHint')}>
        <ModelThinkingPicker model={model} models={models}
          label={draft?.model ? `${draft.model.provider}/${draft.model.id}` : undefined}
          thinking={draft?.model?.thinking ?? null}
          defaultOption={{ active: !draft?.model, description: t('longTerm.inherit'),
            onSelect: () => change(value => ({ enabled: value.enabled })) }}
          onModelChange={item => change(value => ({ ...value, model: { provider: item.provider, id: item.id,
            ...(supportedThinking(item, value.model?.thinking ?? null) ? { thinking: supportedThinking(item, value.model?.thinking ?? null)! } : {}) } }))}
          onThinkingChange={thinking => change(value => value.model ? { ...value, model: { ...value.model, thinking } } : value)} />
      </SettingsRow>
      <SettingsRow title={t('longTerm.browse')} description={t('longTerm.browseHint')}>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t('longTerm.browse')}</Button>
      </SettingsRow>
    </SettingsCard>
    <LongTermInspector open={open} onOpenChange={setOpen} />
  </div>
}

export function LongTermInspector({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const [kind, setKind] = useState<'candidates' | 'memories'>('memories')
  const [page, setPage] = useState<LongTermPage>({ candidates: [], memories: [], nextOffset: null })
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirm, setConfirm] = useState<string>()
  const [evidence, setEvidence] = useState<{ id: string; items: LongTermEvidence[] }>()
  const generation = useRef(0)
  const read = async (offset = 0) => {
    const request = ++generation.current
    setLoading(true); setError(undefined)
    try {
      const result = await api.longTermMemory.list(kind, offset)
      if (request !== generation.current) return
      setPage(previous => offset ? { candidates: [...previous.candidates, ...result.candidates],
        memories: [...previous.memories, ...result.memories], nextOffset: result.nextOffset } : result)
    } catch (failure) { if (request === generation.current) setError(failureMessage(failure)) }
    finally { if (request === generation.current) setLoading(false) }
  }
  useEffect(() => {
    setPage({ candidates: [], memories: [], nextOffset: null }); setConfirm(undefined); setEvidence(undefined)
    if (open) void read()
    return () => { generation.current++ }
  }, [open, kind])
  const forget = async (id: string) => {
    setDeleting(true); setError(undefined)
    try { await api.longTermMemory.forget(kind, id); setConfirm(undefined); setEvidence(undefined); await read() }
    catch (failure) { setError(failureMessage(failure)) }
    finally { setDeleting(false) }
  }
  const showEvidence = async (id: string) => {
    const request = generation.current
    try {
      const items = await api.longTermMemory.evidence(id)
      if (request === generation.current) setEvidence({ id, items })
    } catch (failure) { if (request === generation.current) setError(failureMessage(failure)) }
  }
  const items: (LongTermPage['memories'][number] | LongTermPage['candidates'][number])[] = kind === 'memories' ? page.memories : page.candidates
  return <Dialog open={open} onOpenChange={value => { if (!deleting) onOpenChange(value) }}>
    <DialogContent className="flex max-h-4/5 flex-col sm:max-w-3xl">
      <DialogHeader><DialogTitle>{t('longTerm.title')}</DialogTitle><DialogDescription>{t('longTerm.sourceHint')}</DialogDescription></DialogHeader>
      <div className="flex items-center justify-between gap-3">
        <Tabs value={kind} onValueChange={value => { if (!deleting) setKind(value as typeof kind) }}>
          <TabsList><TabsTrigger value="memories" disabled={deleting}>{t('longTerm.memories')}</TabsTrigger>
            <TabsTrigger value="candidates" disabled={deleting}>{t('longTerm.candidates')}</TabsTrigger></TabsList>
        </Tabs>
        <Button variant="outline" size="sm" disabled={loading || deleting} onClick={() => void read()}>{t('longTerm.refresh')}</Button>
      </div>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        {!items.length ? <p className="text-muted-foreground">{t(loading ? 'longTerm.loading' : 'longTerm.empty')}</p> : null}
        {items.map(item => <section key={item.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{t(`longTerm.${item.status}`)}</Badge>
            {'scope' in item ? <Badge variant="outline">{t(`longTerm.${item.scope}`)}</Badge> : null}
            <span className="text-xs text-muted-foreground">{new Date('sourceTime' in item ? item.sourceTime : item.recordedAt).toLocaleString()}</span>
          </div>
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
          <div className="flex gap-2">
            {'scope' in item ? <Button variant="ghost" size="sm" disabled={deleting} onClick={() => void showEvidence(item.id)}>{t('longTerm.source')}</Button> : null}
            <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirm(item.id)}>{t('longTerm.forget')}</Button>
          </div>
          {evidence && evidence.id === item.id ? <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(evidence.items, null, 2)}</pre> : null}
          {confirm === item.id ? <div className="flex flex-col gap-2">
            <p>{t('longTerm.forgetConfirm')}</p>
            <div className="flex gap-2"><Button variant="destructive" size="sm" disabled={deleting} onClick={() => void forget(item.id)}>{t('longTerm.confirm')}</Button>
              <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirm(undefined)}>{t('longTerm.cancel')}</Button></div>
          </div> : null}
        </section>)}
        {page.nextOffset !== null ? <Button variant="outline" disabled={loading || deleting} onClick={() => void read(page.nextOffset!)}>{t('longTerm.more')}</Button> : null}
      </div>
    </DialogContent>
  </Dialog>
}

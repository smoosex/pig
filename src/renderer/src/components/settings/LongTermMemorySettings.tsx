/** Direct Markdown inspection; no learning queue, classification or auxiliary model. */
import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { MemoryFile, MemoryFileListItem } from '../../../../shared/long-term-memory'
import { api } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { DreamSettings } from './DreamSettings'
import { MemoryFileTree } from './MemoryFileTree'

export function LongTermMemorySettings({ onBusyChange, onDirtyChange }: { onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const t = useT()
  const [enabled, setEnabled] = useState<boolean>()
  const [busy, setBusy] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [editorBusy, setEditorBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  useEffect(() => { let active = true
    setBusy(true); setError(undefined)
    void api.getMemorySettings().then(
      value => { if (active) setEnabled(value.fileMemory?.enabled ?? false) },
      failure => { if (active) { setEnabled(undefined); setError(failureMessage(failure)) } }
    ).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [reloadKey])
  useEffect(() => { onBusyChange?.(busy || editorBusy) }, [busy, editorBusy, onBusyChange])
  const change = async (value: boolean) => {
    setBusy(true); setError(undefined)
    try { setEnabled((await api.setMemorySettings({ fileMemory: { enabled: value } })).fileMemory?.enabled ?? false) }
    catch (failure) {
      setEnabled(undefined); setError(failureMessage(failure))
      try { setEnabled((await api.getMemorySettings()).fileMemory?.enabled ?? false) }
      catch (reloadFailure) { setError(`${failureMessage(failure)}\n${t('longTerm.reloadFailed', { error: failureMessage(reloadFailure) })}`) }
    }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-3">
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <SettingsCard>
      <SettingsRow title={t('longTerm.enabled')} description={enabled === undefined ? t('longTerm.stateUnknown') : t('longTerm.enabledHint')}>
        <div className="flex items-center gap-2">
          {enabled === undefined ? <Button variant="outline" size="sm" disabled={busy} onClick={() => setReloadKey(value => value + 1)}>{t('longTerm.reload')}</Button> : null}
          <Switch aria-label={t('longTerm.enabled')} disabled={enabled === undefined || busy} checked={enabled ?? false} onCheckedChange={value => void change(value)} />
        </div>
      </SettingsRow>
      <SettingsRow title={t('longTerm.browse')} description={t('longTerm.browseHint')}>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{t('longTerm.browse')}</Button>
      </SettingsRow>
      <DreamSettings enabled={enabled === true} />
    </SettingsCard>
    <LongTermInspector open={open} onOpenChange={setOpen} onBusyChange={setEditorBusy} onDirtyChange={onDirtyChange} />
  </div>
}

export function LongTermInspector({ open, onOpenChange, onBusyChange, onDirtyChange }: {
  open: boolean; onOpenChange: (open: boolean) => void
  onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void
}) {
  const t = useT()
  const [items, setItems] = useState<MemoryFileListItem[]>([])
  const [file, setFile] = useState<MemoryFile>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState<'discard' | 'delete'>()
  const pendingPath = useRef<string | undefined>(undefined)
  const generation = useRef(0)
  const dirty = !!file && file.content !== draft
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => { onDirtyChange?.(open && dirty) }, [open, dirty, onDirtyChange])
  const refresh = async () => {
    const id = ++generation.current
    setBusy(true); setError(undefined)
    try { const result = await api.longTermMemory.list(); if (id === generation.current) setItems(result) }
    catch (failure) { if (id === generation.current) setError(failureMessage(failure)) }
    finally { if (id === generation.current) setBusy(false) }
  }
  useEffect(() => {
    if (open) { setFile(undefined); setDraft(''); setConfirm(undefined); void refresh() }
    return () => { generation.current++ }
  }, [open])
  const load = async (path: string) => {
    setConfirm(undefined)
    const id = ++generation.current
    setBusy(true); setError(undefined)
    try { const next = await api.longTermMemory.read(path); if (id === generation.current) { setFile(next); setDraft(next.content) } }
    catch (failure) { if (id === generation.current) setError(failureMessage(failure)) }
    finally { if (id === generation.current) setBusy(false) }
  }
  const select = (path: string) => {
    if (busy || file?.path === path) return
    if (dirty) { pendingPath.current = path; setConfirm('discard') }
    else void load(path)
  }
  const close = (value: boolean) => {
    if (busy) return
    if (!value && dirty) { pendingPath.current = undefined; setConfirm('discard'); return }
    onOpenChange(value)
  }
  const save = async () => {
    if (!file || busy) return
    setBusy(true); setError(undefined)
    try { const next = await api.longTermMemory.save(file.path, draft, file.revision); setFile(next); setDraft(next.content) }
    catch (failure) { setError(failureMessage(failure)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!file || busy) return
    setBusy(true); setError(undefined)
    try {
      await api.longTermMemory.delete(file.path, file.revision)
      setFile(undefined); setDraft(''); setConfirm(undefined)
      await refresh()
    } catch (failure) { setError(failureMessage(failure)) }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={close}>
    <DialogContent confirmation={Boolean(confirm)} className="flex max-h-4/5 flex-col sm:max-w-3xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle className="pr-16">{t('longTerm.title')}</DialogTitle><DialogDescription>{t('longTerm.sourceHint')}</DialogDescription></DialogHeader>
      <Button variant="ghost" size="icon-sm" className="absolute top-4 right-12" aria-label={t('longTerm.refresh')} title={t('longTerm.refresh')} disabled={busy} onClick={() => void refresh()}><RotateCw /></Button>
      {error ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
      <div className="flex min-h-0 flex-1 gap-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex max-h-96 w-1/3 shrink-0 flex-col gap-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {!items.length ? <p className="text-sm text-muted-foreground">{t('longTerm.empty')}</p> : <MemoryFileTree files={items} selected={file?.path} disabled={busy} onSelect={select} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {file ? <>
            <p className="break-all text-sm">{file.path}</p>
            <Textarea aria-label={t('longTerm.editor')} disabled={busy} value={draft} onChange={event => setDraft(event.target.value)} className="min-h-64 flex-1 font-mono [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" />
          </> : <p className="text-sm text-muted-foreground">{t('longTerm.select')}</p>}
          {confirm ? <p className="text-sm">{t(confirm === 'delete' ? 'longTerm.deleteConfirm' : 'longTerm.discardConfirm')}</p> : null}
        </div>
      </div>
      <DialogFooter>
        {confirm ? <>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirm(undefined)}>{t('longTerm.cancel')}</Button>
          <Button variant="destructive" disabled={busy} onClick={() => {
            if (confirm === 'delete') { void remove(); return }
            setConfirm(undefined)
            if (pendingPath.current) void load(pendingPath.current)
            else { setFile(undefined); onOpenChange(false) }
          }}>{t('longTerm.confirm')}</Button>
        </> : <>
          {file ? <Button variant="destructive" className="mr-auto" disabled={busy} onClick={() => setConfirm('delete')}>{t('longTerm.delete')}</Button> : null}
          <Button variant="ghost" disabled={busy} onClick={() => close(false)}>{t('longTerm.cancel')}</Button>
          {file ? <Button disabled={busy || !dirty} onClick={() => void save()}>{t('longTerm.save')}</Button> : null}
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

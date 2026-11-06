import { failureMessage } from '../../lib/ipc-error'
/* Drafts own their original revisions independently of mood snapshots and other file saves. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { History, Info } from 'lucide-react'
import { PERSONA_FILES, type PersonaDocument, type PersonaMoodValues, type PersonaFileName, type PersonaSnapshot } from '../../../../shared/persona'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { ModelThinkingPicker, supportedThinking } from './ModelThinkingPicker'
import { ObserverUsageRow } from './ObserverUsage'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Field, FieldGroup, FieldLabel } from '../ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog'
import { Textarea } from '../ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SettingsCard, SettingsRow } from './SettingsFields'

type Draft = PersonaDocument & { saved: string }
type Drafts = Partial<Record<PersonaFileName, Draft>>

const FILE_HINTS = { 'SOUL.md': 'persona.soulHint', 'USER.md': 'persona.userHint' } as const
const FILE_TITLES = { 'SOUL.md': 'persona.soulTitle', 'USER.md': 'persona.userTitle' } as const

export interface PersonaSettingsProps {
  actionsContainer?: HTMLElement | null
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}

export function PersonaSettings({ actionsContainer, onDirtyChange, onBusyChange }: PersonaSettingsProps) {
  const t = useT()
  const [snapshot, setSnapshot] = useState<PersonaSnapshot | null>(null)
  const [drafts, setDrafts] = useState<Drafts>({})
  const [file, setFile] = useState<PersonaFileName>('SOUL.md')
  const [editing, setEditing] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const configureButton = useRef<HTMLButtonElement | null>(null)
  const models = useModelCatalogStore((state) => state.models)
  const [values, setValues] = useState<PersonaMoodValues>({ pleasantness: 0, activation: 0.5, energy: 0.5 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const locked = useRef(false)
  const dirty = Object.values(drafts).some((draft) => draft.content !== draft.saved)

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  function accept(next: PersonaSnapshot, replace: 'all' | PersonaFileName | null = null) {
    setSnapshot(next)
    setDrafts((previous) => {
      const result = { ...previous }
      for (const document of next.files) {
        const old = previous[document.name]
        if (replace === 'all' || replace === document.name || !old || old.content === old.saved) {
          result[document.name] = { ...document, saved: document.content }
        }
      }
      return result
    })
    setValues({ pleasantness: next.mood.pleasantness, activation: next.mood.activation, energy: next.mood.energy })
  }

  async function run(operation: () => Promise<PersonaSnapshot>, replace: 'all' | PersonaFileName | null = null) {
    if (locked.current) return false
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await operation()
      if (mounted.current) accept(next, replace)
      return true
    } catch (failure) {
      if (mounted.current) {
        setError(failureMessage(failure))
        if (snapshot) setValues({ pleasantness: snapshot.mood.pleasantness, activation: snapshot.mood.activation, energy: snapshot.mood.energy })
      }
      return false
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    // This request has its own lifetime so StrictMode's first reply cannot hydrate a remount.
    let current = true
    locked.current = true
    setBusy(true)
    void api.persona.get().then((next) => {
      if (current) accept(next, 'all')
    }, (failure) => {
      if (current) setError(failureMessage(failure))
    }).finally(() => {
      if (current) { locked.current = false; setBusy(false) }
    })
    return () => { current = false; mounted.current = false }
  }, [])

  // Our own writes already accept their reply; this covers changes from conversations. Unsaved file
  // drafts are kept, and only the newest reread may apply.
  useEffect(() => {
    let latest = 0
    return api.persona.onChanged(() => {
      const request = ++latest
      void api.persona.get().then((next) => {
        if (request === latest && mounted.current && !locked.current) accept(next)
      }, (failure) => {
        if (request === latest && mounted.current) setError(failureMessage(failure))
      })
    })
  }, [])

  const observer = snapshot?.mood.observer
  const observerModel = models.find((item) => item.provider === observer?.provider && item.id === observer?.modelId) ?? null
  const save = async () => {
    const draft = drafts[file]
    if (!draft || draft.content === draft.saved) return
    if (await run(() => api.persona.saveFile({ name: file, content: draft.content, revision: draft.revision }), file)) {
      setEditing(false)
    }
  }
  const closeEditor = () => {
    if (locked.current) return
    if (drafts[file]?.content !== drafts[file]?.saved) setConfirmDiscard(true)
    else setEditing(false)
  }
  // Keep editor state here while placing its triggers beside the parent tabs.
  const actions = <div className="flex items-center gap-2">
    {PERSONA_FILES.map(name => <Button key={name} size="sm" variant="outline" disabled={busy}
      aria-label={t('persona.configureFile', { file: t(FILE_TITLES[name]) })}
      onClick={event => {
        configureButton.current = event.currentTarget
        setFile(name)
        setError(null)
        setEditing(true)
      }}>{t(FILE_TITLES[name])}</Button>)}
  </div>
  const failure = error && <Alert variant="destructive"><AlertTitle>{t('persona.error')}</AlertTitle><AlertDescription><p>{error}</p><p>{t('persona.errorHint')}</p></AlertDescription></Alert>

  return (
    <div className="flex w-full flex-col gap-4" aria-busy={busy}>
      {!editing && failure}
      {!snapshot && busy && <p role="status">{t('persona.loading')}</p>}
      {snapshot && <>
        {actionsContainer === undefined ? actions : actionsContainer && createPortal(actions, actionsContainer)}
        <SettingsCard>
          <SettingsRow title={t('persona.mood')} description={snapshot.mood.feeling}>
            <Popover>
              <Tooltip><TooltipTrigger asChild><PopoverTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('persona.moodDetails')}><Info /></Button>
              </PopoverTrigger></TooltipTrigger><TooltipContent>{t('persona.moodDetails')}</TooltipContent></Tooltip>
              <PopoverContent align="end"><p>{snapshot.mood.description}</p></PopoverContent>
            </Popover>
          </SettingsRow>
          <p className="px-4 py-2 text-xs text-muted-foreground">{t('persona.styleHint')}</p>
          <FieldGroup className="px-4 py-3">
            {(['pleasantness', 'activation', 'energy'] as const).map((dimension) => (
              <Field key={dimension} data-disabled={busy}>
                <FieldLabel htmlFor={`persona-${dimension}`}>{t(`persona.${dimension}`)} · {values[dimension].toFixed(2)}</FieldLabel>
                <Slider id={`persona-${dimension}`} aria-label={t(`persona.${dimension}`)}
                  min={dimension === 'pleasantness' ? -1 : 0} max={1} step={0.01}
                  value={[values[dimension]]} disabled={busy}
                  onValueChange={([value]) => setValues((previous) => ({ ...previous, [dimension]: value }))}
                  onValueCommit={([value]) => void run(() => api.persona.setMood({ ...values, [dimension]: value }))} />
                <p className="text-xs text-muted-foreground">{t(`persona.${dimension}Hint`)}</p>
              </Field>
            ))}
          </FieldGroup>
          <SettingsRow title={t('persona.automatic')} description={t('persona.automaticHint')}>
            <div className="flex items-center gap-2">
              <Popover>
                <Tooltip><TooltipTrigger asChild><PopoverTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={t('persona.history')}><History /></Button>
                </PopoverTrigger></TooltipTrigger><TooltipContent>{t('persona.history')}</TooltipContent></Tooltip>
                <PopoverContent align="end" className="w-80">
                  <span className="text-xs text-muted-foreground">{t('persona.history')}</span>
                  {snapshot.mood.history.length === 0 ? <p className="text-xs text-muted-foreground">{t('persona.noHistory')}</p> : <ul className="flex max-h-60 flex-col gap-2 overflow-y-auto text-xs">
                    {snapshot.mood.history.slice(-20).reverse().map((item, index) => <li key={`${item.timestamp}-${index}`}>
                      <time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleString()}</time>{' · '}{item.feeling}{item.trigger && ` · ${item.trigger}`}
                    </li>)}
                  </ul>}
                </PopoverContent>
              </Popover>
              <Switch aria-label={t('persona.automatic')} checked={snapshot.mood.automatic} disabled={busy} onCheckedChange={(enabled) => void run(() => api.persona.setAutomatic(enabled))} />
            </div>
          </SettingsRow>
          <SettingsRow title={t('persona.observer')} description={t('persona.observerHint')}>
            <Switch aria-label={t('persona.observer')} checked={snapshot.mood.observer.enabled} disabled={busy}
              onCheckedChange={(enabled) => void run(() => api.persona.setObserver({ ...snapshot.mood.observer, enabled }))} />
          </SettingsRow>
          <SettingsRow title={t('persona.observerModel')} description={t('persona.observerDefault')}>
            <fieldset disabled={busy} className="min-w-0">
              <ModelThinkingPicker model={observerModel} models={models}
                label={observer?.provider ? `${observer.provider}/${observer.modelId}` : undefined}
                thinking={observer?.thinking ?? null}
                onThinkingChange={(thinking) => {
                  if (observer?.provider) void run(() => api.persona.setObserver({ ...observer, thinking }))
                }}
                defaultOption={{
                  active: !observer?.provider,
                  description: t('persona.observerDefault'),
                  onSelect: () => void run(() => api.persona.setObserver({ enabled: snapshot.mood.observer.enabled }))
                }}
                onModelChange={(model) => {
                  const thinking = supportedThinking(model, observer?.thinking ?? null)
                  void run(() => api.persona.setObserver({
                    enabled: snapshot.mood.observer.enabled, provider: model.provider, modelId: model.id,
                    ...(thinking ? { thinking } : {})
                  }))
                }} />
            </fieldset>
          </SettingsRow>
          <ObserverUsageRow />

        </SettingsCard>

        <Dialog open={editing} onOpenChange={open => { if (!open) closeEditor() }}>
          <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!busy}
            onEscapeKeyDown={event => { if (busy || confirmDiscard) event.preventDefault() }}
            onInteractOutside={event => event.preventDefault()}
            onCloseAutoFocus={event => { event.preventDefault(); configureButton.current?.focus() }}>
            <DialogHeader>
              <DialogTitle>{t(FILE_TITLES[file])}</DialogTitle>
              <DialogDescription>{t(FILE_HINTS[file])}</DialogDescription>
            </DialogHeader>
            {failure}
            <FieldGroup className="min-h-0 overflow-y-auto">
              <Field data-disabled={busy}>
                <FieldLabel htmlFor={`persona-${file}`}>{file}</FieldLabel>
                <Textarea id={`persona-${file}`} className="min-h-72" value={drafts[file]?.content ?? ''} disabled={busy} spellCheck={false}
                  onChange={event => {
                    const content = event.target.value
                    setDrafts(previous => {
                      const old = previous[file]
                      return old ? { ...previous, [file]: { ...old, content } } : previous
                    })
                  }} />
              </Field>
            </FieldGroup>
            <DialogFooter className="items-center">
              <span className="mr-auto text-xs text-muted-foreground">{drafts[file]?.content !== drafts[file]?.saved ? t('persona.unsaved') : t('persona.saved')}</span>
              <Button variant="outline" disabled={busy} onClick={closeEditor}>{t('persona.usageCancel')}</Button>
              <Button disabled={busy || !drafts[file] || drafts[file]?.content === drafts[file]?.saved} onClick={() => void save()}>{busy ? t('persona.working') : t('persona.save', { file })}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('persona.discardTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('persona.discardHint')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('persona.keepEditing')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => {
                accept(snapshot, file)
                setError(null)
                setConfirmDiscard(false)
                setEditing(false)
              }}>{t('persona.discard')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>}
    </div>
  )
}

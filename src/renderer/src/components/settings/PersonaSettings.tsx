/* Drafts own their original revisions independently of mood snapshots and other file saves. */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, History, Info } from 'lucide-react'
import { PERSONA_EMOTIONS, PERSONA_FILES, type PersonaDocument, type PersonaEmotion, type PersonaFileName, type PersonaSnapshot } from '../../../../shared/persona'
import { useT } from '../../hooks/useT'
import { api } from '../../ipc/api'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Field, FieldGroup, FieldLabel } from '../ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Separator } from '../ui/separator'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { Textarea } from '../ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SettingsCard, SettingsRow } from './SettingsFields'

type Draft = PersonaDocument & { saved: string }
type Drafts = Partial<Record<PersonaFileName, Draft>>

const FILE_HINTS = { 'SOUL.md': 'persona.soulHint', 'IDENTIFY.md': 'persona.identifyHint', 'USER.md': 'persona.userHint' } as const

export interface PersonaSettingsProps {
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}

export function PersonaSettings({ onDirtyChange, onBusyChange }: PersonaSettingsProps) {
  const t = useT()
  const [snapshot, setSnapshot] = useState<PersonaSnapshot | null>(null)
  const [drafts, setDrafts] = useState<Drafts>({})
  const [file, setFile] = useState<PersonaFileName>('SOUL.md')
  const [intensity, setIntensity] = useState(50)
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
    setIntensity(Math.round(next.mood.intensity * 100))
  }

  async function run(operation: () => Promise<PersonaSnapshot>, replace: 'all' | PersonaFileName | null = null) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      const next = await operation()
      if (mounted.current) accept(next, replace)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
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
      if (current) setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (current) { locked.current = false; setBusy(false) }
    })
    return () => { current = false; mounted.current = false }
  }, [])

  const applyMood = (emotion: PersonaEmotion, percent: number) => void run(() => api.persona.setEmotion(emotion, percent / 100))
  const save = () => {
    const draft = drafts[file]
    if (!draft || draft.content === draft.saved) return
    void run(() => api.persona.saveFile({ name: file, content: draft.content, revision: draft.revision }), file)
  }

  return (
    <div className="flex w-full flex-col gap-4" aria-busy={busy}>
      {dirty && <p className="text-xs text-muted-foreground">{t('persona.dirtyHint')}</p>}
      {error && <Alert variant="destructive"><AlertTitle>{t('persona.error')}</AlertTitle><AlertDescription><p>{error}</p><p>{t('persona.errorHint')}</p></AlertDescription></Alert>}
      {!snapshot && busy && <p role="status">{t('persona.loading')}</p>}
      {snapshot && <>
        <SettingsCard>
          <SettingsRow title={t('persona.mood')} description={`${t(`persona.emotions.${snapshot.mood.emotion}`)} · ${Math.round(snapshot.mood.intensity * 100)}%`}>
            <div className="flex items-center gap-2">
            <Popover>
              <Tooltip><TooltipTrigger asChild><PopoverTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('persona.moodDetails')}><Info /></Button>
              </PopoverTrigger></TooltipTrigger><TooltipContent>{t('persona.moodDetails')}</TooltipContent></Tooltip>
              <PopoverContent align="end" className="gap-3">
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-xs text-muted-foreground">{t('persona.moodDescription')}</span>
                  <p>{snapshot.mood.description}</p>
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-xs text-muted-foreground">{t('persona.moodPhrase')}</span>
                  <p>{snapshot.mood.phrase}</p>
                </div>
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" disabled={busy} aria-label={t('persona.setMood')}>
                  {t(`persona.emotions.${snapshot.mood.emotion}`)}<ChevronDown data-icon="inline-end" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" collisionPadding={8} className="max-h-[min(20rem,var(--radix-popover-content-available-height))] w-48 gap-0 p-1">
                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <ToggleGroup type="single" orientation="vertical" className="w-full flex-col items-stretch" value={snapshot.mood.emotion} disabled={busy}
                  onValueChange={(value) => { if (value) applyMood(value as PersonaEmotion, intensity) }}>
                  {PERSONA_EMOTIONS.map((value) => <ToggleGroupItem key={value} value={value} size="sm" className="justify-start">{t(`persona.emotions.${value}`)}</ToggleGroupItem>)}
                </ToggleGroup>
                </div>
                <Separator className="my-1 shrink-0" />
                <div className="flex shrink-0 flex-col gap-2.5 px-2 pt-1 pb-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t('persona.intensity')}</span>
                    <span className="tabular-nums">{intensity}%</span>
                  </div>
                  <Slider aria-label={t('persona.intensity')} min={0} max={100} step={1} value={[intensity]} disabled={busy}
                    onValueChange={([value]) => setIntensity(value)}
                    onValueCommit={([value]) => applyMood(snapshot.mood.emotion, value)} />
                </div>
              </PopoverContent>
            </Popover>
            </div>
          </SettingsRow>
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
                      <time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleString()}</time>{' · '}{t(`persona.emotions.${item.emotion}`)} {Math.round(item.intensity * 100)}%{item.trigger && ` · ${item.trigger}`}
                    </li>)}
                  </ul>}
                </PopoverContent>
              </Popover>
              <Switch aria-label={t('persona.automatic')} checked={snapshot.mood.automatic} disabled={busy} onCheckedChange={(enabled) => void run(() => api.persona.setAutomatic(enabled))} />
            </div>
          </SettingsRow>
        </SettingsCard>
        <Tabs value={file} onValueChange={(value) => setFile(value as PersonaFileName)}>
          <TabsList>{PERSONA_FILES.map((name) => <TabsTrigger key={name} value={name}>{name}{drafts[name]?.content !== drafts[name]?.saved ? ' *' : ''}</TabsTrigger>)}</TabsList>
          {PERSONA_FILES.map((name) => <TabsContent key={name} value={name}>
            <FieldGroup className="gap-2"><Field data-disabled={busy}>
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor={`persona-${name}`}>{name}</FieldLabel>
                <Popover>
                  <Tooltip><TooltipTrigger asChild><PopoverTrigger asChild>
                    <Button size="icon-xs" variant="ghost" aria-label={t('persona.fileInfo', { file: name })}><Info /></Button>
                  </PopoverTrigger></TooltipTrigger><TooltipContent>{t('persona.fileInfo', { file: name })}</TooltipContent></Tooltip>
                  <PopoverContent align="start" className="w-80 text-xs">{t(FILE_HINTS[name])}</PopoverContent>
                </Popover>
              </div>
              <Textarea id={`persona-${name}`} className="min-h-56" value={drafts[name]?.content ?? ''} disabled={busy} spellCheck={false} onChange={(event) => {
                const content = event.target.value
                setDrafts((previous) => {
                  const old = previous[name]
                  return old ? { ...previous, [name]: { ...old, content } } : previous
                })
              }} />
            </Field></FieldGroup>
          </TabsContent>)}
        </Tabs>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{drafts[file]?.content !== drafts[file]?.saved ? t('persona.unsaved') : t('persona.saved')}</span>
          <Button size="sm" disabled={busy || !drafts[file] || drafts[file]?.content === drafts[file]?.saved} onClick={save}>{busy ? t('persona.working') : t('persona.save', { file })}</Button>
        </div>
      </>}
    </div>
  )
}

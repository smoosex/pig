import { useEffect, useState } from 'react'
import { ChevronDownIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { api, type WebSearchSettingsState, type WebSearchSettingsPatch, type WebSearchProviderState } from '../../ipc/api'
import { Button } from '../ui/button'
import { DialogFooter } from '../ui/dialog'
import { Alert, AlertDescription } from '../ui/alert'
import { Field, FieldContent, FieldGroup, FieldLabel, FieldDescription } from '../ui/field'
import { Input } from '../ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { failureMessage } from '../../lib/ipc-error'
import { AddSearchEngineDialog } from './AddSearchEngineDialog'

interface Draft {
  provider: string
  added: string[]
  maxChars: string
  values: Record<string, string>
  sources: Record<string, 'env' | 'config'>
}

function fromState(state: WebSearchSettingsState): Draft {
  return {
    provider: state.settings.provider ?? 'duckduckgo', added: state.settings.addedProviders,
    maxChars: state.settings.maxInlineContentChars === null ? '' : String(state.settings.maxInlineContentChars),
    values: Object.fromEntries(state.providers.map(provider => [provider.id, provider.apiKey])),
    sources: Object.fromEntries(state.providers.map(provider => [provider.id, provider.apiKeySource]))
  }
}

export function WebSearchSettings({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [state, setState] = useState<WebSearchSettingsState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ editing: WebSearchProviderState | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    void api.getWebSearchSettings().then(next => {
      if (!cancelled) { setState(next); setDraft(fromState(next)) }
    }, failure => { if (!cancelled) setError(failureMessage(failure)) })
    return () => { cancelled = true }
  }, [])

  if (!draft || !state) return error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null

  const patch = (): WebSearchSettingsPatch => ({
    provider: draft.provider, addedProviders: draft.added,
    maxInlineContentChars: draft.maxChars.trim() ? Number(draft.maxChars) : null,
    providers: Object.fromEntries(state.providers.filter(provider => provider.kind === 'key').map(provider => {
      const value = draft.values[provider.id]
      const changed: { apiKey?: string | null; apiKeySource?: 'env' | 'config' } = {}
      if (draft.added.includes(provider.id)) changed.apiKeySource = draft.sources[provider.id]
      if (value !== provider.apiKey) changed.apiKey = value || null
      return [provider.id, changed]
    }))
  })
  const run = async (test: boolean) => {
    setBusy(true); setError(null); setTestResult(null)
    try {
      const next = await api.setWebSearchSettings(patch())
      setState(next); setDraft(fromState(next))
      if (test) {
        const result = await api.testWebSearch(draft.provider)
        if (result.ok) setTestResult(result.message)
        else setError(result.message)
      } else onClose()
    } catch (failure) { setError(failureMessage(failure)) }
    finally { setBusy(false) }
  }
  const added = draft.added.map(id => state.providers.find(provider => provider.id === id)!)
  const available = state.providers.filter(provider => !draft.added.includes(provider.id))
  return (
    <>
    <Button variant="outline" size="sm" className="absolute top-4 right-14" disabled={busy || !available.length} onClick={() => setDialog({ editing: null })}>
      <PlusIcon data-icon="inline-start" />{t('webSearch.addProvider')}
    </Button>
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {state.error ? <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert> : null}
      <SettingsCard>
        <SettingsRow title={t('webSearch.defaultProvider')} description={t('webSearch.defaultProviderHint')}>
          <Select value={draft.provider} onValueChange={provider => setDraft({ ...draft, provider })} disabled={busy}>
            <SelectTrigger aria-label={t('webSearch.defaultProvider')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{added.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </SettingsRow>
        {added.map(provider => <SettingsRow key={provider.id} title={provider.name} description={draft.sources[provider.id] === 'env' ? t(provider.envAvailable ? 'webSearch.usingEnv' : 'webSearch.envMissing', { name: provider.apiKeyEnv ?? '' }) : t(provider.kind === 'none' ? 'webSearch.noKeyRequired' : draft.values[provider.id]?.trim() ? 'webSearch.keyConfigured' : 'webSearch.keyMissing')}>
          <div className="flex gap-1">
            {provider.kind === 'key' ? <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`${t('webSearch.editProvider')} ${provider.name}`} onClick={() => setDialog({ editing: provider })}><PencilIcon data-icon="inline-start" /></Button> : null}
            <Button variant="ghost" size="icon-sm" disabled={busy || added.length === 1} aria-label={t('webSearch.removeProvider', { name: provider.name })} onClick={() => {
              const remaining = draft.added.filter(id => id !== provider.id)
              setDraft({ ...draft, added: remaining, provider: draft.provider === provider.id ? remaining[0] : draft.provider })
            }}><Trash2Icon data-icon="inline-start" /></Button>
          </div>
        </SettingsRow>)}

      </SettingsCard>
      {dialog ? <AddSearchEngineDialog
        providers={dialog.editing ? [dialog.editing] : available}
        editing={dialog.editing}
        values={draft.values}
        sources={draft.sources}
        onClose={() => setDialog(null)}
        onSave={(id, apiKey, source) => {
          const provider = state.providers.find(provider => provider.id === id)!
          setDraft({ ...draft, provider: dialog.editing ? draft.provider : id,
            added: draft.added.includes(id) ? draft.added : [...draft.added, id],
            values: provider.kind === 'key' ? { ...draft.values, [id]: apiKey } : draft.values,
            sources: { ...draft.sources, [id]: source } })
          setDialog(null)
        }}
      /> : null}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group w-full justify-between">
            {t('webSearch.advanced')}
            <ChevronDownIcon data-icon="inline-end" className="transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <FieldGroup>
            <SettingsCard>
              <Field className="px-4 py-3">
                <FieldContent>
                  <FieldLabel htmlFor="web-max-chars">{t('webSearch.maxChars')}</FieldLabel>
                  <FieldDescription className="text-xs">{t('webSearch.maxCharsHint')}</FieldDescription>
                </FieldContent>
                <Input id="web-max-chars" type="number" min={1000} max={50000} value={draft.maxChars} placeholder="20000" onChange={event => setDraft({ ...draft, maxChars: event.target.value })} disabled={busy} />
              </Field>
            </SettingsCard>
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {testResult ? <p role="status" className="text-sm text-success">{testResult}</p> : null}
    </div>
    <DialogFooter>
      <p className="mr-auto text-xs text-muted-foreground">{t('webSearch.testNotice')}</p>
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="outline" disabled={busy} onClick={() => void run(true)}>{t('webSearch.test')}</Button>
      <Button disabled={busy} onClick={() => void run(false)}>{t('plugins.save')}</Button>
    </DialogFooter>
    </>
  )
}

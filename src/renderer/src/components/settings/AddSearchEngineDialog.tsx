import { useState } from 'react'
import type { WebSearchProviderState } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function AddSearchEngineDialog({ providers, editing, values, sources, onSave, onClose }: {
  providers: WebSearchProviderState[]
  editing: WebSearchProviderState | null
  values: Record<string, string>
  sources: Record<string, 'env' | 'config'>
  onSave: (id: string, apiKey: string, source: 'env' | 'config') => void
  onClose: () => void
}) {
  const t = useT()
  const [id, setId] = useState(editing?.id ?? providers[0]?.id ?? '')
  const [apiKey, setApiKey] = useState(values[id] ?? '')
  const [source, setSource] = useState<'env' | 'config'>(sources[id] ?? 'config')
  const provider = providers.find(provider => provider.id === id)
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="flex max-h-[85vh] flex-col">
      <DialogHeader>
        <DialogTitle>{t(editing ? 'webSearch.editProvider' : 'webSearch.addProvider')}</DialogTitle>
        <DialogDescription>{t('webSearch.providerDialogHint')}</DialogDescription>
      </DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); if (provider) onSave(id, apiKey, source) }}>
        <FieldGroup className="min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Field>
            <FieldLabel htmlFor="web-provider-select">{t('webSearch.providerLabel')}</FieldLabel>
            <Select value={id} onValueChange={id => { setId(id); setApiKey(values[id] ?? ''); setSource(sources[id] ?? 'config') }} disabled={!!editing}>
              <SelectTrigger id="web-provider-select" aria-label={t('webSearch.providerLabel')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          {provider?.kind === 'key' ? <>
            <Field>
              <FieldLabel id="web-key-source-label">{t('webSearch.keySource')}</FieldLabel>
              <ToggleGroup type="single" variant="outline" className="w-full *:flex-1" value={source} onValueChange={value => { if (value === 'env' || value === 'config') setSource(value) }} aria-labelledby="web-key-source-label">
                <ToggleGroupItem value="env" disabled={!provider.envAvailable}>{t('webSearch.useEnv')}</ToggleGroupItem>
                <ToggleGroupItem value="config">{t('webSearch.useCustom')}</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>{t(provider.envAvailable ? 'webSearch.envDetected' : 'webSearch.envMissing', { name: provider.apiKeyEnv ?? '' })}</FieldDescription>
            </Field>
            {source === 'config' ? <Field>
              <FieldLabel htmlFor="web-provider-key">{t('webSearch.apiKey')}</FieldLabel>
              <Input id="web-provider-key" type="password" autoComplete="off" required value={apiKey} onChange={event => setApiKey(event.target.value)} />
            </Field> : null}
          </> : null}
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!provider || (provider.kind === 'key' && (source === 'env' ? !provider.envAvailable : !apiKey.trim()))}>{t(editing ? 'plugins.save' : 'webSearch.addProvider')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

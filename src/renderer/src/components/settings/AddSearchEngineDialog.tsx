import { useEffect, useState } from 'react'
import type { Translate } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import { ChevronLeft } from 'lucide-react'
import type { WebSearchProviderState } from '../../ipc/api'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SmoothHoverHighlight } from '../ui/smooth-hover-highlight'
import { Switch } from '../ui/switch'

export interface EngineDraft {
  apiKey: string
  baseUrl: string
  extras: Record<string, string>
}

export const EMPTY_ENGINE_DRAFT: EngineDraft = { apiKey: '', baseUrl: '', extras: {} }

type StatusKey = 'webSearch.fromEnv' | 'webSearch.configured' | 'webSearch.noKeyNeeded' | 'webSearch.piLogin' | 'webSearch.unconfigured'

/** What the engine needs before it can search, as shown in the list badge and the picker hint. */
export function engineStatusKey(provider: WebSearchProviderState): StatusKey {
  if (provider.source === 'env') return 'webSearch.fromEnv'
  if (provider.source === 'config') return 'webSearch.configured'
  if (provider.kind === 'none') return 'webSearch.noKeyNeeded'
  if (provider.kind === 'piLogin') return 'webSearch.piLogin'
  return 'webSearch.unconfigured'
}

function engineHint(t: Translate, provider: WebSearchProviderState): string {
  if (provider.source === 'env') return t('webSearch.envDetected', { name: provider.apiKeyEnv ?? provider.baseUrlEnv ?? '' })
  if (provider.kind === 'piLogin') return t('webSearch.piLogin')
  if (provider.kind === 'none') return t('webSearch.noKeyNeeded')
  return provider.apiKeyEnv ?? provider.note ?? ''
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export function AddSearchEngineDialog({
  open,
  onOpenChange,
  providers,
  added,
  editing,
  editingValue,
  valueFor,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: WebSearchProviderState[]
  added: string[]
  editing: WebSearchProviderState | null
  editingValue: EngineDraft | null
  valueFor: (id: string) => EngineDraft
  onSubmit: (id: string, value: EngineDraft) => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<WebSearchProviderState | null>(null)
  const [value, setValue] = useState<EngineDraft>(EMPTY_ENGINE_DRAFT)
  const pick = (provider: WebSearchProviderState) => {
    setChosen(provider)
    setValue(valueFor(provider.id))
  }

  useEffect(() => {
    if (!open) return
    setQuery('')
    setChosen(editing)
    setValue(editingValue ?? EMPTY_ENGINE_DRAFT)
    // Reset only when the dialog opens; later renders must keep what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const available = providers.filter((provider) => !added.includes(provider.id))
  const submit = () => {
    if (!chosen) return
    onSubmit(chosen.id, value)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{chosen ? chosen.name : t('webSearch.pickEngine')}</DialogTitle>
          <DialogDescription>
            {chosen ? chosen.note ?? engineHint(t, chosen) : t('webSearch.pickEngineHint')}
          </DialogDescription>
        </DialogHeader>
        {chosen ? (
          <div className="flex flex-col gap-3">
            {editing ? null : (
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setChosen(null)}>
                <ChevronLeft data-icon="inline-start" />
                {t('webSearch.backToList')}
              </Button>
            )}
            {chosen.apiKeyKey ? (
              <Field label={t('webSearch.apiKey')}>
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label={`${chosen.name} ${t('webSearch.apiKey')}`}
                  placeholder={chosen.apiKeyKey}
                  value={value.apiKey}
                  onChange={(event) => setValue((current) => ({ ...current, apiKey: event.target.value }))}
                />
                {chosen.apiKeyEnv ? (
                  <span className="text-xs text-muted-foreground">
                    {chosen.source === 'env'
                      ? t('webSearch.envDetected', { name: chosen.apiKeyEnv })
                      : t('webSearch.envHint', { name: chosen.apiKeyEnv })}
                  </span>
                ) : null}
              </Field>
            ) : null}
            {chosen.baseUrlKey ? (
              <Field label={t('webSearch.baseUrl')}>
                <Input
                  aria-label={`${chosen.name} ${t('webSearch.baseUrl')}`}
                  placeholder={chosen.baseUrlKey}
                  value={value.baseUrl}
                  onChange={(event) => setValue((current) => ({ ...current, baseUrl: event.target.value }))}
                />
              </Field>
            ) : null}
            {(chosen.extras ?? []).map((field) => (
              <Field key={field.key} label={field.label}>
                {field.type === 'boolean' ? (
                  <Switch
                    aria-label={`${chosen.name} ${field.label}`}
                    checked={value.extras[field.key] === 'true'}
                    onCheckedChange={(checked) => setValue((current) => ({ ...current, extras: { ...current.extras, [field.key]: String(checked) } }))}
                  />
                ) : field.type === 'select' ? (
                  <Select
                    value={value.extras[field.key] ?? ''}
                    onValueChange={(next) => setValue((current) => ({ ...current, extras: { ...current.extras, [field.key]: next } }))}
                  >
                    <SelectTrigger size="sm" aria-label={`${chosen.name} ${field.label}`}><SelectValue placeholder={field.label} /></SelectTrigger>
                    <SelectContent><SelectGroup>
                      {field.options?.map((option) => (
                        <SelectItem key={option || 'empty'} value={option}>{option || t('plugins.defaultValue')}</SelectItem>
                      ))}
                    </SelectGroup></SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={`${chosen.name} ${field.label}`}
                    placeholder={field.env ? `${field.label} · ${field.env}` : field.label}
                    value={value.extras[field.key] ?? ''}
                    onChange={(event) => setValue((current) => ({ ...current, extras: { ...current.extras, [field.key]: event.target.value } }))}
                  />
                )}
              </Field>
            ))}
            {!chosen.apiKeyKey && !chosen.baseUrlKey && !(chosen.extras ?? []).length ? (
              <p className="text-sm text-muted-foreground">{engineHint(t, chosen)}</p>
            ) : null}
          </div>
        ) : (
          <Command
            loop
            // cmdk selects its first row on mount unless the value it starts with matches nothing;
            // a chooser has to open without a hover, so the list waits for real input.
            defaultValue=" "
            onKeyDownCapture={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
            }}
          >
            <CommandInput
              aria-label={t('webSearch.searchEngine')}
              placeholder={t('webSearch.searchEngine')}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="mt-2 max-h-80">
              <SmoothHoverHighlight activeSelector="[data-selected='true']" activeAttribute="data-selected" highlightClassName="bg-glass-prompt-foreground/8 solid:bg-accent">
                <CommandEmpty>{t('webSearch.noMatch')}</CommandEmpty>
                {/* cmdk reorders filtered items inside their group; without one it crashes on a null parent. */}
                <CommandGroup>
                  {available.map((provider) => (
                    <CommandItem
                      key={provider.id}
                      value={provider.id}
                      keywords={[provider.name]}
                      data-hover-highlight-row
                      className="data-selected:bg-transparent!"
                      onSelect={() => pick(provider)}
                    >
                      <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                      <span data-slot="command-shortcut" className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant={provider.source ? 'secondary' : 'outline'}>{t(engineStatusKey(provider))}</Badge>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </SmoothHoverHighlight>
            </CommandList>
          </Command>
        )}
        {chosen ? (
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={submit}>{editing ? t('webSearch.saveEngine') : t('webSearch.add')}</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

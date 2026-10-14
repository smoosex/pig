import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../hooks/useT'
import { ChevronDown, Plus } from 'lucide-react'
import {
  api,
  type WebSearchFetchMode,
  type WebSearchProviderState,
  type WebSearchSettingsPatch,
  type WebSearchSettingsState,
  type WebSearchToolFlags
} from '../../ipc/api'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { AddSearchEngineDialog, EMPTY_ENGINE_DRAFT, engineStatusKey, type EngineDraft } from './AddSearchEngineDialog'
import { SettingsCard, SettingsRow } from './SettingsFields'

const FETCH_MODES: WebSearchFetchMode[] = ['readable', 'raw', 'answer']
const TOOL_KEYS: Array<keyof WebSearchToolFlags> = ['webSearch', 'sourceCheck', 'fetchContent', 'getSearchContent']

interface Draft {
  added: string[]
  provider: string
  tools: WebSearchToolFlags
  maxChars: string
  fetchDefault: string
  fetchModes: WebSearchFetchMode[]
  ranges: string
  trustEnvProxy: boolean
  sameOriginRedirects: boolean
  values: Record<string, EngineDraft>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}

function engineDraft(provider: WebSearchProviderState): EngineDraft {
  return { apiKey: provider.apiKey, baseUrl: provider.baseUrl, extras: { ...provider.extraValues } }
}

/** Added engines are the persisted allowlist; an empty list means the extension may use any engine. */
function addedFrom(state: WebSearchSettingsState): string[] {
  const known = new Set(state.providers.filter((provider) => provider.group !== 'extract').map((provider) => provider.id))
  return (state.settings.allowedProviders ?? []).filter((id) => known.has(id))
}

function draftFrom(state: WebSearchSettingsState): Draft {
  const settings = state.settings
  return {
    added: addedFrom(state),
    provider: settings.provider ?? '',
    tools: { ...settings.tools },
    maxChars: settings.maxInlineContentChars === null ? '' : String(settings.maxInlineContentChars),
    fetchDefault: settings.fetchDefaultMode ?? '',
    fetchModes: settings.fetchAllowedModes ?? [...FETCH_MODES],
    ranges: (settings.ssrfAllowRanges ?? []).join('\n'),
    trustEnvProxy: settings.ssrfTrustEnvProxy ?? false,
    sameOriginRedirects: settings.fetchRedirects === 'same-origin',
    values: Object.fromEntries(state.providers.map((provider) => [provider.id, engineDraft(provider)]))
  }
}

export function WebSearchSettings({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [state, setState] = useState<WebSearchSettingsState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [dialog, setDialog] = useState<{ editing: WebSearchProviderState | null } | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getWebSearchSettings().then((next) => {
      if (cancelled) return
      setState(next)
      setDraft(draftFrom(next))
      setError(null)
    }, (failure) => { if (!cancelled) setError(errorText(failure)) })
    return () => { cancelled = true }
  }, [])

  const engines = useMemo(() => state?.providers.filter((provider) => provider.group !== 'extract') ?? [], [state])
  const extractors = useMemo(() => state?.providers.filter((provider) => provider.group === 'extract') ?? [], [state])
  const engineById = useMemo(() => new Map(engines.map((provider) => [provider.id, provider])), [engines])
  const addedEngines = draft?.added.map((id) => engineById.get(id)).filter((provider): provider is WebSearchProviderState => !!provider) ?? []

  const valueFor = (id: string): EngineDraft => draft?.values[id] ?? EMPTY_ENGINE_DRAFT

  const setValue = (id: string, patch: Partial<EngineDraft>) => {
    setDraft((current) => current && { ...current, values: { ...current.values, [id]: { ...valueFor(id), ...patch } } })
  }

  const removeEngine = (provider: WebSearchProviderState) => {
    setDraft((current) => {
      if (!current) return current
      const added = current.added.filter((id) => id !== provider.id)
      // Engines can share one config key (Parallel and Parallel MCP both use parallelApiKey), so
      // only clear credentials no remaining engine still reads.
      const shared = new Set<string>()
      for (const id of added) {
        const other = engineById.get(id)
        if (!other) continue
        if (other.apiKeyKey) shared.add(other.apiKeyKey)
        if (other.baseUrlKey) shared.add(other.baseUrlKey)
        for (const field of other.extras ?? []) shared.add(field.key)
      }
      const clearing = (key: string | undefined) => key !== undefined && !shared.has(key)
      const currentValue = current.values[provider.id]
      return {
        ...current,
        added,
        provider: current.provider === provider.id ? '' : current.provider,
        // Removing an engine also drops its stored credentials, so it cannot linger in web-search.json.
        values: {
          ...current.values,
          [provider.id]: {
            apiKey: clearing(provider.apiKeyKey) ? '' : currentValue?.apiKey ?? '',
            baseUrl: clearing(provider.baseUrlKey) ? '' : currentValue?.baseUrl ?? '',
            extras: Object.fromEntries(
              (provider.extras ?? []).map((field) => [
                field.key,
                clearing(field.key) ? '' : currentValue?.extras[field.key] ?? ''
              ])
            )
          }
        }
      }
    })
  }

  // `force` rewrites every managed setting from the sanitized state, which is how a file the extension
  // would reject gets repaired: the invalid values are replaced by what the panel can represent.
  // Stored credentials are never invalid, so they stay diff-based.
  const buildPatch = (force = false): WebSearchSettingsPatch => {
    if (!state || !draft) return {}
    const settings = state.settings
    const patch: WebSearchSettingsPatch = {}
    if (force || !sameList(draft.added, addedFrom(state))) patch.allowedProviders = draft.added
    const provider = draft.provider || ''
    if (force || provider !== (settings.provider ?? '')) patch.provider = provider || null
    const tools: Partial<WebSearchToolFlags> = {}
    for (const key of TOOL_KEYS) {
      if (force || draft.tools[key] !== settings.tools[key]) tools[key] = draft.tools[key]
    }
    if (Object.keys(tools).length) patch.tools = tools
    const maxChars = draft.maxChars.trim()
    if (force || maxChars !== (settings.maxInlineContentChars === null ? '' : String(settings.maxInlineContentChars))) {
      patch.maxInlineContentChars = maxChars ? Number(maxChars) : null
    }
    const fetchDefault = draft.fetchDefault || null
    if (force || fetchDefault !== settings.fetchDefaultMode) patch.fetchDefaultMode = fetchDefault
    if (force || !sameList(draft.fetchModes, settings.fetchAllowedModes ?? FETCH_MODES)) patch.fetchAllowedModes = draft.fetchModes
    const ranges = draft.ranges.split('\n').map((range) => range.trim()).filter(Boolean)
    if (force || !sameList(ranges, settings.ssrfAllowRanges ?? [])) patch.ssrfAllowRanges = ranges
    if (force || draft.trustEnvProxy !== (settings.ssrfTrustEnvProxy ?? false)) patch.ssrfTrustEnvProxy = draft.trustEnvProxy
    if (force || draft.sameOriginRedirects !== (settings.fetchRedirects === 'same-origin')) {
      patch.fetchRedirects = draft.sameOriginRedirects ? 'same-origin' : null
    }
    const providers: NonNullable<WebSearchSettingsPatch['providers']> = {}
    for (const providerState of state.providers) {
      const current = draft.values[providerState.id]
      if (!current) continue
      const changed: NonNullable<WebSearchSettingsPatch['providers']>[string] = {}
      if (providerState.apiKeyKey && current.apiKey !== providerState.apiKey) changed.apiKey = current.apiKey || null
      if (providerState.baseUrlKey && current.baseUrl !== providerState.baseUrl) changed.baseUrl = current.baseUrl || null
      const extras: Record<string, string | null> = {}
      for (const field of providerState.extras ?? []) {
        const value = current.extras[field.key] ?? ''
        if (value !== (providerState.extraValues[field.key] ?? '')) extras[field.key] = value || null
      }
      if (Object.keys(extras).length) changed.extras = extras
      if (Object.keys(changed).length) providers[providerState.id] = changed
    }
    if (Object.keys(providers).length) patch.providers = providers
    return patch
  }

  const persist = async (): Promise<void> => {
    const patch = buildPatch(Boolean(state?.error))
    if (!Object.keys(patch).length) return
    const next = await api.setWebSearchSettings(patch)
    setState(next)
    setDraft(draftFrom(next))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await persist()
      setTestResult(null)
      onClose()
    } catch (failure) { setError(errorText(failure)) }
    finally { setSaving(false) }
  }

  const test = async () => {
    if (!draft) return
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      // The extension reads web-search.json, so the draft has to be stored before it can be tested.
      await persist()
      setTestResult(await api.testWebSearch(draft.provider || null))
    } catch (failure) { setTestResult({ ok: false, message: errorText(failure) }) }
    finally { setTesting(false) }
  }

  if (!state || !draft) {
    return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null
  }

  const dirty = Object.keys(buildPatch()).length > 0
  // fetch.allowedModes must keep at least one entry, so the last enabled mode stays on.
  const lockedMode = draft.fetchModes.length === 1 ? draft.fetchModes[0] : null
  const defaultOptions = draft.provider && !draft.added.includes(draft.provider) ? [...addedEngines, engineById.get(draft.provider)].filter((provider): provider is WebSearchProviderState => !!provider) : addedEngines

  return (
    <div className="flex flex-col gap-3">
      {state.error ? (
        <p role="status" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs whitespace-pre-wrap text-destructive">
          {t('webSearch.invalidConfig', { message: state.error })}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('webSearch.engineCount', { count: draft.added.length })}</p>
        <Button size="sm" onClick={() => setDialog({ editing: null })}>
          <Plus data-icon="inline-start" />
          {t('webSearch.addEngine')}
        </Button>
      </div>

      {addedEngines.length ? (
        <SettingsCard>
          {addedEngines.map((provider) => (
            <SettingsRow
              key={provider.id}
              title={provider.name}
              description={provider.source === 'env' ? provider.apiKeyEnv ?? provider.baseUrlEnv ?? provider.id : provider.note ?? provider.apiKeyEnv ?? provider.id}
            >
              <div className="flex items-center gap-3">
                <Badge variant={provider.source ? 'secondary' : 'outline'}>{t(engineStatusKey(provider))}</Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      {t('webSearch.manage')}
                      <ChevronDown data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => setDialog({ editing: provider })}>{t('webSearch.editEngine')}</DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => removeEngine(provider)}>{t('webSearch.removeEngine')}</DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      ) : (
        <Empty className="min-h-40 border">
          <EmptyHeader>
            <EmptyTitle>{t('webSearch.noEngine')}</EmptyTitle>
            <EmptyDescription>{t('webSearch.noEngineHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <SettingsCard>
        <SettingsRow title={t('webSearch.defaultProvider')} description={t('webSearch.defaultProviderHint')}>
          <Select value={draft.provider || 'auto'} onValueChange={(value) => setDraft((current) => current && { ...current, provider: value === 'auto' ? '' : value })}>
            <SelectTrigger size="sm" aria-label={t('webSearch.defaultProvider')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="auto">{t('webSearch.auto')}</SelectItem>
              {defaultOptions.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
        </SettingsRow>
        {TOOL_KEYS.map((key) => (
          <SettingsRow key={key} title={t(`webSearch.tool_${key}`)} description={t(`webSearch.tool_${key}_hint`)}>
            <Switch aria-label={t(`webSearch.tool_${key}`)} checked={draft.tools[key]}
              onCheckedChange={(checked) => setDraft((current) => current && { ...current, tools: { ...current.tools, [key]: checked } })} />
          </SettingsRow>
        ))}
      </SettingsCard>

      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="self-start text-muted-foreground">
            <ChevronDown className={advanced ? 'rotate-180 transition-transform' : 'transition-transform'} data-icon="inline-start" />
            {t('webSearch.advanced')}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-3">
          <p className="text-xs text-muted-foreground">{t('webSearch.extractHint')}</p>
          <SettingsCard>
            {extractors.map((provider) => (
              <div key={provider.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{provider.name}</span>
                  <Badge variant={provider.source ? 'secondary' : 'outline'}>{t(engineStatusKey(provider))}</Badge>
                  <span className="text-xs text-muted-foreground">{provider.note ?? provider.apiKeyEnv ?? ''}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {provider.apiKeyKey ? (
                    <Input className="min-w-48 flex-1" type="password" autoComplete="off" aria-label={`${provider.name} ${t('webSearch.apiKey')}`}
                      placeholder={provider.apiKeyKey} value={valueFor(provider.id).apiKey}
                      onChange={(event) => setValue(provider.id, { apiKey: event.target.value })} />
                  ) : null}
                  {provider.baseUrlKey ? (
                    <Input className="min-w-40 flex-1" aria-label={`${provider.name} ${t('webSearch.baseUrl')}`}
                      placeholder={provider.baseUrlKey} value={valueFor(provider.id).baseUrl}
                      onChange={(event) => setValue(provider.id, { baseUrl: event.target.value })} />
                  ) : null}
                  {(provider.extras ?? []).map((field) => field.type === 'select' ? (
                    <Select key={field.key} value={valueFor(provider.id).extras[field.key] ?? ''}
                      onValueChange={(value) => setValue(provider.id, { extras: { ...valueFor(provider.id).extras, [field.key]: value } })}>
                      <SelectTrigger size="sm" aria-label={`${provider.name} ${field.label}`}><SelectValue placeholder={field.label} /></SelectTrigger>
                      <SelectContent><SelectGroup>
                        {field.options?.map((option) => <SelectItem key={option || 'empty'} value={option}>{option || t('plugins.defaultValue')}</SelectItem>)}
                      </SelectGroup></SelectContent>
                    </Select>
                  ) : (
                    <Input key={field.key} className="min-w-40 flex-1" aria-label={`${provider.name} ${field.label}`}
                      placeholder={field.env ? `${field.label} · ${field.env}` : field.label} value={valueFor(provider.id).extras[field.key] ?? ''}
                      onChange={(event) => setValue(provider.id, { extras: { ...valueFor(provider.id).extras, [field.key]: event.target.value } })} />
                  ))}
                </div>
              </div>
            ))}
          </SettingsCard>

          <SettingsCard>
            <SettingsRow title={t('webSearch.fetchDefault')} description={t('webSearch.fetchDefaultHint')}>
              <Select value={draft.fetchDefault || 'default'} onValueChange={(value) => setDraft((current) => current && { ...current, fetchDefault: value === 'default' ? '' : value })}>
                <SelectTrigger size="sm" aria-label={t('webSearch.fetchDefault')}><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  {draft.fetchModes.includes('readable') ? <SelectItem value="default">{t('plugins.defaultValue')}</SelectItem> : null}
                  {FETCH_MODES.filter((mode) => draft.fetchModes.includes(mode)).map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
                </SelectGroup></SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow title={t('webSearch.fetchModes')} description={t('webSearch.fetchModesHint')}>
              <div className="flex items-center gap-3">
                {FETCH_MODES.map((mode) => (
                  <label key={mode} className="flex items-center gap-1.5 text-xs">
                    <Switch aria-label={mode} disabled={mode === lockedMode} checked={draft.fetchModes.includes(mode)}
                      onCheckedChange={(checked) => setDraft((current) => {
                        if (!current) return current
                        const fetchModes = checked ? [...current.fetchModes, mode] : current.fetchModes.filter((item) => item !== mode)
                        if (!fetchModes.length) return current
                        // The extension reads an unset default as "readable" and requires the default
                        // to be an allowed mode, so keep them consistent while the user toggles.
                        const fallback = current.fetchDefault || 'readable'
                        return {
                          ...current,
                          fetchModes,
                          fetchDefault: fetchModes.includes(fallback as WebSearchFetchMode) ? current.fetchDefault : fetchModes[0]
                        }
                      })} />
                    {mode}
                  </label>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow title={t('webSearch.maxChars')} description={t('webSearch.maxCharsHint')}>
              <Input className="w-30" type="number" min="1000" max="200000" aria-label={t('webSearch.maxChars')} value={draft.maxChars}
                placeholder={t('plugins.autoDefault')} onChange={(event) => setDraft((current) => current && { ...current, maxChars: event.target.value })} />
            </SettingsRow>
            <SettingsRow title={t('webSearch.trustEnvProxy')} description={t('webSearch.trustEnvProxyHint')}>
              <Switch aria-label={t('webSearch.trustEnvProxy')} checked={draft.trustEnvProxy}
                onCheckedChange={(checked) => setDraft((current) => current && { ...current, trustEnvProxy: checked })} />
            </SettingsRow>
            <SettingsRow title={t('webSearch.sameOriginRedirects')} description={t('webSearch.sameOriginRedirectsHint')}>
              <Switch aria-label={t('webSearch.sameOriginRedirects')} checked={draft.sameOriginRedirects}
                onCheckedChange={(checked) => setDraft((current) => current && { ...current, sameOriginRedirects: checked })} />
            </SettingsRow>
            <div className="flex flex-col gap-2 px-4 py-3">
              <div className="text-sm font-medium">{t('webSearch.ssrfRanges')}</div>
              <p className="text-xs text-muted-foreground">{t('webSearch.ssrfRangesHint')}</p>
              <Textarea rows={3} aria-label={t('webSearch.ssrfRanges')} placeholder="198.18.0.0/15" value={draft.ranges}
                onChange={(event) => setDraft((current) => current && { ...current, ranges: event.target.value })} />
            </div>
          </SettingsCard>
        </CollapsibleContent>
      </Collapsible>

      <p className="text-xs text-muted-foreground">{t('webSearch.reloadHint')}</p>
      {testResult ? (
        <p
          role="status"
          className={`max-h-48 overflow-y-auto rounded-md bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap ${testResult.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {testResult.message}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {error ? (
          <span role="alert" className="min-w-0 flex-1 text-xs text-destructive">{error}</span>
        ) : (
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">{dirty ? t('webSearch.testSaves') : ''}</span>
        )}
        <Button size="sm" variant="outline" disabled={testing}
          onClick={() => void test()}>{testing ? t('webSearch.testing') : t('webSearch.test')}</Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? t('plugins.working') : t('plugins.save')}</Button>
      </div>

      <AddSearchEngineDialog
        open={dialog !== null}
        onOpenChange={(open) => { if (!open) setDialog(null) }}
        providers={engines}
        added={draft.added}
        editing={dialog?.editing ?? null}
        editingValue={dialog?.editing ? valueFor(dialog.editing.id) : null}
        valueFor={valueFor}
        onSubmit={(id, value) => setDraft((current) => current && {
          ...current,
          added: current.added.includes(id) ? current.added : [...current.added, id],
          values: { ...current.values, [id]: value }
        })}
      />
    </div>
  )
}

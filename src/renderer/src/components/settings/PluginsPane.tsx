import { useEffect, useState } from 'react'
import { ChevronDown, FolderOpen, Plus, Settings, X } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { api, type MemoryPluginSettings, type MemoryPluginSettingsPatch, type PluginInfo } from '../../ipc/api'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { DefaultModelPicker } from './DefaultModelPicker'
import { WebSearchSettings } from './WebSearchSettings'

const numericKeys = [
  'observeAfterTokens', 'reflectAfterTokens', 'observerChunkMaxTokens', 'compactAfterTokens',
  'compactAfterTokensRatio', 'observationsPoolMaxTokens', 'observationsPoolTargetTokens',
  'agentMaxTurns', 'agentMaxTokens'
] as const
const booleanKeys = ['showWorkerNotifications', 'showCompactionNotifications', 'passive', 'debugLog'] as const

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PluginsPane() {
  const t = useT()
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toRemove, setToRemove] = useState<PluginInfo | null>(null)
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null)
  const [pluginConfig, setPluginConfig] = useState<Record<string, string | number | boolean>>({})
  const [pluginDraft, setPluginDraft] = useState<Record<string, string>>({})
  const [pluginConfigError, setPluginConfigError] = useState<string | null>(null)
  const [configSaving, setConfigSaving] = useState(false)
  const [saved, setSaved] = useState<MemoryPluginSettings>({})
  const [draft, setDraft] = useState<MemoryPluginSettings>({})
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [defaults, setDefaults] = useState<Record<string, number>>({})
  const [modelProvider, setModelProvider] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelThinking, setModelThinking] = useState('default')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const models = useModelCatalogStore((s) => s.models)
  const selectedPlugin = plugins.find((item) => item.id === selectedPluginId)
  const memoryModel = modelProvider.trim() && modelId.trim()
    ? models.find((item) => item.provider === modelProvider.trim() && item.id === modelId.trim()) ?? null
    : null

  useEffect(() => {
    let cancelled = false
    const load = () => void api.listPlugins().then((items) => {
      if (!cancelled) setPlugins(items)
    }, (failure) => { if (!cancelled) setError(errorText(failure)) })
    load()
    const off = api.onPluginsChanged(load)
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    if (selectedPluginId !== 'observational-memory') return
    let cancelled = false
    void api.getMemoryPluginDefaults().then((items) => {
      if (!cancelled) setDefaults(items)
    }, () => { if (!cancelled) setDefaults({}) })
    void api.getMemoryPluginSettings().then((config) => {
      if (cancelled) return
      setSaved(config)
      setDraft(config)
      setNumbers(Object.fromEntries(numericKeys.map((key) => [key, config[key] == null ? '' : String(config[key])])))
      setModelProvider(config.model?.provider ?? '')
      setModelId(config.model?.id ?? '')
      setModelThinking(config.model?.thinking ?? 'default')
      setSettingsError(null)
    }, (failure) => { if (!cancelled) setSettingsError(errorText(failure)) })
    return () => { cancelled = true }
  }, [selectedPluginId])

  useEffect(() => {
    if (!selectedPlugin?.settings) return
    let cancelled = false
    void api.getPluginSettings(selectedPlugin.id).then((config) => {
      if (cancelled) return
      setPluginConfig(config)
      setPluginDraft(Object.fromEntries(selectedPlugin.settings!.fields.map((field) => [field.key, config[field.key] === undefined ? '__pig_default__' : String(config[field.key])])))
      setPluginConfigError(null)
    }, (failure) => { if (!cancelled) setPluginConfigError(errorText(failure)) })
    return () => { cancelled = true }
  }, [selectedPlugin?.id, selectedPlugin?.settings])

  const act = async (operation: () => Promise<PluginInfo[]>) => {
    setBusy(true)
    setError(null)
    try { setPlugins(await operation()) }
    catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }

  const saveMemory = async () => {
    const patch: MemoryPluginSettingsPatch = {}
    for (const key of numericKeys) {
      const oldValue = saved[key] == null ? '' : String(saved[key])
      const current = (numbers[key] ?? '').trim()
      if (current !== oldValue) patch[key] = current ? Number(current) : null
    }
    for (const key of booleanKeys) {
      if (draft[key] !== saved[key]) patch[key] = draft[key] ?? null
    }
    if (draft.compactAfterTokensMode !== saved.compactAfterTokensMode) {
      patch.compactAfterTokensMode = draft.compactAfterTokensMode ?? null
    }
    const model = modelProvider.trim() && modelId.trim()
      ? { provider: modelProvider.trim(), id: modelId.trim(), ...(modelThinking === 'default' ? {} : { thinking: modelThinking as NonNullable<MemoryPluginSettings['model']>['thinking'] }) }
      : null
    if ((modelProvider.trim() || modelId.trim()) && !model) {
      setSettingsError('Provider and model ID are both required')
      return
    }
    if (JSON.stringify(model) !== JSON.stringify(saved.model ?? null)) patch.model = model
    setSaving(true)
    setSettingsError(null)
    try {
      const next = await api.setMemoryPluginSettings(patch)
      setSaved(next)
      setDraft(next)
      setNumbers(Object.fromEntries(numericKeys.map((key) => [key, next[key] == null ? '' : String(next[key])])))
      setSelectedPluginId(null)
    } catch (failure) { setSettingsError(errorText(failure)) }
    finally { setSaving(false) }
  }

  const saveConfig = async () => {
    if (!selectedPlugin?.settings) return
    const patch: Record<string, string | number | boolean | null> = {}
    for (const field of selectedPlugin.settings.fields) {
      const value = pluginDraft[field.key] ?? '__pig_default__'
      if (value === (pluginConfig[field.key] === undefined ? '__pig_default__' : String(pluginConfig[field.key]))) continue
      patch[field.key] = value === '__pig_default__' ? null
        : field.type === 'boolean' ? value === 'true'
        : field.type === 'integer' ? Number(value) : value
    }
    setConfigSaving(true)
    setPluginConfigError(null)
    try {
      setPluginConfig(await api.setPluginSettings(selectedPlugin.id, patch))
      setSelectedPluginId(null)
    } catch (failure) { setPluginConfigError(errorText(failure)) }
    finally { setConfigSaving(false) }
  }

  const system = plugins.filter((plugin) => plugin.kind === 'system')
  const external = plugins.filter((plugin) => plugin.kind !== 'system')
  const renderPlugin = (plugin: PluginInfo) => (
    <SettingsRow key={plugin.id} title={plugin.name} description={plugin.error ?? plugin.source}>
      <div className="flex items-center gap-2">
        {!plugin.available ? <Badge variant="destructive">{t('plugins.missing')}</Badge> : null}
        {plugin.id === 'observational-memory' || plugin.id === 'pi-web-access' || plugin.settings ? (
          <Button size="icon-sm" variant="ghost" aria-label={`${t('plugins.configure')} ${plugin.name}`}
            onClick={() => setSelectedPluginId(plugin.id)}><Settings /></Button>
        ) : null}
        <span className="text-xs text-muted-foreground">{t(plugin.enabled ? 'plugins.enabled' : 'plugins.disabled')}</span>
        <Switch aria-label={plugin.name} checked={plugin.enabled} disabled={busy || (!plugin.available && !plugin.enabled)}
          onCheckedChange={(enabled) => void act(() => api.setPluginEnabled(plugin.id, enabled))} />
        {plugin.kind !== 'system' ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" disabled={busy} aria-label={plugin.name}><ChevronDown /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => void act(() => api.updatePlugin(plugin.id))}>{t('plugins.update')}</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setToRemove(plugin)} disabled={plugin.enabled}>{t('plugins.remove')}</DropdownMenuItem>
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </SettingsRow>
  )

  return (
    <div className="flex flex-col gap-8">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">{t('plugins.reloadHint')}</p>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t('plugins.system')}</p>
        <SettingsCard>{system.map(renderPlugin)}</SettingsCard>
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t('plugins.installed')}</p>
        {external.length ? <SettingsCard>{external.map(renderPlugin)}</SettingsCard> : <p className="text-sm text-muted-foreground">{t('plugins.none')}</p>}
        <p className="text-xs text-muted-foreground">{t('plugins.installWarning')} {t('plugins.configHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-52 flex-1" value={source} placeholder={t('plugins.sourcePlaceholder')} onChange={(event) => setSource(event.target.value)} />
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void api.pickPluginPath().then((path) => { if (path) setSource(path) }, (failure) => setError(errorText(failure)))}><FolderOpen data-icon="inline-start" />{t('plugins.choosePath')}</Button>
          <Button size="sm" disabled={busy || !source.trim()} onClick={() => void act(async () => { const result = await api.installPlugin(source.trim()); setSource(''); return result })}><Plus data-icon="inline-start" />{busy ? t('plugins.working') : t('plugins.install')}</Button>
        </div>
      </div>
      <Dialog open={!!selectedPluginId} onOpenChange={(open) => { if (!open) setSelectedPluginId(null) }}>
        <DialogContent className="max-h-[80vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:max-w-2xl" onOpenAutoFocus={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('plugins.configure')} · {selectedPlugin?.name}</DialogTitle>
          </DialogHeader>
      {selectedPlugin?.settings ? (
        <div className="flex flex-col gap-3">
          {pluginConfigError ? <p role="alert" className="text-sm text-destructive">{pluginConfigError}</p> : null}
          <SettingsCard>{selectedPlugin.settings.fields.map((field) => (
            <SettingsRow key={field.key} title={field.label} description={field.description ?? field.key}>
              {field.type === 'boolean' ? (
                <div className="flex items-center gap-2">
                  <Switch aria-label={field.label} checked={pluginDraft[field.key] === 'true'}
                    onCheckedChange={(checked) => setPluginDraft((current) => ({ ...current, [field.key]: String(checked) }))} />
                  <Button variant="ghost" size="sm" disabled={pluginDraft[field.key] === '__pig_default__'}
                    onClick={() => setPluginDraft((current) => ({ ...current, [field.key]: '__pig_default__' }))}>{t('plugins.defaultValue')}</Button>
                </div>
              ) : field.type === 'string' || field.type === 'integer' ? (
                <Input className="w-48" aria-label={field.label} type={field.type === 'integer' ? 'number' : 'text'} min={field.min} max={field.max} value={pluginDraft[field.key] === '__pig_default__' ? '' : pluginDraft[field.key] ?? ''}
                  onChange={(event) => setPluginDraft((current) => ({ ...current, [field.key]: event.target.value || '__pig_default__' }))} />
              ) : (
                <Select value={pluginDraft[field.key] ?? '__pig_default__'} onValueChange={(value) => setPluginDraft((current) => ({ ...current, [field.key]: value }))}>
                  <SelectTrigger size="sm" aria-label={field.label}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                    <SelectItem value="__pig_default__">{t('plugins.defaultValue')}</SelectItem>
                    {field.options?.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                  </SelectGroup></SelectContent>
                </Select>
              )}
            </SettingsRow>
          ))}</SettingsCard>
          <Button size="sm" className="self-end" disabled={configSaving} onClick={() => void saveConfig()}>{configSaving ? t('plugins.working') : t('plugins.save')}</Button>
        </div>
      ) : null}
      {selectedPluginId === 'observational-memory' ? <div className="flex flex-col gap-3">
        {settingsError ? <p role="alert" className="text-sm text-destructive">{settingsError}</p> : null}
        <SettingsCard>
          {numericKeys.map((key) => (
            <SettingsRow key={key} title={t(`plugins.${key}`)} description={key === 'observerChunkMaxTokens' ? t('plugins.observerChunkAutoHint') : t(`plugins.${key}Hint`)}>
              <Input className="w-30" aria-label={t(`plugins.${key}`)} type="number" min={key === 'compactAfterTokensRatio' ? '0.0001' : '1'} max={key === 'compactAfterTokensRatio' ? '0.9999' : undefined} step={key === 'compactAfterTokensRatio' ? 'any' : '1'} value={numbers[key] ?? ''} placeholder={key === 'observerChunkMaxTokens' ? t('plugins.autoDefault') : (defaults[key] === undefined ? '—' : String(defaults[key]))} onChange={(event) => setNumbers((items) => ({ ...items, [key]: event.target.value }))} />
            </SettingsRow>
          ))}
          <SettingsRow title={t('plugins.compactAfterTokensMode')} description={t('plugins.compactAfterTokensModeHint')}>
            <Select value={draft.compactAfterTokensMode ?? 'default'} onValueChange={(value) => setDraft((item) => ({ ...item, compactAfterTokensMode: value === 'default' ? undefined : value as 'ratio' | 'calibrated' }))}>
              <SelectTrigger size="sm" aria-label={t('plugins.compactAfterTokensMode')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                <SelectItem value="default">{t('plugins.defaultValue')}</SelectItem>
                <SelectItem value="calibrated">{t('plugins.calibrated')}</SelectItem>
                <SelectItem value="ratio">{t('plugins.ratio')}</SelectItem>
              </SelectGroup></SelectContent>
            </Select>
          </SettingsRow>
          {booleanKeys.map((key) => (
            <SettingsRow key={key} title={t(`plugins.${key}`)} description={t(`plugins.${key}Hint`)}>
              <Switch aria-label={t(`plugins.${key}`)} checked={draft[key] ?? (key === 'showWorkerNotifications' || key === 'showCompactionNotifications')}
                onCheckedChange={(checked) => setDraft((item) => ({ ...item, [key]: checked }))} />
            </SettingsRow>
          ))}
          <SettingsRow title={t('plugins.memoryModel')} description={t('plugins.memoryModelHint')}>
            <div className="flex flex-wrap items-center gap-2">
              <DefaultModelPicker model={memoryModel} models={models} onSelect={(item) => { setModelProvider(item.provider); setModelId(item.id) }} />
              {modelProvider.trim() && modelId.trim() ? (
                <Button size="icon-sm" variant="ghost" aria-label={t('plugins.clearModel')}
                  onClick={() => { setModelProvider(''); setModelId(''); setModelThinking('default') }}><X /></Button>
              ) : null}
              <Select value={modelThinking} onValueChange={setModelThinking}>
                <SelectTrigger size="sm" aria-label={t('plugins.thinking')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                  <SelectItem value="default">{t('plugins.thinking')}</SelectItem>
                  {(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
                </SelectGroup></SelectContent>
              </Select>
            </div>
          </SettingsRow>
        </SettingsCard>
        <Button size="sm" className="self-end" disabled={saving} onClick={() => void saveMemory()}>{saving ? t('plugins.working') : t('plugins.save')}</Button>
      </div> : null}
      {selectedPluginId === 'pi-web-access' ? <WebSearchSettings onClose={() => setSelectedPluginId(null)} /> : null}
        </DialogContent>
      </Dialog>
      <Dialog open={!!toRemove} onOpenChange={(open) => { if (!open) setToRemove(null) }}>
        <DialogContent><DialogHeader><DialogTitle>{t('plugins.remove')} {toRemove?.name}</DialogTitle><DialogDescription>{toRemove?.source}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToRemove(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={() => { const plugin = toRemove; setToRemove(null); if (plugin) void act(() => api.removePlugin(plugin.id)) }}>{t('plugins.remove')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

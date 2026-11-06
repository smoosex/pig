/** Standalone configuration of built-in observational memory. */
import { useEffect, useState } from 'react'
import { api, type MemorySettings, type MemorySettingsPatch, type ThinkingLevel } from '../../ipc/api'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { ModelThinkingPicker, supportedThinking } from './ModelThinkingPicker'

const numericKeys = [
  'observeAfterTokens', 'reflectAfterTokens', 'observerChunkMaxTokens', 'compactAfterTokens',
  'compactAfterTokensRatio', 'workerMemoryMaxTokens', 'compactionMaxRetainedTokens',
  'compactionSummaryMaxTokens', 'observationsPoolMaxTokens', 'observationsPoolTargetTokens',
  'agentMaxTurns', 'agentMaxTokens'
] as const
// Rendered alongside the numeric keys; 0 is a meaningful value (disables catch-up).
const nonNegativeKeys = ['compactionCatchUpMaxChunks'] as const
const numberSettingKeys = [...numericKeys, ...nonNegativeKeys] as const
const booleanKeys = ['consolidateWhenIdle', 'showWorkerNotifications', 'showCompactionNotifications', 'passive', 'debugLog'] as const

/** Drafts keep the unset level as a sentinel string; the picker takes null. */
function thinkingOf(value: string | undefined): ThinkingLevel | null {
  return value && value !== 'default' && value !== '__pig_default__' ? value as ThinkingLevel : null
}

export function MemorySettings({ onDirtyChange, onBusyChange }: { onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const t = useT()
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState<MemorySettings>({})
  const [draft, setDraft] = useState<MemorySettings>({})
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [defaults, setDefaults] = useState<Record<string, number>>({})
  const [modelProvider, setModelProvider] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelThinking, setModelThinking] = useState('default')
  const [fallbackProvider, setFallbackProvider] = useState('')
  const [fallbackId, setFallbackId] = useState('')
  const [fallbackThinking, setFallbackThinking] = useState('default')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const models = useModelCatalogStore((s) => s.models)
  const memoryModel = modelProvider.trim() && modelId.trim()
    ? models.find((item) => item.provider === modelProvider.trim() && item.id === modelId.trim()) ?? null
    : null
  const memoryFallbackModel = fallbackProvider.trim() && fallbackId.trim()
    ? models.find((item) => item.provider === fallbackProvider.trim() && item.id === fallbackId.trim()) ?? null
    : null

  useEffect(() => {
    let cancelled = false
    void Promise.all([api.getMemoryDefaults(), api.getMemorySettings()]).then(([items, config]) => {
      if (cancelled) return
      setDefaults(items)
      setLoaded(true)
      setSaved(config)
      setDraft(config)
      setNumbers(Object.fromEntries(numberSettingKeys.map((key) => [key, config[key] == null ? '' : String(config[key])])))
      setModelProvider(config.model?.provider ?? '')
      setModelId(config.model?.id ?? '')
      setModelThinking(config.model?.thinking ?? 'default')
      setFallbackProvider(config.fallbackModel?.provider ?? '')
      setFallbackId(config.fallbackModel?.id ?? '')
      setFallbackThinking(config.fallbackModel?.thinking ?? 'default')
      setSettingsError(null)
    }, (failure) => { if (!cancelled) setSettingsError(failureMessage(failure)) })
    return () => { cancelled = true }
  }, [])


  const dirty = loaded && (
    numberSettingKeys.some(key => (numbers[key] ?? '').trim() !== (saved[key] == null ? '' : String(saved[key]))) ||
    booleanKeys.some(key => draft[key] !== saved[key]) ||
    draft.compactAfterTokensMode !== saved.compactAfterTokensMode ||
    modelProvider !== (saved.model?.provider ?? '') || modelId !== (saved.model?.id ?? '') || modelThinking !== (saved.model?.thinking ?? 'default') ||
    fallbackProvider !== (saved.fallbackModel?.provider ?? '') || fallbackId !== (saved.fallbackModel?.id ?? '') || fallbackThinking !== (saved.fallbackModel?.thinking ?? 'default')
  )
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  const saveMemory = async () => {
    if (!loaded || saving) return
    const patch: MemorySettingsPatch = {}
    for (const key of numberSettingKeys) {
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
      ? { provider: modelProvider.trim(), id: modelId.trim(), ...(modelThinking === 'default' ? {} : { thinking: modelThinking as NonNullable<MemorySettings['model']>['thinking'] }) }
      : null
    if ((modelProvider.trim() || modelId.trim()) && !model) {
      setSettingsError('Provider and model ID are both required')
      return
    }
    if (JSON.stringify(model) !== JSON.stringify(saved.model ?? null)) patch.model = model
    const fallback = fallbackProvider.trim() && fallbackId.trim()
      ? { provider: fallbackProvider.trim(), id: fallbackId.trim(), ...(fallbackThinking === 'default' ? {} : { thinking: fallbackThinking as NonNullable<MemorySettings['fallbackModel']>['thinking'] }) }
      : null
    if ((fallbackProvider.trim() || fallbackId.trim()) && !fallback) {
      setSettingsError('Provider and model ID are both required')
      return
    }
    if (JSON.stringify(fallback) !== JSON.stringify(saved.fallbackModel ?? null)) patch.fallbackModel = fallback
    setSaving(true)
    setSettingsError(null)
    try {
      const next = await api.setMemorySettings(patch)
      setSaved(next)
      setDraft(next)
      setNumbers(Object.fromEntries(numberSettingKeys.map((key) => [key, next[key] == null ? '' : String(next[key])])))
    } catch (failure) { setSettingsError(failureMessage(failure)) }
    finally { setSaving(false) }
  }


  return (
<div className="flex flex-col gap-3">
        {settingsError ? <p role="alert" className="text-sm text-destructive">{settingsError}</p> : null}
        <SettingsCard>
          <SettingsRow title={t('plugins.memoryModel')} description={t('plugins.memoryModelHint')}>
            <ModelThinkingPicker model={memoryModel} models={models}
              label={modelProvider.trim() && modelId.trim() ? `${modelProvider.trim()}/${modelId.trim()}` : undefined}
              thinking={thinkingOf(modelThinking)}
              defaultOption={{
                active: !(modelProvider.trim() && modelId.trim()),
                description: t('plugins.memoryModelDefault'),
                onSelect: () => { setModelProvider(''); setModelId(''); setModelThinking('default') }
              }}
              onModelChange={(item) => {
                setModelProvider(item.provider)
                setModelId(item.id)
                setModelThinking(supportedThinking(item, thinkingOf(modelThinking)) ?? 'default')
              }}
              onThinkingChange={setModelThinking} />
          </SettingsRow>
          <SettingsRow title={t('plugins.fallbackModel')} description={t('plugins.fallbackModelHint')}>
            <ModelThinkingPicker model={memoryFallbackModel} models={models}
              label={fallbackProvider.trim() && fallbackId.trim() ? `${fallbackProvider.trim()}/${fallbackId.trim()}` : undefined}
              thinking={thinkingOf(fallbackThinking)}
              defaultOption={{
                active: !(fallbackProvider.trim() && fallbackId.trim()),
                description: t('plugins.fallbackModelDefault'),
                onSelect: () => { setFallbackProvider(''); setFallbackId(''); setFallbackThinking('default') }
              }}
              onModelChange={(item) => {
                setFallbackProvider(item.provider)
                setFallbackId(item.id)
                setFallbackThinking(supportedThinking(item, thinkingOf(fallbackThinking)) ?? 'default')
              }}
              onThinkingChange={setFallbackThinking} />
          </SettingsRow>
          {numericKeys.map((key) => (
            <SettingsRow key={key} title={t(`plugins.${key}`)} description={key === 'observerChunkMaxTokens' ? t('plugins.observerChunkAutoHint') : t(`plugins.${key}Hint`)}>
              <Input className="w-30" aria-label={t(`plugins.${key}`)} type="number" min={key === 'compactAfterTokensRatio' ? '0.0001' : '1'} max={key === 'compactAfterTokensRatio' ? '0.9999' : undefined} step={key === 'compactAfterTokensRatio' ? 'any' : '1'} value={numbers[key] ?? ''} placeholder={key === 'observerChunkMaxTokens' || key === 'workerMemoryMaxTokens' || key === 'compactionMaxRetainedTokens' || key === 'compactionSummaryMaxTokens' ? t('plugins.autoDefault') : (defaults[key] === undefined ? '—' : String(defaults[key]))} onChange={(event) => setNumbers((items) => ({ ...items, [key]: event.target.value }))} />
            </SettingsRow>
          ))}
          {nonNegativeKeys.map((key) => (
            <SettingsRow key={key} title={t(`plugins.${key}`)} description={t(`plugins.${key}Hint`)}>
              <Input className="w-30" aria-label={t(`plugins.${key}`)} type="number" min="0" step="1" value={numbers[key] ?? ''} placeholder={String(defaults[key] ?? '')} onChange={(event) => setNumbers((items) => ({ ...items, [key]: event.target.value }))} />
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
        </SettingsCard>
        <Button size="sm" className="self-end" disabled={saving || !loaded} onClick={() => void saveMemory()}>{saving ? t('plugins.working') : t('plugins.save')}</Button>
      </div>  )
}

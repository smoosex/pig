/** Standalone configuration of built-in observational memory. */
import { useEffect, useState } from 'react'
import { api, type MemorySettings, type MemorySettingsPatch } from '../../ipc/api'
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

const modelKeys = ['model', 'fallbackModel'] as const

export function MemorySettings({ onDirtyChange, onBusyChange }: { onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const t = useT()
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState<MemorySettings>({})
  const [draft, setDraft] = useState<MemorySettings>({})
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [defaults, setDefaults] = useState<Record<string, number>>({})
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const models = useModelCatalogStore((s) => s.models)
  const memoryModel = models.find((item) => item.provider === draft.model?.provider && item.id === draft.model?.id) ?? null
  const memoryFallbackModel = models.find((item) => item.provider === draft.fallbackModel?.provider && item.id === draft.fallbackModel?.id) ?? null

  useEffect(() => {
    let cancelled = false
    void Promise.all([api.getMemoryDefaults(), api.getMemorySettings()]).then(([items, config]) => {
      if (cancelled) return
      setDefaults(items)
      setLoaded(true)
      setSaved(config)
      setDraft(config)
      setNumbers(Object.fromEntries(numberSettingKeys.map((key) => [key, config[key] == null ? '' : String(config[key])])))
      setSettingsError(null)
    }, (failure) => { if (!cancelled) setSettingsError(failureMessage(failure)) })
    return () => { cancelled = true }
  }, [])

  const modelChanged = (key: typeof modelKeys[number]) =>
    draft[key]?.provider !== saved[key]?.provider || draft[key]?.id !== saved[key]?.id || draft[key]?.thinking !== saved[key]?.thinking
  const dirty = loaded && (
    numberSettingKeys.some(key => (numbers[key] ?? '').trim() !== (saved[key] == null ? '' : String(saved[key]))) ||
    booleanKeys.some(key => draft[key] !== saved[key]) ||
    draft.compactAfterTokensMode !== saved.compactAfterTokensMode ||
    modelKeys.some(modelChanged)
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
    for (const key of modelKeys) {
      if (modelChanged(key)) patch[key] = draft[key] ?? null
    }
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
              label={draft.model ? `${draft.model.provider}/${draft.model.id}` : undefined}
              thinking={draft.model?.thinking ?? null}
              defaultOption={{
                active: !draft.model,
                description: t('plugins.memoryModelDefault'),
                onSelect: () => setDraft({ ...draft, model: undefined })
              }}
              onModelChange={(item) => {
                const thinking = supportedThinking(item, draft.model?.thinking ?? null)
                setDraft({ ...draft, model: { provider: item.provider, id: item.id, ...(thinking ? { thinking } : {}) } })
              }}
              onThinkingChange={(thinking) => { if (draft.model) setDraft({ ...draft, model: { ...draft.model, thinking } }) }} />
          </SettingsRow>
          <SettingsRow title={t('plugins.fallbackModel')} description={t('plugins.fallbackModelHint')}>
            <ModelThinkingPicker model={memoryFallbackModel} models={models}
              label={draft.fallbackModel ? `${draft.fallbackModel.provider}/${draft.fallbackModel.id}` : undefined}
              thinking={draft.fallbackModel?.thinking ?? null}
              defaultOption={{
                active: !draft.fallbackModel,
                description: t('plugins.fallbackModelDefault'),
                onSelect: () => setDraft({ ...draft, fallbackModel: undefined })
              }}
              onModelChange={(item) => {
                const thinking = supportedThinking(item, draft.fallbackModel?.thinking ?? null)
                setDraft({ ...draft, fallbackModel: { provider: item.provider, id: item.id, ...(thinking ? { thinking } : {}) } })
              }}
              onThinkingChange={(thinking) => { if (draft.fallbackModel) setDraft({ ...draft, fallbackModel: { ...draft.fallbackModel, thinking } }) }} />
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

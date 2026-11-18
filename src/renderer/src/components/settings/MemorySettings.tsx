/** Standalone configuration of built-in observational memory. */
import { useEffect, useRef, useState } from 'react'
import { api, type MemorySettings, type MemorySettingsPatch } from '../../ipc/api'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { useT } from '../../hooks/useT'
import { failureMessage } from '../../lib/ipc-error'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { ModelThinkingPicker, supportedThinking } from './ModelThinkingPicker'

const numericKeys = [
  'observeAfterTokens', 'reflectAfterTokens', 'observerChunkMaxTokens', 'compactAfterTokens',
  'compactAfterTokensRatio', 'workerMemoryMaxTokens', 'compactionMaxRetainedTokens',
  'compactionSummaryMaxTokens', 'observationsPoolMaxTokens', 'observationsPoolTargetTokens',
  'agentMaxTurns', 'agentMaxTokens'
] as const
const nonNegativeKeys = ['compactionCatchUpMaxChunks'] as const
const numberSettingKeys = [...numericKeys, ...nonNegativeKeys] as const
const booleanKeys = ['consolidateWhenIdle', 'showWorkerNotifications', 'showCompactionNotifications', 'passive', 'debugLog'] as const
const modelKeys = ['model', 'fallbackModel'] as const

export function MemorySettings({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const t = useT()
  const [config, setConfig] = useState<MemorySettings>()
  const [defaults, setDefaults] = useState<Record<string, number>>({})
  const [error, setError] = useState<string>()
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState(true)
  const saving = useRef(false)
  const models = useModelCatalogStore((s) => s.models)

  useEffect(() => {
    let active = true
    setBusy(true)
    setError(undefined)
    void Promise.all([api.getObservationalMemorySettings(), api.getMemoryDefaults()]).then(
      ([value, fallback]) => { if (active) { setConfig(value); setDefaults(fallback) } },
      (failure) => { if (active) setError(failureMessage(failure)) }
    ).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [reloadKey])

  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  const change = async (patch: MemorySettingsPatch) => {
    if (!config || busy || saving.current) return
    saving.current = true
    setBusy(true)
    setError(undefined)
    try {
      setConfig(await api.setObservationalMemorySettings(patch))
    } catch (failure) {
      const message = failureMessage(failure)
      setError(message)
      // Applying the settings can fail after persistence, so the old UI value is not authoritative.
      try { setConfig(await api.getObservationalMemorySettings()) }
      catch (reloadFailure) {
        setConfig(undefined)
        setError(`${message}\n${t('longTerm.reloadFailed', { error: failureMessage(reloadFailure) })}`)
      }
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const disabled = !config || busy
  return (
    <div className="flex flex-col gap-3">
      {error ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
      {!config && error ? <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => setReloadKey(key => key + 1)}>{t('longTerm.reload')}</Button> : null}
      <SettingsCard>
        {modelKeys.map(key => {
          const selected = config?.[key]
          const model = models.find(item => item.provider === selected?.provider && item.id === selected?.id) ?? null
          return <SettingsRow key={key} title={t(key === 'model' ? 'plugins.memoryModel' : 'plugins.fallbackModel')}
            description={t(key === 'model' ? 'plugins.memoryModelHint' : 'plugins.fallbackModelHint')}>
            <ModelThinkingPicker model={model} models={models} disabled={disabled}
              label={selected ? `${selected.provider}/${selected.id}` : undefined}
              thinking={selected?.thinking ?? null}
              defaultOption={{
                active: !selected,
                description: t(key === 'model' ? 'plugins.memoryModelDefault' : 'plugins.fallbackModelDefault'),
                onSelect: () => { if (selected) void change({ [key]: null }) }
              }}
              onModelChange={(item) => {
                if (item.provider === selected?.provider && item.id === selected.id) return
                const thinking = supportedThinking(item, selected?.thinking ?? null)
                void change({ [key]: { provider: item.provider, id: item.id, ...(thinking ? { thinking } : {}) } })
              }}
              onThinkingChange={(thinking) => {
                if (selected && selected.thinking !== thinking) void change({ [key]: { ...selected, thinking } })
              }} />
          </SettingsRow>
        })}
        {numberSettingKeys.map(key => {
          const value = config?.[key]
          const ratio = key === 'compactAfterTokensRatio'
          return <SettingsRow key={key} title={t(`plugins.${key}`)}
            description={key === 'observerChunkMaxTokens' ? t('plugins.observerChunkAutoHint') : t(`plugins.${key}Hint`)}>
            <Input key={value ?? 'default'} className="w-30" aria-label={t(`plugins.${key}`)} type="number" disabled={disabled}
              min={ratio ? undefined : key === 'compactionCatchUpMaxChunks' ? 0 : 1}
              step={ratio ? 'any' : 1}
              defaultValue={value ?? ''} placeholder={defaults[key]?.toString() ?? t('plugins.autoDefault')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
              onBlur={({ currentTarget: input }) => {
                const next = input.validity.badInput ? NaN : input.value === '' ? null : input.valueAsNumber
                input.value = value?.toString() ?? ''
                if (next !== (value ?? null)) void change({ [key]: next })
              }} />
          </SettingsRow>
        })}
        <SettingsRow title={t('plugins.compactAfterTokensMode')} description={t('plugins.compactAfterTokensModeHint')}>
          <Select disabled={disabled} value={config?.compactAfterTokensMode ?? 'default'} onValueChange={(value) => {
            if (value === 'default' || value === 'calibrated' || value === 'ratio') {
              void change({ compactAfterTokensMode: value === 'default' ? null : value })
            }
          }}>
            <SelectTrigger size="sm" aria-label={t('plugins.compactAfterTokensMode')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="default">{t('plugins.defaultValue')}</SelectItem>
              <SelectItem value="calibrated">{t('plugins.calibrated')}</SelectItem>
              <SelectItem value="ratio">{t('plugins.ratio')}</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </SettingsRow>
        {booleanKeys.map((key) => (
          <SettingsRow key={key} title={t(`plugins.${key}`)} description={t(`plugins.${key}Hint`)}>
            <Switch aria-label={t(`plugins.${key}`)} disabled={disabled}
              checked={config?.[key] ?? false}
              onCheckedChange={(checked) => void change({ [key]: checked })} />
          </SettingsRow>
        ))}
      </SettingsCard>
    </div>
  )
}

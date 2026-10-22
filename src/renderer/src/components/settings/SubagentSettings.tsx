import { useEffect, useState } from 'react'
import { useT } from '../../hooks/useT'
import { api, type SubagentSettings as Settings } from '../../ipc/api'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ModelThinkingPicker, supportedThinking } from './ModelThinkingPicker'
import { SettingsCard, SettingsRow } from './SettingsFields'

const LIMITS = [
  { key: 'maxConcurrent', min: 1 },
  { key: 'timeoutMinutes', min: 0 },
  { key: 'maxTurns', min: 0 }
] as const

export function SubagentSettings({ onClose }: { onClose: () => void }) {
  const t = useT()
  const models = useModelCatalogStore((state) => state.models)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    void api.getSubagentSettings().then(
      (settings) => {
        if (!current) return
        setDraft(settings)
        setNumbers(Object.fromEntries(LIMITS.map(({ key }) => [key, String(settings[key])])))
      },
      (reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) }
    )
    return () => { current = false }
  }, [])

  if (!draft) return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null

  const model = draft.model
    ? models.find((item) => item.provider === draft.model?.provider && item.id === draft.model?.id) ?? null
    : null

  const save = async () => {
    const limits: Partial<Record<(typeof LIMITS)[number]['key'], number>> = {}
    for (const { key, min } of LIMITS) {
      const value = Number(numbers[key])
      if (!Number.isSafeInteger(value) || value < min) {
        setError(`${t(`plugins.${key}`)}: ${t(`plugins.${key}Hint`)}`)
        return
      }
      limits[key] = value
    }
    setSaving(true)
    setError(null)
    try {
      await api.setSubagentSettings({
        model: draft.model ?? null,
        thinkingLevel: draft.model ? draft.thinkingLevel ?? null : null,
        ...limits
      })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <SettingsCard>
        <SettingsRow title={t('plugins.subagentModel')} description={t('plugins.subagentModelHint')}>
          <ModelThinkingPicker model={model} models={models}
            label={draft.model ? `${draft.model.provider}/${draft.model.id}` : undefined}
            thinking={draft.model ? draft.thinkingLevel ?? null : null}
            defaultOption={{
              active: !draft.model,
              description: t('plugins.subagentModelDefault'),
              onSelect: () => setDraft({ ...draft, model: undefined, thinkingLevel: undefined })
            }}
            onModelChange={(item) => setDraft({
              ...draft,
              model: { provider: item.provider, id: item.id },
              thinkingLevel: supportedThinking(item, draft.thinkingLevel ?? null) ?? undefined
            })}
            onThinkingChange={(thinkingLevel) => setDraft({ ...draft, thinkingLevel })} />
        </SettingsRow>
        {LIMITS.map(({ key, min }) => (
          <SettingsRow key={key} title={t(`plugins.${key}`)} description={t(`plugins.${key}Hint`)}>
            <Input className="w-30" aria-label={t(`plugins.${key}`)} type="number" min={min} step="1" value={numbers[key] ?? ''}
              onChange={(event) => setNumbers((items) => ({ ...items, [key]: event.target.value }))} />
          </SettingsRow>
        ))}
      </SettingsCard>
      <Button size="sm" className="self-end" disabled={saving} onClick={() => void save()}>{saving ? t('plugins.working') : t('plugins.save')}</Button>
    </div>
  )
}

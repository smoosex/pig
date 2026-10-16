import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../hooks/useT'
import { api, type SubagentSettings as Settings, type ThinkingLevel } from '../../ipc/api'
import { useModelCatalogStore } from '../../stores/model-catalog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { DefaultModelPicker } from './DefaultModelPicker'
import { SettingsCard, SettingsRow } from './SettingsFields'

const LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
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
        thinkingLevel: draft.thinkingLevel ?? null,
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
          <div className="flex flex-wrap items-center gap-2">
            {draft.model && !model ? <span className="text-xs text-muted-foreground">{draft.model.provider}/{draft.model.id}</span> : null}
            <DefaultModelPicker model={model} models={models} onSelect={(item) => setDraft({ ...draft, model: { provider: item.provider, id: item.id } })} />
            {draft.model ? (
              <Button size="icon-sm" variant="ghost" aria-label={t('plugins.clearSubagentModel')}
                onClick={() => setDraft({ ...draft, model: undefined })}><X /></Button>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow title={t('plugins.subagentThinking')} description={t('plugins.subagentThinkingHint')}>
          <Select
            value={draft.thinkingLevel ?? 'follow'}
            onValueChange={(value) => setDraft({ ...draft, thinkingLevel: value === 'follow' ? undefined : value as ThinkingLevel })}
          >
            <SelectTrigger size="sm" aria-label={t('plugins.subagentThinking')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="follow">{t('plugins.followSession')}</SelectItem>
              {LEVELS.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
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

import { LOCALES, type Locale, type MessageKey } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import type { LocaleSetting } from '../../ipc/api'
import { useSettingsStore } from '../../stores/settings'
import { useModelCatalogStore } from '../../stores/model-catalog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { Switch } from '../ui/switch'
import { ScopedModelsSetting } from './ScopedModelsSetting'
import { ModelThinkingPicker } from './ModelThinkingPicker'
import { SettingsCard, SettingsRow } from './SettingsFields'

/** Language names are endonyms, so each locale maps to its own key rather than to a translation. */
const languageLabels: Record<Locale, MessageKey> = {
  'zh-CN': 'settings.languageZh',
  en: 'settings.languageEn'
}

export function GeneralPane() {
  const t = useT()
  const localeSetting = useSettingsStore((s) => s.localeSetting)
  const systemLocale = useSettingsStore((s) => s.systemLocale)
  const setLocale = useSettingsStore((s) => s.setLocale)
  const beamBorderEnabled = useSettingsStore((s) => s.beamBorderEnabled)
  const setBeamBorderEnabled = useSettingsStore((s) => s.setBeamBorderEnabled)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const defaultThinkingLevel = useSettingsStore((s) => s.defaultThinkingLevel)
  const thinkingLevels = useSettingsStore((s) => s.thinkingLevels)
  const defaultSettingsError = useSettingsStore((s) => s.defaultSettingsError)
  const models = useModelCatalogStore((s) => s.models)
  const completionNotifications = useSettingsStore((s) => s.completionNotifications)
  const setCompletionNotifications = useSettingsStore((s) => s.setCompletionNotifications)
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel)
  const setDefaultThinking = useSettingsStore((s) => s.setDefaultThinking)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('settings.sectionInterface')}
        </p>
        <SettingsCard>
          <SettingsRow
            title={t('settings.language')}
            description={t('settings.languageDescription')}
          >
            <Select
              value={localeSetting}
              onValueChange={(value) => void setLocale(value as LocaleSetting)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="system">
                    {t('settings.languageSystemWith', { language: t(languageLabels[systemLocale]) })}
                  </SelectItem>
                  {LOCALES.map((locale) => (
                    <SelectItem key={locale} value={locale}>
                      {t(languageLabels[locale])}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            title={t('settings.beamBorder')}
            description={t('settings.beamBorderDescription')}
          >
            <Switch
              aria-label={t('settings.beamBorder')}
              checked={beamBorderEnabled}
              onCheckedChange={(enabled) => void setBeamBorderEnabled(enabled)}
            />
          </SettingsRow>
        </SettingsCard>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('settings.notifications')}
        </p>
        <SettingsCard>
          <SettingsRow
            title={t('settings.completionNotifications')}
            description={t('settings.completionNotificationsDescription')}
          >
            <Select
              value={completionNotifications ? 'on' : 'off'}
              onValueChange={(value) => void setCompletionNotifications(value === 'on')}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="on">{t('settings.notificationsOn')}</SelectItem>
                  <SelectItem value="off">{t('settings.notificationsOff')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('settings.model')}
        </p>
        {defaultSettingsError ? (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {t('settings.defaultModelReadFailed', { message: defaultSettingsError })}
          </p>
        ) : null}
        <SettingsCard>
          <SettingsRow
            title={t('settings.defaultModel')}
            description={t('settings.defaultModelDescription')}
          >
            <ModelThinkingPicker
              model={defaultModel ? { ...defaultModel, thinkingLevels } : null}
              models={models}
              thinking={defaultThinkingLevel ?? thinkingLevels[0] ?? null}
              onModelChange={(item) => void setDefaultModel(item.provider, item.id)}
              onThinkingChange={(level) => void setDefaultThinking(level)}
            />
          </SettingsRow>
          <ScopedModelsSetting />
        </SettingsCard>
      </div>
    </div>
  )
}

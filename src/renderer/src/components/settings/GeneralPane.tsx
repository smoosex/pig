import { LOCALES, type Locale, type MessageKey } from '../../../../shared/i18n'
import { useT } from '../../hooks/useT'
import type { LocaleSetting, SendShortcut, ThinkingLevel } from '../../ipc/api'
import { thinkingLevelKeys } from '../../lib/thinking-levels'
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
import { DefaultModelPicker } from './DefaultModelPicker'
import { SettingsCard, SettingsRow } from './SettingsFields'
import { CodemodeSetting } from './ToolSettingsFields'

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
  const sendShortcut = useSettingsStore((s) => s.sendShortcut)
  const defaultModel = useSettingsStore((s) => s.defaultModel)
  const defaultThinkingLevel = useSettingsStore((s) => s.defaultThinkingLevel)
  const thinkingLevels = useSettingsStore((s) => s.thinkingLevels)
  const models = useModelCatalogStore((s) => s.models)
  const setSendShortcut = useSettingsStore((s) => s.setSendShortcut)
  const completionNotifications = useSettingsStore((s) => s.completionNotifications)
  const setCompletionNotifications = useSettingsStore((s) => s.setCompletionNotifications)
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel)
  const setDefaultThinking = useSettingsStore((s) => s.setDefaultThinking)
  const newline = sendShortcut === 'enter' ? 'Shift+Enter' : 'Enter'

  return (
    <div className="flex flex-col gap-8">
      <CodemodeSetting />
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
          {t('settings.send')}
        </p>
        <SettingsCard>
          <SettingsRow
            title={t('settings.sendShortcut')}
            description={t('settings.sendShortcutDescription', { key: newline })}
          >
            <Select
              value={sendShortcut}
              onValueChange={(value) => void setSendShortcut(value as SendShortcut)}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="enter">Enter</SelectItem>
                  <SelectItem value="shift-enter">Shift+Enter</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
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
        <SettingsCard>
          <SettingsRow
            title={t('settings.defaultModel')}
            description={t('settings.defaultModelDescription')}
          >
            <DefaultModelPicker
              model={defaultModel}
              models={models}
              onSelect={(item) => void setDefaultModel(item.provider, item.id)}
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.defaultThinking')}
            description={t('settings.defaultThinkingDescription')}
          >
            {thinkingLevels.length === 0 ? (
              <span className="text-xs text-muted-foreground">{t('settings.thinkingUnsupported')}</span>
            ) : (
              <Select
                value={defaultThinkingLevel ?? thinkingLevels[0]}
                onValueChange={(value) => void setDefaultThinking(value as ThinkingLevel)}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectGroup>
                    {thinkingLevels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t(thinkingLevelKeys[level])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  )
}

import type { MessageKey } from '../../../../shared/i18n'
import type { PaletteId } from '../../ipc/api'
import { useT } from '../../hooks/useT'
import { useSettingsStore } from '../../stores/settings'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { GooeyNav } from '../ui/gooey-nav'
import { SettingsCard, SettingsRow } from './SettingsFields'

const APPEARANCES = ['system', 'light', 'dark'] as const

const APPEARANCE_KEYS: Record<(typeof APPEARANCES)[number], MessageKey> = {
  system: 'settings.appearanceSystem',
  light: 'settings.appearanceLight',
  dark: 'settings.appearanceDark'
}

export function ThemePane() {
  const t = useT()
  const appearance = useSettingsStore((s) => s.appearance)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)
  const setTheme = useSettingsStore((s) => s.setTheme)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('settings.appearance')}
        </p>
        <SettingsCard>
          <SettingsRow
            title={t('settings.appearance')}
            description={t('settings.appearanceDescription')}
          >
            <GooeyNav
              size="sm"
              aria-label={t('settings.appearance')}
              items={APPEARANCES.map((item) => t(APPEARANCE_KEYS[item]))}
              value={APPEARANCES.indexOf(appearance)}
              onChange={(index) => {
                const next = APPEARANCES[index]
                if (!next) return
                void setTheme({ appearance: next })
              }}
            />
          </SettingsRow>
        </SettingsCard>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('settings.theme')}
        </p>
        <SettingsCard>
          <SettingsRow
            title={t('settings.themeLight')}
            description={t('settings.themeLightDescription')}
          >
            <Select
              value={lightTheme}
              onValueChange={(value) => void setTheme({ lightTheme: value as PaletteId })}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="pig">{t('settings.themeDefault')}</SelectItem>
                  <SelectItem value="everforest">Everforest</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            title={t('settings.themeDark')}
            description={t('settings.themeDarkDescription')}
          >
            <Select
              value={darkTheme}
              onValueChange={(value) => void setTheme({ darkTheme: value as PaletteId })}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="pig">{t('settings.themeDefault')}</SelectItem>
                  <SelectItem value="everforest">Everforest</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  )
}

import type { PaletteId } from '../../ipc/api'
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

export function ThemePane() {
  const appearance = useSettingsStore((s) => s.appearance)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)
  const setTheme = useSettingsStore((s) => s.setTheme)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          外观
        </p>
        <SettingsCard>
          <SettingsRow title="外观" description="跟随系统，或固定浅色 / 暗色">
            <GooeyNav
              size="sm"
              aria-label="外观"
              items={['系统', '浅色', '暗色']}
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
          主题
        </p>
        <SettingsCard>
          <SettingsRow title="浅色主题" description="浅色外观时使用的配色">
            <Select
              value={lightTheme}
              onValueChange={(value) => void setTheme({ lightTheme: value as PaletteId })}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="pig">默认</SelectItem>
                  <SelectItem value="everforest">Everforest</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow title="暗色主题" description="暗色外观时使用的配色">
            <Select
              value={darkTheme}
              onValueChange={(value) => void setTheme({ darkTheme: value as PaletteId })}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="pig">默认</SelectItem>
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

import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/settings'

export function useComposerAppearance() {
  const appearance = useSettingsStore((s) => s.appearance)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    if (appearance !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [appearance])

  const dark = appearance === 'system' ? systemDark : appearance === 'dark'
  const palette = dark ? darkTheme : lightTheme
  return {
    theme: appearance === 'system' ? 'auto' as const : appearance,
    colorVariant: palette === 'everforest' ? 'forest' as const : 'colorful' as const
  }
}

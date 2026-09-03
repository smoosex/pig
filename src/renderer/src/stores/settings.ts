import { create } from 'zustand'
import {
  api,
  type AppSettings,
  type SendShortcut,
  type SessionModelInfo,
  type SettingsProvider,
  type ThemePrefs,
  type ThinkingLevel
} from '../ipc/api'
import { applyDocumentTheme } from '../lib/theme'

interface SettingsStore extends AppSettings {
  loaded: boolean
  load: () => Promise<void>
  setSendShortcut: (shortcut: SendShortcut) => Promise<void>
  setTheme: (patch: Partial<ThemePrefs>) => Promise<void>
  setDefaultModel: (provider: string, id: string) => Promise<void>
  setDefaultThinking: (level: ThinkingLevel) => Promise<void>
  setProviders: (providers: SettingsProvider[]) => void
}

const empty: AppSettings = {
  sendShortcut: 'enter',
  appearance: 'system',
  lightTheme: 'pig',
  darkTheme: 'pig',
  defaultModel: null,
  defaultThinkingLevel: null,
  thinkingLevels: [],
  models: [],
  providers: []
}

function applyDefaults(
  next: {
    model: SessionModelInfo | null
    thinkingLevel: ThinkingLevel | null
    thinkingLevels: ThinkingLevel[]
  }
): Pick<AppSettings, 'defaultModel' | 'defaultThinkingLevel' | 'thinkingLevels'> {
  return {
    defaultModel: next.model,
    defaultThinkingLevel: next.thinkingLevel,
    thinkingLevels: next.thinkingLevels
  }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...empty,
  loaded: false,

  load: async () => {
    const settings = await api.getSettings()
    applyDocumentTheme({
      appearance: settings.appearance,
      lightTheme: settings.lightTheme,
      darkTheme: settings.darkTheme
    })
    set({ ...settings, loaded: true })
  },

  setSendShortcut: async (shortcut) => {
    const next = await api.setSendShortcut(shortcut)
    set({ sendShortcut: next.sendShortcut })
  },

  setTheme: async (patch) => {
    const current = get()
    applyDocumentTheme({
      appearance: current.appearance,
      lightTheme: current.lightTheme,
      darkTheme: current.darkTheme,
      ...patch
    })
    const next = await api.setTheme(patch)
    applyDocumentTheme(next)
    set({
      appearance: next.appearance,
      lightTheme: next.lightTheme,
      darkTheme: next.darkTheme
    })
  },

  setDefaultModel: async (provider, id) => {
    set(applyDefaults(await api.setDefaultModelSetting(provider, id)))
  },

  setDefaultThinking: async (level) => {
    set(applyDefaults(await api.setDefaultThinkingSetting(level)))
  },

  setProviders: (providers) => set({ providers })
}))

export function modelKey(model: Pick<SessionModelInfo, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

import { create } from 'zustand'
import {
  api,
  type AppSettings,
  type SendShortcut,
  type SessionModelInfo,
  type SettingsProvider,
  type ThinkingLevel
} from '../ipc/api'

interface SettingsStore extends AppSettings {
  loaded: boolean
  load: () => Promise<void>
  setSendShortcut: (shortcut: SendShortcut) => Promise<void>
  setDefaultModel: (provider: string, id: string) => Promise<void>
  setDefaultThinking: (level: ThinkingLevel) => Promise<void>
  setProviders: (providers: SettingsProvider[]) => void
}

const empty: AppSettings = {
  sendShortcut: 'enter',
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

export const useSettingsStore = create<SettingsStore>((set) => ({
  ...empty,
  loaded: false,

  load: async () => {
    const settings = await api.getSettings()
    set({ ...settings, loaded: true })
  },

  setSendShortcut: async (shortcut) => {
    const next = await api.setSendShortcut(shortcut)
    set({ sendShortcut: next.sendShortcut })
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

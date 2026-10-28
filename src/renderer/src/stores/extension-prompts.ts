/**
 * Open extension prompts, fed once by `ExtensionUI`. Ordinary ones become a dialog there; permission
 * approvals are read by the owning session's composer instead. Either way a reply removes the prompt.
 */
import { create } from 'zustand'
import { api, type ExtensionUIEvent } from '../ipc/api'

export type ExtensionPrompt = Extract<ExtensionUIEvent, { kind: 'prompt' }>

interface ExtensionPromptsState {
  prompts: ExtensionPrompt[]
  add(prompt: ExtensionPrompt): void
  remove(id: string): void
}

export const useExtensionPrompts = create<ExtensionPromptsState>((set) => ({
  prompts: [],
  add: (prompt) => set((state) => ({ prompts: [...state.prompts, prompt] })),
  remove: (id) => set((state) => ({ prompts: state.prompts.filter((item) => item.id !== id) }))
}))

/** Removes the prompt locally first so a second keypress cannot answer it twice. */
export function replyExtensionPrompt(id: string, value: string | null): Promise<void> {
  useExtensionPrompts.getState().remove(id)
  return api.replyExtensionUI(id, value)
}

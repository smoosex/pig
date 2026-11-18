/** Persona and memory are built in for all human conversations, never child agents. */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'

export function conversationFeatureFactories(): InlineExtension[] {
  return [
    { name: 'pig-persona', factory: async pi => {
      const { default: persona } = await import('./persona')
      persona(pi)
    } },
    { name: 'observational-memory', factory: async pi => {
      const { default: memory } = await import('./memory')
      await memory(pi)
    } },
  ]
}

/** Persisted visual identity; Lucide components and theme classes stay in the renderer. */
export const SUBAGENT_ANIMALS = [
  'panda', 'cat', 'turtle', 'rat', 'squirrel', 'dog', 'fish', 'rabbit', 'bird', 'snail', 'shrimp', 'piggy-bank'
] as const
export const SUBAGENT_COLORS = [1, 2, 3, 4, 5, 6, 7] as const

export interface SubagentAppearance {
  animal: typeof SUBAGENT_ANIMALS[number]
  color: typeof SUBAGENT_COLORS[number]
}

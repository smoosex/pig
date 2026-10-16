/** Prefer unused animals and theme colors within a parent run; balance reuse after exhaustion. */
import { randomInt } from 'node:crypto'
import { SUBAGENT_ANIMALS, SUBAGENT_COLORS, type SubagentAppearance } from '../../shared/subagent-appearance'

function leastUsed<T>(choices: readonly T[], used: readonly T[]): T {
  const counts = new Map(choices.map((choice) => [choice, 0]))
  for (const choice of used) counts.set(choice, (counts.get(choice) ?? 0) + 1)
  const minimum = Math.min(...choices.map((choice) => counts.get(choice)!))
  const candidates = choices.filter((choice) => counts.get(choice) === minimum)
  return candidates[randomInt(candidates.length)]
}

export function chooseSubagentAppearance(used: readonly SubagentAppearance[]): SubagentAppearance {
  return {
    animal: leastUsed(SUBAGENT_ANIMALS, used.map((item) => item.animal)),
    color: leastUsed(SUBAGENT_COLORS, used.map((item) => item.color))
  }
}

import type { MessageKey } from '../../../shared/i18n'
import type { ThinkingLevel } from '../ipc/api'

/** The settings picker and the composer name the same levels, so both read this map. */
export const thinkingLevelKeys: Record<ThinkingLevel, MessageKey> = {
  off: 'thinking.off',
  minimal: 'thinking.minimal',
  low: 'thinking.low',
  medium: 'thinking.medium',
  high: 'thinking.high',
  xhigh: 'thinking.xhigh',
  max: 'thinking.max'
}

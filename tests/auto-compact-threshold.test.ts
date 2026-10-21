import { expect, test } from 'bun:test'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'
import { autoCompactAt } from '../src/main/pi/model-settings'

const settings = (enabled: boolean, reserveTokens: number, seen: unknown[] = []) => ({
  getCompactionSettings: (model?: unknown) => {
    seen.push(model)
    return { enabled, reserveTokens, keepRecentTokens: 20_000 }
  }
}) as unknown as SettingsManager

test('auto-compaction threshold follows Pi reserve tokens per model and is absent when disabled', () => {
  const seen: unknown[] = []
  const model = { provider: 'p', id: 'm' }
  expect(autoCompactAt(1_000_000, model, settings(true, 16_384, seen))).toBe(983_616)
  expect(seen).toEqual([model])
  expect(autoCompactAt(10_000, null, settings(true, 16_384))).toBe(0)
  expect(autoCompactAt(200_000, model, settings(false, 16_384))).toBeNull()
})

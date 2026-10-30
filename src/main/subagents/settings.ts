/** Subagent preferences in `$PIG_DIR/subagent-settings.json`; read per spawn so edits apply to the next child. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SubagentSettings, SubagentSettingsPatch, ThinkingLevel } from '../../shared/api'
import { pigPath } from '../pig-dir'

export const SUBAGENT_DEFAULTS: SubagentSettings = { maxConcurrent: 4, timeoutMinutes: 60, maxTurns: 100 }

const THINKING: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const settingsPath = () => pigPath('subagent-settings.json')

function isModel(value: unknown): value is { provider: string; id: string } {
  return !!value && typeof value === 'object' &&
    typeof (value as { provider?: unknown }).provider === 'string' && !!(value as { provider: string }).provider &&
    typeof (value as { id?: unknown }).id === 'string' && !!(value as { id: string }).id
}

function count(value: unknown, fallback: number, min: number): number {
  return Number.isSafeInteger(value) && (value as number) >= min ? value as number : fallback
}

function parse(value: unknown): SubagentSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    ...(isModel(raw.model) ? { model: { provider: raw.model.provider, id: raw.model.id } } : {}),
    ...(THINKING.includes(raw.thinkingLevel as ThinkingLevel) ? { thinkingLevel: raw.thinkingLevel as ThinkingLevel } : {}),
    maxConcurrent: count(raw.maxConcurrent, SUBAGENT_DEFAULTS.maxConcurrent, 1),
    timeoutMinutes: count(raw.timeoutMinutes, SUBAGENT_DEFAULTS.timeoutMinutes, 0),
    maxTurns: count(raw.maxTurns, SUBAGENT_DEFAULTS.maxTurns, 0)
  }
}

export async function readSubagentSettings(): Promise<SubagentSettings> {
  try {
    return parse(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...SUBAGENT_DEFAULTS }
    throw error
  }
}

let writing: Promise<unknown> = Promise.resolve()

export function writeSubagentSettings(patch: SubagentSettingsPatch): Promise<SubagentSettings> {
  const run = writing.then(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid subagent settings')
    const next: SubagentSettings = { ...(await readSubagentSettings()) }
    if (patch.model === null) delete next.model
    else if (patch.model !== undefined) {
      if (!isModel(patch.model)) throw new Error('Invalid subagent model')
      next.model = { provider: patch.model.provider, id: patch.model.id }
    }
    if (patch.thinkingLevel === null) delete next.thinkingLevel
    else if (patch.thinkingLevel !== undefined) {
      if (!THINKING.includes(patch.thinkingLevel)) throw new Error('Invalid subagent thinking level')
      next.thinkingLevel = patch.thinkingLevel
    }
    for (const [key, min] of [['maxConcurrent', 1], ['timeoutMinutes', 0], ['maxTurns', 0]] as const) {
      const value = patch[key]
      if (value === undefined) continue
      if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${key}`)
      next[key] = value
    }
    const path = settingsPath()
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`)
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    return next
  })
  writing = run.catch(() => undefined)
  return run
}

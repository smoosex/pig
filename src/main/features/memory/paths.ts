/** Extension-safe memory paths; no Electron or runtime dependencies. */
import { join } from 'node:path'

const root = (): string => process.env.PIG_DIR || join(process.cwd(), '.pig')

export const memorySettingsPath = (): string => join(root(), 'memory-settings.json')
export const fileMemoryPath = (): string => join(root(), 'memory')

/** Dedicated UI-only configuration of Pig's built-in persona and memory. */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { getMemoryDefaults, getMemorySettings, setMemorySettings } from '../features/memory-settings'
import { getLive, sessionCwd, sessionSourceFor } from '../pi/session-registry'
import { memoryStatus, memoryView } from '../features/memory/details'
import type { Entry } from '../features/memory/session-ledger'
import { applyConversationFeatures } from '../features/apply'
import type { MemorySettingsPatch } from '../../shared/api'

function assertUi(event: IpcMainInvokeEvent): void {
  assertBrowserSender(event, windowForEvent(event))
}
export function registerConversationFeaturesIpc(): void {
  ipcMain.handle('memory:enabled', (event, sessionId: string) => {
    assertUi(event)
    if (typeof sessionId !== 'string') throw new Error('Session id is required')
    sessionCwd(sessionId)
    return true
  })
  ipcMain.handle('memory:defaults', (event) => { assertUi(event); return getMemoryDefaults() })
  ipcMain.handle('memory:get', (event) => { assertUi(event); return getMemorySettings() })
  ipcMain.handle('memory:set', async (event, patch: MemorySettingsPatch) => {
    assertUi(event)
    const settings = await setMemorySettings(patch)
    await applyConversationFeatures()
    return settings
  })
  ipcMain.handle('memory:detail', async (event, sessionId: string, kind: 'status' | 'view', full?: boolean) => {
    assertUi(event)
    if (typeof sessionId !== 'string' || !['status', 'view'].includes(kind) || (full !== undefined && typeof full !== 'boolean')) {
      throw new Error('Invalid memory detail request')
    }
    sessionCwd(sessionId)
    const entries = (await sessionSourceFor(sessionId)).branch() as Entry[]
    if (kind === 'view') return memoryView(entries, full)
    return memoryStatus(sessionId, entries, getLive(sessionId)?.agentSession.model?.contextWindow, sessionCwd(sessionId))
  })
}

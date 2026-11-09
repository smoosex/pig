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
import { LongTermMemoryStore } from '../features/memory/long-term/store'
import { MEMORY_KINDS, type MemoryViewKind } from '../../shared/long-term-memory'
import { longTermMemoryPath } from '../features/memory/paths'
import { learningConcurrency } from '../features/memory/long-term/service'

function withLongTermStore<T>(action: (store: LongTermMemoryStore) => T): T {
  const store = new LongTermMemoryStore(longTermMemoryPath())
  try { return action(store) } finally { store.close() }
}
function memoryKind(value: unknown): asserts value is MemoryViewKind {
  if (value !== 'episodes' && !MEMORY_KINDS.includes(value as typeof MEMORY_KINDS[number])) throw new Error('Invalid long-term memory kind')
}
function memoryId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid long-term memory id')
}

function assertUi(event: IpcMainInvokeEvent): void {
  assertBrowserSender(event, windowForEvent(event))
}
export function registerConversationFeaturesIpc(): void {
  ipcMain.handle('memory:long-term:list', (event, kind: unknown, offset?: number) => {
    assertUi(event)
    memoryKind(kind)
    return withLongTermStore(store => store.page(kind, offset))
  })
  ipcMain.handle('memory:long-term:evidence', (event, id: unknown) => {
    assertUi(event)
    memoryId(id)
    return withLongTermStore(store => {
      const episode = store.episode(id)
      return episode ? [{ episodeId: episode.id, sources: episode.sources }] : store.evidence(id)
    })
  })
  ipcMain.handle('memory:long-term:status', event => {
    assertUi(event)
    return withLongTermStore(store => ({ ...store.status(), runningJobs: learningConcurrency() }))
  })
  ipcMain.handle('memory:long-term:delete-episode', (event, id: unknown) => {
    assertUi(event)
    memoryId(id)
    withLongTermStore(store => store.deleteEpisode(id))
  })
  ipcMain.handle('memory:long-term:forget', (event, id: unknown) => {
    assertUi(event)
    memoryId(id)
    withLongTermStore(store => store.forgetFact(id))
  })
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

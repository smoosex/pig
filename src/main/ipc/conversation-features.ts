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
import { MemoryFiles, memoryRoot } from '../features/memory/long-term/files'
import { join } from 'node:path'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'

const memoryFiles = () => new MemoryFiles(memoryRoot())
function scopedFile(path: unknown): { store: MemoryFiles; path: string } {
  if (typeof path !== 'string') throw new Error('Invalid memory path')
  const match = /^(global|projects\/[a-f0-9]{64})\/(.+)$/.exec(path)
  if (!match) throw new Error('Invalid memory scope path')
  return { store: new MemoryFiles(join(memoryRoot(), match[1]), memoryRoot()), path: match[2] }
}

function assertUi(event: IpcMainInvokeEvent): void {
  assertBrowserSender(event, windowForEvent(event))
}
export function registerConversationFeaturesIpc(): void {
  ipcMain.handle('memory:files:list', event => { assertUi(event); return memoryFiles().list() })
  ipcMain.handle('memory:files:read', (event, path: string) => { assertUi(event); const item = scopedFile(path); return { ...item.store.read(item.path), path } })
  ipcMain.handle('memory:files:save', async (event, path: string, content: string, revision: string) => {
    assertUi(event)
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid memory revision')
    const item = scopedFile(path)
    return withFileMutationQueue(item.store.resolve(item.path), async () => { assertUi(event); return { ...item.store.save(item.path, content, revision), path } })
  })
  ipcMain.handle('memory:files:delete', async (event, path: string, revision: string) => {
    assertUi(event)
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid memory revision')
    const item = scopedFile(path)
    return withFileMutationQueue(item.store.resolve(item.path), async () => { assertUi(event); item.store.delete(item.path, revision) })
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

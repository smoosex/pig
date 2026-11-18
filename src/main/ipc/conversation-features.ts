/** Dedicated UI-only configuration of Pig's built-in persona and memory. */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { getMemorySettings, setMemorySettings } from '../features/memory-settings'
import { getMemoryDefaults, getMemorySettings as getObservationalMemorySettings, setMemorySettings as setObservationalMemorySettings } from '../features/observational-memory-settings'
import { sessionState, withSource } from '../pi/session-registry'
import { controlsFor } from '../pi/session-controls'
import { memoryStatus, memoryView } from '../features/memory/details'
import type { Entry } from '../features/memory/session-ledger'
import { applyConversationFeatures } from '../features/apply'
import type { FileMemorySettingsPatch, MemorySettingsPatch } from '../../shared/api'
import { MemoryFiles, memoryRoot } from '../features/memory/long-term/files'
import { join } from 'node:path'
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { registerDreamIpc } from './dream'
import { shutdownDream } from '../features/memory/dream/lifecycle'

import { listMemoryFiles } from '../features/memory/long-term/catalog'
function scopedFile(path: unknown): { store: MemoryFiles; path: string } {
  if (typeof path !== 'string') throw new Error('Invalid memory path')
  const match = /^(global|projects\/[a-f0-9]{64})\/(.+)$/.exec(path)
  if (!match) throw new Error('Invalid memory scope path')
  return { store: new MemoryFiles(join(memoryRoot(), match[1]), memoryRoot()), path: match[2] }
}

function assertUi(event: IpcMainInvokeEvent) {
  const win = windowForEvent(event)
  assertBrowserSender(event, win)
  return win
}

function ownedSession(event: IpcMainInvokeEvent, sessionId: string) {
  const win = assertUi(event)
  const session = sessionState(sessionId)
  if (session.win !== win) throw new Error('Session belongs to another window')
  return session
}

export function registerConversationFeaturesIpc(): void {
  registerDreamIpc()
  ipcMain.handle('memory:files:list', async event => {
    assertUi(event)
    const files = await listMemoryFiles()
    assertUi(event)
    return files
  })
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
    ownedSession(event, sessionId)
    return true
  })
  ipcMain.handle('memory:get', (event) => { assertUi(event); return getMemorySettings() })
  ipcMain.handle('memory:defaults', (event) => { assertUi(event); return getMemoryDefaults() })
  ipcMain.handle('memory:observational:get', (event) => { assertUi(event); return getObservationalMemorySettings() })
  ipcMain.handle('memory:observational:set', async (event, patch: MemorySettingsPatch) => {
    assertUi(event)
    const settings = await setObservationalMemorySettings(patch)
    assertUi(event)
    await applyConversationFeatures()
    return settings
  })
  ipcMain.handle('memory:set', async (event, patch: FileMemorySettingsPatch) => {
    assertUi(event)
    const settings = await setMemorySettings(patch)
    if (patch.fileMemory?.enabled === false) await shutdownDream(true)
    await applyConversationFeatures()
    return settings
  })
  ipcMain.handle('memory:detail', async (event, sessionId: string, kind: 'status' | 'view', full?: boolean) => {
    assertUi(event)
    if (typeof sessionId !== 'string' || !['status', 'view'].includes(kind) || (full !== undefined && typeof full !== 'boolean')) {
      throw new Error('Invalid memory detail request')
    }
    return withSource(sessionId, async source => {
      const session = ownedSession(event, sessionId)
      if (kind === 'view') return memoryView(source.branch() as Entry[], full)
      const { model } = await controlsFor(session)
      if (ownedSession(event, sessionId) !== session) throw new Error('Session changed while reading memory')
      return memoryStatus(sessionId, source.branch() as Entry[], model?.contextWindow, session.cwd)
    }, () => { ownedSession(event, sessionId) })
  })
}

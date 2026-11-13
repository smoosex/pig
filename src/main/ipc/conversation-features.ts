/** Dedicated UI-only configuration of Pig's built-in persona and memory. */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { getMemorySettings, setMemorySettings } from '../features/memory-settings'
import { applyConversationFeatures } from '../features/apply'
import type { MemorySettingsPatch } from '../../shared/api'
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

function assertUi(event: IpcMainInvokeEvent): void {
  assertBrowserSender(event, windowForEvent(event))
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
  ipcMain.handle('memory:get', (event) => { assertUi(event); return getMemorySettings() })
  ipcMain.handle('memory:set', async (event, patch: MemorySettingsPatch) => {
    assertUi(event)
    const settings = await setMemorySettings(patch)
    if (patch.fileMemory?.enabled === false) await shutdownDream(true)
    await applyConversationFeatures()
    return settings
  })
}

/** Skills IPC accepts inventory ids and opaque probe tokens, never arbitrary file-read or delete paths. */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { dirname } from 'node:path'
import {
  discardSkillProbe, installSkills, listSkills, probeSkills, readSkill,
  removeSkill, setSkillEnabled, skillById
} from '../skills/manager'
import { searchSkillMarket } from '../skills/market'
import { hasBusyPluginSessions, refreshToolSessions } from '../pi/session-registry'

async function changed(): Promise<void> {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('skills:changed')
  }
  await refreshToolSessions()
}

export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('skills:enable', async (_event, id: string, enabled: boolean) => {
    await setSkillEnabled(id, enabled)
    await changed()
  })
  ipcMain.handle('skills:remove', async (_event, id: string) => {
    if (typeof id !== 'string') throw new Error('Skill id is required')
    if (hasBusyPluginSessions()) throw new Error('Wait for active sessions to finish before removing a skill')
    await removeSkill(id)
    await changed()
  })
  ipcMain.handle('skills:read', (_event, id: string) => readSkill(id))
  ipcMain.handle('skills:open-directory', async (_event, id: string) => {
    const skill = await skillById(id)
    const error = await shell.openPath(dirname(skill.filePath))
    if (error) throw new Error(error)
  })
  ipcMain.handle('skills:probe', (_event, source: string) => {
    if (typeof source !== 'string') throw new Error('Skill source is required')
    return probeSkills(source)
  })
  ipcMain.handle('skills:discard-probe', (_event, token: string) => discardSkillProbe(token))
  ipcMain.handle('skills:install', async (_event, token: string, paths: string[]) => {
    const result = await installSkills(token, paths)
    if (result.installed.length) await changed()
    return result
  })
  ipcMain.handle('skills:search', (_event, query: string) => {
    if (typeof query !== 'string') throw new Error('Search query is required')
    return searchSkillMarket(query)
  })
}

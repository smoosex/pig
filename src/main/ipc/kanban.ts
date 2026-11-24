/**
 * IPC boundary for the local Kanban board. Validates UI main-frame sender and ensures new project
 * assignments point to an opened project root.
 */
import { clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { resolve } from 'node:path'
import type { KanbanCreateInput, KanbanUpdateInput } from '../../shared/kanban'
import { assertBrowserSender } from '../browser/validation'
import { t } from '../i18n'
import { registerKanbanAgent } from '../kanban/agent-host'
import { kanban } from '../kanban/service'
import { listOpenedCwds } from '../opened-projects'
import { windowForEvent } from './window'

function assertUi(event: IpcMainInvokeEvent): void {
  const win = windowForEvent(event)
  assertBrowserSender(event, win)
}

async function validateAssignedProject(
  projectCwd: string | null | undefined,
  existingProjectCwd?: string | null
): Promise<string | null | undefined> {
  if (projectCwd === undefined) return undefined
  if (projectCwd === null || projectCwd === '') return null
  if (typeof projectCwd !== 'string') throw new Error('Invalid project path')
  const normalized = resolve(projectCwd)
  if (existingProjectCwd && resolve(existingProjectCwd) === normalized) return normalized
  const opened = await listOpenedCwds()
  if (!opened.includes(normalized)) {
    throw new Error('Project is not open in Pig')
  }
  return normalized
}

export function registerKanbanIpc(): void {
  registerKanbanAgent()
  ipcMain.handle('kanban:snapshot', (event) => {
    assertUi(event)
    return kanban.getSnapshot()
  })

  ipcMain.handle('kanban:create', async (event, raw: unknown) => {
    assertUi(event)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid issue payload')
    }
    const input = raw as KanbanCreateInput
    const projectCwd = await validateAssignedProject(input.projectCwd)
    return kanban.create({ ...input, projectCwd })
  })

  ipcMain.handle('kanban:update', async (event, raw: unknown) => {
    assertUi(event)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid issue update payload')
    }
    const input = raw as KanbanUpdateInput
    const existing = await kanban.getByNumber(input.number)
    if (!existing) throw new Error(`Issue #${input.number} not found`)
    const projectCwd = await validateAssignedProject(input.projectCwd, existing.projectCwd)
    return kanban.update({ ...input, ...(projectCwd !== undefined ? { projectCwd } : {}) })
  })

  ipcMain.handle('kanban:delete', async (event, number: unknown) => {
    assertUi(event)
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
      throw new Error('Invalid issue number')
    }
    return kanban.delete(number)
  })

  ipcMain.handle('kanban:copy', async (event, number: unknown) => {
    assertUi(event)
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
      throw new Error('Invalid issue number')
    }
    const text = await kanban.formatIssueForClipboard(number, t('kanban.copyImagesHeading'))
    clipboard.writeText(text)
    return text
  })
}

/**
 * IPC handlers for Project Spaces. Restricts access to UI main frames and validates
 * project paths against opened projects before persisting space assignments.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  CreateProjectSpaceInput,
  ProjectSpacesSnapshot,
  UpdateProjectSpaceInput
} from '../../shared/project-spaces'
import { assertBrowserSender } from '../browser/validation'
import { projectSpaces } from '../project-spaces'
import { requireOpenedProject } from '../project-worktrees'
import { windowForEvent } from './window'

function assertUi(event: IpcMainInvokeEvent): void {
  const win = windowForEvent(event)
  assertBrowserSender(event, win)
}

function broadcastChanged(snapshot: ProjectSpacesSnapshot): ProjectSpacesSnapshot {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('spaces:changed', snapshot)
    }
  }
  return snapshot
}

export function registerProjectSpacesIpc(): void {
  ipcMain.handle('spaces:snapshot', (event) => {
    assertUi(event)
    return projectSpaces.getSnapshot()
  })

  ipcMain.handle('spaces:select', async (event, spaceId: string) => {
    assertUi(event)
    return broadcastChanged(await projectSpaces.select(spaceId))
  })

  ipcMain.handle('spaces:create', async (event, input: CreateProjectSpaceInput) => {
    assertUi(event)
    const moveProjectCwd =
      typeof input?.moveProjectCwd === 'string' && input.moveProjectCwd
        ? await requireOpenedProject(input.moveProjectCwd)
        : undefined
    return broadcastChanged(
      await projectSpaces.create({
        ...input,
        moveProjectCwd
      })
    )
  })

  ipcMain.handle('spaces:update', async (event, input: UpdateProjectSpaceInput) => {
    assertUi(event)
    return broadcastChanged(await projectSpaces.update(input))
  })

  ipcMain.handle('spaces:remove', async (event, id: string) => {
    assertUi(event)
    return broadcastChanged(await projectSpaces.remove(id))
  })

  ipcMain.handle('spaces:assign-project', async (event, cwd: string, spaceId: string) => {
    assertUi(event)
    const verified = await requireOpenedProject(cwd)
    return broadcastChanged(await projectSpaces.assignProject(verified, spaceId))
  })

  ipcMain.handle('spaces:forget-project', async (event, cwd: string) => {
    assertUi(event)
    return broadcastChanged(await projectSpaces.forgetProject(cwd))
  })
}

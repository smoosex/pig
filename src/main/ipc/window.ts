import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export function windowForEvent(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('No window attached to sender')
  return win
}

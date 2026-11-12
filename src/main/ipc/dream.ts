/** Manual Dream is available only to the owning Pig UI main frame, never to model tools. */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assertBrowserSender } from '../browser/validation'
import { windowForEvent } from './window'
import { dreamService, validateDreamRequest } from '../features/memory/dream/service'
import { listDreamRecords, readDreamRecord } from '../features/memory/dream/records'

export function registerDreamIpc(): void {
  const bound = new WeakSet<Electron.WebContents>()
  const owner = (event: IpcMainInvokeEvent) => {
    const window = windowForEvent(event)
    assertBrowserSender(event, window)
    const contents = event.sender
    if (!bound.has(contents)) {
      bound.add(contents)
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) dreamService.cancelOwner(contents.id)
      })
      contents.on('render-process-gone', () => dreamService.cancelOwner(contents.id))
      contents.once('destroyed', () => dreamService.cancelOwner(contents.id))
    }
    return contents.id
  }
  ipcMain.handle('memory:dream:list', (event, offset?: number) => { owner(event); return listDreamRecords(offset) })
  ipcMain.handle('memory:dream:read', (event, id: string) => { owner(event); return readDreamRecord(id) })
  ipcMain.handle('memory:dream:status', event => { owner(event); return dreamService.status() })
  ipcMain.handle('memory:dream:start', (event, request: unknown) => {
    const id = owner(event)
    validateDreamRequest(request)
    return dreamService.start(id, request)
  })
  ipcMain.handle('memory:dream:stop', event => dreamService.stop(owner(event)))
}

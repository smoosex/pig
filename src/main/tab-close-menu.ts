/** Remove macOS's window-close role without adding a repeat-blind native tab accelerator. */
import { BrowserWindow, Menu, MenuItem } from 'electron'
import { BROWSER_SHORTCUT_CHANNEL } from '../shared/browser'
import { t } from './i18n'

export function installTabCloseMenu(): void {
  if (process.platform !== 'darwin') return
  const current = Menu.getApplicationMenu()
  if (!current) throw new Error('Application menu is unavailable')
  const replace = (menu: Menu): Menu => {
    const items = menu.items.map((item) => {
      if (item.role === 'close') {
        // Menu callbacks omit the repeat flag. Leave Cmd+W to the existing repeat-aware
        // renderer/guest handlers, and remove the native window-close role entirely.
        return new MenuItem({
          label: t('tabBar.closeTab'),
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
              win.webContents.send(BROWSER_SHORTCUT_CHANNEL, 'tab.close')
            }
          }
        })
      }
      if (!item.submenu) return item
      const submenu = replace(item.submenu)
      if (submenu === item.submenu) return item
      return new MenuItem({
        label: item.label, role: item.role, type: item.type, enabled: item.enabled, visible: item.visible,
        id: item.id, submenu
      })
    })
    if (items.every((item, index) => item === menu.items[index])) return menu
    const next = new Menu()
    for (const item of items) next.append(item)
    return next
  }
  Menu.setApplicationMenu(replace(current))
}

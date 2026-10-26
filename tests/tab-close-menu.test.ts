/** A native menu close accelerator must request a tab close, never perform native window closing. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'

async function fixture() {
  const { mock } = await import('bun:test')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  class Item {
    label = ''
    role?: string
    submenu?: FakeMenu
    click?: () => void
    accelerator?: string
    constructor(options: Record<string, unknown>) { Object.assign(this, options) }
  }
  class FakeMenu {
    items: Item[] = []
    static current: FakeMenu | null = null
    static getApplicationMenu() { return this.current }
    static setApplicationMenu(menu: FakeMenu) { this.current = menu }
    append(item: Item) { this.items.push(item) }
  }
  const sent: unknown[][] = []
  let focused: unknown = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) } }
  mock.module('electron', () => ({
    BrowserWindow: { getFocusedWindow: () => focused }, Menu: FakeMenu, MenuItem: Item
  }))
  const file = new FakeMenu()
  const quit = new Item({ role: 'quit', label: 'Quit' })
  file.items = [new Item({ role: 'close', label: 'Close Window' }), quit]
  const edit = new Item({ role: 'editMenu', label: 'Edit', submenu: new FakeMenu() })
  const copy = new Item({ role: 'copy', label: 'Copy' })
  edit.submenu!.items.push(copy)
  const menu = new FakeMenu()
  const services = new Item({ role: 'services', label: 'Services', submenu: new FakeMenu() })
  const windows = new Item({ role: 'windowMenu', label: 'Window', submenu: new FakeMenu() })
  menu.items = [new Item({ role: 'fileMenu', label: 'File', submenu: file }), edit, services, windows]
  FakeMenu.current = menu
  const { installTabCloseMenu } = await import('../src/main/tab-close-menu')
  installTabCloseMenu()
  const result = FakeMenu.current!
  const close = result.items[0]!.submenu!.items[0]!
  assert.equal(close.role, undefined, 'the native close role cannot bypass the callback')
  assert.equal(close.accelerator, undefined, 'no repeat-blind native accelerator bypasses the key handlers')
  assert.equal(result.items[0]!.role, 'fileMenu')
  assert.equal(result.items[1], edit, 'unmodified native submenus keep their identity')
  assert.equal(result.items[2], services, 'native Services registration remains intact')
  assert.equal(result.items[3], windows, 'native Window menu registration remains intact')
  close.click!()
  assert.deepEqual(sent, [['browser:host-shortcut-requested', 'tab.close']])
  assert.equal(result.items[0]!.submenu!.items[1], quit)
  assert.equal(result.items[1]!.submenu!.items[0], copy, 'editing roles are untouched')
  focused = null
  close.click!()
  assert.equal(sent.length, 1)
}

if (process.argv[2] === '--fixture') await fixture()
else test('native Cmd+W closes the active Pig tab without a window-close menu role', async () => {
  const child = Bun.spawn([process.execPath, import.meta.path, '--fixture'], { stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code, 0, err || out)
})

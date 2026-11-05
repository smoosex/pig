/** Keep background navigation from transferring native keyboard ownership. No DOM focus is changed. */
import type { BrowserWindow, WebContents } from 'electron'

export class BrowserFocusGuard {
  private contents = new Map<WebContents, () => boolean>()
  private protected = new Set<WebContents>()
  private current?: WebContents
  private restoring = false
  private cleanups = new Set<() => void>()

  constructor(private win: BrowserWindow) {
    this.register(win.webContents, () => true)
    const reset = () => { this.protected.clear(); this.current = undefined }
    win.on('blur', reset)
    win.on('hide', reset)
    win.on('minimize', reset)
    this.cleanups.add(() => {
      win.off('blur', reset)
      win.off('hide', reset)
      win.off('minimize', reset)
    })
  }

  private available(contents: WebContents): boolean {
    return !contents.isDestroyed() && this.contents.get(contents)?.() === true
  }

  private focused(): WebContents | undefined {
    if (this.current && this.available(this.current) && this.current.isFocused()) return this.current
    return [...this.contents.keys()].find(contents => this.available(contents) && contents.isFocused())
  }

  /** Called before starting background work, not when its completion promise resolves. */
  protect(contents: WebContents): void {
    if (!this.win.isFocused()) return
    const source = this.focused()
    if (source && source !== contents) {
      this.current = source
      this.protected.add(contents)
    }
  }

  userIntent(contents: WebContents): void { this.protected.delete(contents) }

  register(contents: WebContents, visible: () => boolean, publish?: () => void): void {
    this.contents.set(contents, visible)
    const focus = () => {
      if (this.win.isDestroyed() || !this.win.isFocused()) return
      if (this.restoring) { this.current = contents; return }
      if (!visible() || this.protected.has(contents)) {
        const source = this.current && this.available(this.current) ? this.current : this.focused()
        if (!this.win.isDestroyed() && this.win.isFocused() && source && source !== contents && this.available(source)) {
          this.restoring = true
          try { source.focus(); this.current = source } finally { this.restoring = false }
        }
        return
      }
      this.userIntent(contents)
      this.current = contents
      publish?.()
    }
    const mouse = (_event: unknown, input: { type: string }) => {
      if (input.type === 'mouseDown' && visible()) this.userIntent(contents)
    }
    const destroyed = () => {
      this.cleanups.delete(cleanup)
      this.contents.delete(contents)
      this.protected.delete(contents)
      if (this.current === contents) this.current = undefined
      contents.off('focus', focus)
      contents.off('before-mouse-event', mouse)
    }
    const cleanup = () => { destroyed(); contents.off('destroyed', destroyed) }
    contents.on('focus', focus)
    contents.on('before-mouse-event', mouse)
    contents.once('destroyed', destroyed)
    this.cleanups.add(cleanup)
    if (!this.current && this.win.isFocused() && visible() && contents.isFocused()) this.current = contents
  }

  dispose(): void {
    for (const cleanup of [...this.cleanups]) cleanup()
    this.cleanups.clear()
    this.protected.clear()
    this.contents.clear()
    this.current = undefined
  }
}

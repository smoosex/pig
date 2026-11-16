/** Session-wide download gate with page-owned lifetimes and native save dialogs. */
import type { DownloadItem, Event, Session, WebContents } from 'electron'

export interface BrowserDownloadOptions {
  isAlive(): boolean
  report(error: string): void
  /** Trusted, localized generic message; native errors and download metadata are never reported. */
  errorMessage: string
  saveDialogTitle?: string
}

interface DownloadOwner {
  dispose(): void
  start(event: Event, item: DownloadItem): void
}
const owners = new WeakMap<Session, Map<WebContents, DownloadOwner>>()

function sessionOwners(session: Session): Map<WebContents, DownloadOwner> {
  const existing = owners.get(session)
  if (existing) return existing
  const pages = new Map<WebContents, DownloadOwner>()
  // Keep the gate installed even with no registrations: otherwise unknown sources regain downloads.
  session.on('will-download', (event, item, contents) => {
    const owner = pages.get(contents)
    if (owner) owner.start(event, item)
    else event.preventDefault()
  })
  owners.set(session, pages)
  return pages
}

/** The host must call the returned cleanup on teardown; isAlive also guards late events. */
export function registerBrowserDownloads(contents: WebContents, options: BrowserDownloadOptions): () => void {
  if (contents.isDestroyed() || !options.isAlive()) return () => {}
  const pages = sessionOwners(contents.session)
  pages.get(contents)?.dispose()
  const pending = new Map<DownloadItem, () => void>()
  let disposed = false
  const alive = (): boolean => !disposed && !contents.isDestroyed() && options.isAlive()
  const report = (): void => { if (alive()) options.report(options.errorMessage) }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (pages.get(contents) === owner) pages.delete(contents)
    contents.removeListener('destroyed', dispose)
    for (const [item, detach] of pending) {
      detach()
      try {
        item.cancel()
      } catch {
        // Native teardown may already have invalidated an item; never expose its error.
      }
    }
  }
  const owner: DownloadOwner = {
    dispose,
    start(event, item) {
      if (!alive()) {
        event.preventDefault()
        dispose()
        return
      }
      try {
        // Never setSavePath: Electron owns the system save dialog and the user's destination.
        item.setSaveDialogOptions(options.saveDialogTitle === undefined ? {} : { title: options.saveDialogTitle })
      } catch {
        event.preventDefault()
        report()
        return
      }
      let attached = true
      let reported = false
      const detach = (): void => {
        attached = false
        pending.delete(item)
        item.removeListener('updated', updated)
        item.removeListener('done', done)
      }
      const interrupted = (): void => {
        if (reported) return
        reported = true
        report()
      }
      const updated = (_event: Event, state: 'progressing' | 'interrupted'): void => {
        if (!attached) return
        if (!alive()) { dispose(); return }
        // updated/interrupted is resumable, not terminal: keep ownership until done or cleanup.
        if (state === 'interrupted') interrupted()
      }
      const done = (_event: Event, state: 'completed' | 'cancelled' | 'interrupted'): void => {
        if (!attached) return
        detach()
        if (!alive()) { dispose(); return }
        if (state === 'interrupted') interrupted()
      }
      pending.set(item, detach)
      item.on('updated', updated)
      item.on('done', done)
    }
  }
  pages.set(contents, owner)
  contents.once('destroyed', dispose)
  return dispose
}

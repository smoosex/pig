/**
 * The window's document decides what the preload bridge can reach, so it may only ever be pig's own
 * UI. The preload runs in every document of the window — including one that was navigated to a
 * `pig-image` payload, which is a real origin serving bytes from session entries — so any other
 * navigation would run that content with the bridge attached.
 */
import { pathToFileURL } from 'node:url'

export interface AppUrlOptions {
  /** Dev server URL; any path of it is the app, everything else is not. */
  devServer?: string
  /** Absolute path of the bundled renderer entry. */
  rendererHtml: string
}

export function createAppUrlCheck({ devServer, rendererHtml }: AppUrlOptions): (url: string) => boolean {
  const fileUrl = pathToFileURL(rendererHtml).href
  const devOrigin = devServer ? devOriginOf(devServer) : null
  return (url) => {
    if (url === fileUrl) return true
    if (!devOrigin) return false
    return devOriginOf(url) === devOrigin
  }
}

/** The part of `webContents` the guard needs; a redirect is the same risk as a navigation. */
export interface NavigationHost {
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (event: { preventDefault: () => void }, url: string) => void
  ): unknown
}

export function installNavigationGuard(
  webContents: NavigationHost,
  isAppUrl: (url: string) => boolean
): void {
  const guard = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAppUrl(url)) event.preventDefault()
  }
  webContents.on('will-navigate', guard)
  webContents.on('will-redirect', guard)
}

function devOriginOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

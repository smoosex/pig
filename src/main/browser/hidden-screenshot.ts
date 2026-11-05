/** CDP requests frames before capture, unlike capturePage's early surface-availability check. */
import type { Debugger, WebContents } from 'electron'
import { withBrowserDebugger } from './browser-debugger'

export function captureHiddenPage(contents: WebContents): Promise<string> {
  return withBrowserDebugger(contents, captureHiddenFrame)
}

/** Also usable inside an existing queue operation; never recursively acquire the queue. */
export async function captureHiddenFrame(debuggerApi: Debugger): Promise<string> {
  const result = await debuggerApi.sendCommand('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false
  })
  if (typeof result.data !== 'string' || !result.data) throw new Error('Browser screenshot is empty')
  return result.data
}

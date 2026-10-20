/** CDP requests frames before capture, unlike capturePage's early surface-availability check. */
import type { WebContents } from 'electron'
import { withBrowserDebugger } from './browser-debugger'

export function captureHiddenPage(contents: WebContents): Promise<string> {
  return withBrowserDebugger(contents, async debuggerApi => {
    const result = await debuggerApi.sendCommand('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false
    })
    if (typeof result.data !== 'string' || !result.data) throw new Error('Browser screenshot is empty')
    return result.data
  })
}

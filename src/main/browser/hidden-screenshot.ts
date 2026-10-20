/** CDP requests frames before capture, unlike capturePage's early surface-availability check. */
import type { WebContents } from 'electron'

const captures = new WeakMap<WebContents, Promise<string>>()

export function captureHiddenPage(contents: WebContents): Promise<string> {
  const previous = captures.get(contents)
  const capture = async (): Promise<string> => {
    const debuggerApi = contents.debugger
    const attachedHere = !debuggerApi.isAttached()
    if (attachedHere) debuggerApi.attach('1.3')
    try {
      const result = await debuggerApi.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false
      })
      if (typeof result.data !== 'string' || !result.data) throw new Error('Browser screenshot is empty')
      return result.data
    } finally {
      if (attachedHere && !contents.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach()
    }
  }
  // Serialize temporary debugger ownership; a failed capture must not poison the next request.
  const result = previous ? previous.then(capture, capture) : capture()
  captures.set(contents, result)
  const cleanup = () => { if (captures.get(contents) === result) captures.delete(contents) }
  void result.then(cleanup, cleanup)
  return result
}

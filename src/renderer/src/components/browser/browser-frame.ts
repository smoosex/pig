/** Paint barriers for handing the viewport between a native page and its renderer snapshot. */
export function decodeBrowserFrame(frame: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const image = new Image()
  image.src = frame
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
    image.decode().then(finish, error => {
      signal.removeEventListener('abort', finish)
      reject(error)
    })
  })
}

export function waitForBrowserPaint(signal: AbortSignal): Promise<void> {
  if (signal.aborted || document.hidden) return Promise.resolve()
  return new Promise(resolve => {
    let frame = 0
    const finish = () => {
      cancelAnimationFrame(frame)
      signal.removeEventListener('abort', finish)
      document.removeEventListener('visibilitychange', visibility)
      resolve()
    }
    const visibility = () => { if (document.hidden) finish() }
    signal.addEventListener('abort', finish, { once: true })
    document.addEventListener('visibilitychange', visibility)
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish) })
  })
}
